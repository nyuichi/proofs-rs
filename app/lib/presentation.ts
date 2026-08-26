import type { PublicationWithRuns } from "./repository.server";
import {
  getResultMessage,
  getToolName,
  getToolVersion,
} from "./sarif";
import type { JsonObject, SarifResult, SarifRun } from "./sarif";

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

/**
 * The data consumed by the publication detail page.
 *
 * This is deliberately a view model rather than a second SARIF schema. The
 * raw runs remain available to the page, while this model gives visitors the
 * useful "module -> type -> method" index and keeps the evidence needed to
 * inspect a claim.
 */
export interface VerifiedSource {
  text?: string;
  uri?: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

export interface VerifiedEvidence {
  runIndex: number;
  resultIndex: number;
  locationIndex: number;
  logicalLocationIndex: number;
  targetName: string;
  targetKind?: string;
  message?: string;
  ruleId: string;
  toolName: string;
  toolVersion?: string;
  source?: VerifiedSource;
}

export interface VerifiedClaim {
  /** Exact result.message.text; no PASS-prefix or whitespace rewriting. */
  text?: string;
  contexts: string[];
  evidence: VerifiedEvidence[];
}

export interface VerifiedSubtarget {
  name: string;
  fullyQualifiedName: string;
  kind: string;
  claims: VerifiedClaim[];
}

export interface VerifiedApi {
  name: string;
  fullyQualifiedName: string;
  kind: "type" | "function";
  modulePath: string;
  contexts: string[];
  claims: VerifiedClaim[];
  subtargets: VerifiedSubtarget[];
}

export interface VerifiedType {
  name: string;
  fullyQualifiedName: string;
  modulePath: string;
  contexts: string[];
  claims: VerifiedClaim[];
  methods: VerifiedApi[];
  subtargets: VerifiedSubtarget[];
}

export interface VerifiedModule {
  /** "crate root" is used for the empty path; the crate name is omitted. */
  name: string;
  fullyQualifiedName: string;
  types: VerifiedType[];
  functions: VerifiedApi[];
}

export type VerificationContextKind = "configuration" | "test";

export interface VerificationContextTarget {
  name: string;
  fullyQualifiedName: string;
  kind: VerificationContextKind;
  claims: VerifiedClaim[];
}

export interface VerificationContext {
  name: string;
  kinds: VerificationContextKind[];
  targets: VerificationContextTarget[];
}

export interface OtherVerifiedTarget {
  name: string;
  fullyQualifiedName: string;
  kind?: string;
  claims: VerifiedClaim[];
}

export interface VerifiedTargetsModel {
  /** Sorted module list. Each module contains sorted types/functions. */
  typesAndApis: VerifiedModule[];
  verificationContexts: VerificationContext[];
  otherTargets: OtherVerifiedTarget[];
}

interface LogicalReference {
  name: string;
  fullyQualifiedName: string;
  kind?: string;
  normalizedKind?: string;
  parentIndex?: number;
  locationIndex: number;
  logicalLocationIndex: number;
}

interface IndexedRun {
  runIndex: number;
  run: SarifRun;
  contextName: string;
}

interface PreparedResult {
  indexedRun: IndexedRun;
  result: SarifResult;
  resultIndex: number;
}

interface ClaimAccumulator {
  text?: string;
  contexts: Set<string>;
  evidence: VerifiedEvidence[];
}

interface TargetAccumulator {
  name: string;
  fullyQualifiedName: string;
  kind?: string;
  claims: Map<string, ClaimAccumulator>;
}

interface ApiAccumulator extends TargetAccumulator {
  kind: "type" | "function";
  modulePath: string;
  parentTypeName?: string;
  subtargets: Map<string, TargetAccumulator>;
}

interface ContextAccumulator {
  name: string;
  kinds: Set<VerificationContextKind>;
  targets: Map<string, TargetAccumulator>;
}

const TARGET_NOT_SPECIFIED = "Target not specified";

// These are intentionally a small, explicit set. A new/unknown SARIF kind
// must remain visible under Other targets instead of silently becoming an API.
const INTERNAL_TARGET_KINDS = new Set([
  "basic-block",
  "basic_block",
  "block",
  "expression",
  "field",
  "instruction",
  "local",
  "loop",
  "member",
  "parameter",
  "region",
  "statement",
  "variable",
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedKind(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Splits Rust paths without treating `::` inside generic arguments as a path separator. */
function splitQualifiedName(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let angleDepth = 0;
  for (let index = 0; index < value.length - 1; index += 1) {
    const character = value[index];
    if (character === "<") angleDepth += 1;
    else if (character === ">" && angleDepth > 0) angleDepth -= 1;
    if (angleDepth === 0 && character === ":" && value[index + 1] === ":") {
      const part = value.slice(start, index).trim();
      if (part) parts.push(part);
      start = index + 2;
      index += 1;
    }
  }
  const last = value.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function leafName(value: string): string {
  return splitQualifiedName(value).at(-1) ?? value;
}

function isQualifiedPrefix(prefix: string, value: string): boolean {
  return value !== prefix && value.startsWith(`${prefix}::`);
}

function modulePathForName(value: string): string {
  const parts = splitQualifiedName(value);
  if (parts.length <= 2) return "";
  // Rust logical names normally begin with the crate name. Omitting that first
  // segment gives the docs.rs-like module headings requested by the design.
  return parts.slice(1, -1).join("::");
}

function modulePathForApi(value: string, parentTypeName?: string): string {
  return parentTypeName ? modulePathForName(parentTypeName) : modulePathForName(value);
}

function contextNameForRun(run: SarifRun, runIndex: number): string {
  const properties = asObject(run.properties);
  const configuration = nonEmptyText(properties?.configuration);
  if (configuration) return configuration;

  const automationDetails = asObject(run.automationDetails);
  const automationId = nonEmptyText(automationDetails?.id);
  if (automationId) {
    const segments = automationId.split(/[\\/]/).filter(Boolean);
    const terminal = segments.at(-1)?.trim();
    if (terminal) return terminal;
  }
  return `Run ${runIndex + 1}`;
}

function logicalReferencesForLocation(
  location: JsonObject,
  locationIndex: number,
): LogicalReference[] {
  const logicalLocations = location.logicalLocations;
  if (!Array.isArray(logicalLocations)) return [];

  return logicalLocations.flatMap((value, logicalLocationIndex) => {
    const logical = asObject(value);
    if (!logical) return [];
    const fullyQualifiedName = nonEmptyText(logical.fullyQualifiedName);
    const name = nonEmptyText(logical.name);
    const targetName = fullyQualifiedName ?? name ?? TARGET_NOT_SPECIFIED;
    const rawKind = nonEmptyText(logical.kind);
    const parentIndex =
      typeof logical.parentIndex === "number" &&
      Number.isInteger(logical.parentIndex) &&
      logical.parentIndex >= 0
        ? logical.parentIndex
        : undefined;
    return [
      {
        name: leafName(targetName),
        fullyQualifiedName: targetName,
        kind: rawKind,
        normalizedKind: normalizedKind(rawKind),
        parentIndex,
        locationIndex,
        logicalLocationIndex,
      },
    ];
  });
}

function locationsForResult(result: SarifResult): JsonObject[] {
  if (!Array.isArray(result.locations) || result.locations.length === 0) return [{}];
  const locations = result.locations.flatMap((value) => {
    const location = asObject(value);
    return location ? [location] : [];
  });
  return locations.length > 0 ? locations : [{}];
}

function referencesForResult(result: SarifResult): Array<{
  location: JsonObject;
  references: LogicalReference[];
  locationIndex: number;
}> {
  return locationsForResult(result).map((location, locationIndex) => {
    const references = logicalReferencesForLocation(location, locationIndex);
    return {
      location,
      references:
        references.length > 0
          ? references
          : [
              {
                name: TARGET_NOT_SPECIFIED,
                fullyQualifiedName: TARGET_NOT_SPECIFIED,
                locationIndex,
                logicalLocationIndex: 0,
              },
            ],
      locationIndex,
    };
  });
}

function resultValues(run: SarifRun): SarifResult[] {
  if (!Array.isArray(run.results)) return [];
  return run.results.flatMap((value) => {
    const result = asObject(value);
    return result ? [result as SarifResult] : [];
  });
}

function preparedRuns(runs: readonly SarifRun[]): {
  indexedRuns: IndexedRun[];
  results: PreparedResult[];
} {
  const indexedRuns = runs.map((run, runIndex) => ({
    runIndex,
    run,
    contextName: contextNameForRun(run, runIndex),
  }));
  const results: PreparedResult[] = [];
  for (const indexedRun of indexedRuns) {
    resultValues(indexedRun.run).forEach((result, resultIndex) => {
      results.push({ indexedRun, result, resultIndex });
    });
  }
  return { indexedRuns, results };
}

function apiKind(kind: string | undefined): "type" | "function" | undefined {
  if (kind === "type" || kind === "function") return kind;
  return undefined;
}

function isContextKind(kind: string | undefined): kind is VerificationContextKind {
  return kind === "configuration" || kind === "test";
}

function isInternalKind(kind: string | undefined): boolean {
  return kind !== undefined && INTERNAL_TARGET_KINDS.has(kind);
}

function collectNames(results: PreparedResult[]): {
  typeNames: Set<string>;
  apiNames: Set<string>;
} {
  const typeNames = new Set<string>();
  const apiNames = new Set<string>();
  for (const prepared of results) {
    for (const { references } of referencesForResult(prepared.result)) {
      for (const reference of references) {
        const kind = apiKind(reference.normalizedKind);
        if (!kind) continue;
        apiNames.add(reference.fullyQualifiedName);
        if (kind === "type") typeNames.add(reference.fullyQualifiedName);
      }
    }
  }
  return { typeNames, apiNames };
}

function parentReferenceByIndex(
  reference: LogicalReference,
  references: LogicalReference[],
): LogicalReference | undefined {
  if (reference.parentIndex === undefined) return undefined;
  return references[reference.parentIndex];
}

function explicitApiParent(
  reference: LogicalReference,
  references: LogicalReference[],
): LogicalReference | undefined {
  const visited = new Set<number>();
  let current: LogicalReference | undefined = reference;
  while (current?.parentIndex !== undefined && !visited.has(current.parentIndex)) {
    visited.add(current.parentIndex);
    current = parentReferenceByIndex(current, references);
    if (current && apiKind(current.normalizedKind)) return current;
  }
  return undefined;
}

function longestPrefix(
  value: string,
  candidates: Iterable<string>,
): string | undefined {
  let best: string | undefined;
  for (const candidate of candidates) {
    if (!isQualifiedPrefix(candidate, value)) continue;
    if (!best || splitQualifiedName(candidate).length > splitQualifiedName(best).length) {
      best = candidate;
    }
  }
  return best;
}

function nearestApiName(
  reference: LogicalReference,
  references: LogicalReference[],
  apiNames: Set<string>,
): string | undefined {
  const explicitParent = explicitApiParent(reference, references);
  if (explicitParent) return explicitParent.fullyQualifiedName;
  return longestPrefix(reference.fullyQualifiedName, apiNames);
}

function parentTypeNameForFunction(
  reference: LogicalReference,
  references: LogicalReference[],
  typeNames: Set<string>,
): string | undefined {
  const explicitParent = explicitApiParent(reference, references);
  if (explicitParent?.normalizedKind === "type") {
    return explicitParent.fullyQualifiedName;
  }
  return longestPrefix(reference.fullyQualifiedName, typeNames);
}

function inferredParentIndices(
  references: LogicalReference[],
  typeNames: Set<string>,
  apiNames: Set<string>,
): Set<number> {
  const parentIndices = new Set<number>();
  references.forEach((reference, index) => {
    if (
      reference.parentIndex !== undefined &&
      reference.parentIndex >= 0 &&
      reference.parentIndex < references.length &&
      reference.parentIndex !== index
    ) {
      parentIndices.add(reference.parentIndex);
    }

    const kind = reference.normalizedKind;
    if (kind === "function") {
      const parentType = parentTypeNameForFunction(reference, references, typeNames);
      if (parentType) {
        const parentIndex = references.findIndex(
          (candidate) =>
            candidate.fullyQualifiedName === parentType && candidate.normalizedKind === "type",
        );
        if (parentIndex >= 0) parentIndices.add(parentIndex);
      }
    } else if (isInternalKind(kind)) {
      const parentName = nearestApiName(reference, references, apiNames);
      if (parentName) {
        const parentIndex = references.findIndex(
          (candidate) =>
            candidate.fullyQualifiedName === parentName && apiKind(candidate.normalizedKind),
        );
        if (parentIndex >= 0) parentIndices.add(parentIndex);
      }
    }
  });
  return parentIndices;
}

function sourceForLocation(location: JsonObject): VerifiedSource | undefined {
  const physical = asObject(location.physicalLocation);
  const artifact = asObject(physical?.artifactLocation);
  const region = asObject(physical?.region);
  const uri = nonEmptyText(artifact?.uri);
  const sourceText = physicalLocationText(location);
  const source: VerifiedSource = {};
  if (sourceText) source.text = sourceText;
  if (uri) source.uri = uri;
  if (typeof region?.startLine === "number") source.startLine = region.startLine;
  if (typeof region?.startColumn === "number") source.startColumn = region.startColumn;
  if (typeof region?.endLine === "number") source.endLine = region.endLine;
  if (typeof region?.endColumn === "number") source.endColumn = region.endColumn;
  return Object.keys(source).length > 0 ? source : undefined;
}

function newTarget(
  reference: LogicalReference,
  kind?: string,
): TargetAccumulator {
  return {
    name: reference.name,
    fullyQualifiedName: reference.fullyQualifiedName,
    ...(kind ? { kind } : {}),
    claims: new Map(),
  };
}

function claimKey(text: string | undefined): string {
  return text === undefined ? "\u0000<missing>" : `\u0000${text}`;
}

function addClaim(
  target: TargetAccumulator,
  text: string | undefined,
  contextName: string,
  evidence: VerifiedEvidence,
): void {
  const key = claimKey(text);
  let claim = target.claims.get(key);
  if (!claim) {
    claim = { text, contexts: new Set(), evidence: [] };
    target.claims.set(key, claim);
  }
  claim.contexts.add(contextName);
  claim.evidence.push(evidence);
}

function finalizeClaims(claims: Map<string, ClaimAccumulator>): VerifiedClaim[] {
  return [...claims.values()]
    .map((claim) => ({
      text: claim.text,
      contexts: [...claim.contexts].sort(compareText),
      evidence: claim.evidence.slice().sort((left, right) => {
        const leftOrder = [
          left.runIndex,
          left.resultIndex,
          left.locationIndex,
          left.logicalLocationIndex,
        ];
        const rightOrder = [
          right.runIndex,
          right.resultIndex,
          right.locationIndex,
          right.logicalLocationIndex,
        ];
        for (let index = 0; index < leftOrder.length; index += 1) {
          if (leftOrder[index] !== rightOrder[index]) {
            return leftOrder[index]! - rightOrder[index]!;
          }
        }
        return compareText(left.ruleId, right.ruleId);
      }),
    }))
    .sort((left, right) => compareText(left.text ?? "", right.text ?? ""));
}

function targetKey(target: TargetAccumulator): string {
  return `${target.kind ?? ""}\u0000${target.fullyQualifiedName}`;
}

function addToTargetMap(
  map: Map<string, TargetAccumulator>,
  reference: LogicalReference,
  kind?: string,
): TargetAccumulator {
  const candidate = newTarget(reference, kind);
  const key = targetKey(candidate);
  const existing = map.get(key);
  if (existing) return existing;
  map.set(key, candidate);
  return candidate;
}

function evidenceFor(
  prepared: PreparedResult,
  reference: LogicalReference,
  location: JsonObject,
): VerifiedEvidence {
  const ruleId = typeof prepared.result.ruleId === "string" ? prepared.result.ruleId : "";
  const toolVersion = getToolVersion(prepared.indexedRun.run);
  const message = getResultMessage(prepared.result);
  const source = sourceForLocation(location);
  return {
    runIndex: prepared.indexedRun.runIndex,
    resultIndex: prepared.resultIndex,
    locationIndex: reference.locationIndex,
    logicalLocationIndex: reference.logicalLocationIndex,
    targetName: reference.fullyQualifiedName,
    ...(reference.kind ? { targetKind: reference.kind } : {}),
    ...(message !== undefined ? { message } : {}),
    ruleId,
    toolName: getToolName(prepared.indexedRun.run),
    ...(toolVersion ? { toolVersion } : {}),
    ...(source ? { source } : {}),
  };
}

function finalizeSubtargets(subtargets: Map<string, TargetAccumulator>): VerifiedSubtarget[] {
  return [...subtargets.values()]
    .map((subtarget) => ({
      name: subtarget.name,
      fullyQualifiedName: subtarget.fullyQualifiedName,
      // Internal targets always have an explicit kind by construction.
      kind: subtarget.kind ?? "other",
      claims: finalizeClaims(subtarget.claims),
    }))
    .sort((left, right) => {
      const byName = compareText(left.name, right.name);
      return byName || compareText(left.fullyQualifiedName, right.fullyQualifiedName);
    });
}

function apiContexts(api: ApiAccumulator): string[] {
  const contexts = new Set<string>();
  for (const claim of api.claims.values()) {
    for (const context of claim.contexts) contexts.add(context);
  }
  return [...contexts].sort(compareText);
}

function finalizeApi(api: ApiAccumulator): VerifiedApi {
  return {
    name: api.name,
    fullyQualifiedName: api.fullyQualifiedName,
    kind: api.kind,
    modulePath: api.modulePath,
    contexts: apiContexts(api),
    claims: finalizeClaims(api.claims),
    subtargets: finalizeSubtargets(api.subtargets),
  };
}

function finalizeType(type: ApiAccumulator, methods: ApiAccumulator[]): VerifiedType {
  return {
    name: type.name,
    fullyQualifiedName: type.fullyQualifiedName,
    modulePath: type.modulePath,
    contexts: apiContexts(type),
    claims: finalizeClaims(type.claims),
    methods: methods
      .slice()
      .sort((left, right) => compareText(left.name, right.name) || compareText(left.fullyQualifiedName, right.fullyQualifiedName))
      .map(finalizeApi),
    subtargets: finalizeSubtargets(type.subtargets),
  };
}

function finalizeContext(context: ContextAccumulator): VerificationContext {
  return {
    name: context.name,
    kinds: [...context.kinds].sort(compareText),
    targets: [...context.targets.values()]
      .sort((left, right) => compareText(left.name, right.name) || compareText(left.fullyQualifiedName, right.fullyQualifiedName))
      .map((target) => ({
        name: target.name,
        fullyQualifiedName: target.fullyQualifiedName,
        kind: target.kind as VerificationContextKind,
        claims: finalizeClaims(target.claims),
      })),
  };
}

function finalizeOther(targets: Map<string, TargetAccumulator>): OtherVerifiedTarget[] {
  return [...targets.values()]
    .sort((left, right) => compareText(left.name, right.name) || compareText(left.fullyQualifiedName, right.fullyQualifiedName))
    .map((target) => ({
      name: target.name,
      fullyQualifiedName: target.fullyQualifiedName,
      ...(target.kind ? { kind: target.kind } : {}),
      claims: finalizeClaims(target.claims),
    }));
}

/**
 * Builds the deterministic detail-page model from SARIF runs.
 *
 * API identity is `kind + fullyQualifiedName`; claims merge only when their
 * result.message.text values are exactly equal. Every source occurrence is
 * retained as evidence, including its run, rule, tool and source location.
 */
export function buildVerifiedTargets(runs: readonly SarifRun[]): VerifiedTargetsModel {
  return buildVerifiedTargetsFromIndexed(
    runs.map((run, runIndex) => ({ runIndex, run })),
  );
}

function buildVerifiedTargetsFromIndexed(
  indexedInput: readonly { runIndex: number; run: SarifRun }[],
): VerifiedTargetsModel {
  const inputRuns = indexedInput.map(({ run }) => run);
  const prepared = preparedRuns(inputRuns);
  prepared.indexedRuns.forEach((indexedRun, index) => {
    const suppliedIndex = indexedInput[index]?.runIndex;
    if (suppliedIndex !== undefined) indexedRun.runIndex = suppliedIndex;
    indexedRun.contextName = contextNameForRun(indexedRun.run, indexedRun.runIndex);
  });
  const { results } = prepared;
  const { typeNames, apiNames } = collectNames(results);
  const apiMap = new Map<string, ApiAccumulator>();
  const typeMap = new Map<string, ApiAccumulator>();
  const contextMap = new Map<string, ContextAccumulator>();
  const otherMap = new Map<string, TargetAccumulator>();

  // A run is itself a verification context even when its SARIF results do not
  // contain an explicit configuration/test logical location. Keeping an empty
  // context makes the run-level condition visible and gives API claims a
  // stable context name in the detail page.
  for (const indexedRun of prepared.indexedRuns) {
    contextMap.set(indexedRun.contextName, {
      name: indexedRun.contextName,
      kinds: new Set(),
      targets: new Map(),
    });
  }

  const getApi = (
    reference: LogicalReference,
    kind: "type" | "function",
    parentTypeName?: string,
  ): ApiAccumulator => {
    const candidate: ApiAccumulator = {
      ...newTarget(reference, kind),
      kind,
      modulePath: modulePathForApi(reference.fullyQualifiedName, parentTypeName),
      ...(parentTypeName ? { parentTypeName } : {}),
      subtargets: new Map(),
    };
    const key = `${kind}\u0000${reference.fullyQualifiedName}`;
    const existing = apiMap.get(key);
    if (existing) {
      // Prefer a discovered parent type if one was not known earlier. This is
      // useful when a result lists a method before its type in the SARIF file.
      if (!existing.parentTypeName && parentTypeName) {
        existing.parentTypeName = parentTypeName;
        existing.modulePath = modulePathForApi(existing.fullyQualifiedName, parentTypeName);
      }
      return existing;
    }
    apiMap.set(key, candidate);
    if (kind === "type") typeMap.set(reference.fullyQualifiedName, candidate);
    return candidate;
  };

  // Materialize all API containers before attaching claims. This is important
  // for a loop result that appears before its parent function in SARIF, and
  // makes fullyQualifiedName fallback independent of result order.
  for (const prepared of results) {
    for (const { references } of referencesForResult(prepared.result)) {
      for (const reference of references) {
        const kind = apiKind(reference.normalizedKind);
        if (!kind) continue;
        const parentTypeName =
          kind === "function"
            ? parentTypeNameForFunction(reference, references, typeNames)
            : undefined;
        getApi(reference, kind, parentTypeName);
      }
    }
  }

  const addEvidenceToOther = (
    reference: LogicalReference,
    prepared: PreparedResult,
    location: JsonObject,
  ): void => {
    const other = addToTargetMap(otherMap, reference, reference.kind);
    addClaim(
      other,
      getResultMessage(prepared.result),
      prepared.indexedRun.contextName,
      evidenceFor(prepared, reference, location),
    );
  };

  for (const prepared of results) {
    const message = getResultMessage(prepared.result);

    for (const { location, references } of referencesForResult(prepared.result)) {
      const parentIndices = inferredParentIndices(references, typeNames, apiNames);
      const leaves = references.filter((_, index) => !parentIndices.has(index));

      for (const reference of leaves) {
        const kind = reference.normalizedKind;
        const evidence = evidenceFor(prepared, reference, location);
        const parentTypeName =
          kind === "function"
            ? parentTypeNameForFunction(reference, references, typeNames)
            : undefined;
        const api = apiKind(kind);
        if (api) {
          const target = getApi(reference, api, parentTypeName);
          addClaim(target, message, prepared.indexedRun.contextName, evidence);
          continue;
        }

        if (isContextKind(kind)) {
          let context = contextMap.get(prepared.indexedRun.contextName);
          if (!context) {
            context = {
              name: prepared.indexedRun.contextName,
              kinds: new Set(),
              targets: new Map(),
            };
            contextMap.set(context.name, context);
          }
          context.kinds.add(kind);
          const target = addToTargetMap(context.targets, reference, kind);
          addClaim(target, message, prepared.indexedRun.contextName, evidence);
          continue;
        }

        if (isInternalKind(kind)) {
          const nearest = nearestApiName(reference, references, apiNames);
          const nearestApi = nearest
            ? [...apiMap.values()].find(
                (candidate) => candidate.fullyQualifiedName === nearest,
              )
            : undefined;
          if (nearestApi) {
            const subtarget = addToTargetMap(nearestApi.subtargets, reference, reference.kind);
            addClaim(subtarget, message, prepared.indexedRun.contextName, evidence);
            continue;
          }
        }

        // Unknown and missing kinds deliberately end up here. Do not infer an
        // API solely from the shape of its name.
        addEvidenceToOther(reference, prepared, location);
      }
    }
  }

  const modules = new Map<
    string,
    { name: string; fullyQualifiedName: string; types: Map<string, ApiAccumulator>; functions: ApiAccumulator[] }
  >();
  const moduleFor = (path: string) => {
    let module = modules.get(path);
    if (!module) {
      module = {
        name: path || "crate root",
        fullyQualifiedName: path,
        types: new Map(),
        functions: [],
      };
      modules.set(path, module);
    }
    return module;
  };

  for (const api of apiMap.values()) {
    const module = moduleFor(api.modulePath);
    if (api.kind === "type") module.types.set(api.fullyQualifiedName, api);
    else if (!api.parentTypeName) module.functions.push(api);
  }

  // A function can be observed before its type. Attach it after all API
  // accumulators have been collected, so the hierarchy is order-independent.
  for (const api of apiMap.values()) {
    if (api.kind !== "function" || !api.parentTypeName) continue;
    const type = typeMap.get(api.parentTypeName);
    if (type) {
      const module = moduleFor(type.modulePath);
      module.types.set(type.fullyQualifiedName, type);
    } else {
      // Inconsistent SARIF may mention a parent type without a type result.
      // Keep the method discoverable by creating an empty structural type.
      const typeReference: LogicalReference = {
        name: leafName(api.parentTypeName),
        fullyQualifiedName: api.parentTypeName,
        kind: "type",
        normalizedKind: "type",
        locationIndex: api.modulePath ? 1 : 0,
        logicalLocationIndex: 0,
      };
      const syntheticType = getApi(typeReference, "type");
      typeMap.set(syntheticType.fullyQualifiedName, syntheticType);
      const module = moduleFor(syntheticType.modulePath);
      module.types.set(syntheticType.fullyQualifiedName, syntheticType);
    }
  }

  for (const api of apiMap.values()) {
    if (api.kind !== "function" || !api.parentTypeName) continue;
    const type = typeMap.get(api.parentTypeName);
    if (type) {
      const module = moduleFor(type.modulePath);
      module.types.set(type.fullyQualifiedName, type);
    }
  }

  const typesAndApis: VerifiedModule[] = [...modules.values()]
    .sort((left, right) => compareText(left.name, right.name) || compareText(left.fullyQualifiedName, right.fullyQualifiedName))
    .map((module) => ({
      name: module.name,
      fullyQualifiedName: module.fullyQualifiedName,
      types: [...module.types.values()]
        .sort((left, right) => compareText(left.name, right.name) || compareText(left.fullyQualifiedName, right.fullyQualifiedName))
        .map((type) =>
          finalizeType(
            type,
            [...apiMap.values()].filter(
              (candidate) => candidate.kind === "function" && candidate.parentTypeName === type.fullyQualifiedName,
            ),
          ),
        ),
      functions: module.functions
        .slice()
        .sort((left, right) => compareText(left.name, right.name) || compareText(left.fullyQualifiedName, right.fullyQualifiedName))
        .map(finalizeApi),
    }));

  return {
    typesAndApis,
    verificationContexts: [...contextMap.values()]
      .sort((left, right) => compareText(left.name, right.name))
      .map(finalizeContext),
    otherTargets: finalizeOther(otherMap),
  };
}

/** Builds the detail model while retaining the stored run_index as evidence. */
export function verifiedTargetsForPublication(
  publication: PublicationWithRuns,
): VerifiedTargetsModel {
  const indexed = publication.runs
    .slice()
    .sort((left, right) => left.run_index - right.run_index)
    .map((storedRun) => ({
      runIndex: storedRun.run_index,
      run: parseStoredRun(storedRun.run_json),
    }));

  return buildVerifiedTargetsFromIndexed(indexed);
}

export const buildVerifiedTargetsModel = buildVerifiedTargets;
