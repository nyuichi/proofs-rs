import type { MiddlewareHandler } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import type { OpenAPIV3_1 } from "openapi-types";
import type { App } from "./core";
import { Fault, jsonBody } from "./core";
import { z, error } from "./schemas";

type OperationOptions = {
  tags?: string[];
  body?: z.ZodType;
  query?: z.ZodObject;
  params?: Record<string, z.ZodType>;
  status?: number;
  additionalResponses?: Record<number, z.ZodType>;
  errors?: number[];
  description?: string;
  auth?: "session" | "user" | "bearer" | "signup" | "optional";
  write?: boolean;
  idempotent?: boolean;
  form?: boolean;
  // Raw SARIF is validated by readRecord; preserve bytes for hashing/storage.
  raw?: boolean;
  media?: string;
  responseMedia?: string;
  redirect?: boolean;
};
const jsonResponse = (
  schema: z.ZodType,
  description: string,
  media = "application/json",
) => ({
  description,
  content: { [media]: { schema: resolver(schema) } },
});
function parameters(
  schema: z.ZodObject,
  location: "query" | "path",
): OpenAPIV3_1.ParameterObject[] {
  const json = z.toJSONSchema(schema);
  return Object.entries(json.properties ?? {}).map(([name, property]) => ({
    name,
    in: location,
    required: location === "path" || !!json.required?.includes(name),
    schema: property as OpenAPIV3_1.ParameterObject["schema"],
  }));
}

// Route-local metadata and request validation share the same schemas. No path
// catalogue is kept here: hono-openapi reads the mounted Hono routes directly.
export function operation(
  summary: string,
  response: z.ZodType,
  options: OperationOptions = {},
) {
  const session: OpenAPIV3_1.SecurityRequirementObject = options.write
    ? { session: [], csrf: [] }
    : { session: [] };
  const security: OpenAPIV3_1.SecurityRequirementObject[] =
    options.auth === "optional"
      ? [{}, { session: [] }, { bearer: [] }]
      : options.auth === "user"
        ? [session, { bearer: [] }]
        : options.auth === "session"
          ? [session]
          : options.auth === "bearer"
            ? [{ bearer: [] }]
            : options.auth === "signup"
              ? [{ signup: [], csrf: [] }]
              : [];
  const media = options.media ?? "application/json";
  const requestContent = options.body
    ? {
        [media]: { schema: resolver(options.body) },
        ...(options.form
          ? {
              "application/x-www-form-urlencoded": {
                schema: resolver(options.body),
              },
            }
          : {}),
      }
    : undefined;
  const describe = describeRoute({
    summary,
    tags: options.tags,
    description: options.description,
    security,
    parameters: [
      ...parameters(options.query ?? z.object({}), "query"),
      ...parameters(z.object(options.params ?? {}), "path"),
      ...(options.idempotent
        ? [
            {
              name: "Idempotency-Key",
              in: "header" as const,
              required: true,
              schema: {
                type: "string" as const,
                pattern: "^[a-zA-Z0-9_-]{16,100}$",
              },
            },
          ]
        : []),
    ],
    ...(requestContent
      ? { requestBody: { required: true, content: requestContent } }
      : {}),
    responses: {
      [options.status ?? 200]: options.redirect
        ? {
            description: "Redirect",
            headers: {
              Location: {
                description: "Redirect destination",
                required: true,
                schema: { type: "string" },
              },
            },
          }
        : jsonResponse(response, "Success", options.responseMedia),
      ...Object.fromEntries(
        Object.entries(options.additionalResponses ?? {}).map(
          ([status, schema]) => [status, jsonResponse(schema, "Success")],
        ),
      ),
      ...Object.fromEntries(
        (options.errors ?? []).map((status) => [
          status,
          jsonResponse(error, "Request failed"),
        ]),
      ),
      default: jsonResponse(
        error,
        "Request failed; error identifies the reason.",
      ),
    },
  });
  const validate: MiddlewareHandler<App> = async (c, next) => {
    if (options.body && !options.raw) {
      const value =
        options.form &&
        c.req
          .header("content-type")
          ?.includes("application/x-www-form-urlencoded")
          ? Object.fromEntries(new URLSearchParams(await c.req.text()))
          : await jsonBody(c);
      const parsed = options.body.safeParse(value);
      if (!parsed.success)
        throw new Fault(
          400,
          "invalid_field",
          parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        );
    }
    // Domain checks (including cursor decoding/not-found precedence) remain in
    // handlers. Query schemas describe string inputs without coercing them.
    await next();
  };
  return [describe, validate] as const;
}

export const documentation = {
  openapi: "3.1.0",
  info: {
    title: "proofs.rs API",
    version: "1",
    description:
      "Public API. Session writes require the application's Origin and X-CSRF-Token from GET /api/v1/me, plus current terms acceptance. Bearer tokens have the publish scope; only operations listing bearer security accept them. Pagination returns an opaque next_cursor. Administrative APIs are not part of this definition.",
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer" },
      session: {
        type: "apiKey",
        in: "cookie",
        name: "__Host-proofsr_session",
        description: "Browser session. Local HTTP uses proofsr_session.",
      },
      csrf: { type: "apiKey", in: "header", name: "X-CSRF-Token" },
      signup: {
        type: "apiKey",
        in: "cookie",
        name: "__Host-proofsr_signup",
        description: "Pending signup cookie. Local HTTP uses proofsr_signup.",
      },
    },
  },
} satisfies Partial<OpenAPIV3_1.Document>;
