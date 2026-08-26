PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS publication_labels (
  publication_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 7),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0 AND length(display_name) <= 32),
  normalized_name TEXT NOT NULL COLLATE NOCASE
    CHECK (length(trim(normalized_name)) > 0),
  PRIMARY KEY (publication_id, position),
  UNIQUE (publication_id, normalized_name),
  FOREIGN KEY (publication_id) REFERENCES publications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_publication_labels_publication_position
  ON publication_labels (publication_id, position);

-- Keep the first production fixture's labels stable if this migration is
-- replayed. The SELECT makes the seed a no-op on installations without that
-- fixture (including fresh local databases).
INSERT OR IGNORE INTO publication_labels (
  publication_id, position, display_name, normalized_name
)
SELECT '01M0Y9XDRX507PG4H5YPP9BAP2', 0, 'complete-api', 'complete-api'
WHERE EXISTS (
  SELECT 1 FROM publications WHERE id = '01M0Y9XDRX507PG4H5YPP9BAP2'
);

INSERT OR IGNORE INTO publication_labels (
  publication_id, position, display_name, normalized_name
)
SELECT '01M0Y9XDRX507PG4H5YPP9BAP2', 1, 'no-panic', 'no-panic'
WHERE EXISTS (
  SELECT 1 FROM publications WHERE id = '01M0Y9XDRX507PG4H5YPP9BAP2'
);

INSERT OR IGNORE INTO publication_labels (
  publication_id, position, display_name, normalized_name
)
SELECT '01M0Y9XDRX507PG4H5YPP9BAP2', 2, 'no-unsafe', 'no-unsafe'
WHERE EXISTS (
  SELECT 1 FROM publications WHERE id = '01M0Y9XDRX507PG4H5YPP9BAP2'
);
