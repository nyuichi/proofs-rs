CREATE TABLE verification_runs (
  id TEXT PRIMARY KEY,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  crate TEXT NOT NULL,
  version TEXT NOT NULL,
  tool_version_id TEXT NOT NULL REFERENCES tool_versions(id),
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size > 0 AND size <= 8388608),
  r2_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE report_runs (
  report_id INTEGER NOT NULL,
  revision_no INTEGER NOT NULL,
  run_id TEXT NOT NULL REFERENCES verification_runs(id),
  position INTEGER NOT NULL,
  PRIMARY KEY(report_id,revision_no,run_id),
  FOREIGN KEY(report_id,revision_no) REFERENCES report_revisions(report_id,revision_no)
);
CREATE INDEX report_runs_run ON report_runs(run_id);
