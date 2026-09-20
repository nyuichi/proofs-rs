import { Hono } from "hono";
import semver from "semver";
import {
  App,
  Ctx,
  Fault,
  now,
  uid,
  one,
  rows,
  stmt,
  batch,
  guard,
  quota,
  requireUser,
  jsonBody,
  text,
  positive,
  url,
  page,
  paged,
  idempotent,
  publicClaim,
  latest,
  karmaPolicy,
  hash,
  verifyToken,
  listing,
} from "./core";
const api = new Hono<App>();
const visible = (db: D1Database, id: number) =>
  one(db, "SELECT * FROM claims WHERE id=? AND visibility=?", id, "public");
async function claim(c: Ctx) {
  const q = await visible(c.env.DB, positive(c.req.param("id")));
  if (!q) throw new Fault(404, "claim_not_found");
  return q;
}
const activeGuard = (c: Ctx) =>
  guard(
    c.env.DB,
    "EXISTS(SELECT 1 FROM users WHERE id=? AND status='active' AND accepted_terms_version=?)",
    requireUser(c).id,
    c.env.TERMS_VERSION,
  );
function publicComment(cm: any) {
  const { author_id, visibility, ...rest } = cm;
  if (cm.deleted_at || visibility !== "public") rest.body = null;
  if (visibility !== "public") rest.username = null;
  return { ...rest, author_id, hidden: visibility !== "public" };
}
api.get("/health", (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT }));
api.get("/config", (c) =>
  c.json({
    environment: c.env.ENVIRONMENT,
    oauth_configured: !!(c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET),
    email_disabled: c.env.EMAIL_DISABLED === "true",
    email_configured:
      c.env.EMAIL_DISABLED !== "true" && !!(c.env.EMAIL && c.env.EMAIL_FROM),
    terms_version: c.env.TERMS_VERSION,
  }),
);
api.get("/terms/current", (c) =>
  c.json({
    version: c.env.TERMS_VERSION,
    url: "/#/terms",
    summary: "Terms for the proofs.rs verification-claim registry.",
    requires_agreement:
      !!c.get("user") &&
      c.get("user")!.accepted_terms_version !== c.env.TERMS_VERSION,
  }),
);
api.get("/me", async (c) => {
  const u = c.get("user");
  if (!u) return c.json({ user: null });
  const email = await one(
    c.env.DB,
    "SELECT address,delivery_status FROM email_contacts WHERE user_id=?",
    u.id,
  );
  const delayed = await one(
    c.env.DB,
    "SELECT COUNT(*) n FROM email_deliveries WHERE user_id=? AND status IN ('pending','retry','unknown')",
    u.id,
  );
  return c.json({
    user: u,
    csrf: c.get("csrf"),
    email,
    delayed_notifications: delayed.n,
    karma: await karmaPolicy.compute(c.env.DB, u.id),
    terms_required: u.accepted_terms_version !== c.env.TERMS_VERSION,
  });
});
api.post("/me/terms-acceptance", async (c) => {
  const u = requireUser(c),
    b = await jsonBody(c);
  if (b.version !== c.env.TERMS_VERSION) throw new Fault(409, "terms_changed");
  await stmt(
    c.env.DB,
    "UPDATE users SET accepted_terms_version=?,terms_accepted_at=? WHERE id=? AND accepted_terms_version<>?",
    b.version,
    now(),
    u.id,
    b.version,
  ).run();
  return c.json({ ok: true });
});
api.get("/me/notification-preferences", async (c) =>
  c.json(
    await one(
      c.env.DB,
      "SELECT replies,claim_comments FROM notification_preferences WHERE user_id=?",
      requireUser(c).id,
    ),
  ),
);
api.patch("/me/notification-preferences", async (c) => {
  const u = requireUser(c),
    b = await jsonBody(c);
  if (typeof b.replies !== "boolean" || typeof b.claim_comments !== "boolean")
    throw new Fault(400, "invalid_preferences");
  await stmt(
    c.env.DB,
    "UPDATE notification_preferences SET replies=?,claim_comments=? WHERE user_id=?",
    +b.replies,
    +b.claim_comments,
    u.id,
  ).run();
  return c.json({ ok: true });
});
api.post("/notifications/unsubscribe", async (c) => {
  const b = await jsonBody(c);
  if (
    typeof b.user !== "string" ||
    typeof b.signature !== "string" ||
    !(await verifyToken(c.env, `unsubscribe:${b.user}`, b.signature))
  )
    throw new Fault(403, "invalid_token");
  await stmt(
    c.env.DB,
    "UPDATE notification_preferences SET replies=0,claim_comments=0 WHERE user_id=?",
    b.user,
  ).run();
  return c.json({ ok: true });
});
api.get("/home", async (c) => {
  const db = c.env.DB;
  const crates = await rows(
    db,
    `SELECT cr.id,cr.name,cr.description,MAX(c.updated_at) updated_at,COUNT(c.id) claim_count FROM crates cr JOIN releases rel ON rel.crate_id=cr.id JOIN api_items a ON a.release_id=rel.id JOIN claims c ON c.api_item_id=a.id WHERE c.visibility='public' GROUP BY cr.id ORDER BY updated_at DESC LIMIT 12`,
  );
  const discussion = await rows(
    db,
    `SELECT cm.id,cm.claim_id,cm.sequence_no,cm.revision_no,cm.body,cm.created_at,u.username,cm.author_id FROM comments cm JOIN claims c ON c.id=cm.claim_id LEFT JOIN users u ON u.id=cm.author_id WHERE c.visibility='public' AND cm.visibility='public' AND cm.deleted_at IS NULL ORDER BY cm.created_at DESC,cm.id DESC LIMIT 12`,
  );
  return c.json({ crates, discussion });
});
api.get("/crates", async (c) =>
  c.json(
    await listing(
      c,
      `SELECT cr.*,(SELECT COUNT(*) FROM claims c JOIN api_items a ON c.api_item_id=a.id JOIN releases r ON a.release_id=r.id WHERE r.crate_id=cr.id AND c.visibility='public') claim_count FROM crates cr WHERE name LIKE ? ESCAPE '\\' AND EXISTS(SELECT 1 FROM releases r JOIN api_items a ON a.release_id=r.id JOIN claims c ON c.api_item_id=a.id WHERE r.crate_id=cr.id AND c.visibility='public')`,
      ["%" + (c.req.query("q") || "").replace(/[\\%_]/g, "\\$&") + "%"],
      [{ sql: "cr.name", key: "name" }],
    ),
  ),
);
api.get("/crates/:name/releases", async (c) => {
  const releases = await rows(
    c.env.DB,
    `SELECT r.* FROM releases r JOIN crates cr ON cr.id=r.crate_id WHERE cr.name=? AND EXISTS(SELECT 1 FROM api_items a JOIN claims c ON c.api_item_id=a.id WHERE a.release_id=r.id AND c.visibility='public')`,
    c.req.param("name"),
  );
  releases.sort((a, b) => semver.rcompare(a.version, b.version));
  return c.json({
    items: releases,
    default_version:
      releases.find((x) => !semver.prerelease(x.version))?.version ||
      releases[0]?.version,
  });
});
api.get("/crates/:name/:version/apis", async (c) =>
  c.json(
    await listing(
      c,
      `SELECT a.*,(SELECT COUNT(*) FROM claims c WHERE c.api_item_id=a.id AND c.property='no_ub' AND c.visibility='public') no_ub_count,(SELECT COUNT(*) FROM claims c WHERE c.api_item_id=a.id AND c.property='panic_contract' AND c.visibility='public') panic_count FROM api_items a JOIN releases r ON r.id=a.release_id JOIN crates cr ON cr.id=r.crate_id JOIN doc_snapshots ds ON ds.release_id=r.id WHERE cr.name=? AND r.version=? AND a.display_path LIKE ?`,
      [
        c.req.param("name"),
        c.req.param("version"),
        "%" + (c.req.query("q") || "") + "%",
      ],
      [{ sql: "a.display_path", key: "display_path" }],
    ),
  ),
);
api.get("/apis/:id", async (c) => {
  const item = await one(
    c.env.DB,
    `SELECT a.*,cr.name crate,r.version,r.yanked,ds.target,ds.features_json,ds.rustdoc_format FROM api_items a JOIN releases r ON a.release_id=r.id JOIN crates cr ON cr.id=r.crate_id JOIN doc_snapshots ds ON ds.release_id=r.id WHERE a.id=?`,
    c.req.param("id"),
  );
  if (!item) throw new Fault(404, "api_not_found");
  return c.json(item);
});
api.get("/apis/:id/claims", async (c) =>
  c.json(
    await listing(
      c,
      publicClaim +
        ` WHERE c.api_item_id=? AND c.visibility='public' AND ${latest}`,
      [c.req.param("id")],
      [{ sql: "c.id", key: "id", desc: true }],
    ),
  ),
);
api.get("/claims/:id", async (c) => {
  await claim(c);
  const q = await one(
    c.env.DB,
    publicClaim + ` WHERE c.id=? AND ${latest}`,
    positive(c.req.param("id")),
  );
  const versions = await rows(
    c.env.DB,
    "SELECT revision_no,created_at FROM claim_revisions WHERE claim_id=? ORDER BY revision_no DESC",
    q.id,
  );
  return c.json({ ...q, versions });
});
api.get("/claims/:id/revisions/:n", async (c) => {
  await claim(c);
  const q = await one(
    c.env.DB,
    publicClaim + " WHERE c.id=? AND r.revision_no=?",
    positive(c.req.param("id")),
    positive(c.req.param("n")),
  );
  if (!q) throw new Fault(404, "revision_not_found");
  return c.json(q);
});
async function validate(c: Ctx, b: any) {
  const a = await one(
    c.env.DB,
    "SELECT a.* FROM api_items a JOIN doc_snapshots ds ON ds.release_id=a.release_id WHERE a.id=?",
    text(b.api_item_id, "API", 200, true),
  );
  if (!a) throw new Fault(400, "api_not_imported");
  if (!["no_ub", "panic_contract"].includes(b.property))
    throw new Fault(400, "invalid_property");
  const pre = text(
    b.precondition,
    "Preconditions",
    10000,
    b.property === "panic_contract" || !!a.is_unsafe,
  );
  const tv = await one(
    c.env.DB,
    "SELECT tv.id FROM tool_versions tv JOIN tools t ON t.id=tv.tool_id WHERE tv.id=? AND tv.selectable=1 AND t.active=1",
    text(b.tool_version_id, "Tool version", 200, true),
  );
  if (!tv) throw new Fault(400, "tool_version_unavailable");
  return {
    api_item_id: a.id,
    property: b.property,
    title: text(b.title, "Title", 1000, true),
    precondition: pre,
    explanation: text(b.explanation, "Explanation", 10000, true),
    trusted_assumptions: text(
      b.trusted_assumptions,
      "Trusted assumptions",
      10000,
      true,
    ),
    tool_version_id: tv.id,
    environment: text(b.environment, "Environment"),
    evidence_url: url(b.evidence_url),
    limitations: text(b.limitations, "Limitations"),
  };
}
const revisionValues = (v: any) => [
  v.title,
  v.precondition,
  v.explanation,
  v.trusted_assumptions,
  v.tool_version_id,
  v.environment,
  v.evidence_url,
  v.limitations,
  now(),
];
api.post("/claims/validate", async (c) => {
  requireUser(c);
  return c.json(await validate(c, await jsonBody(c)));
});
api.post("/claims", async (c) => {
  const u = requireUser(c),
    b = await jsonBody(c),
    v = await validate(c, b),
    resource = uid();
  const key = await idempotent(c, "claim", b, resource, async (createKey) => [
    activeGuard(c),
    quota(c.env.DB, u.id, "claim", 20),
    stmt(
      c.env.DB,
      "INSERT INTO claims(create_key,api_item_id,property,author_id,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      createKey,
      v.api_item_id,
      v.property,
      u.id,
      now(),
      now(),
    ),
    stmt(
      c.env.DB,
      "INSERT INTO claim_revisions SELECT id,1,?,?,?,?,?,?,?,?,? FROM claims WHERE create_key=?",
      ...revisionValues(v),
      createKey,
    ),
    stmt(
      c.env.DB,
      "UPDATE idempotency_keys SET resource_id=(SELECT CAST(id AS TEXT) FROM claims WHERE create_key=?) WHERE user_id=? AND operation=? AND key=?",
      createKey,
      u.id,
      "claim",
      c.req.header("Idempotency-Key"),
    ),
  ]);
  const result = await one(
    c.env.DB,
    "SELECT resource_id FROM idempotency_keys WHERE user_id=? AND operation=? AND key=?",
    u.id,
    "claim",
    c.req.header("Idempotency-Key"),
  );
  return c.json({ id: Number(result.resource_id) }, 201);
});
api.post("/claims/:id/revisions", async (c) => {
  const q = await claim(c),
    u = requireUser(c);
  if (q.author_id !== u.id) throw new Fault(403, "not_author");
  const b = await jsonBody(c),
    v = await validate(c, b),
    expected = positive(b.expected_revision);
  if (v.api_item_id !== q.api_item_id || v.property !== q.property)
    throw new Fault(400, "immutable_target");
  const n = expected + 1;
  await idempotent(c, "revision:" + q.id, b, String(n), async () => [
    activeGuard(c),
    guard(
      c.env.DB,
      "(SELECT MAX(revision_no) FROM claim_revisions WHERE claim_id=?)=? AND EXISTS(SELECT 1 FROM claims WHERE id=? AND author_id=? AND visibility='public')",
      q.id,
      expected,
      q.id,
      u.id,
    ),
    quota(c.env.DB, u.id, "claim", 20),
    stmt(
      c.env.DB,
      "INSERT INTO claim_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      q.id,
      n,
      ...revisionValues(v),
    ),
    stmt(c.env.DB, "UPDATE claims SET updated_at=? WHERE id=?", now(), q.id),
  ]);
  return c.json({ id: q.id, revision_no: n }, 201);
});
api.put("/claims/:id/withdrawal", async (c) => {
  const q = await claim(c),
    u = requireUser(c);
  if (q.author_id !== u.id) throw new Fault(403, "not_author");
  await batch(c.env.DB, [
    activeGuard(c),
    stmt(
      c.env.DB,
      "UPDATE claims SET withdrawn_at=COALESCE(withdrawn_at,?) WHERE id=? AND author_id=?",
      now(),
      q.id,
      u.id,
    ),
  ]);
  return c.json({ ok: true });
});
const commentSelect = `SELECT cm.*,u.username,COALESCE((SELECT SUM(value) FROM comment_votes WHERE comment_id=cm.id),0) score,(SELECT value FROM comment_votes WHERE comment_id=cm.id AND user_id=?) my_vote,(SELECT COUNT(*) FROM comments ch WHERE ch.reply_to_id=cm.id) reply_count FROM comments cm LEFT JOIN users u ON u.id=cm.author_id`;
api.get("/claims/:id/comments", async (c) => {
  const q = await claim(c);
  return c.json(
    await listing(
      c,
      commentSelect + " WHERE cm.claim_id=? AND cm.reply_to_id IS ?",
      [c.get("user")?.id || "", q.id, c.req.query("parent_id") || null],
      [{ sql: "cm.sequence_no", key: "sequence_no" }],
      publicComment,
    ),
  );
});
api.get("/comments/:id", async (c) => {
  const cm = await one(
    c.env.DB,
    commentSelect + " WHERE cm.id=?",
    c.get("user")?.id || "",
    c.req.param("id"),
  );
  if (!cm || !(await visible(c.env.DB, cm.claim_id)))
    throw new Fault(404, "comment_not_found");
  const ancestors = await rows(
    c.env.DB,
    `WITH RECURSIVE chain(id,reply_to_id,depth) AS (SELECT id,reply_to_id,0 FROM comments WHERE id=? UNION ALL SELECT p.id,p.reply_to_id,chain.depth+1 FROM comments p JOIN chain ON p.id=chain.reply_to_id) SELECT id FROM chain ORDER BY depth DESC`,
    cm.id,
  );
  return c.json({
    ...publicComment(cm),
    ancestors: ancestors.map((x) => x.id),
  });
});
api.post("/claims/:id/comments", async (c) => {
  const q = await claim(c),
    u = requireUser(c),
    b = await jsonBody(c),
    body = text(b.body, "Comment", 5000, true),
    rev = positive(b.revision_no),
    parent = b.reply_to_id ? text(b.reply_to_id, "Reply", 100) : null,
    id = uid(),
    event = uid();
  const resource = await idempotent(c, "comment:" + q.id, b, id, async () => [
    activeGuard(c),
    guard(
      c.env.DB,
      "EXISTS(SELECT 1 FROM claims WHERE id=? AND visibility='public')",
      q.id,
    ),
    quota(c.env.DB, u.id, "comment", 100),
    stmt(
      c.env.DB,
      "INSERT INTO comments(id,claim_id,sequence_no,revision_no,author_id,reply_to_id,body,created_at) SELECT ?,?,COALESCE(MAX(sequence_no),0)+1,?,?,?,?,? FROM comments WHERE claim_id=?",
      id,
      q.id,
      rev,
      u.id,
      parent,
      body,
      now(),
      q.id,
    ),
    stmt(
      c.env.DB,
      "INSERT INTO comment_history VALUES(?,1,?,?,?,?)",
      id,
      "create",
      body,
      u.id,
      now(),
    ),
    stmt(
      c.env.DB,
      "INSERT INTO outbox_events(id,type,aggregate_id,dedupe_key,payload,created_at) VALUES(?,?,?,?,?,?)",
      event,
      "comment",
      id,
      "comment:" + id,
      JSON.stringify({ comment_id: id }),
      now(),
    ),
  ]);
  return c.json({ id: resource }, 201);
});
async function editComment(c: Ctx, deleting: boolean) {
  const u = requireUser(c),
    b = await jsonBody(c),
    id = c.req.param("id"),
    cm = await one(c.env.DB, "SELECT * FROM comments WHERE id=?", id);
  if (!cm || !(await visible(c.env.DB, cm.claim_id)))
    throw new Fault(404, "comment_not_found");
  if (cm.author_id !== u.id) throw new Fault(403, "not_author");
  const expected = positive(b.edit_version),
    body = deleting ? null : text(b.body, "Comment", 5000, true);
  await batch(c.env.DB, [
    activeGuard(c),
    guard(
      c.env.DB,
      "EXISTS(SELECT 1 FROM comments cm JOIN claims c ON c.id=cm.claim_id WHERE cm.id=? AND cm.author_id=? AND cm.edit_version=? AND cm.deleted_at IS NULL AND cm.visibility='public' AND c.visibility='public')",
      id,
      u.id,
      expected,
    ),
    stmt(
      c.env.DB,
      "INSERT INTO comment_history VALUES(?,?,?,?,?,?)",
      id,
      expected + 1,
      deleting ? "delete" : "edit",
      body,
      u.id,
      now(),
    ),
    stmt(
      c.env.DB,
      "UPDATE comments SET body=?,edit_version=edit_version+1,edited_at=?,deleted_at=? WHERE id=?",
      body,
      now(),
      deleting ? now() : null,
      id,
    ),
    ...(deleting
      ? [stmt(c.env.DB, "DELETE FROM comment_votes WHERE comment_id=?", id)]
      : []),
  ]);
  return c.json({ ok: true, edit_version: expected + 1 });
}
api.patch("/comments/:id", (c) => editComment(c, false));
api.delete("/comments/:id", (c) => editComment(c, true));
api.on(["PUT", "DELETE"], "/comments/:id/vote", async (c) => {
  const u = requireUser(c),
    id = c.req.param("id");
  const cm = await one(c.env.DB, "SELECT * FROM comments WHERE id=?", id);
  if (!cm || !(await visible(c.env.DB, cm.claim_id)))
    throw new Fault(404, "comment_not_found");
  if (cm.author_id === u.id || cm.deleted_at || cm.visibility !== "public")
    throw new Fault(403, "vote_forbidden");
  const b = c.req.method === "PUT" ? await jsonBody(c) : {};
  if (c.req.method === "PUT" && ![-1, 1].includes(b.value))
    throw new Fault(400, "invalid_vote");
  await batch(c.env.DB, [
    activeGuard(c),
    guard(
      c.env.DB,
      "EXISTS(SELECT 1 FROM claims WHERE id=? AND visibility='public')",
      cm.claim_id,
    ),
    c.req.method === "DELETE"
      ? stmt(
          c.env.DB,
          "DELETE FROM comment_votes WHERE comment_id=? AND user_id=?",
          id,
          u.id,
        )
      : stmt(
          c.env.DB,
          "INSERT INTO comment_votes VALUES(?,?,?,?) ON CONFLICT(comment_id,user_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
          id,
          u.id,
          b.value,
          now(),
        ),
  ]);
  return c.json({ ok: true });
});
api.get("/claims/:id/revisions/:n/accepts", async (c) => {
  const q = await claim(c);
  return c.json(
    await listing(
      c,
      "SELECT a.user_id,u.username,a.created_at FROM accepts a JOIN users u ON u.id=a.user_id WHERE claim_id=? AND revision_no=?",
      [q.id, positive(c.req.param("n"))],
      [
        { sql: "a.created_at", key: "created_at" },
        { sql: "a.user_id", key: "user_id" },
      ],
    ),
  );
});
api.on(["PUT", "DELETE"], "/claims/:id/revisions/:n/accept", async (c) => {
  const q = await claim(c),
    u = requireUser(c),
    n = positive(c.req.param("n"));
  if (q.author_id === u.id) throw new Fault(403, "self_accept");
  await batch(c.env.DB, [
    activeGuard(c),
    guard(
      c.env.DB,
      "EXISTS(SELECT 1 FROM claims WHERE id=? AND visibility='public')",
      q.id,
    ),
    c.req.method === "DELETE"
      ? stmt(
          c.env.DB,
          "DELETE FROM accepts WHERE claim_id=? AND revision_no=? AND user_id=?",
          q.id,
          n,
          u.id,
        )
      : stmt(
          c.env.DB,
          "INSERT INTO accepts VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
          q.id,
          n,
          u.id,
          now(),
        ),
  ]);
  return c.json({ ok: true });
});
api.get("/users/:id", async (c) => {
  const u = await one(
    c.env.DB,
    "SELECT id,username,created_at FROM users WHERE id=? OR username=? ORDER BY id=? DESC LIMIT 1",
    c.req.param("id"),
    c.req.param("id"),
    c.req.param("id"),
  );
  if (!u) throw new Fault(404, "user_not_found");
  return c.json({
    ...u,
    karma: await karmaPolicy.compute(c.env.DB, u.id),
    algorithm_version: karmaPolicy.id,
  });
});
for (const prefix of ["/users/:id", "/me"]) {
  api.get(prefix + "/claims", async (c) =>
    c.json(
      await listing(
        c,
        publicClaim +
          ` WHERE c.author_id=? AND c.visibility='public' AND ${latest}`,
        [prefix === "/me" ? requireUser(c).id : c.req.param("id")],
        [{ sql: "c.id", key: "id", desc: true }],
      ),
    ),
  );
  api.get(prefix + "/comments", async (c) =>
    c.json(
      await listing(
        c,
        commentSelect +
          " JOIN claims c ON c.id=cm.claim_id WHERE cm.author_id=? AND c.visibility='public' AND cm.visibility='public'",
        [
          c.get("user")?.id || "",
          prefix === "/me" ? requireUser(c).id : c.req.param("id"),
        ],
        [
          { sql: "cm.created_at", key: "created_at", desc: true },
          { sql: "cm.id", key: "id", desc: true },
        ],
        publicComment,
      ),
    ),
  );
}
api.get("/me/accepts", async (c) =>
  c.json(
    await listing(
      c,
      publicClaim.replace(
        "SELECT c.id",
        "SELECT ac.created_at accepted_at,c.id",
      ) +
        " JOIN accepts ac ON ac.claim_id=c.id AND ac.revision_no=r.revision_no WHERE ac.user_id=? AND c.visibility='public'",
      [requireUser(c).id],
      [
        { sql: "ac.created_at", key: "accepted_at", desc: true },
        { sql: "c.id", key: "id", desc: true },
        { sql: "r.revision_no", key: "revision_no", desc: true },
      ],
    ),
  ),
);
api.get("/tools", async (c) =>
  c.json({
    items: await rows(c.env.DB, "SELECT * FROM tools ORDER BY name"),
    versions: await rows(
      c.env.DB,
      "SELECT * FROM tool_versions ORDER BY tool_id,version",
    ),
  }),
);
api.get("/tools/:slug", async (c) => {
  const t = await one(
    c.env.DB,
    "SELECT * FROM tools WHERE id=?",
    c.req.param("slug"),
  );
  if (!t) throw new Fault(404, "tool_not_found");
  return c.json({
    ...t,
    versions: await rows(
      c.env.DB,
      "SELECT * FROM tool_versions WHERE tool_id=?",
      t.id,
    ),
  });
});
api.get("/tools/:slug/claims", async (c) =>
  c.json(
    await listing(
      c,
      publicClaim + ` WHERE t.id=? AND c.visibility='public' AND ${latest}`,
      [c.req.param("slug")],
      [{ sql: "c.id", key: "id", desc: true }],
    ),
  ),
);
api.get("/resolve-api", async (c) => {
  const name = c.req.query("crate") || "",
    version = c.req.query("version") || "",
    path = c.req.query("path") || "";
  const a = await one(
    c.env.DB,
    `SELECT a.id FROM api_items a JOIN releases r ON r.id=a.release_id JOIN crates cr ON cr.id=r.crate_id JOIN doc_snapshots ds ON ds.release_id=r.id WHERE cr.name=? AND r.version=? AND a.display_path IN (?,?)`,
    name,
    version,
    path,
    name.replaceAll("-", "_") + "::" + path,
  );
  if (!a) throw new Fault(404, "api_not_found");
  return c.json(a);
});
export default api;
