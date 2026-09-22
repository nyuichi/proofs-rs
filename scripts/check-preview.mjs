import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const html = readFileSync(process.argv[2], "utf8");
const dom = new JSDOM(html, {
  url: "https://preview.invalid/#/tools",
  runScripts: "outside-only",
});
const w = dom.window;
Object.assign(w, { Response, structuredClone, TextEncoder });
w.HTMLElement.prototype.scrollIntoView = () => {};
for (const s of w.document.querySelectorAll("script")) w.eval(s.textContent);
async function ready() {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (
      w.document.querySelector("#app").getAttribute("aria-busy") === "false" &&
      !w.document.querySelector("[data-loading]")
    )
      return;
  }
  throw Error("Preview did not settle");
}
await ready();
assert.ok(!w.document.querySelector("[role=alert]"));
let tool = w.document.querySelector('a[href^="#/tool/"]');
assert.ok(tool);
tool.click();
await ready();
let doc = w.document.querySelector('a[href^="#/tool-documentation/"]');
assert.ok(doc);
doc.click();
await ready();
assert.match(w.document.querySelector("h2").textContent, /Guarantees/);
assert.ok(w.document.querySelector(".tool-documentation"));
w.location.hash = "/reports";
await ready();
const report = w.document.querySelector('a[href^="#/report/"]');
assert.ok(report);
report.click();
await ready();
assert.ok(w.document.querySelector('a[href^="#/tool-documentation/"]'));
assert.match(w.document.querySelector("#app").textContent, /Claims \(\d+\)/);
const claim = w.document.querySelector('a[href^="#/claim/"]');
assert.ok(claim);
claim.click();
await ready();
assert.ok(w.document.querySelector('a[href^="#/tool-documentation/"]'));
assert.ok(!w.document.querySelector("[role=alert]"));
dom.window.close();
console.log(
  "Built preview navigation passed: tools → documentation; reports → report → claim, preserving claim counts and documentation links.",
);
