-- Documents themselves and their immutable revisions are reviewed in Git.
CREATE TABLE tool_documentation_bindings (
  tool_id TEXT PRIMARY KEY REFERENCES tools(id),
  documentation_id TEXT NOT NULL CHECK(length(documentation_id)>0)
);
CREATE TABLE tool_version_documentation_bindings (
  tool_version_id TEXT PRIMARY KEY REFERENCES tool_versions(id),
  documentation_id TEXT NOT NULL CHECK(length(documentation_id)>0)
);
INSERT INTO tool_documentation_bindings SELECT id,'kani' FROM tools WHERE lower(name)='kani' OR id='kani';
INSERT OR IGNORE INTO tool_documentation_bindings SELECT id,CASE WHEN id='demo-kani' THEN 'kani' ELSE 'demo' END FROM tools WHERE id LIKE 'demo-%';
