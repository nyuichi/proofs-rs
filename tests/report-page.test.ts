import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
for (const loggedIn of [false, true])
  test(`report renders before history and requests past revision directly (logged in: ${loggedIn})`, async () => {
    const dom = new JSDOM('<main id="app"></main>', {
      url: "https://example.test/#/report/1?v=1",
      runScripts: "outside-only",
    });
    const w = dom.window as any;
    let resolveHistory: (value: any) => void;
    const history = new Promise((resolve) => (resolveHistory = resolve));
    const calls: string[] = [];
    w.request = async (path: string) => {
      calls.push(path);
      if (path === "/reports/1/revisions") return history;
      assert.equal(path, "/reports/1/revisions/1");
      return {
        id: 1,
        title: "Report body",
        revision_no: 1,
        latest_revision_no: 2,
        claims: [],
        run_ids: [],
        comment_count: 0,
      };
    };
    w.loadComments = async (_id: any, _parent: any, box: any) => {
      box.textContent = "Comments loaded";
    };
    w.loggedIn = loggedIn;
    const source = readFileSync(
      new URL("../web/main.ts", import.meta.url),
      "utf8",
    );
    const report = source.slice(
      source.indexOf("async function reportPage("),
      source.indexOf("async function loadComments("),
    );
    const setup = `const root=document.querySelector('#app'); const me={user:loggedIn?{id:'bob'}:null};let commentReply=null;const current=()=>new URL('https://example.test/?v=1');const enc=encodeURIComponent;const esc=(x)=>String(x??'');const reportContent=(c)=>'<h1>'+c.title+'</h1>';const user=()=>'';const date=()=>'';const reproduceSection=()=>'';const claimItem=()=>'';const breadcrumbs=()=>'';const crateCrumbs=()=>[];const notice='';const bindReproduce=()=>{};const bindStars=()=>{};const bind=()=>{};`;
    w.eval(
      transpileModule(setup + report + ";window.finished=reportPage(1);", {
        compilerOptions: {
          module: ModuleKind.None,
          target: ScriptTarget.ES2022,
        },
      }).outputText,
    );
    await w.finished;
    assert.match(w.document.querySelector("h1").textContent, /Report body/);
    assert.match(
      w.document.querySelector("#comments").textContent,
      /Comments loaded/,
    );
    assert.deepEqual(calls, ["/reports/1/revisions/1", "/reports/1/revisions"]);
    resolveHistory!({
      items: [{ revision_no: 2 }, { revision_no: 1 }],
      next_cursor: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(w.document.querySelectorAll("#revision-history a").length, 2);
    if (loggedIn)
      assert.equal(w.document.querySelector("[name=revision_no]").value, "1");
    dom.window.close();
  });
