import type { PublicationWithRuns } from "./repository.server";
import type { JsonObject, SarifRun } from "./sarif";

export interface MessageParts {
  title: string;
  body: string;
}

export function splitPublicationMessage(message: string): MessageParts {
  const lines = message.replace(/\r\n?/g, "\n").split("\n");
  const title = lines[0]?.trim() || "Untitled publication";
  const bodyStart = lines[1] === "" ? 2 : 1;
  return { title, body: lines.slice(bodyStart).join("\n").trim() };
}

export function parseStoredRun(runJson: string): SarifRun {
  try {
    return JSON.parse(runJson) as SarifRun;
  } catch {
    // A publication can only be created from validated JSON. Keep the renderer
    // defensive in case an operator repairs a database row manually.
    return {} as SarifRun;
  }
}

export function runsForPublication(publication: PublicationWithRuns): SarifRun[] {
  return publication.runs
    .slice()
    .sort((a, b) => a.run_index - b.run_index)
    .map((run) => parseStoredRun(run.run_json));
}

export function ruleIdsForPublication(publication: PublicationWithRuns): string[] {
  return runsForPublication(publication).flatMap((run) => {
    const results = Array.isArray(run.results) ? run.results : [];
    return results.flatMap((result) =>
      typeof result === "object" && result !== null && typeof result.ruleId === "string"
        ? [result.ruleId]
        : [],
    );
  });
}

export function relativeTime(isoDate: string, now = Date.now()): string {
  const deltaSeconds = Math.round((new Date(isoDate).getTime() - now) / 1_000);
  const absolute = Math.abs(deltaSeconds);
  if (!Number.isFinite(absolute)) return "unknown time";
  if (absolute < 45) return deltaSeconds < 0 ? "just now" : "in a moment";

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 24 * 60 * 60],
    ["month", 30 * 24 * 60 * 60],
    ["week", 7 * 24 * 60 * 60],
    ["day", 24 * 60 * 60],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  for (const [unit, seconds] of units) {
    if (absolute >= seconds) {
      return formatter.format(Math.round(deltaSeconds / seconds), unit);
    }
  }
  return formatter.format(deltaSeconds, "second");
}

export function githubTreeUrl(
  repository: string,
  commit: string,
  path = "",
): string {
  const safePath = path
    .trim()
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .filter((part) => part !== "." && part !== "..");
  const encodedPath = safePath.map((part) => encodeURIComponent(part)).join("/");
  return `https://github.com/${repository}/tree/${encodeURIComponent(commit)}${
    encodedPath ? `/${encodedPath}` : ""
  }`;
}

export function physicalLocationText(location: JsonObject): string | undefined {
  const physical = asObject(location.physicalLocation);
  const artifact = asObject(physical?.artifactLocation);
  if (typeof artifact?.uri !== "string" || artifact.uri.length === 0) return undefined;
  const region = asObject(physical?.region);
  const startLine = typeof region?.startLine === "number" ? region.startLine : undefined;
  const startColumn = typeof region?.startColumn === "number" ? region.startColumn : undefined;
  return `${artifact.uri}${startLine ? `:${startLine}` : ""}${
    startColumn ? `:${startColumn}` : ""
  }`;
}

export function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function textFromDescriptor(value: unknown): string | undefined {
  const object = asObject(value);
  return typeof object?.text === "string" ? object.text : undefined;
}
