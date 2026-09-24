-- scripts/migrate-sarif-only.mjs prepare must migrate R2 logs and run metadata first.
-- Fail closed instead of dropping the only copy of an unmigrated execution log.
CREATE TABLE _sarif_migration_guard (ready INTEGER NOT NULL CHECK(ready=1));
INSERT INTO _sarif_migration_guard
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM verification_runs
  WHERE json_type(metadata_json,'$.artifacts') IS NOT NULL
     OR json_type(metadata_json,'$.source.repository') IS NOT 'text'
     OR json_type(metadata_json,'$.source.commit') IS NOT 'text'
     OR json_type(metadata_json,'$.sarif_sha256') IS NOT 'text'
) THEN 0 ELSE 1 END;
DROP TABLE _sarif_migration_guard;

CREATE TABLE run_sarif (
  run_id TEXT PRIMARY KEY,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size > 0 AND size <= 8388608),
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO run_sarif
SELECT run_id,author_id,sha256,size,r2_key,created_at FROM run_artifacts
WHERE kind='sarif' AND run_id IN (SELECT id FROM verification_runs);
CREATE TABLE IF NOT EXISTS r2_deletions (r2_key TEXT PRIMARY KEY);
INSERT OR IGNORE INTO r2_deletions
SELECT r2_key FROM run_artifacts WHERE r2_key NOT IN (SELECT r2_key FROM run_sarif);
DROP TABLE run_artifacts;
DROP TRIGGER IF EXISTS sarif_migration_runs;
DROP TRIGGER IF EXISTS sarif_migration_reports;
DROP TRIGGER IF EXISTS sarif_migration_claims;

-- Obsolete storage metadata cannot be reintroduced into the JSON record either.
CREATE TRIGGER verification_runs_metadata_insert BEFORE INSERT ON verification_runs
WHEN json_type(NEW.metadata_json,'$.artifacts') IS NOT NULL
  OR json_type(NEW.metadata_json,'$.git_commit') IS NOT NULL
  OR json_type(NEW.metadata_json,'$.git_dirty') IS NOT NULL
BEGIN SELECT RAISE(ABORT,'obsolete run metadata'); END;
CREATE TRIGGER verification_runs_metadata_update BEFORE UPDATE OF metadata_json ON verification_runs
WHEN json_type(NEW.metadata_json,'$.artifacts') IS NOT NULL
  OR json_type(NEW.metadata_json,'$.git_commit') IS NOT NULL
  OR json_type(NEW.metadata_json,'$.git_dirty') IS NOT NULL
BEGIN SELECT RAISE(ABORT,'obsolete run metadata'); END;
