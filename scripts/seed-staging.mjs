import { readFile } from "node:fs/promises";
const origin = "https://proofs-rs-staging.proofs-rs.workers.dev";
const config = JSON.parse(await readFile("wrangler.json", "utf8"));
const name = "proofs-rs-staging-reports-v1";
if (
  config.name !== "proofs-rs-staging" ||
  config.vars.ENVIRONMENT !== "staging" ||
  config.d1_databases[0].database_name !== name
)
  throw Error("Staging configuration required");
const health = await fetch(`${origin}/api/v1/health`).then((r) => r.json());
if (health.environment !== "staging" || !health.ok)
  throw Error("Staging health check failed");
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw Error("Cloudflare credentials missing");
async function api(path, body) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
    {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  const d = await r.json();
  if (!r.ok || !d.success) throw Error(JSON.stringify(d.errors));
  return d.result;
}
let db;
for (let page = 1; page <= 100; page++) {
  const databases = await api(`/d1/database?page=${page}&per_page=100`);
  db = databases.find((d) => d.name === name);
  if (db || databases.length < 100) break;
}
if (!db)
  throw Error(
    "Existing staging database not found; refusing to create or use another database",
  );
const detail = await api(`/d1/database/${db.uuid}`);
if (detail.name !== name) throw Error("Database identity mismatch");
const sql = await readFile("fixtures/staging-demo.sql", "utf8");
if (
  sql
    .split("\n")
    .some((s) => s.trim() && !s.startsWith("INSERT OR IGNORE INTO "))
)
  throw Error("Seed must be additive");
const results = await api(`/d1/database/${db.uuid}/query`, { sql });
if (results.some((r) => !r.success)) throw Error("Seed query failed");
const stats = await api(`/d1/database/${db.uuid}/query`, {
  sql: "SELECT COUNT(*) AS demo_claims FROM claims WHERE report_id IN (SELECT id FROM reports WHERE create_key LIKE 'staging-demo-reports-v1-%'); SELECT COUNT(*) AS demo_users FROM users WHERE github_id BETWEEN -91004 AND -91001; PRAGMA foreign_key_check;",
});
if (
  stats[0].results[0].demo_claims !== 16 ||
  stats[1].results[0].demo_users !== 4 ||
  stats[2].results.length
)
  throw Error("Seed verification failed");
console.log(
  "Staging demo ready: 7 crates, 9 reports, 16 claims, nested comments and independent stars.",
);
