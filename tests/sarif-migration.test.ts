import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { convert } from "../scripts/migrate-sarif-only.mjs";
import { validateSarif } from "../src/runs";
const source = {
  repository: "https://github.com/test/source",
  commit: "a".repeat(40),
};
const sarif = {
  version: "2.1.0",
  runs: [
    {
      tool: { driver: { name: "test" } },
      invocations: [{ executionSuccessful: true }],
      artifacts: [
        { location: { uri: "src/lib.rs" }, hashes: { "sha-256": "abc" } },
      ],
      properties: { sourceSnapshot: "old" },
      results: [{ kind: "pass", message: { text: "vc" } }],
    },
  ],
};
test("migration preserves results and both log streams without embedding source", () => {
  const original = structuredClone(sarif);
  const converted = convert(
    sarif,
    "=== stdout ===\nhello\n=== stderr ===\nwarning",
    {
      id: "run",
      git_commit: source.commit,
      git_dirty: false,
      artifacts: { source: "old" },
    },
    source,
  );
  const s = JSON.parse(converted.bytes.toString());
  assert.deepEqual(s.runs[0].results, original.runs[0].results);
  assert.equal(
    s.runs[0].artifacts[s.runs[0].invocations[0].stdout.index].contents.text,
    "hello",
  );
  assert.equal(
    s.runs[0].artifacts[s.runs[0].invocations[0].stderr.index].contents.text,
    "warning",
  );
  assert.equal(s.runs[0].artifacts[0].contents, undefined);
  assert.equal(s.runs[0].properties.sourceSnapshot, undefined);
  assert.equal(converted.metadata.artifacts, undefined);
  assert.equal(
    converted.metadata.sarif_sha256,
    createHash("sha256").update(converted.bytes).digest("hex"),
  );
  assert.deepEqual(sarif, original);
  validateSarif(s);
  assert.throws(() => convert(sarif, "unknown", { git_dirty: false }, source));
  assert.throws(() =>
    convert(
      sarif,
      "=== stdout ===\nx\n=== stderr ===\n",
      { git_dirty: true },
      source,
    ),
  );
  s.runs[0].artifacts[0].contents = { text: "whole source" };
  assert.throws(() => validateSarif(s), /embedded_source_not_allowed/);
});
test("hex combined log is preserved byte-for-byte as stdoutStderr", () => {
  const log = "compiler output\nProved 167/167 obligations\n";
  const c = convert(
    sarif,
    log,
    { id: "a0167c89-42c9-463c-b1d9-553ceabb6433", git_dirty: false },
    source,
  );
  const r = JSON.parse(c.bytes.toString()).runs[0];
  assert.equal(
    r.artifacts[r.invocations[0].stdoutStderr.index].contents.text,
    log,
  );
  validateSarif(JSON.parse(c.bytes.toString()));
});
test("schema migration guards unmigrated data, preserves links and removes generic artifact storage", () => {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations")
    .filter((f) => f.endsWith(".sql") && f < "0006")
    .sort())
    db.exec(readFileSync("migrations/" + f, "utf8"));
  db.exec(
    "PRAGMA foreign_keys=OFF; INSERT INTO verification_runs VALUES('r',NULL,'hex','0.4.3','tool','{\"artifacts\":{\"source\":\"x\"}}','now'); INSERT INTO run_artifacts VALUES('r',NULL,'source','s',10,'source-key','now'),('r',NULL,'sarif','j',10,'sarif-key','now'),('r',NULL,'logs','l',10,'log-key','now'); INSERT INTO report_runs VALUES(1,1,'r',0);",
  );
  const migration = readFileSync("migrations/0006_sarif_only.sql", "utf8");
  db.exec("BEGIN");
  assert.throws(() => db.exec(migration), /CHECK constraint failed/);
  db.exec("ROLLBACK");
  assert.equal(
    (db.prepare("SELECT count(*) n FROM run_artifacts").get() as any).n,
    3,
  );
  db.prepare("UPDATE verification_runs SET metadata_json=?").run(
    JSON.stringify({ source, sarif_sha256: "j", contracts: [] }),
  );
  db.exec(migration);
  assert.equal(
    db
      .prepare("SELECT name FROM sqlite_master WHERE name='run_artifacts'")
      .get(),
    undefined,
  );
  assert.equal(
    (db.prepare("SELECT count(*) n FROM run_sarif").get() as any).n,
    1,
  );
  assert.deepEqual(
    db
      .prepare("SELECT r2_key FROM r2_deletions ORDER BY r2_key")
      .all()
      .map((r: any) => r.r2_key),
    ["log-key", "source-key"],
  );
  assert.equal(
    (db.prepare("SELECT run_id FROM report_runs").get() as any).run_id,
    "r",
  );
  assert.throws(
    () =>
      db.exec(
        `UPDATE verification_runs SET metadata_json='{"artifacts":{"source":"oops"}}'`,
      ),
    /obsolete run metadata/,
  );
  db.close();
});
