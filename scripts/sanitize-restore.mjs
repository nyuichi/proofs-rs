// Offline restore gate. Run against a private SQLite copy before remote import.
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
const [database, markers] = process.argv.slice(2);
if (!database || !markers)
  throw Error(
    "Usage: node scripts/sanitize-restore.mjs private.sqlite latest-erasure-markers/",
  );
const db = new DatabaseSync(database);
db.exec("PRAGMA foreign_keys=ON; BEGIN");
try {
  for (const file of await readdir(markers)) {
    if (!file.endsWith(".json")) continue;
    const e = JSON.parse(await readFile(markers + "/" + file, "utf8"));
    if (e.user_id) {
      db.prepare(
        "DELETE FROM email_suppressions WHERE address IN (SELECT address FROM email_contacts WHERE user_id=?)",
      ).run(e.user_id);
      db.prepare(
        "UPDATE email_deliveries SET sent_address=NULL,user_id=NULL WHERE user_id=?",
      ).run(e.user_id);
      db.prepare("DELETE FROM users WHERE id=?").run(e.user_id);
    } else if (e.action === "redact_comment") {
      db.prepare("UPDATE comment_history SET body=NULL WHERE comment_id=?").run(
        e.target,
      );
      db.prepare(
        "UPDATE comments SET body=NULL,deleted_at=COALESCE(deleted_at,?) WHERE id=?",
      ).run(e.created_at, e.target);
      db.prepare("DELETE FROM comment_votes WHERE comment_id=?").run(e.target);
    } else if (e.action === "redact_revision") {
      db.exec("INSERT OR IGNORE INTO maintenance VALUES(1)");
      db.prepare(
        "UPDATE claim_revisions SET title='[Redacted]',precondition='',explanation='[Redacted]',trusted_assumptions='',environment='',evidence_url='https://example.invalid/redacted',limitations='' WHERE claim_id=? AND revision_no=?",
      ).run(e.target, e.revision_no);
      db.exec("DELETE FROM maintenance");
    } else throw Error("Unknown erasure marker");
  }
  // Restored sessions and pending email work must never become active automatically.
  db.exec(
    "DELETE FROM sessions; DELETE FROM oauth_flows; UPDATE email_deliveries SET status='cancelled' WHERE status IN ('pending','retry','sending'); INSERT OR REPLACE INTO settings VALUES('email_paused','1'); INSERT OR REPLACE INTO settings VALUES('imports_paused','1');",
  );
  if (db.prepare("PRAGMA foreign_key_check").all().length)
    throw Error("Foreign-key check failed");
  db.exec("COMMIT");
  console.log(
    "Erasure markers applied; sessions invalidated; background work paused.",
  );
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
} finally {
  db.close();
}
