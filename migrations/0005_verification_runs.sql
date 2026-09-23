CREATE TABLE verification_runs (
  id TEXT PRIMARY KEY,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  crate TEXT NOT NULL,
  version TEXT NOT NULL,
  tool_version_id TEXT NOT NULL REFERENCES tool_versions(id),
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE run_artifacts (
  run_id TEXT NOT NULL,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK(kind IN ('source','sarif','logs')),
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id,kind)
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
