import { env } from "cloudflare:workers";
import { data, Form, redirect, useActionData, useNavigation } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/publish";
import {
  assertSameOrigin,
  getOptionalPublisher,
} from "../lib/auth.server";
import {
  createPublication,
  PublicationRateLimitError,
} from "../lib/repository.server";
import { parsePublicationMetadata } from "../lib/metadata";
import { parseSarif, SarifValidationError } from "../lib/sarif";

const FIELD_NAMES = [
  "message",
  "crate_name",
  "crate_version",
  "upstream_repository",
  "upstream_commit",
  "upstream_path",
  "verification_repository",
  "verification_commit",
  "verification_path",
  "sarif",
] as const;

export type PublishValues = Record<(typeof FIELD_NAMES)[number], string>;

export interface PublishActionData {
  values: PublishValues;
  errors: Record<string, string>;
}

function stringValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function valuesFromFormData(formData: FormData): PublishValues {
  return Object.fromEntries(
    FIELD_NAMES.map((name) => [name, stringValue(formData, name)]),
  ) as PublishValues;
}

function validationErrors(error: unknown): Record<string, string> {
  if (error instanceof z.ZodError) {
    const errors: Record<string, string> = {};
    for (const issue of error.issues) {
      const field = issue.path[0];
      if (typeof field === "string" && !errors[field]) errors[field] = issue.message;
    }
    return errors;
  }
  if (error instanceof SarifValidationError) {
    return { sarif: error.message };
  }
  if (error instanceof PublicationRateLimitError) {
    return { _form: error.message };
  }
  return { _form: "This publication could not be created. Try again." };
}

function publishLoginRedirect(): Response {
  return redirect(`/auth/github?returnTo=${encodeURIComponent("/publish")}`, 303);
}

export async function loader({ request }: Route.LoaderArgs) {
  const publisher = await getOptionalPublisher(request, env.DB);
  if (!publisher) throw publishLoginRedirect();
  return { publisher: { github_login: publisher.github_login } };
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request, env);
  const publisher = await getOptionalPublisher(request, env.DB);
  if (!publisher) return publishLoginRedirect();

  const formData = await request.formData();
  const values = valuesFromFormData(formData);
  try {
    const metadata = parsePublicationMetadata({
      message: values.message,
      crate_name: values.crate_name,
      crate_version: values.crate_version,
      upstream_repository: values.upstream_repository,
      upstream_commit: values.upstream_commit,
      upstream_path: values.upstream_path,
      verification_repository: values.verification_repository,
      verification_commit: values.verification_commit,
      verification_path: values.verification_path,
    });
    const sarif = parseSarif(values.sarif);
    const id = await createPublication({
      db: env.DB,
      publisherId: publisher.id,
      metadata,
      sarif,
    });
    return redirect(`/publications/${encodeURIComponent(id)}`, 303);
  } catch (error) {
    if (
      !(error instanceof z.ZodError) &&
      !(error instanceof SarifValidationError) &&
      !(error instanceof PublicationRateLimitError)
    ) {
      throw error;
    }
    return data<PublishActionData>(
      { values, errors: validationErrors(error) },
      { status: 400 },
    );
  }
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Publish · proofs.rs" },
    {
      name: "description",
      content: "Publish a verification record to proofs.rs.",
    },
  ];
}

function fieldError(errors: Record<string, string>, name: string): string | undefined {
  return errors[name];
}

function FieldError({ error, id }: { error?: string; id: string }) {
  return error ? (
    <p className="field-error" id={id} role="alert">
      {error}
    </p>
  ) : null;
}

function TextField({
  label,
  name,
  value,
  errors,
  wide = false,
  placeholder,
}: {
  label: string;
  name: keyof PublishValues;
  value: string;
  errors: Record<string, string>;
  wide?: boolean;
  placeholder?: string;
}) {
  const error = fieldError(errors, name);
  const errorId = `${name}-error`;
  return (
    <div className={`form-field${wide ? " form-field-wide" : ""}`}>
      <label htmlFor={name}>{label}</label>
      <input
        id={name}
        name={name}
        defaultValue={value}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        required={name !== "upstream_path" && name !== "verification_path"}
      />
      <FieldError error={error} id={errorId} />
    </div>
  );
}

export default function Publish({}: Route.ComponentProps) {
  const actionData = useActionData() as PublishActionData | undefined;
  const navigation = useNavigation();
  const values = actionData?.values ?? {
    message: "",
    crate_name: "",
    crate_version: "",
    upstream_repository: "",
    upstream_commit: "",
    upstream_path: "",
    verification_repository: "",
    verification_commit: "",
    verification_path: "",
    sarif: "",
  } satisfies PublishValues;
  const errors = actionData?.errors ?? {};
  const isSubmitting = navigation.state === "submitting";

  return (
    <main className="page-shell publish-page">
      <section className="page-heading">
        <p className="eyebrow">New record</p>
        <h1>Publish</h1>
        <p className="lede">
          One immutable publication with one crate version and one SARIF document.
        </p>
      </section>

      <Form className="publish-form" method="post">
        <section className="form-section">
          <h2>Publication message</h2>
          <div className="form-field form-field-wide">
            <label htmlFor="message">
              First line becomes the title; add a blank line before the longer explanation.
            </label>
            <textarea
              id="message"
              name="message"
              defaultValue={values.message}
              rows={5}
              aria-invalid={errors.message ? true : undefined}
              aria-describedby={errors.message ? "message-error" : undefined}
              required
            />
            <FieldError error={errors.message} id="message-error" />
          </div>
        </section>

        <section className="form-section">
          <h2>Upstream</h2>
          <div className="form-grid">
            <TextField
              label="Crate"
              name="crate_name"
              value={values.crate_name}
              errors={errors}
              placeholder="tokio"
            />
            <TextField
              label="Version"
              name="crate_version"
              value={values.crate_version}
              errors={errors}
              placeholder="1.48.0"
            />
            <TextField
              label="GitHub repository"
              name="upstream_repository"
              value={values.upstream_repository}
              errors={errors}
              wide
              placeholder="tokio-rs/tokio"
            />
            <TextField
              label="Commit (40 or 64 hex characters)"
              name="upstream_commit"
              value={values.upstream_commit}
              errors={errors}
              placeholder="full commit SHA"
            />
            <TextField
              label="Path (optional)"
              name="upstream_path"
              value={values.upstream_path}
              errors={errors}
              placeholder="tokio/src/sync/semaphore.rs"
            />
          </div>
        </section>

        <section className="form-section">
          <h2>Verification source</h2>
          <div className="form-grid">
            <TextField
              label="GitHub repository"
              name="verification_repository"
              value={values.verification_repository}
              errors={errors}
              wide
              placeholder="alice/tokio-verification"
            />
            <TextField
              label="Commit (40 or 64 hex characters)"
              name="verification_commit"
              value={values.verification_commit}
              errors={errors}
              placeholder="full commit SHA"
            />
            <TextField
              label="Path (optional)"
              name="verification_path"
              value={values.verification_path}
              errors={errors}
              placeholder="verification/"
            />
          </div>
        </section>

        <section className="form-section">
          <h2>SARIF JSON</h2>
          <div className="form-field form-field-wide">
            <label htmlFor="sarif">
              One SARIF 2.1.0 document; multiple runs are allowed; maximum 1 MB.
            </label>
            <textarea
              className="sarif-input"
              id="sarif"
              name="sarif"
              defaultValue={values.sarif}
              rows={16}
              spellCheck={false}
              placeholder='{"version":"2.1.0","runs":[...]}'
              aria-invalid={errors.sarif ? true : undefined}
              aria-describedby={errors.sarif ? "sarif-error" : undefined}
              required
            />
            <FieldError error={errors.sarif} id="sarif-error" />
          </div>
          <p className="form-note">
            Rule IDs and descriptions are displayed exactly as supplied by the SARIF document.
          </p>
        </section>

        {errors._form ? (
          <p className="form-error" role="alert">
            {errors._form}
          </p>
        ) : null}

        <button className="primary-button" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Publishing…" : "Publish record"}
        </button>
      </Form>
    </main>
  );
}
