export const MAX_SARIF_BYTES = 1_000_000;
export const SARIF_VERSION = "2.1.0";

export type JsonObject = Record<string, unknown>;

export interface SarifRoot extends JsonObject {
  version: string;
  runs: SarifRun[];
}

export interface SarifRun extends JsonObject {
  tool: JsonObject;
  results?: SarifResult[];
}

export interface SarifResult extends JsonObject {
  ruleId: string;
  ruleIndex?: number;
  rule?: JsonObject;
  locations?: SarifLocation[];
  message?: JsonObject | string;
}

export interface SarifLocation extends JsonObject {
  logicalLocations?: JsonObject[];
  physicalLocation?: JsonObject;
}

export interface SarifRuleDescriptor extends JsonObject {
  id: string;
  shortDescription?: JsonObject;
  fullDescription?: JsonObject;
  helpUri?: string;
}

export interface SarifTarget {
  name: string;
  kind?: string;
  source: "logicalLocation" | "unspecified";
}

export interface SarifRuleDetails {
  id: string;
  shortDescription?: string;
  fullDescription?: string;
  helpUri?: string;
}

export interface SarifOccurrence {
  runIndex: number;
  resultIndex: number;
  ruleId: string;
  targets: SarifTarget[];
  message?: string;
  locations: JsonObject[];
  rule: SarifRuleDetails;
  toolName: string;
  toolVersion?: string;
}

export class SarifValidationError extends Error {
  constructor(message: string, readonly path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "SarifValidationError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasExternalProperties(value: JsonObject): boolean {
  return (
    "externalPropertyFileReferences" in value ||
    "externalProperties" in value ||
    "externalPropertiesFileReferences" in value
  );
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isObject(value) && typeof value.text === "string") return value.text;
  return undefined;
}

function descriptorFrom(value: unknown): SarifRuleDescriptor | undefined {
  if (!isObject(value) || !nonEmptyString(value.id)) return undefined;
  return value as SarifRuleDescriptor;
}

function driverFromRun(run: SarifRun): JsonObject {
  if (!isObject(run.tool)) {
    throw new SarifValidationError("tool is required", "tool");
  }
  const tool = run.tool;
  const driver = tool.driver;
  if (!isObject(driver) || !nonEmptyString(driver.name)) {
    throw new SarifValidationError("tool.driver.name is required", "tool.driver.name");
  }
  return driver;
}

function descriptorsFromRun(run: SarifRun): SarifRuleDescriptor[] {
  if (!isObject(run.tool)) {
    throw new SarifValidationError("tool is required", "tool");
  }
  if ("extensions" in run.tool && run.tool.extensions !== undefined) {
    if (!Array.isArray(run.tool.extensions) || run.tool.extensions.length > 0) {
      throw new SarifValidationError("tool.extensions are not supported", "tool.extensions");
    }
  }
  const driver = driverFromRun(run);
  if ("extensions" in driver && driver.extensions !== undefined) {
    throw new SarifValidationError("tool.driver.extensions are not supported", "tool.driver.extensions");
  }
  const descriptors: SarifRuleDescriptor[] = [];
  const driverRules = driver.rules;
  if (driverRules !== undefined) {
    if (!Array.isArray(driverRules)) {
      throw new SarifValidationError("tool.driver.rules must be an array", "tool.driver.rules");
    }
    for (const [index, descriptor] of driverRules.entries()) {
      const item = descriptorFrom(descriptor);
      if (!item) {
        throw new SarifValidationError("each rule descriptor needs a non-empty id", `tool.driver.rules[${index}]`);
      }
      descriptors.push(item);
    }
  }

  return descriptors;
}

function ruleIdMatchesDescriptor(ruleId: string, descriptorId: string): boolean {
  return ruleId === descriptorId || ruleId.startsWith(`${descriptorId}/`);
}

interface ResultRuleReference {
  id?: string;
  index?: number;
}

function readResultRuleReference(result: JsonObject, path: string): ResultRuleReference {
  if (result.rule === undefined) return {};
  if (!isObject(result.rule)) {
    throw new SarifValidationError("result.rule must be an object", `${path}.rule`);
  }
  if ("toolComponent" in result.rule) {
    throw new SarifValidationError(
      "result.rule.toolComponent references are not supported",
      `${path}.rule.toolComponent`,
    );
  }
  let id: string | undefined;
  let index: number | undefined;
  if (result.rule.id !== undefined) {
    if (!nonEmptyString(result.rule.id)) {
      throw new SarifValidationError("result.rule.id must be a non-empty string", `${path}.rule.id`);
    }
    id = result.rule.id;
  }
  if (result.rule.index !== undefined) {
    const rawIndex = result.rule.index;
    if (typeof rawIndex !== "number" || !Number.isInteger(rawIndex) || rawIndex < 0) {
      throw new SarifValidationError("result.rule.index must be a non-negative integer", `${path}.rule.index`);
    }
    index = rawIndex;
  }
  return { id, index };
}

interface ResolvedRule {
  descriptor?: SarifRuleDescriptor;
  index?: number;
}

function resolveRuleReference(run: SarifRun, result: JsonObject, path = "result"): ResolvedRule {
  if (!nonEmptyString(result.ruleId)) {
    throw new SarifValidationError("result.ruleId is required", `${path}.ruleId`);
  }
  const descriptors = descriptorsFromRun(run);
  const resultRuleIndex = result.ruleIndex;
  if (
    resultRuleIndex !== undefined &&
    (typeof resultRuleIndex !== "number" || !Number.isInteger(resultRuleIndex) || resultRuleIndex < 0)
  ) {
    throw new SarifValidationError("result.ruleIndex must be a non-negative integer", `${path}.ruleIndex`);
  }
  const resultRule = readResultRuleReference(result, path);
  if (
    resultRuleIndex !== undefined &&
    resultRule.index !== undefined &&
    resultRuleIndex !== resultRule.index
  ) {
    throw new SarifValidationError("result.rule.index contradicts result.ruleIndex", path);
  }
  if (resultRule.id !== undefined && !ruleIdMatchesDescriptor(result.ruleId as string, resultRule.id)) {
    throw new SarifValidationError("result.rule.id contradicts result.ruleId", path);
  }

  const index = resultRuleIndex ?? resultRule.index;
  if (index !== undefined) {
    const descriptor = descriptors[index];
    if (!descriptor) {
      throw new SarifValidationError("rule index does not resolve to a driver descriptor", `${path}.ruleIndex`);
    }
    if (!ruleIdMatchesDescriptor(result.ruleId as string, descriptor.id)) {
      throw new SarifValidationError("result.ruleId contradicts the indexed descriptor", path);
    }
    if (
      resultRule.id !== undefined &&
      resultRule.id !== descriptor.id &&
      resultRule.id !== result.ruleId
    ) {
      throw new SarifValidationError("result.rule.id contradicts the indexed descriptor", path);
    }
    return { descriptor, index };
  }

  let candidates = descriptors
    .map((descriptor, descriptorIndex) => ({ descriptor, index: descriptorIndex }))
    .filter(({ descriptor }) => ruleIdMatchesDescriptor(result.ruleId as string, descriptor.id));
  if (resultRule.id !== undefined) {
    candidates = candidates.filter(
      ({ descriptor }) => descriptor.id === resultRule.id || resultRule.id === result.ruleId,
    );
  }
  if (candidates.length > 1) {
    throw new SarifValidationError("ruleId resolves to multiple descriptors; provide ruleIndex", path);
  }
  if (candidates.length === 0) {
    // A tool may omit driver.rules. In that case the explicit ruleId remains
    // usable, but a present descriptor list must resolve every result.
    if (descriptors.length > 0) {
      throw new SarifValidationError("result.ruleId does not resolve to a driver descriptor", path);
    }
    return {};
  }
  return candidates[0]!;
}

function validateRun(run: unknown, runIndex: number): SarifRun {
  if (!isObject(run)) throw new SarifValidationError("run must be an object", `runs[${runIndex}]`);
  if (hasExternalProperties(run)) {
    throw new SarifValidationError("external properties are not supported", `runs[${runIndex}]`);
  }
  const typedRun = run as SarifRun;
  driverFromRun(typedRun);
  descriptorsFromRun(typedRun);
  if (typedRun.results !== undefined && !Array.isArray(typedRun.results)) {
    throw new SarifValidationError("results must be an array", `runs[${runIndex}].results`);
  }

  const results = typedRun.results ?? [];
  for (const [resultIndex, result] of results.entries()) {
    if (!isObject(result)) {
      throw new SarifValidationError("result must be an object", `runs[${runIndex}].results[${resultIndex}]`);
    }
    if (!nonEmptyString(result.ruleId)) {
      throw new SarifValidationError(
        "result.ruleId is required",
        `runs[${runIndex}].results[${resultIndex}].ruleId`,
      );
    }
    resolveRuleReference(typedRun, result, `runs[${runIndex}].results[${resultIndex}]`);
  }
  return typedRun;
}

export function parseSarif(value: string): SarifRoot {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > MAX_SARIF_BYTES) {
    throw new SarifValidationError(`SARIF must be at most ${MAX_SARIF_BYTES} UTF-8 bytes.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SarifValidationError("SARIF must be valid JSON.");
  }
  if (!isObject(parsed)) throw new SarifValidationError("SARIF root must be an object.");
  if (hasExternalProperties(parsed)) {
    throw new SarifValidationError("external properties are not supported.");
  }
  if (parsed.version !== SARIF_VERSION) {
    throw new SarifValidationError(`SARIF version must be ${SARIF_VERSION}.`, "version");
  }
  if (!Array.isArray(parsed.runs) || parsed.runs.length === 0) {
    throw new SarifValidationError("SARIF must contain at least one run.", "runs");
  }

  const runs = parsed.runs.map((run, index) => validateRun(run, index));
  const resultCount = runs.reduce((count, run) => count + (run.results?.length ?? 0), 0);
  if (resultCount < 1) throw new SarifValidationError("SARIF must contain at least one result.", "runs");
  return { ...parsed, version: SARIF_VERSION, runs } as SarifRoot;
}

export function splitSarifRuns(root: SarifRoot): string[] {
  return root.runs.map((run) => JSON.stringify(run));
}

export function extractRuleIds(root: SarifRoot): string[] {
  const ids: string[] = [];
  for (const run of root.runs) {
    for (const result of run.results ?? []) {
      if (typeof result.ruleId === "string") ids.push(result.ruleId);
    }
  }
  return ids;
}

export function getToolName(run: SarifRun): string {
  const driver = isObject(run.tool) && isObject(run.tool.driver) ? run.tool.driver : undefined;
  return typeof driver?.name === "string" ? driver.name : "Unknown tool";
}

export function getToolVersion(run: SarifRun): string | undefined {
  const driver = isObject(run.tool) && isObject(run.tool.driver) ? run.tool.driver : undefined;
  return typeof driver?.version === "string" && driver.version.length > 0 ? driver.version : undefined;
}

export function getRuleDetails(run: SarifRun, ruleId: string, result?: SarifResult): SarifRuleDetails {
  const resolved = resolveRuleReference(run, result ?? { ruleId });
  const descriptor = resolved.descriptor;
  return {
    id: ruleId,
    shortDescription: descriptor ? textValue(descriptor.shortDescription) : undefined,
    fullDescription: descriptor ? textValue(descriptor.fullDescription) : undefined,
    helpUri: descriptor && typeof descriptor.helpUri === "string" ? descriptor.helpUri : undefined,
  };
}

export function getTargets(result: SarifResult): SarifTarget[] {
  const targets: SarifTarget[] = [];
  if (Array.isArray(result.locations)) {
    for (const location of result.locations) {
      if (!isObject(location) || !Array.isArray(location.logicalLocations)) continue;
      for (const logicalLocation of location.logicalLocations) {
        if (!isObject(logicalLocation)) continue;
        const name =
          (typeof logicalLocation.fullyQualifiedName === "string" && logicalLocation.fullyQualifiedName) ||
          (typeof logicalLocation.name === "string" && logicalLocation.name);
        if (name) {
          targets.push({
            name,
            kind: typeof logicalLocation.kind === "string" ? logicalLocation.kind : undefined,
            source: "logicalLocation",
          });
        }
      }
    }
  }
  return targets.length > 0 ? targets : [{ name: "Target not specified", source: "unspecified" }];
}

export function getResultMessage(result: SarifResult): string | undefined {
  return textValue(result.message);
}

export function getOccurrences(root: SarifRoot): SarifOccurrence[] {
  const occurrences: SarifOccurrence[] = [];
  root.runs.forEach((run, runIndex) => {
    (run.results ?? []).forEach((result, resultIndex) => {
      const ruleId = result.ruleId;
      for (const target of getTargets(result)) {
        occurrences.push({
          runIndex,
          resultIndex,
          ruleId,
          targets: [target],
          message: getResultMessage(result),
          locations: Array.isArray(result.locations) ? result.locations : [],
          rule: getRuleDetails(run, ruleId, result),
          toolName: getToolName(run),
          toolVersion: getToolVersion(run),
        });
      }
    });
  });
  return occurrences;
}
