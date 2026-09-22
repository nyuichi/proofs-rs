/** Read-only, self-contained preview of the actual frontend and API fixtures. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { app } from "../src/worker";
import type { Env } from "../src/core";
const db = new DatabaseSync(":memory:");
for (const f of readdirSync("migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort())
  db.exec(readFileSync("migrations/" + f, "utf8"));
db.exec(readFileSync("fixtures/staging-demo.sql", "utf8"));
const binding = {
  prepare(sql: string) {
    let args: any[] = [];
    return {
      bind(...v: any[]) {
        args = v;
        return this;
      },
      async first() {
        return db.prepare(sql).get(...args) || null;
      },
      async all() {
        return { results: db.prepare(sql).all(...args) };
      },
      async run() {
        return { meta: db.prepare(sql).run(...args) };
      },
    };
  },
};
const env = {
  DB: binding,
  ENVIRONMENT: "staging",
  APP_ORIGIN: "https://preview.invalid",
  TERMS_VERSION: "2026-09-21",
  EMAIL_DISABLED: "true",
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
} as unknown as Env;
const paths = new Set([
  "/health",
  "/config",
  "/me",
  "/home",
  "/crates",
  "/reports",
  "/tools",
]);
for (const r of db
  .prepare(
    "SELECT cr.name,rel.version FROM releases rel JOIN crates cr ON cr.id=rel.crate_id",
  )
  .all() as any[]) {
  paths.add(`/crates/${r.name}/releases`);
  paths.add(`/crates/${r.name}/${r.version}/apis`);
  paths.add(`/crates/${r.name}/${r.version}/reports`);
}
for (const r of db.prepare("SELECT id FROM reports").all() as any[]) {
  for (const suffix of ["", "/revisions", "/comments", "/stars"])
    paths.add(`/reports/${r.id}${suffix}`);
}
for (const r of db
  .prepare("SELECT report_id,revision_no FROM report_revisions")
  .all() as any[])
  paths.add(`/reports/${r.report_id}/revisions/${r.revision_no}`);
for (const r of db
  .prepare("SELECT claim_id,report_revision FROM claim_revisions")
  .all() as any[]) {
  paths.add(`/claims/${r.claim_id}`);
  paths.add(`/claims/${r.claim_id}?report_revision=${r.report_revision}`);
  paths.add(`/claims/${r.claim_id}/stars`);
}
for (const r of db.prepare("SELECT id FROM api_items").all() as any[]) {
  paths.add(`/apis/${r.id}`);
  paths.add(`/apis/${r.id}/claims`);
}
for (const r of db.prepare("SELECT id FROM tools").all() as any[]) {
  paths.add(`/tools/${r.id}`);
  paths.add(`/tools/${r.id}/reports`);
}
for (const r of db.prepare("SELECT id FROM tool_versions").all() as any[])
  paths.add(`/tool-versions/${r.id}/documentation`);
for (const r of db.prepare("SELECT id FROM users").all() as any[])
  for (const suffix of ["", "/reports", "/comments"])
    paths.add(`/users/${r.id}${suffix}`);
for (const r of db
  .prepare("SELECT id,report_id FROM report_comments")
  .all() as any[]) {
  paths.add(`/comments/${r.id}`);
  paths.add(`/reports/${r.report_id}/comments?parent_id=${r.id}`);
}
const responses: Record<string, any> = {};
function key(path: string) {
  const u = new URL(path, "https://preview.invalid");
  u.searchParams.delete("cursor");
  for (const [k, v] of u.searchParams) if (!v) u.searchParams.delete(k);
  u.searchParams.sort();
  return u.pathname + (u.searchParams.size ? "?" + u.searchParams : "");
}
for (const path of paths) {
  const r = await app.request("https://preview.invalid/api/v1" + path, {}, env);
  if (r.status !== 200)
    throw Error(path + ": " + r.status + " " + (await r.text()));
  let body = await r.json();
  responses[key("/api/v1" + path)] = body;
}
// Include subsequent pages in each static listing, so all demo entries remain navigable.
for (const path of paths) {
  let body = responses[key("/api/v1" + path)];
  while (body?.next_cursor) {
    const url = new URL("/api/v1" + path, "https://preview.invalid");
    url.searchParams.set("cursor", String(body.next_cursor));
    const r = await app.request(url.href, {}, env);
    if (!r.ok) throw Error("Pagination failed");
    const next: any = await r.json();
    body.items.push(...next.items);
    body.next_cursor = next.next_cursor;
  }
}
let html = readFileSync("dist/index.html", "utf8");
const jsPath = html.match(/src="(\/assets\/[^\"]+\.js)"/)![1];
const js = readFileSync("dist" + jsPath, "utf8");
html = html
  .replace(/<script type="module"[^>]*><\/script>/, "")
  .replace(
    '<link rel="stylesheet" href="/style.css" />',
    "<style>" + readFileSync("public/style.css", "utf8") + "</style>",
  )
  .replace(/<link rel="icon"[^>]+>/, "");
const bootstrap = `const previewResponses=${JSON.stringify(responses).replaceAll("<", "\\u003c")};window.fetch=async(input,init={})=>{if(init.method&&init.method!=='GET')return new Response(JSON.stringify({message:'Read-only preview: changes are not saved.'}),{status:403});const u=new URL(String(input),'https://preview.invalid');u.searchParams.delete('cursor');for(const [k,v]of u.searchParams)if(!v)u.searchParams.delete(k);u.searchParams.sort();const k=u.pathname+(u.searchParams.size?'?'+u.searchParams:'');let data=previewResponses[k];if(!data&&u.pathname==='/api/v1/crates'){const q=(u.searchParams.get('q')||'').toLowerCase();data=structuredClone(previewResponses['/api/v1/crates']);data.items=data.items.filter(x=>x.name.toLowerCase().includes(q));data.matching_count=data.items.length;}return new Response(JSON.stringify(data||{message:'Not available in the offline preview.'}),{status:data?200:404});};document.addEventListener('click',e=>{const a=e.target.closest('a');if(a&&a.getAttribute('href')?.startsWith('/auth/')){e.preventDefault();alert('Read-only preview. Authentication is disabled.');}});`;
html = html
  .replace(
    "<body>",
    '<body><p class="demo">Read-only branch preview · Synthetic staging data · No sign-in or writes</p>',
  )
  .replace(
    "</body>",
    "<script>" +
      bootstrap +
      '</script><script type="module">' +
      js.replaceAll("</script", "<\\/script") +
      "</script></body>",
  );
writeFileSync(process.argv[2] || "dist/branch-preview.html", html);
console.log(
  "Preview generated from the built frontend; " +
    Object.keys(responses).length +
    " fixture API responses.",
);
