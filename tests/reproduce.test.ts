import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";

test("Reproduce starts collapsed, loads on demand, links claims and safely renders output", async () => {
  const dom = new JSDOM('<main id="app"></main>', {
    url: "https://proofs.rs",
    runScripts: "outside-only",
  });
  const w = dom.window;
  const calls: string[] = [];
  const run = {
    command: ["cargo", "kani", "--harness", "check_'f"],
    working_directory: "crate",
    execution_successful: true,
    started_at: "2026-09-23T00:00:00Z",
    finished_at: "2026-09-23T00:00:01Z",
    duration_ms: 1000,
    exit_code: 0,
    environment: { RUSTFLAGS: "--cfg demo" },
    artifacts: { source: "abc" },
    contracts: [
      {
        harness: "demo::check_f",
        api_paths: ["demo::f"],
        properties: ["no_ub"],
      },
    ],
  };
  (w as any).fetch = async (url: string) => {
    calls.push(url);
    return {
      ok: true,
      json: async () =>
        url.endsWith("/sarif")
          ? {
              runs: [
                {
                  results: [
                    {
                      kind: "pass",
                      message: { text: "<script>bad</script>" },
                      properties: { harness: "demo::check_f" },
                    },
                  ],
                },
              ],
            }
          : run,
      text: async () => "<img src=x onerror=bad()>",
    };
  };
  w.eval(
    transpileModule(
      readFileSync(
        new URL("../web/reproduce.ts", import.meta.url),
        "utf8",
      ).replaceAll("export function", "function"),
      {
        compilerOptions: {
          module: ModuleKind.None,
          target: ScriptTarget.ES2022,
        },
      },
    ).outputText +
      `\nconst root = document.querySelector('#app'); root.innerHTML = reproduceSection(['run-1']); bindReproduce(root, {id: 42, revision_no: 2, run_ids: ['run-1'], claims: [{id: 17, display_path: 'demo::f', property: 'no_ub'}]});`,
  );
  const section = w.document.querySelector("details")!;
  assert.equal(section.open, false);
  assert.equal(calls.length, 0);
  assert.equal(w.document.querySelector("button"), null);
  section.open = true;
  section.dispatchEvent(new w.Event("toggle"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 2);
  assert.equal(w.document.querySelector("script"), null);
  assert.ok(
    w.document
      .querySelector("td")!
      .textContent!.includes("<script>bad</script>"),
  );
  assert.equal(
    w.document.querySelector("td a")!.getAttribute("href"),
    "#/claim/17?report_revision=2",
  );
  assert.ok(
    w.document
      .querySelector("pre")!
      .textContent!.includes("cd report-42-source-1/crate"),
  );
  assert.ok(
    w.document
      .querySelector("pre")!
      .textContent!.includes("env 'RUSTFLAGS=--cfg demo' cargo kani"),
  );
  const logs = w.document.querySelector<HTMLDetailsElement>(".run-logs")!;
  logs.open = true;
  logs.dispatchEvent(new w.Event("toggle"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(w.document.querySelector("img"), null);
  assert.equal(
    logs.querySelector("pre")!.textContent,
    "<img src=x onerror=bad()>",
  );
  section.open = false;
  section.open = true;
  section.dispatchEvent(new w.Event("toggle"));
  assert.equal(calls.length, 3);
  w.close();
});
