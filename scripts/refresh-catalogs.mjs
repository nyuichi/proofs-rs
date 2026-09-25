import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { extractAPIs } from "../src/imports.ts";

const configFile = process.argv[2];
if (!configFile) throw Error("Expected a Wrangler configuration path");
const config = JSON.parse(await readFile(configFile, "utf8"));
const database = config.d1_databases[0].database_name;
const bucket = config.r2_buckets[0].bucket_name;
const wrangler = "node_modules/.bin/wrangler";
function run(...args) {
  return execFileSync(wrangler, [...args, "--remote", "--config", configFile], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120000,
  });
}
function query(sql) {
  const data = JSON.parse(run("d1", "execute", database, "--command", sql, "--json"));
  if (!data[0]?.success) throw Error("D1 catalogue query failed");
  return data[0].results;
}
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const releases = query("SELECT s.release_id, s.r2_key, s.source_hash, cr.name, r.version FROM doc_snapshots s JOIN releases r ON r.id=s.release_id JOIN crates cr ON cr.id=r.crate_id ORDER BY s.release_id");
const temp = await mkdtemp(join(tmpdir(), "proofs-catalog-"));
try {
  for (const release of releases) {
    const file = join(temp, "rustdoc.json");
    run("r2", "object", "get", `${bucket}/${release.r2_key}`, "--file", file);
    const raw = await readFile(file, "utf8");
    if (digest(raw) !== release.source_hash)
      throw Error(`Archived rustdoc hash mismatch for ${release.name} ${release.version}`);
    const apis = extractAPIs(JSON.parse(raw), release.name, release.version);
    const before = query(`SELECT COUNT(*) AS total FROM api_items WHERE release_id=${Number(release.release_id)}`)[0].total;
    for (let i = 0; i < apis.length; i += 50) {
      const statements = apis.slice(i, i + 50).map((a) => {
        const values = [digest(`${release.release_id}:${a.canonical_key}`), release.release_id,
          a.canonical_key, a.display_path, a.kind, a.is_unsafe, a.signature, a.upstream_url];
        return `INSERT OR IGNORE INTO api_items VALUES(${values.map((v, n) => n === 1 || n === 5 ? Number(v) : quote(v)).join(",")});`;
      });
      const sqlFile = join(temp, "insert.sql");
      await writeFile(sqlFile, statements.join("\n"));
      run("d1", "execute", database, "--file", sqlFile, "--yes");
    }
    const after = query(`SELECT COUNT(*) AS total FROM api_items WHERE release_id=${Number(release.release_id)}`)[0].total;
    console.log(`${release.name} ${release.version}: ${after - before} added, ${after} total`);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
