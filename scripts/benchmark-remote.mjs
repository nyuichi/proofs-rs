import assert from "node:assert/strict";
// Temporary GET-only Workers; no DB writes, migrations, scheduled jobs, or production deployment.
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw Error("Cloudflare credentials required");
const api = async (path, method = "GET") => {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
    { method, headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await r.json();
  if (!r.ok || !data.success)
    throw Error(`Cloudflare ${method} ${path} failed`);
  return data.result;
};
const base = JSON.parse(await readFile("wrangler.json", "utf8"));
const databases = await api("/d1/database?per_page=100");
const db = databases.find((x) => x.name === base.d1_databases[0].database_name);
if (!db)
  throw Error("Existing staging database not found; refusing to create one");
const domain = await api("/workers/subdomain");
const root = process.cwd();
const baseline = resolve(".perf-baseline");
execFileSync("git", ["worktree", "add", "--detach", baseline, "7b90c70"]);
execFileSync("ln", ["-s", resolve("node_modules"), `${baseline}/node_modules`]);
const targets = [];
const result = {
  baseline: "7b90c70",
  candidate: process.env.GITHUB_SHA,
  database: db.name,
  location: "GitHub Actions runner (not Tokyo)",
  samples: [],
};
try {
  for (const [label, cwd] of [
    ["before", baseline],
    ["after", root],
  ]) {
    execFileSync("npm", ["run", "build"], { cwd, stdio: "inherit" });
    const name = `proofs-perf-${process.env.GITHUB_RUN_ID}-${label}`;
    const origin = `https://${name}.${domain.subdomain}.workers.dev`;
    targets.push({ name, origin, label });
    await writeFile(
      `${cwd}/perf-worker.ts`,
      `import { app } from './src/worker';\nexport default {fetch(request, env, ctx) { const u = new URL(request.url); if (request.method !== 'GET' || !u.pathname.startsWith('/api/v1/') || request.headers.has('Authorization') || request.headers.has('Cookie')) return new Response('Read-only anonymous benchmark', {status:403}); return app.fetch(request, env, ctx); }};\n`,
    );
    await writeFile(
      `${cwd}/wrangler.perf.json`,
      JSON.stringify({
        name,
        main: "perf-worker.ts",
        compatibility_date: base.compatibility_date,
        compatibility_flags: base.compatibility_flags,
        workers_dev: true,
        vars: { ...base.vars, APP_ORIGIN: origin },
        d1_databases: [
          { binding: "DB", database_name: db.name, database_id: db.uuid },
        ],
        assets: {
          directory: "dist",
          binding: "ASSETS",
          run_worker_first: true,
        },
      }),
    );
    execFileSync(
      resolve("node_modules/.bin/wrangler"),
      ["deploy", "--config", "wrangler.perf.json"],
      { cwd, stdio: "inherit" },
    );
  }
  // New workers.dev hostnames can briefly return an HTML propagation/error page.
  for (const target of targets) {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const r = await fetch(`${target.origin}/api/v1/health`);
        ready = r.ok && (await r.json()).ok === true;
      } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!ready) throw Error(`${target.label} Worker did not become ready`);
  }
  // Warm both isolates and discover an existing published report without mutating fixtures.
  const home = await fetch(`${targets[0].origin}/api/v1/home`).then((r) =>
    r.json(),
  );
  const report = home.reports?.[0];
  if (!report) throw Error("Staging has no published reports to benchmark");
  const paths = [
    "/home",
    "/crates",
    `/reports/${report.id}`,
    `/reports/${report.id}/revisions`,
    `/reports/${report.id}/comments`,
    `/crates/${encodeURIComponent(report.crate)}/releases`,
  ];
  for (const path of paths) {
    for (const t of targets)
      await fetch(`${t.origin}/api/v1${path}`).then((r) => r.arrayBuffer());
    for (let i = 0; i < 7; i++) {
      const bodies = [];
      for (const t of i % 2 ? [...targets].reverse() : targets) {
        const start = performance.now();
        const response = await fetch(`${t.origin}/api/v1${path}`);
        const ttfb_ms = performance.now() - start;
        const raw = await response.text();
        if (!response.headers.get("content-type")?.includes("application/json"))
          throw Error(`${t.label} ${path}: non-JSON HTTP ${response.status}`);
        const body = JSON.parse(raw);
        if (!response.ok) throw Error(`${t.label} ${path}: ${response.status}`);
        result.samples.push({
          label: t.label,
          path,
          ttfb_ms,
          total_ms: performance.now() - start,
          ray: response.headers.get("cf-ray"),
        });
        bodies.push(body);
      }
      assert.deepEqual(bodies[0], bodies[1], `Response mismatch: ${path}`);
    }
  }
  const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  result.summary = paths.map((path) => ({
    path,
    ...Object.fromEntries(
      targets.map((t) => [
        t.label,
        median(
          result.samples
            .filter((s) => s.path === path && s.label === t.label)
            .map((s) => s.ttfb_ms),
        ),
      ]),
    ),
  }));
  console.log(JSON.stringify(result.summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `Anonymous staging comparison; median TTFB, 7 alternating warm samples. Same D1 database; runner location differs from Tokyo.\n\n| API | Before ms | After ms |\n|---|---:|---:|\n${result.summary.map((x) => `| ${x.path} | ${x.before.toFixed(1)} | ${x.after.toFixed(1)} |`).join("\n")}\n`,
    );
} finally {
  await writeFile("performance-results.json", JSON.stringify(result, null, 2));
  for (const t of targets) await api(`/workers/scripts/${t.name}`, "DELETE");
}
