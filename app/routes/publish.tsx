import { RecordEditor } from "../components/record-editor";
import { getPublicationRecords, RecordValidationError, recordInputsSchema } from "../lib/records.server";
import { getPublication } from "../lib/repository.server";
import { isDemoMode } from "../lib/demo.server";
import { demoDraft } from "../lib/demo-data";
import { env } from "cloudflare:workers";
import { data, Form, redirect, useActionData, useNavigation } from "react-router";
import { useState, type KeyboardEvent } from "react";
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
import {
  MAX_PUBLICATION_LABEL_LENGTH,
  MAX_PUBLICATION_LABELS,
} from "../lib/publication-labels";
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
  "labels",
  "sarif",
  "records",
  "inherited",
  "source",
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

function labelValues(formData: FormData): string[] {
  return formData
    .getAll("labels")
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function valuesFromFormData(formData: FormData): PublishValues {
  return {
    ...Object.fromEntries(
      FIELD_NAMES.map((name) => [name, stringValue(formData, name)]),
    ),
    labels: labelValues(formData).join(", "),
  } as PublishValues;
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
  if (error instanceof RecordValidationError) return { _form: error.message };
  if (error instanceof SarifValidationError) {
    return { sarif: error.message };
  }
  if (error instanceof PublicationRateLimitError) {
    return { _form: error.message };
  }
  return { _form: "This publication could not be created. Try again." };
}

function publishLoginRedirect(request: Request): Response {
 const url=new URL(request.url);const returnTo=url.pathname+url.search;
 return redirect(`${isDemoMode(env)?'/demo':'/auth/github'}?returnTo=${encodeURIComponent(returnTo)}`,303);
}

export async function loader({ request }: Route.LoaderArgs) {
  const publisher = await getOptionalPublisher(request, env.DB);
  if (!publisher) throw publishLoginRedirect(request);
  const url=new URL(request.url);
  const from=url.searchParams.get('from');
  const source=from ? await getPublication(env.DB,from) : null;
  if(from&&!source) throw new Response('Source publication not found',{status:404});
  const available=source ? await getPublicationRecords(env.DB,source.id) : [];
  const initial: Partial<PublishValues> = source ? {
   message:`Update ${source.crate_name} verification`, crate_name:source.crate_name,crate_version:source.crate_version,
   upstream_repository:source.upstream_repository,upstream_commit:source.upstream_commit,upstream_path:source.upstream_path,
   verification_repository:source.verification_repository,verification_commit:source.verification_commit,verification_path:source.verification_path,
   sarif:JSON.stringify({version:source.sarif_version,runs:source.runs.map(r=>JSON.parse(r.run_json))},null,2),source:source.id
  } : {crate_name:url.searchParams.get('crate') ?? '',crate_version:url.searchParams.get('version') ?? ''};
  if(url.searchParams.has('demo') && isDemoMode(env)) Object.assign(initial,demoDraft());
  return { publisher: { github_login: publisher.github_login }, initial, available };

}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request, env);
  const publisher = await getOptionalPublisher(request, env.DB);
  if (!publisher) return publishLoginRedirect(request);

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
      labels: labelValues(formData),
    });
    const sarif = parseSarif(values.sarif);
    let recordInput: unknown, inherited: unknown;
    try { recordInput=JSON.parse(values.records || '[]');inherited=JSON.parse(values.inherited || '[]'); }
    catch { throw new RecordValidationError('Invalid API result data.'); }
    const records=recordInputsSchema.parse(recordInput);
    const inheritedRecordIds=z.array(z.string().min(1)).max(200).parse(inherited);
    if(records.length+inheritedRecordIds.length===0) throw new RecordValidationError('Add at least one API result or retain an existing result.');

    const id = await createPublication({
      db: env.DB,
      publisherId: publisher.id,
      metadata,
      sarif,
      records,
      inheritedRecordIds,
    });
    return redirect(`/publications/${encodeURIComponent(id)}`, 303);
  } catch (error) {
    if (
      !(error instanceof z.ZodError) &&
      !(error instanceof SarifValidationError) &&
      !(error instanceof RecordValidationError) &&
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

function labelsForEditor(value: string): string[] {
  return value
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

function PublicationLabelsField({
  value,
  error,
}: {
  value: string;
  error?: string;
}) {
  const [labels, setLabels] = useState(() => labelsForEditor(value));
  const [draft, setDraft] = useState("");
  const errorId = "labels-error";

  function addDraft() {
    const next = draft.trim();
    if (!next || labels.length >= MAX_PUBLICATION_LABELS) return;
    setLabels((current) => [...current, next]);
    setDraft("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addDraft();
    }
  }

  return (
    <div className="form-field form-field-wide">
      <label htmlFor="labels">Labels (optional)</label>
      <div
        className="publication-label-editor"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      >
        {labels.map((label, index) => (
          <span className="publication-label publication-label-edit" key={`${label}-${index}`}>
            <span>{label}</span>
            <button
              type="button"
              className="publication-label-remove"
              aria-label={`Remove label ${label}`}
              onClick={() => setLabels((current) => current.filter((_, item) => item !== index))}
            >
              ×
            </button>
            <input type="hidden" name="labels" value={label} />
          </span>
        ))}
        <input
          id="labels"
          name="labels"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder="no-panic, data race"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
      </div>
      <p className="form-note">
        Press Enter or comma to add a label. Up to {MAX_PUBLICATION_LABELS} labels,{" "}
        {MAX_PUBLICATION_LABEL_LENGTH} characters each.
      </p>
      <FieldError error={error} id={errorId} />
    </div>
  );
}

export default function Publish({loaderData}: Route.ComponentProps) {
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
    labels: "",
    sarif: "",
    records: "[]",
    inherited: "[]",
    source: "",
    ...loaderData.initial,
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
        <input type="hidden" name="source" value={values.source}/>
        <RecordEditor initial={JSON.parse(values.records || '[]')} available={loaderData.available} selected={actionData ? JSON.parse(values.inherited || '[]') : undefined}/>

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
          <h2>Labels</h2>
          <PublicationLabelsField value={values.labels} error={errors.labels} />
        </section>

        <section className="form-section">
          <h2>SARIF JSON</h2><label>Upload SARIF file<input type="file" accept=".sarif,.json,application/json" onChange={async event=>{
 const file=event.target.files?.[0]; if(!file)return;
 if(file.size>1000000){event.target.setCustomValidity('Maximum file size is 1 MB.');event.target.reportValidity();return;}
 event.target.setCustomValidity('');const area=document.getElementById('sarif') as HTMLTextAreaElement|null;if(area)area.value=await file.text();
 }}/></label>
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

