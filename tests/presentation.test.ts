import { describe, expect, it } from "vitest";

import {
  buildVerifiedTargets,
  type VerifiedTargetsModel,
} from "../app/lib/presentation";
import type { SarifRun } from "../app/lib/sarif";

function run(
  results: unknown[],
  options: {
    configuration?: string;
    automationId?: string;
    tool?: string;
    version?: string;
  } = {},
): SarifRun {
  return {
    ...(options.configuration || options.automationId
      ? {
          ...(options.configuration ? { properties: { configuration: options.configuration } } : {}),
          ...(options.automationId ? { automationDetails: { id: options.automationId } } : {}),
        }
      : {}),
    tool: {
      driver: {
        name: options.tool ?? "kani",
        ...(options.version ? { version: options.version } : {}),
      },
    },
    results,
  } as SarifRun;
}

function result(
  ruleId: string,
  message: string,
  logicalLocations: unknown[],
  line: number,
): Record<string, unknown> {
  return {
    ruleId,
    message: { text: message },
    locations: [
      {
        logicalLocations,
        physicalLocation: {
          artifactLocation: { uri: "src/lib.rs" },
          region: { startLine: line, startColumn: 3, endLine: line + 1 },
        },
      },
    ],
  };
}

function modelWithTwoRuns(): VerifiedTargetsModel {
  return buildVerifiedTargets([
    run(
      [
        // This comes before the API result to prove parent lookup is not
        // dependent on SARIF result order.
        result(
          "loop_rule",
          "loop claim",
          [{ fullyQualifiedName: "demo::alpha::Widget::write::loop", kind: "loop" }],
          40,
        ),
        result(
          "type_rule",
          "type claim",
          [{ fullyQualifiedName: "demo::alpha::Widget", kind: "type" }],
          10,
        ),
        result(
          "write_rule",
          "write claim",
          [{ fullyQualifiedName: "demo::alpha::Widget::write", kind: "function" }],
          20,
        ),
        result(
          "free_rule",
          "free claim",
          [{ fullyQualifiedName: "demo::alpha::free_fn", kind: "function" }],
          30,
        ),
        result(
          "config_rule",
          "configuration claim",
          [{ fullyQualifiedName: "demo::verification::no-default-features", kind: "configuration" }],
          50,
        ),
        result(
          "test_rule",
          "test claim",
          [{ fullyQualifiedName: "demo::tests::basic", kind: "test" }],
          60,
        ),
        result(
          "unknown_rule",
          "unknown claim",
          [{ fullyQualifiedName: "demo::alpha::mystery", kind: "mystery" }],
          70,
        ),
        result("missing_kind_rule", "missing kind claim", [{ name: "missing_kind" }], 80),
        result("no_target_rule", "no target claim", [], 90),
      ],
      {
        configuration: "z-feature",
        automationId: "demo/no-default-features",
        tool: "kani",
        version: "0.66.0",
      },
    ),
    run(
      [
        result(
          "write_rule",
          "write claim",
          [{ fullyQualifiedName: "demo::alpha::Widget::write", kind: "function" }],
          21,
        ),
        result(
          "write_other_rule",
          "another write claim",
          [{ fullyQualifiedName: "demo::alpha::Widget::write", kind: "function" }],
          22,
        ),
        result(
          "loop_rule",
          "loop claim",
          [{ fullyQualifiedName: "demo::alpha::Widget::write::loop", kind: "loop" }],
          41,
        ),
      ],
      {
        automationId: "demo/all-features",
        tool: "creusot",
        version: "0.11.0-dev",
      },
    ),
  ]);
}

describe("verified SARIF presentation model", () => {
  it("builds a sorted module/type/method index and nests loop subtargets", () => {
    const model = modelWithTwoRuns();
    expect(model.typesAndApis.map((module) => module.name)).toEqual([
      "alpha",
    ]);

    const alpha = model.typesAndApis[0]!;
    expect(alpha.types.map((type) => type.name)).toEqual(["Widget"]);
    expect(alpha.functions.map((fn) => fn.name)).toEqual(["free_fn"]);

    const widget = alpha.types[0]!;
    expect(widget.methods.map((method) => method.name)).toEqual(["write"]);
    expect(widget.methods[0]!.claims.map((claim) => claim.text)).toEqual([
      "another write claim",
      "write claim",
    ]);
    const mergedWriteClaim = widget.methods[0]!.claims.find(
      (claim) => claim.text === "write claim",
    )!;
    expect(mergedWriteClaim.contexts).toEqual(["all-features", "z-feature"]);
    expect(mergedWriteClaim.evidence).toHaveLength(2);
    expect(widget.methods[0]!.subtargets.map((target) => target.name)).toEqual(["loop"]);
    expect(widget.methods[0]!.subtargets[0]!.claims[0]!.contexts).toEqual([
      "all-features",
      "z-feature",
    ]);

    expect(model.verificationContexts.map((context) => context.name)).toEqual([
      "all-features",
      "z-feature",
    ]);
    expect(model.otherTargets.map((target) => target.name)).toEqual([
      "Target not specified",
      "missing_kind",
      "mystery",
    ]);
  });

  it("uses explicit parentIndex before path-prefix fallback", () => {
    const model = buildVerifiedTargets([
      run([
        result(
          "method_rule",
          "method claim",
          [
            { fullyQualifiedName: "demo::alpha::OtherType", kind: "type" },
            {
              fullyQualifiedName: "demo::alpha::Widget::method",
              kind: "function",
              parentIndex: 0,
            },
          ],
          1,
        ),
      ]),
    ]);

    const alpha = model.typesAndApis.find((module) => module.name === "alpha");
    expect(alpha?.types.map((type) => type.name)).toEqual(["OtherType"]);
    expect(alpha?.types[0]?.methods.map((method) => method.name)).toEqual(["method"]);
    expect(alpha?.functions).toEqual([]);
  });

  it("preserves raw claim/evidence details and context precedence", () => {
    const model = modelWithTwoRuns();
    const alpha = model.typesAndApis.find((module) => module.name === "alpha")!;
    const writeClaim = alpha.types[0]!.methods[0]!.claims.find(
      (claim) => claim.text === "write claim",
    )!;
    const firstEvidence = writeClaim.evidence[0]!;

    expect(writeClaim.text).toBe("write claim");
    expect(firstEvidence).toMatchObject({
      runIndex: 0,
      resultIndex: 2,
      locationIndex: 0,
      logicalLocationIndex: 0,
      targetName: "demo::alpha::Widget::write",
      targetKind: "function",
      message: "write claim",
      ruleId: "write_rule",
      toolName: "kani",
      toolVersion: "0.66.0",
      source: {
        text: "src/lib.rs:20:3",
        uri: "src/lib.rs",
        startLine: 20,
        startColumn: 3,
        endLine: 21,
      },
    });
  });
});
