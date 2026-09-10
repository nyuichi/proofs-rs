import { env } from "cloudflare:workers";
import { Link } from "react-router";

import type { Route } from "./+types/publication";
import { getPublicationRecords } from "../lib/records.server";
import { VerificationList } from "../components/verification-list";
import { getPublication } from "../lib/repository.server";
import {
  asObject,
  githubTreeUrl,
  parseStoredRun,
  relativeTime,
  splitPublicationMessage,
  verifiedTargetsForPublication,
} from "../lib/presentation";
import type {
  OtherVerifiedTarget,
  VerifiedApi,
  VerifiedClaim,
  VerifiedEvidence,
  VerifiedModule,
  VerifiedSubtarget,
  VerifiedTargetsModel,
  VerifiedType,
  VerificationContext,
} from "../lib/presentation";
import { getToolName, getToolVersion } from "../lib/sarif";
import type { SarifRun } from "../lib/sarif";

export async function loader({ params }: Route.LoaderArgs) {
  const id = params.id;
  if (!id) throw new Response("Publication not found", { status: 404 });
  const publication = await getPublication(env.DB, id);
  if (!publication) throw new Response("Publication not found", { status: 404 });
  return { publication, records: await getPublicationRecords(env.DB,id) };
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Publication · proofs.rs" },
    {
      name: "description",
      content: "A published verification record for a Rust crate.",
    },
  ];
}

function repositoryUrl(repository: string): string {
  return `https://github.com/${repository}`;
}

function sourceLocationUrl(
  repository: string,
  commit: string,
  verificationPath: string,
  uri: string,
): string | undefined {
  const path = [verificationPath, uri]
    .map((value) => value.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  if (path.split("/").some((part) => part === "..")) return undefined;
  return githubTreeUrl(repository, commit, path);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function contextNameForRun(run: SarifRun, runIndex: number): string {
  const properties = asObject(run.properties);
  const configuration = nonEmptyString(properties?.configuration);
  if (configuration) return configuration;

  const automationDetails = asObject(run.automationDetails);
  const automationId = nonEmptyString(automationDetails?.id);
  if (automationId) {
    const segments = automationId.split(/[\\/]/).filter(Boolean);
    const terminal = segments.at(-1)?.trim();
    if (terminal) return terminal;
  }
  return `Run ${runIndex + 1}`;
}

interface ContextDetails {
  runIndexes: number[];
  scope?: string;
  command?: string;
  tools: string[];
}

function commandForRun(run: SarifRun): string | undefined {
  const properties = asObject(run.properties);
  const propertyCommand =
    nonEmptyString(properties?.commandLine) ??
    nonEmptyString(properties?.command_line) ??
    nonEmptyString(properties?.proof_command) ??
    nonEmptyString(properties?.command);
  if (propertyCommand) return propertyCommand;

  if (!Array.isArray(run.invocations)) return undefined;
  for (const invocationValue of run.invocations) {
    const invocation = asObject(invocationValue);
    const command = nonEmptyString(invocation?.commandLine);
    if (command) return command;
  }
  return undefined;
}

function scopeForRun(run: SarifRun): string | undefined {
  const properties = asObject(run.properties);
  return (
    nonEmptyString(properties?.scope) ??
    nonEmptyString(properties?.verification_scope) ??
    nonEmptyString(properties?.proof_scope)
  );
}

function contextDetailsForPublication(
  publication: NonNullable<Awaited<ReturnType<typeof getPublication>>>,
): Map<string, ContextDetails> {
  const details = new Map<string, ContextDetails>();
  for (const storedRun of publication.runs
    .slice()
    .sort((left, right) => left.run_index - right.run_index)) {
    const run = parseStoredRun(storedRun.run_json);
    const name = contextNameForRun(run, storedRun.run_index);
    const current = details.get(name) ?? { runIndexes: [], tools: [] };
    if (!current.runIndexes.includes(storedRun.run_index)) {
      current.runIndexes.push(storedRun.run_index);
    }

    const scope = scopeForRun(run);
    if (!current.scope && scope) current.scope = scope;
    const command = commandForRun(run);
    if (!current.command && command) current.command = command;

    const tool = getToolName(run);
    const version = getToolVersion(run);
    const toolLabel = version ? `${tool} ${version}` : tool;
    if (!current.tools.includes(toolLabel)) current.tools.push(toolLabel);
    details.set(name, current);
  }
  return details;
}

function ProvenanceLine({
  label,
  repository,
  commit,
  path,
}: {
  label: string;
  repository: string;
  commit: string;
  path: string;
}) {
  return (
    <div className="provenance-line">
      <span className="provenance-line-label">{label}</span>
      <a href={repositoryUrl(repository)} target="_blank" rel="noreferrer">
        {repository}
      </a>
      <a
        className="provenance-line-ref"
        href={githubTreeUrl(repository, commit, path)}
        target="_blank"
        rel="noreferrer"
      >
        {commit}
        {path ? ` / ${path}` : ""}
      </a>
    </div>
  );
}

function contextCount(contexts: readonly string[]): string {
  if (contexts.length === 1) return "1 context";
  return `${contexts.length} contexts`;
}

function contextsForClaims(claims: readonly VerifiedClaim[]): string[] {
  return [...new Set(claims.flatMap((claim) => claim.contexts))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function sourceText(source: VerifiedEvidence["source"]): string | undefined {
  if (!source) return undefined;
  return source.text ?? source.uri;
}

function EvidenceRow({
  evidence,
  publication,
}: {
  evidence: VerifiedEvidence;
  publication: NonNullable<Awaited<ReturnType<typeof getPublication>>>;
}) {
  const sourceHref = evidence.source?.uri
    ? sourceLocationUrl(
        publication.verification_repository,
        publication.verification_commit,
        publication.verification_path,
        evidence.source.uri,
      )
    : undefined;
  const source = sourceText(evidence.source);
  const tool = evidence.toolVersion
    ? `${evidence.toolName} ${evidence.toolVersion}`
    : evidence.toolName;

  return (
    <div className="evidence-row">
      <div className="evidence-row-meta">
        <span>Run {evidence.runIndex + 1}</span>
        <span>{tool}</span>
        <code>{evidence.ruleId || "Rule ID not supplied"}</code>
      </div>
      {source ? (
        <p className="evidence-source">
          <span className="detail-label">Source</span>
          {sourceHref ? (
            <a href={sourceHref} target="_blank" rel="noreferrer">
              {source}
            </a>
          ) : (
            source
          )}
        </p>
      ) : null}
    </div>
  );
}

function ClaimList({
  claims,
  publication,
}: {
  claims: readonly VerifiedClaim[];
  publication: NonNullable<Awaited<ReturnType<typeof getPublication>>>;
}) {
  if (claims.length === 0) {
    return <p className="muted target-empty-detail">No claim details supplied.</p>;
  }

  return (
    <div className="claim-list">
      {claims.map((claim, claimIndex) => (
        <div className="claim-block" key={`${claim.text ?? "missing"}-${claimIndex}`}>
          <p className="claim-text">
            {claim.text ?? <span className="muted">Claim text not supplied.</span>}
          </p>
          {claim.contexts.length > 0 ? (
            <p className="claim-contexts">
              <span className="detail-label">Contexts</span>
              {claim.contexts.join(" · ")}
            </p>
          ) : null}
          <div className="evidence-list">
            {claim.evidence.map((evidence) => (
              <EvidenceRow
                key={`${evidence.runIndex}-${evidence.resultIndex}-${evidence.locationIndex}-${evidence.logicalLocationIndex}-${evidence.ruleId}`}
                evidence={evidence}
                publication={publication}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function VerifiedTargetDisclosure({
  name,
  fullyQualifiedName,
  kind,
  contexts,
  claims,
  subtargets = [],
  publication,
  className,
}: {
  name: string;
  fullyQualifiedName: string;
  kind?: string;
  contexts: readonly string[];
  claims: readonly VerifiedClaim[];
  subtargets?: readonly VerifiedSubtarget[];
  publication: NonNullable<Awaited<ReturnType<typeof getPublication>>>;
  className?: string;
}) {
  return (
    <details className={`verified-target-disclosure${className ? ` ${className}` : ""}`}>
      <summary className="verified-target-summary">
        <span className="verified-target-summary-main">
          <span className="verified-target-name">{name}</span>
          {fullyQualifiedName !== name ? (
            <span className="verified-target-path">{fullyQualifiedName}</span>
          ) : null}
          {kind ? <span className="verified-target-kind">{kind}</span> : null}
        </span>
        <span className="verified-target-contexts">{contextCount(contexts)}</span>
      </summary>
      <div className="verified-target-detail">
        <ClaimList claims={claims} publication={publication} />
        {subtargets.length > 0 ? (
          <div className="subtarget-list">
            <p className="subtarget-heading">Internal targets</p>
            {subtargets.map((subtarget) => (
              <VerifiedTargetDisclosure
                key={`${subtarget.kind}-${subtarget.fullyQualifiedName}`}
                name={subtarget.name}
                fullyQualifiedName={subtarget.fullyQualifiedName}
                kind={subtarget.kind}
                contexts={contextsForClaims(subtarget.claims)}
                claims={subtarget.claims}
                publication={publication}
                className="subtarget-disclosure"
              />
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function ApiDisclosure({
  api,
  publication,
  className,
}: {
  api: VerifiedApi;
  publication: NonNullable<Awaited<ReturnType<typeof getPublication>>>;
  className?: string;
}) {
  return (
    <VerifiedTargetDisclosure
      name={api.name}
      fullyQualifiedName={api.fullyQualifiedName}
      kind={api.kind}
      contexts={api.contexts}
      claims={api.claims}
      subtargets={api.subtargets}
      publication={publication}
      className={className}
    />
  );
}

function TypeEntry({
  type,
  publication,
}: {
  type: VerifiedType;
  publication: NonNullable<Awaited<ReturnType<typeof getPublication>>>;
}) {
  return (
    <div className="type-entry">
      <VerifiedTargetDisclosure
        name={type.name}
        fullyQualifiedName={type.fullyQualifiedName}
        kind="type"
        contexts={type.contexts}
        claims={type.claims}
        subtargets={type.subtargets}
        publication={publication}
        className="type-disclosure"
      />
      {type.methods.length > 0 ? (
        <div className="api-child-list" aria-label={`${type.name} methods`}>
          {type.methods.map((method) => (
            <ApiDisclosure
              key={`${method.kind}-${method.fullyQualifiedName}`}
              api={method}
              publication={publication}
              className="api-child-disclosure"
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ModuleSection({
  module,
  publication,
}: {
  module: VerifiedModule;
  publication: NonNullable<Awaited<ReturnType<typeof getPublication>>>;
}) {
  return (
    <section className="target-module">
      {module.fullyQualifiedName ? (
        <h4 className="target-module-name">
          {module.name}
          {module.fullyQualifiedName !== module.name ? (
            <span className="target-module-path">{module.fullyQualifiedName}</span>
          ) : null}
        </h4>
      ) : null}
      <div className="module-target-list">
        {module.types.map((type) => (
          <TypeEntry key={type.fullyQualifiedName} type={type} publication={publication} />
        ))}
        {module.functions.map((fn) => (
          <ApiDisclosure
            key={`${fn.kind}-${fn.fullyQualifiedName}`}
            api={fn}
            publication={publication}
            className="module-function-disclosure"
          />
        ))}
      </div>
    </section>
  );
}

function ContextDisclosure({
  context,
  details,
  apiCount,
  publication,
}: {
  context: VerificationContext;
  details?: ContextDetails;
  apiCount: number;
  publication: NonNullable<Awaited<ReturnType<typeof getPublication>>>;
}) {
  const runIndexes = details?.runIndexes ?? [];
  const runLabel =
    runIndexes.length === 0
      ? undefined
      : runIndexes.length === 1
        ? `Run ${runIndexes[0]! + 1}`
        : `Runs ${runIndexes.map((index) => index + 1).join(", ")}`;
  const tools = details?.tools ?? [];

  return (
    <details className="context-row">
      <summary className="context-summary">
        <span className="context-summary-main">
          <span className="context-name">{context.name}</span>
          {context.kinds.length > 0 ? (
            <span className="context-kind">{context.kinds.join(" · ")}</span>
          ) : null}
        </span>
        <span className="context-summary-facts">
          {details?.scope ? <span>{details.scope}</span> : null}
          <span>{apiCount} {apiCount === 1 ? "API" : "APIs"}</span>
          {runLabel ? <span>{runLabel}</span> : null}
        </span>
      </summary>
      <div className="context-detail">
        <div className="context-facts">
          {details?.scope ? (
            <p>
              <span className="detail-label">Scope</span>
              {details.scope}
            </p>
          ) : null}
          {details?.command ? (
            <p>
              <span className="detail-label">Command</span>
              <code>{details.command}</code>
            </p>
          ) : null}
          {tools.length > 0 ? (
            <p>
              <span className="detail-label">Tool</span>
              {tools.join(" · ")}
            </p>
          ) : null}
        </div>
        {context.targets.length > 0 ? (
          <div className="context-target-list">
            {context.targets.map((target) => (
              <VerifiedTargetDisclosure
                key={`${target.kind}-${target.fullyQualifiedName}`}
                name={target.name}
                fullyQualifiedName={target.fullyQualifiedName}
                kind={target.kind}
                contexts={contextsForClaims(target.claims)}
                claims={target.claims}
                publication={publication}
                className="context-target-disclosure"
              />
            ))}
          </div>
        ) : (
          <p className="muted">No context-specific target details supplied.</p>
        )}
      </div>
    </details>
  );
}

function OtherTargetDisclosure({
  target,
  publication,
}: {
  target: OtherVerifiedTarget;
  publication: NonNullable<Awaited<ReturnType<typeof getPublication>>>;
}) {
  return (
    <VerifiedTargetDisclosure
      name={target.name}
      fullyQualifiedName={target.fullyQualifiedName}
      kind={target.kind}
      contexts={contextsForClaims(target.claims)}
      claims={target.claims}
      publication={publication}
      className="other-target-disclosure"
    />
  );
}

function VerifiedTargets({
  model,
  contextDetails,
  publication,
}: {
  model: VerifiedTargetsModel;
  contextDetails: Map<string, ContextDetails>;
  publication: NonNullable<Awaited<ReturnType<typeof getPublication>>>;
}) {
  const typeAndApiCount = model.typesAndApis.reduce(
    (count, module) =>
      count +
      module.types.length +
      module.functions.length +
      module.types.reduce((nested, type) => nested + type.methods.length, 0),
    0,
  );
  const apiCountForContext = (contextName: string) =>
    model.typesAndApis.reduce(
      (count, module) =>
        count +
        module.functions.filter((api) => api.contexts.includes(contextName)).length +
        module.types.filter((type) => type.contexts.includes(contextName)).length +
        module.types.reduce(
          (methodCount, type) =>
            methodCount + type.methods.filter((method) => method.contexts.includes(contextName)).length,
          0,
        ),
      0,
    );

  return (
    <section className="detail-section verified-targets-section" aria-labelledby="targets-heading">
      <h2 id="targets-heading">Verified targets</h2>

      <section className="target-subsection" aria-labelledby="types-apis-heading">
        <h3 id="types-apis-heading">Types &amp; APIs</h3>
        {typeAndApiCount > 0 ? (
          <div className="module-list">
            {model.typesAndApis.map((module) => (
              <ModuleSection
                key={module.fullyQualifiedName || module.name}
                module={module}
                publication={publication}
              />
            ))}
          </div>
        ) : (
          <p className="muted">No type or API targets supplied.</p>
        )}
      </section>

      <section className="target-subsection context-subsection" aria-labelledby="contexts-heading">
        <h3 id="contexts-heading">Verification contexts</h3>
        {model.verificationContexts.length > 0 ? (
          <div className="context-list">
            {model.verificationContexts.map((context) => (
              <ContextDisclosure
                key={context.name}
                context={context}
                details={contextDetails.get(context.name)}
                apiCount={apiCountForContext(context.name)}
                publication={publication}
              />
            ))}
          </div>
        ) : (
          <p className="muted">No verification contexts supplied.</p>
        )}
      </section>

      <details className="target-subsection other-targets-section">
        <summary className="section-disclosure-summary">
          <span>Other targets</span>
          <span className="section-count">
            {model.otherTargets.length} {model.otherTargets.length === 1 ? "target" : "targets"}
          </span>
        </summary>
        <div className="other-target-list">
          {model.otherTargets.length > 0 ? (
            model.otherTargets.map((target) => (
              <OtherTargetDisclosure
                key={`${target.kind ?? "other"}-${target.fullyQualifiedName}`}
                target={target}
                publication={publication}
              />
            ))
          ) : (
            <p className="muted">No other targets supplied.</p>
          )}
        </div>
      </details>
    </section>
  );
}

function RawRuns({
  publication,
}: {
  publication: NonNullable<Awaited<ReturnType<typeof getPublication>>>;
}) {
  const runs = publication.runs.slice().sort((left, right) => left.run_index - right.run_index);
  return (
    <section className="detail-section runs-section" aria-labelledby="runs-heading">
      <h2 id="runs-heading">Raw SARIF</h2>
      {runs.length > 0 ? (
        <div className="raw-run-list">
          {runs.map((storedRun) => {
            const run = parseStoredRun(storedRun.run_json);
            const tool = getToolName(run);
            const version = getToolVersion(run);
            const context = contextNameForRun(run, storedRun.run_index);
            return (
              <details className="raw-run" key={storedRun.run_index}>
                <summary>
                  <span>
                    Run {storedRun.run_index + 1} · {context} · {tool}
                    {version ? ` ${version}` : ""}
                  </span>
                  <span className="raw-run-action">View SARIF JSON</span>
                </summary>
                <pre>{JSON.stringify(run, null, 2)}</pre>
              </details>
            );
          })}
        </div>
      ) : (
        <p className="muted">No SARIF runs supplied.</p>
      )}
    </section>
  );
}

export default function PublicationDetail({ loaderData }: Route.ComponentProps) {
  const { publication, records } = loaderData;
  const { title, body } = splitPublicationMessage(publication.message);
  const model = verifiedTargetsForPublication(publication);
  const contextDetails = contextDetailsForPublication(publication);

  return (
    <main className="page-shell detail-page">
      <div className="crate-controls"><Link to={`/crates/${publication.crate_name}?version=${publication.crate_version}`}>← {publication.crate_name} {publication.crate_version}</Link><Link className="primary-button" to={`/publish?from=${publication.id}`}>Build on this publication</Link></div>

      <Link className="back-link" to="/">
        ← Publications
      </Link>
      <article>
        <header className="detail-header">
          <div className="detail-header-main">
            <div className="detail-crate">
              <span className="detail-crate-name">{publication.crate_name}</span>
              <span className="detail-crate-version">{publication.crate_version}</span>
            </div>
          </div>
          <h1>{title}</h1>
          {publication.labels.length > 0 ? (
            <div className="detail-labels" aria-label="Publication labels">
              {publication.labels.map((label) => (
                <span className="publication-label" key={label.position}>
                  {label.display_name}
                </span>
              ))}
            </div>
          ) : null}
          <p className="publication-byline">
            by @{publication.publisher_login} <span aria-hidden="true">·</span>{" "}
            <time dateTime={publication.created_at} suppressHydrationWarning>
              {relativeTime(publication.created_at)}
            </time>
          </p>
          {body ? <p className="message-body">{body}</p> : null}
        </header>

        <section className="detail-provenance" aria-labelledby="provenance-heading">
          <h2 id="provenance-heading" className="sr-only">
            Source provenance
          </h2>
          <ProvenanceLine
            label="Upstream"
            repository={publication.upstream_repository}
            commit={publication.upstream_commit}
            path={publication.upstream_path}
          />
          <ProvenanceLine
            label="Verification source"
            repository={publication.verification_repository}
            commit={publication.verification_commit}
            path={publication.verification_path}
          />
        </section>

        {records.length>0 ? <VerificationList records={records}/> : <VerifiedTargets
          model={model}
          contextDetails={contextDetails}
          publication={publication}
        />}

        <RawRuns publication={publication} />
      </article>
    </main>
  );
}

