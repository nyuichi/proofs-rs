CREATE TABLE pending_signups(token_hash TEXT PRIMARY KEY,profile_json TEXT NOT NULL,csrf TEXT NOT NULL,return_to TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE INDEX pending_signups_expiry ON pending_signups(expires_at);
