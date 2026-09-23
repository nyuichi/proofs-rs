import { Hono } from "hono";
import {
  App,
  Fault,
  requireUser,
  jsonBody,
  text,
  uid,
  now,
  stmt,
  batch,
  rows,
  one,
  url,
} from "./core";
export const admin = new Hono<App>();
admin.use("*", async (c, next) => {
  const u = requireUser(c);
  if (u.role !== "admin") throw new Fault(403, "admin_required");
  await next();
});
admin.get("/audit", async (c) =>
  c.json({
    items: await rows(
      c.env.DB,
      "SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 100",
    ),
  }),
);
admin.get("/comments/:id/history", async (c) => {
  await stmt(
    c.env.DB,
    "INSERT INTO audit_events VALUES(?,?,?,?,?,?)",
    uid(),
    requireUser(c).id,
    "read_report_comment_history",
    c.req.param("id"),
    "Administrative review",
    now(),
  ).run();
  return c.json({
    items: await rows(
      c.env.DB,
      "SELECT * FROM report_comment_history WHERE comment_id=? ORDER BY history_no",
      c.req.param("id"),
    ),
  });
});
admin.get("/deliveries", async (c) =>
  c.json({
    items: await rows(
      c.env.DB,
      "SELECT id,status,attempts,created_at FROM email_deliveries WHERE status IN ('unknown','failed','rejected') ORDER BY created_at LIMIT 100",
    ),
  }),
);
admin.post("/action", async (c) => {
  const u = requireUser(c),
    b = await jsonBody(c),
    reason = text(b.reason, "Reason", 1000, true),
    target = text(String(b.target || ""), "Target", 200, true),
    db = c.env.DB,
    ss = [
      stmt(
        db,
        "INSERT INTO audit_events VALUES(?,?,?,?,?,?)",
        uid(),
        u.id,
        b.action,
        target,
        reason,
        now(),
      ),
    ];
  switch (b.action) {
    case "report_visibility":
      if (!["public", "hidden"].includes(b.value))
        throw new Fault(400, "invalid_visibility");
      ss.push(
        stmt(db, "UPDATE reports SET visibility=? WHERE id=?", b.value, target),
      );
      break;
    case "comment_visibility":
      if (!["public", "hidden"].includes(b.value))
        throw new Fault(400, "invalid_visibility");
      ss.push(
        stmt(
          db,
          "UPDATE report_comments SET visibility=? WHERE id=?",
          b.value,
          target,
        ),
      );
      break;
    case "suspend":
      ss.push(
        stmt(db, "UPDATE users SET status='suspended' WHERE id=?", target),
        stmt(db, "DELETE FROM sessions WHERE user_id=?", target),
        stmt(
          db,
          "UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=?",
          now(),
          target,
        ),
        stmt(
          db,
          "UPDATE device_authorizations SET state='denied' WHERE user_id=? AND state='approved'",
          target,
        ),
      );
      break;
    case "restore_user":
      ss.push(stmt(db, "UPDATE users SET status='active' WHERE id=?", target));
      break;
    case "pause":
      if (!["email_paused", "imports_paused"].includes(target))
        throw new Fault(400, "invalid_setting");
      ss.push(
        stmt(
          db,
          "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          target,
          b.value ? "1" : "0",
        ),
      );
      break;
    case "redact_comment":
      await c.env.ARCHIVE.put(
        "erasures/comment-" + target + ".json",
        JSON.stringify({ action: "redact_comment", target, created_at: now() }),
      );
      ss.push(
        stmt(
          db,
          "UPDATE report_comment_history SET body=NULL WHERE comment_id=?",
          target,
        ),
        stmt(
          db,
          "UPDATE report_comments SET body=NULL,deleted_at=COALESCE(deleted_at,?),edit_version=edit_version+1 WHERE id=?",
          now(),
          target,
        ),
        stmt(db, "DELETE FROM report_comment_votes WHERE comment_id=?", target),
      );
      break;
    case "redact_revision":
      if (!Number.isSafeInteger(b.revision_no) || b.revision_no < 1)
        throw new Fault(400, "invalid_revision");
      await c.env.ARCHIVE.put(
        "erasures/revision-" + target + "-" + b.revision_no + ".json",
        JSON.stringify({
          action: "redact_revision",
          target,
          revision_no: b.revision_no,
          created_at: now(),
        }),
      );
      ss.push(
        stmt(db, "INSERT INTO maintenance VALUES(1)"),
        stmt(
          db,
          "UPDATE report_revisions SET title='[Redacted]',explanation='[Redacted]',trusted_assumptions='',environment='',evidence_url='https://example.invalid/redacted',limitations='' WHERE report_id=? AND revision_no=?",
          target,
          Number(b.revision_no),
        ),
        stmt(
          db,
          "UPDATE claim_revisions SET title='[Redacted]',precondition='',explanation='[Redacted]',trusted_assumptions='',evidence_url='',limitations='' WHERE report_id=? AND report_revision=?",
          target,
          Number(b.revision_no),
        ),
        stmt(
          db,
          "DELETE FROM report_runs WHERE report_id=? AND revision_no=?",
          target,
          Number(b.revision_no),
        ),
        stmt(db, "DELETE FROM maintenance"),
      );
      break;
    case "delete_user":
      if (target === u.id) throw new Fault(400, "cannot_delete_self_admin");
      await envErase(c.env, target);
      ss.push(
        stmt(
          db,
          "UPDATE email_deliveries SET sent_address=NULL,user_id=NULL WHERE user_id=?",
          target,
        ),
        stmt(db, "DELETE FROM users WHERE id=?", target),
      );
      break;
    case "retry_email":
      ss.push(
        stmt(
          db,
          "UPDATE email_deliveries SET status='pending',next_attempt_at=NULL,provider_id=NULL WHERE id=? AND status IN ('unknown','failed','rejected')",
          target,
        ),
      );
      break;
    case "tool_version_limitations": {
      const version = await one(
        db,
        "SELECT id FROM tool_versions WHERE id=?",
        target,
      );
      if (!version) throw new Fault(404, "tool_version_not_found");
      ss.push(
        stmt(
          db,
          "UPDATE tool_versions SET limitations=?,limitations_updated_at=? WHERE id=?",
          text(b.limitations, "Limitations", 10000),
          now(),
          target,
        ),
      );
      break;
    }
    case "tool_version":
      ss.push(
        stmt(
          db,
          "INSERT INTO tool_versions(id,tool_id,version,selectable) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET selectable=excluded.selectable",
          target,
          text(b.tool_id, "Tool", 100, true),
          text(b.version, "Version", 100, true),
          b.selectable === false ? 0 : 1,
        ),
      );
      break;
    case "tool":
      ss.push(
        stmt(
          db,
          "INSERT INTO tools VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,official_url=excluded.official_url,active=excluded.active",
          target,
          text(b.name, "Name", 100, true),
          text(b.description, "Description"),
          url(b.url),
          b.active === false ? 0 : 1,
        ),
      );
      break;
    default:
      throw new Fault(400, "unknown_admin_action");
  }
  await batch(db, ss);
  return c.json({ ok: true });
});
async function envErase(env: App["Bindings"], id: string) {
  await env.ARCHIVE.put(
    "erasures/" + id + ".json",
    JSON.stringify({ user_id: id, created_at: now() }),
  );
  await stmt(
    env.DB,
    "INSERT INTO erasures VALUES(?,?) ON CONFLICT DO NOTHING",
    id,
    now(),
  ).run();
  const e = await one(
    env.DB,
    "SELECT address FROM email_contacts WHERE user_id=?",
    id,
  );
  if (e?.address)
    await stmt(
      env.DB,
      "DELETE FROM email_suppressions WHERE address=?",
      e.address,
    ).run();
}
