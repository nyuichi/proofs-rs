CREATE TABLE api_tokens (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL CHECK(scope='publish'),
 created_at TEXT NOT NULL, last_used_at TEXT, expires_at TEXT NOT NULL, revoked_at TEXT
);
CREATE INDEX api_tokens_owner ON api_tokens(user_id,created_at);
CREATE TABLE device_authorizations (
 device_hash TEXT PRIMARY KEY, user_code_hash TEXT NOT NULL UNIQUE,
 user_id TEXT REFERENCES users(id) ON DELETE CASCADE, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','denied','consumed')),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, next_poll_at TEXT NOT NULL,
 poll_interval INTEGER NOT NULL DEFAULT 5, token_id TEXT REFERENCES api_tokens(id) ON DELETE SET NULL
);
CREATE INDEX device_expiry ON device_authorizations(expires_at);
