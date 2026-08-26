import { describe, expect, it } from "vitest";

import {
  extractRuleIds,
  getOccurrences,
  getRuleDetails,
  getTargets,
  parseSarif,
  splitSarifRuns,
} from "../app/lib/sarif";

const root = {
  version: "2.1.0",
  runs: [
    {
      tool: {
        driver: {
          name: "kani",
          version: "0.66.0",
          rules: [{ id: "no_duplicate_permits", shortDescription: { text: "No duplicate permits" } }],
        },
      },
      results: [
        {
          ruleId: "no_duplicate_permits",
          locations: [
            { logicalLocations: [{ fullyQualifiedName: "tokio::sync::Semaphore::acquire" }] },
            { logicalLocations: [{ name: "tokio::sync::Semaphore::try_acquire" }] },
          ],
        },
        { ruleId: "no_duplicate_permits" },
      ],
    },
  ],
} as const;

describe("SARIF helpers", () => {
  it("validates 2.1.0 and keeps rule IDs in occurrence order", () => {
    const parsed = parseSarif(JSON.stringify(root));
    expect(extractRuleIds(parsed)).toEqual(["no_duplicate_permits", "no_duplicate_permits"]);
    expect(splitSarifRuns(parsed)).toHaveLength(1);
  });

  it("uses fully qualified names before names and preserves multi-location occurrences", () => {
    const parsed = parseSarif(JSON.stringify(root));
    const result = parsed.runs[0]?.results?.[0];
    expect(result).toBeDefined();
    expect(getTargets(result!)).toEqual([
      { name: "tokio::sync::Semaphore::acquire", source: "logicalLocation" },
      { name: "tokio::sync::Semaphore::try_acquire", source: "logicalLocation" },
    ]);
    expect(getOccurrences(parsed)).toHaveLength(3);
  });

  it("groups a result without logical locations under an explicit target", () => {
    const parsed = parseSarif(JSON.stringify(root));
    const result = parsed.runs[0]?.results?.[1];
    expect(getTargets(result!)).toEqual([{ name: "Target not specified", source: "unspecified" }]);
  });

  it("rejects malformed version, missing rule IDs, and external properties", () => {
    expect(() => parseSarif(JSON.stringify({ ...root, version: "2.0.0" }))).toThrow("2.1.0");
    expect(() =>
      parseSarif(JSON.stringify({ ...root, runs: [{ ...root.runs[0], results: [{ message: "missing" }] }] })),
    ).toThrow("ruleId");
    expect(() => parseSarif(JSON.stringify({ ...root, externalPropertyFileReferences: [] }))).toThrow(
      "external properties",
    );
  });

  it("resolves hierarchical rule IDs through ruleIndex and keeps duplicate descriptors addressable", () => {
    const duplicateRoot = {
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "kani",
              rules: [
                { id: "no_duplicate_permits", shortDescription: { text: "First" } },
                { id: "no_duplicate_permits", shortDescription: { text: "Second" } },
              ],
            },
          },
          results: [{ ruleId: "no_duplicate_permits/variant", ruleIndex: 1 }],
        },
      ],
    };
    const parsed = parseSarif(JSON.stringify(duplicateRoot));
    expect(
      getRuleDetails(parsed.runs[0]!, "no_duplicate_permits/variant", parsed.runs[0]!.results![0]).shortDescription,
    ).toBe("Second");
    expect(getOccurrences(parsed)[0]!.rule.shortDescription).toBe("Second");
    expect(() =>
      parseSarif(
        JSON.stringify({
          ...duplicateRoot,
          runs: [{ ...duplicateRoot.runs[0], results: [{ ruleId: "no_duplicate_permits/variant" }] }],
        }),
      ),
    ).toThrow("multiple descriptors");
  });

  it("rejects contradictory result.rule references and unsupported extensions", () => {
    expect(() =>
      parseSarif(
        JSON.stringify({
          ...root,
          runs: [
            {
              ...root.runs[0],
              results: [{ ruleId: "no_duplicate_permits", rule: { id: "different_rule" } }],
            },
          ],
        }),
      ),
    ).toThrow("contradict");
    expect(() =>
      parseSarif(
        JSON.stringify({
          ...root,
          runs: [
            {
              ...root.runs[0],
              results: [{ ruleId: "no_duplicate_permits", ruleIndex: 0, rule: { index: 1 } }],
            },
          ],
        }),
      ),
    ).toThrow("contradict");
    expect(() =>
      parseSarif(
        JSON.stringify({
          ...root,
          runs: [
            {
              ...root.runs[0],
              results: [{ ruleId: "no_duplicate_permits", rule: { toolComponent: { name: "extension" } } }],
            },
          ],
        }),
      ),
    ).toThrow("toolComponent");
    expect(() =>
      parseSarif(
        JSON.stringify({
          ...root,
          runs: [{ ...root.runs[0], tool: { ...root.runs[0].tool, extensions: [{ rules: [] }] } }],
        }),
      ),
    ).toThrow("tool.extensions");
  });
});
