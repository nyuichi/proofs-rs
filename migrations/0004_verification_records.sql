CREATE TABLE verification_records (
  id TEXT PRIMARY KEY NOT NULL,
  publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  api_path TEXT NOT NULL,
  api_kind TEXT NOT NULL CHECK (api_kind IN ('function', 'method')),
  tag TEXT NOT NULL CHECK (tag IN ('no-ub', 'no-panic')),
  contract TEXT NOT NULL,
  configuration TEXT NOT NULL,
  run_index INTEGER NOT NULL,
  result_index INTEGER NOT NULL,
  supersedes_id TEXT REFERENCES verification_records(id),
  FOREIGN KEY (publication_id, run_index) REFERENCES sarif_runs(publication_id, run_index)
);
CREATE TABLE publication_records (
  publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES verification_records(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (publication_id, record_id),
  UNIQUE (publication_id, position)
);
CREATE INDEX idx_publications_crate_version_latest ON publications(crate_name, crate_version, created_at DESC, id DESC);
CREATE INDEX idx_records_origin ON verification_records(publication_id);
CREATE INDEX idx_records_parent ON verification_records(supersedes_id);
CREATE INDEX idx_memberships_record ON publication_records(record_id);
