PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS publishers (
  id TEXT PRIMARY KEY NOT NULL,
  github_user_id TEXT NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  publisher_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS publications (
  id TEXT PRIMARY KEY NOT NULL,
  publisher_id TEXT NOT NULL,
  message TEXT NOT NULL,
  crate_name TEXT NOT NULL,
  crate_version TEXT NOT NULL,
  upstream_repository TEXT NOT NULL,
  upstream_commit TEXT NOT NULL,
  upstream_path TEXT NOT NULL,
  verification_repository TEXT NOT NULL,
  verification_commit TEXT NOT NULL,
  verification_path TEXT NOT NULL,
  sarif_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sarif_runs (
  publication_id TEXT NOT NULL,
  run_index INTEGER NOT NULL,
  run_json TEXT NOT NULL CHECK (json_valid(run_json)),
  PRIMARY KEY (publication_id, run_index),
  FOREIGN KEY (publication_id) REFERENCES publications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_publications_created_id
  ON publications (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_publications_publisher_created
  ON publications (publisher_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_publisher
  ON sessions (publisher_id);

CREATE INDEX IF NOT EXISTS idx_sessions_expires
  ON sessions (expires_at);
