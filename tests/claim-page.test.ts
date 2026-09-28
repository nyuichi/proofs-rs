import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import ts from "typescript";

test("claim layout preserves scoped content, escaping, and revision context", () => {
  const source = ts.createSourceFile(
    "main.ts",
    readFileSync(new URL("../web/main.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = ["claimContent", "claimScope", "toolLimitations", "toolLink"];
  const functions = source.statements
    .filter((n) => ts.isFunctionDeclaration(n) && names.includes(n.name!.text))
    .map((n) => n.getText(source))
    .join("\n");
  const dom = new JSDOM("<main></main>", { runScripts: "outside-only" });
  const w = dom.window as any;
  w.c = {
    id: "one",
    claim_number: 1,
    title: "Claim",
    api_item_id: "api",
    display_path: "demo::f",
    property: "panic_contract",
    signature: "unsafe fn f()",
    is_unsafe: 1,
    tool: "Demo",
    tool_version: "1",
    tool_version_id: "tool",
    report_id: 8,
    report_revision: 2,
    precondition: "Valid pointer",
    explanation: "Claim <script>text</script>",
    shared_explanation: "Report context text",
    shared_evidence_url: "https://example.com/report",
    evidence_url: "https://example.com/claim",
    shared_trusted_assumptions: "Report trust",
    trusted_assumptions: "Claim trust",
    shared_limitations: "Report limit",
    limitations: "Claim limit",
    tool_limitations: "Tool limit",
    environment: "Environment text",
  };
  w.eval(
    ts.transpileModule(
      `const enc=encodeURIComponent;const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');const prop=()=> 'Panic contract';const date=v=>v;` +
        functions +
        `;document.querySelector('main').innerHTML=claimContent(c);`,
      {
        compilerOptions: {
          module: ts.ModuleKind.None,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText,
  );
  const d = w.document;
  for (const value of [
    "Valid pointer",
    "Claim <script>text</script>",
    "Report context text",
    "Report trust",
    "Claim trust",
    "Report limit",
    "Claim limit",
    "Tool limit",
    "Environment text",
  ])
    assert.ok(d.body.textContent.includes(value), value);
  assert.equal(d.querySelector("script"), null);
  assert.equal(d.querySelectorAll('a[target="_blank"]').length, 2);
  assert.equal(
    d.querySelector('a[href="#/report/8?v=2"]').textContent,
    "Reproduction details in report v2",
  );
  assert.equal(d.querySelectorAll("h2").length, 4);
  assert.equal(d.querySelector("dl"), null);
  assert.equal(d.querySelector(".claim-report-context").open, false);
  dom.window.close();
});
