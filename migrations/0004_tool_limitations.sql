ALTER TABLE tool_versions ADD COLUMN limitations TEXT NOT NULL DEFAULT '';
ALTER TABLE tool_versions ADD COLUMN limitations_updated_at TEXT;
