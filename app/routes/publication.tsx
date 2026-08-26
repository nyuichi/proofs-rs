import { env } from "cloudflare:workers";
import { Link } from "react-router";

import type { Route } from "./+types/publication";
import { getPublication } from "../lib/repository.server";
import {
  asObject,
  githubTreeUrl,
  parseStoredRun,
  physicalLocationText,
  relativeTime,
  splitPublicationMessage,
  textFromDescriptor,
} from "../lib/presentation";
import type { JsonObject, SarifRun } from "../lib/sarif";

const UNSPECIFIED_TARGET = "Target not specified";

interface RuleOccurrence {
  key: string;
  ruleId: string;
  shortDescription?: string;
  fullDescription?: string;
  toolName: string;
  toolVersion?: string;
  locationText?: string;
  locationUri?: string;
  locationLine?: number;
}

interface TargetGroup {
  target: string;
  occurrences: RuleOccurrence[];
}

export async function loader({ params }: Route.LoaderArgs) {
  const id = params.id;
  if (!id) throw new Response("Publication not found", { status: 404 });
  const publication = await getPublication(env.DB, id);
  if (!publication) throw new Response("Publication not found", { status: 404 });
  return { publication };
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

function driverForRun(run: SarifRun): JsonObject {
  const tool = asObject(run.tool);
  return asObject(tool?.driver) ?? {};
}

function descriptorsForRun(run: SarifRun): JsonObject[] {
  const driver = driverForRun(run);
  return Array.isArray(driver.rules)
    ? driver.rules.flatMap((rule) => {
        const object = asObject(rule);
        return object ? [object] : [];
      })
    : [];
}

function descriptorForResult(run: SarifRun, result: JsonObject): JsonObject | undefined {
  const descriptors = descriptorsForRun(run);
  const resultRule = asObject(result.rule);
  const index =
    typeof result.ruleIndex === "number"
      ? result.ruleIndex
      : typeof resultRule?.index === "number"
        ? resultRule.index
        : undefined;
  if (index !== undefined && Number.isInteger(index)) return descriptors[index];

  const ruleId = typeof result.ruleId === "string" ? result.ruleId : "";
  return descriptors.find((descriptor) => {
    const id = typeof descriptor.id === "string" ? descriptor.id : "";
    return id === ruleId || ruleId.startsWith(`${id}/`);
  });
}

function targetNamesForLocation(location: JsonObject): string[] {
  const logicalLocations = location.logicalLocations;
  if (!Array.isArray(logicalLocations)) return [UNSPECIFIED_TARGET];
  const names = logicalLocations.flatMap((logicalLocation) => {
    const logical = asObject(logicalLocation);
    const fullyQualifiedName = logical?.fullyQualifiedName;
    const name = logical?.name;
    if (typeof fullyQualifiedName === "string" && fullyQualifiedName.trim()) {
      return [fullyQualifiedName];
    }
    if (typeof name === "string" && name.trim()) return [name];
    return [];
  });
  return names.length > 0 ? names : [UNSPECIFIED_TARGET];
}

function locationsForResult(result: JsonObject): JsonObject[] {
  if (!Array.isArray(result.locations) || result.locations.length === 0) {
    return [{}];
  }
  const locations = result.locations.flatMap((location) => {
    const object = asObject(location);
    return object ? [object] : [];
  });
  return locations.length > 0 ? locations : [{}];
}

function uriFromLocation(location: JsonObject): string | undefined {
  const physical = asObject(location.physicalLocation);
  const artifact = asObject(physical?.artifactLocation);
  return typeof artifact?.uri === "string" && artifact.uri.trim()
    ? artifact.uri.trim()
    : undefined;
}

function lineFromLocation(location: JsonObject): number | undefined {
  const physical = asObject(location.physicalLocation);
  const region = asObject(physical?.region);
  return typeof region?.startLine === "number" ? region.startLine : undefined;
}

function groupedOccurrences(publication: Awaited<ReturnType<typeof getPublication>>): TargetGroup[] {
  if (!publication) return [];
  const groups = new Map<string, RuleOccurrence[]>();
  for (const storedRun of publication.runs.slice().sort((a, b) => a.run_index - b.run_index)) {
    const run = parseStoredRun(storedRun.run_json);
    const driver = driverForRun(run);
    const toolName = typeof driver.name === "string" ? driver.name : "Unknown tool";
    const toolVersion = typeof driver.version === "string" ? driver.version : undefined;
    const results = Array.isArray(run.results) ? run.results : [];
    results.forEach((resultValue, resultIndex) => {
      const result = asObject(resultValue);
      const ruleId = result?.ruleId;
      if (!result || typeof ruleId !== "string") return;
      const descriptor = descriptorForResult(run, result);
      const shortDescription = textFromDescriptor(descriptor?.shortDescription);
      const fullDescription = textFromDescriptor(descriptor?.fullDescription);
      locationsForResult(result).forEach((location, locationIndex) => {
        const locationUri = uriFromLocation(location);
        const locationLine = lineFromLocation(location);
        const occurrence: RuleOccurrence = {
          key: `${storedRun.run_index}-${resultIndex}-${locationIndex}`,
          ruleId,
          shortDescription,
          fullDescription,
          toolName,
          toolVersion,
          locationText: physicalLocationText(location),
          locationUri,
          locationLine,
        };
        for (const target of targetNamesForLocation(location)) {
          const current = groups.get(target);
          if (current) current.push({ ...occurrence, key: `${occurrence.key}-${target}` });
          else groups.set(target, [{ ...occurrence, key: `${occurrence.key}-${target}` }]);
        }
      });
    });
  }
  return [...groups.entries()]
    .filter(([target]) => target !== UNSPECIFIED_TARGET)
    .concat([...groups.entries()].filter(([target]) => target === UNSPECIFIED_TARGET))
    .map(([target, occurrences]) => ({ target, occurrences }));
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

function ProvenanceBlock({
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
    <div className="provenance-block">
      <h3>{label}</h3>
      <a href={repositoryUrl(repository)} target="_blank" rel="noreferrer">
        {repository}
      </a>
      <p>
        <a
          className="provenance-detail-link"
          href={githubTreeUrl(repository, commit, path)}
          target="_blank"
          rel="noreferrer"
        >
          {commit}
          {path ? ` / ${path}` : ""}
        </a>
      </p>
    </div>
  );
}

function RuleDisclosure({
  occurrence,
  publication,
}: {
  occurrence: RuleOccurrence;
  publication: NonNullable<Awaited<ReturnType<typeof getPublication>>>;
}) {
  const sourceHref = occurrence.locationUri
    ? sourceLocationUrl(
        publication.verification_repository,
        publication.verification_commit,
        publication.verification_path,
        occurrence.locationUri,
      )
    : undefined;

  return (
    <details className="rule-disclosure">
      <summary>
        <span className="rule-id">{occurrence.ruleId}</span>
        <span className="rule-description-muted">
          {occurrence.shortDescription ?? "Description not supplied"}
        </span>
        <span className="rule-tool">
          {occurrence.toolName}
          {occurrence.toolVersion ? ` ${occurrence.toolVersion}` : ""}
        </span>
      </summary>
      <div className="rule-detail">
        {occurrence.shortDescription ? (
          <p>
            <span className="detail-label">Summary</span>
            {occurrence.shortDescription}
          </p>
        ) : null}
        {occurrence.fullDescription ? (
          <p>
            <span className="detail-label">Full description</span>
            {occurrence.fullDescription}
          </p>
        ) : null}
        {occurrence.locationText ? (
          <p className="source-location">
            <span className="detail-label">Source</span>
            {sourceHref ? (
              <a href={sourceHref} target="_blank" rel="noreferrer">
                {occurrence.locationText}
              </a>
            ) : (
              occurrence.locationText
            )}
            {occurrence.locationLine ? ` (line ${occurrence.locationLine})` : ""}
          </p>
        ) : null}
        {!occurrence.shortDescription && !occurrence.fullDescription && !occurrence.locationText ? (
          <p className="muted">No description or source location supplied.</p>
        ) : null}
      </div>
    </details>
  );
}

export default function PublicationDetail({ loaderData }: Route.ComponentProps) {
  const { publication } = loaderData;
  const { title, body } = splitPublicationMessage(publication.message);
  const groups = groupedOccurrences(publication);
  const runs = publication.runs.slice().sort((a, b) => a.run_index - b.run_index);

  return (
    <main className="page-shell detail-page">
      <Link className="back-link" to="/">
        ← Publications
      </Link>
      <article>
        <header className="detail-header">
          <div className="detail-subject-row">
            <span className="publication-subject">
              {publication.crate_name} {publication.crate_version}
            </span>
            <span className="publication-byline">
              by @{publication.publisher_login} <span aria-hidden="true">·</span>{" "}
              <time dateTime={publication.created_at} suppressHydrationWarning>
                {relativeTime(publication.created_at)}
              </time>
            </span>
          </div>
          <h1>{title}</h1>
          {body ? <p className="message-body">{body}</p> : null}
        </header>

        <section className="detail-section" aria-labelledby="targets-heading">
          <h2 id="targets-heading">Verified targets and rules</h2>
          {groups.length > 0 ? (
            groups.map((group) => (
              <section className="target-group" key={group.target}>
                <h3 className="target-name">{group.target}</h3>
                <div className="rule-list">
                  {group.occurrences.map((occurrence) => (
                    <RuleDisclosure
                      key={occurrence.key}
                      occurrence={occurrence}
                      publication={publication}
                    />
                  ))}
                </div>
              </section>
            ))
          ) : (
            <p className="muted">No rule results were supplied.</p>
          )}
        </section>

        <section className="detail-section" aria-labelledby="provenance-heading">
          <h2 id="provenance-heading">Source provenance</h2>
          <div className="provenance-grid">
            <ProvenanceBlock
              label="Upstream"
              repository={publication.upstream_repository}
              commit={publication.upstream_commit}
              path={publication.upstream_path}
            />
            <ProvenanceBlock
              label="Verification source"
              repository={publication.verification_repository}
              commit={publication.verification_commit}
              path={publication.verification_path}
            />
          </div>
        </section>

        <section className="detail-section runs-section" aria-labelledby="runs-heading">
          <h2 id="runs-heading">SARIF runs</h2>
          {runs.map((storedRun) => {
            const run = parseStoredRun(storedRun.run_json);
            const driver = driverForRun(run);
            const name = typeof driver.name === "string" ? driver.name : "Unknown tool";
            const version = typeof driver.version === "string" ? driver.version : "";
            return (
              <details className="raw-run" key={storedRun.run_index}>
                <summary>
                  <span>
                    Run {storedRun.run_index + 1} · {name}
                    {version ? ` ${version}` : ""}
                  </span>
                  <span className="raw-run-action">View SARIF JSON</span>
                </summary>
                <pre>{JSON.stringify(run, null, 2)}</pre>
              </details>
            );
          })}
        </section>
      </article>
    </main>
  );
}
