// One-time, resumable transition. No source archive is downloaded or re-uploaded.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export function convert(sarif, log, metadata, source) {
  const s = structuredClone(sarif),
    m = structuredClone(metadata);
  if (
    !source ||
    !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(source.repository) ||
    !/^[a-f0-9]{40}$/.test(source.commit) ||
    metadata.git_dirty === true
  )
    throw Error(
      "An exact external source commit is required; migration stopped without deleting evidence",
    );
  const run = s.runs[0],
    invocation = run.invocations[0];
  run.artifacts ||= [];
  // Old recorder logs are sequential labeled streams, not interleaved stdoutStderr.
  const prefix = "=== stdout ===\n",
    separator = "\n=== stderr ===\n";
  const split = log.indexOf(separator, prefix.length);
  const streams =
    log.startsWith(prefix) && split >= 0
      ? [
          ["stdout", log.slice(prefix.length, split)],
          ["stderr", log.slice(split + separator.length)],
        ]
      : metadata.id === "a0167c89-42c9-463c-b1d9-553ceabb6433"
        ? [["stdoutStderr", log]] // This recorder captured stderr=STDOUT into one stream.
        : null;
  if (!streams)
    throw Error(
      "Unknown legacy log format; refusing to guess stream boundaries",
    );
  for (const [name, text] of streams) {
    invocation[name] = { index: run.artifacts.length };
    run.artifacts.push({ contents: { text } });
  }
  if (run.properties) delete run.properties.sourceSnapshot;
  run.versionControlProvenance = [
    { repositoryUri: source.repository, revisionId: source.commit },
  ];
  delete m.artifacts;
  delete m.git_commit;
  delete m.git_dirty;
  m.source = source;
  const bytes = Buffer.from(JSON.stringify(s, null, 2));
  if (bytes.length > 8388608) throw Error("Migrated SARIF exceeds 8 MiB");
  m.sarif_sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, metadata: m };
}

async function main() {
  const [target = "staging", phase = "prepare"] = process.argv.slice(2);
  if (
    !["staging", "production"].includes(target) ||
    !["prepare", "cleanup"].includes(phase)
  )
    throw Error("Invalid migration arguments");
  const configPath = `wrangler.${target}.json`,
    config = JSON.parse(readFileSync(configPath));
  const bucket = config.r2_buckets.find(
    (b) => b.binding === "ARCHIVE",
  ).bucket_name;
  const call = (args) =>
    execFileSync(
      "npx",
      ["--no-install", "wrangler", ...args, "--config", configPath],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
  const sql = (command) => {
    const raw = call([
      "d1",
      "execute",
      "DB",
      "--remote",
      "--json",
      "--command",
      command,
    ]);
    const result = JSON.parse(raw);
    if (result.some((r) => r.success === false))
      throw Error("D1 migration statement failed");
    return result.flatMap((r) => r.results || []);
  };
  const q = (x) => "'" + String(x).replaceAll("'", "''") + "'";
  const exists = (table) =>
    sql(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=${q(table)}`,
    ).length;
  const dir = mkdtempSync(join(tmpdir(), "proofs-sarif-migration-"));
  const get = (key) => {
    const file = join(dir, "input");
    call([
      "r2",
      "object",
      "get",
      `${bucket}/${key}`,
      "--remote",
      "--file",
      file,
    ]);
    return readFileSync(file);
  };
  try {
    if (phase === "prepare" && exists("run_artifacts")) {
      // Block legacy writes while migrating; triggers disappear in 0006.
      sql(`CREATE TABLE IF NOT EXISTS r2_deletions(r2_key TEXT PRIMARY KEY);
        CREATE TRIGGER IF NOT EXISTS sarif_migration_artifacts BEFORE INSERT ON run_artifacts BEGIN SELECT RAISE(ABORT,'SARIF migration in progress'); END;
        CREATE TRIGGER IF NOT EXISTS sarif_migration_runs BEFORE INSERT ON verification_runs BEGIN SELECT RAISE(ABORT,'SARIF migration in progress'); END;
        CREATE TRIGGER IF NOT EXISTS sarif_migration_reports BEFORE INSERT ON report_revisions BEGIN SELECT RAISE(ABORT,'SARIF migration in progress'); END;
        CREATE TRIGGER IF NOT EXISTS sarif_migration_claims BEFORE INSERT ON claim_revisions BEGIN SELECT RAISE(ABORT,'SARIF migration in progress'); END;`);
      for (const row of sql("SELECT * FROM verification_runs")) {
        const m = JSON.parse(row.metadata_json);
        if (m.source && m.sarif_sha256 && !m.artifacts) continue;
        // Only the existing, independently verified public hex commit has a mapping.
        const source =
          m.source ||
          (m.git_commit === "c6d8352aecd423d311f26e64bef3ed37ec950b84" &&
          m.crate === "hex" &&
          m.version === "0.4.3"
            ? {
                repository: "https://github.com/nyuichi/rust-crate-proofs",
                commit: m.git_commit,
              }
            : null);
        if (!source)
          throw Error(`No verified external source mapping for run ${row.id}`);
        const artifacts = sql(
          `SELECT * FROM run_artifacts WHERE run_id=${q(row.id)}`,
        );
        const sarif = artifacts.find((a) => a.kind === "sarif"),
          log = artifacts.find((a) => a.kind === "logs");
        if (!sarif || !log)
          throw Error(`Incomplete legacy evidence for ${row.id}`);
        const sb = get(sarif.r2_key),
          lb = get(log.r2_key);
        for (const [bytes, a] of [
          [sb, sarif],
          [lb, log],
        ])
          if (createHash("sha256").update(bytes).digest("hex") !== a.sha256)
            throw Error("Legacy artifact hash mismatch");
        const result = convert(JSON.parse(sb), lb.toString("utf8"), m, source);
        const key = `runs/${row.author_id}/${row.id}/sarif/${result.metadata.sarif_sha256}`;
        const file = join(dir, "converted.sarif.json");
        writeFileSync(file, result.bytes);
        call([
          "r2",
          "object",
          "put",
          `${bucket}/${key}`,
          "--remote",
          "--file",
          file,
          "--content-type",
          "application/sarif+json",
        ]);
        if (!get(key).equals(result.bytes))
          throw Error("R2 read-back mismatch");
        // D1 batches the statements atomically; retries skip completed runs.
        sql(`UPDATE run_artifacts SET sha256=${q(result.metadata.sarif_sha256)},size=${result.bytes.length},r2_key=${q(key)} WHERE run_id=${q(row.id)} AND kind='sarif';
          UPDATE verification_runs SET metadata_json=${q(JSON.stringify(result.metadata))} WHERE id=${q(row.id)};
          INSERT OR IGNORE INTO r2_deletions VALUES(${q(sarif.r2_key)});`);
        console.log(
          `Converted run ${row.id}; source files were not downloaded.`,
        );
      }
      // Rewrite every historical evidence link, preserving report/claim identities and revisions.
      for (const row of sql("SELECT id,metadata_json FROM verification_runs")) {
        const m = JSON.parse(row.metadata_json),
          url = `${m.source.repository}/tree/${m.source.commit}`;
        for (const table of ["report_revisions", "claim_revisions"]) {
          const old = `/api/v1/runs/${row.id}/source`;
          sql(
            `UPDATE ${table} SET evidence_url=${q(url)} WHERE evidence_url LIKE ${q("%" + old)};`,
          );
        }
      }
    }
    if (phase === "cleanup" && exists("r2_deletions")) {
      if (exists("run_artifacts")) throw Error("Apply 0006 before cleanup");
      for (const row of sql("SELECT r2_key FROM r2_deletions")) {
        // Idempotent object deletion, then dequeue. Never deletes the new SARIF.
        if (
          sql(`SELECT run_id FROM run_sarif WHERE r2_key=${q(row.r2_key)}`)
            .length
        )
          throw Error("Refusing to delete live SARIF");
        call(["r2", "object", "delete", `${bucket}/${row.r2_key}`, "--remote"]);
        sql(`DELETE FROM r2_deletions WHERE r2_key=${q(row.r2_key)}`);
      }
      console.log(
        "Legacy source/log objects removed; SARIF-only migration complete.",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
