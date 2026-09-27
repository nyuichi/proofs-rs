CREATE TABLE api_item_metadata (
  api_item_id TEXT PRIMARY KEY REFERENCES api_items(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK(category IN ('function','associated','method','trait')),
  trait_path TEXT,
  self_type TEXT,
  method_name TEXT NOT NULL,
  is_blanket INTEGER NOT NULL CHECK(is_blanket IN (0,1))
);
