import { z } from "zod";

const GITHUB_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/;
const GIT_COMMIT = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const repositorySchema = z
  .string()
  .trim()
  .regex(GITHUB_REPOSITORY, "Use the owner/repository format.");

export const commitSchema = z
  .string()
  .trim()
  .regex(GIT_COMMIT, "Use a 40- or 64-character hexadecimal commit.");

export function normalizeRepositoryPath(value: string | undefined | null): string {
  const path = (value ?? "").trim().replace(/^\/+/, "");
  if (path.split("/").some((segment) => segment === "..")) {
    throw new Error("Repository paths must not contain '..'.");
  }
  return path;
}

const metadataInputSchema = z.object({
  message: z.string(),
  crate_name: z.string().trim().min(1).max(200),
  crate_version: z.string().trim().min(1).max(120),
  upstream_repository: repositorySchema,
  upstream_commit: commitSchema,
  upstream_path: z.string().max(1_000).optional().default(""),
  verification_repository: repositorySchema,
  verification_commit: commitSchema,
  verification_path: z.string().max(1_000).optional().default(""),
});

export const metadataSchema = metadataInputSchema.transform((value, ctx) => {
  const message = value.message.replace(/\r\n?/g, "\n");

  if (message.length < 1) {
    ctx.addIssue({ code: "custom", message: "Add a publication message.", path: ["message"] });
  } else if (message.length > 4_000) {
    ctx.addIssue({
      code: "custom",
      message: "The publication message must be at most 4,000 characters.",
      path: ["message"],
    });
  }

  if (FORBIDDEN_CONTROL.test(message)) {
    ctx.addIssue({
      code: "custom",
      message: "The publication message contains unsupported control characters.",
      path: ["message"],
    });
  }

  const firstLine = (message.split("\n", 1)[0] ?? "").trim();
  if (firstLine.length < 1 || firstLine.length > 80) {
    ctx.addIssue({
      code: "custom",
      message: "The first line must be between 1 and 80 characters.",
      path: ["message"],
    });
  }

  let upstreamPath = "";
  let verificationPath = "";
  try {
    upstreamPath = normalizeRepositoryPath(value.upstream_path);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid upstream path.",
      path: ["upstream_path"],
    });
  }
  try {
    verificationPath = normalizeRepositoryPath(value.verification_path);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid verification path.",
      path: ["verification_path"],
    });
  }

  return {
    ...value,
    message,
    upstream_path: upstreamPath,
    verification_path: verificationPath,
  };
});

export type PublicationMetadata = z.output<typeof metadataSchema>;

export function parsePublicationMetadata(input: unknown): PublicationMetadata {
  return metadataSchema.parse(input);
}
