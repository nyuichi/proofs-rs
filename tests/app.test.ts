import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { app } from "../src/worker";
import { hash, Env } from "../src/core";
import { extractAPIs } from "../src/imports";
function database() {
  const db = new DatabaseSync(":memory:");
  for (const f of ["0001_schema.sql", "0002_tools.sql"])
    db.exec(
      readFileSync(new URL("../migrations/" + f, import.meta.url), "utf8"),
    );
  const prepare = (sql: string) => {
    let values: any[] = [];
    const q = {
      bind(...v: any[]) {
        values = v;
        return q;
      },
      async first() {
        return db.prepare(sql).get(...values) || null;
      },
      async all() {
        return { results: db.prepare(sql).all(...values) };
      },
      async run() {
        return { meta: db.prepare(sql).run(...values) };
      },
    };
    return q;
  };
  return {
    db,
    binding: {
      prepare,
      async batch(statements: any[]) {
        db.exec("BEGIN");
        try {
          const results = [];
          for (const s of statements) results.push(await s.run());
          db.exec("COMMIT");
          return results;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    } as unknown as D1Database,
  };
}
async function fixture() {
  const { db, binding } = database();
  const time = new Date().toISOString();
  for (const [id, n] of [
    ["alice", 1],
    ["bob", 2],
    ["admin", 3],
  ] as const) {
    db.prepare(
      "INSERT INTO users(id,github_id,username,role,accepted_terms_version,terms_accepted_at,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(id, n, id, id === "admin" ? "admin" : "user", "test", time, time);
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(
      await hash(id),
      id,
      "csrf",
      new Date(Date.now() + 86400000).toISOString(),
    );
    db.prepare("INSERT INTO notification_preferences(user_id) VALUES(?)").run(
      id,
    );
  }
  db.exec(
    `INSERT INTO crates(id,name) VALUES(1,'sample');INSERT INTO releases VALUES(1,1,'1.0.0','checksum',0,'${time}');INSERT INTO doc_snapshots VALUES(1,'test','{}',61,NULL,'https://docs.rs','hash','key','${time}');INSERT INTO api_items VALUES('safe',1,'sample::safe','sample::safe','function',0,'pub fn safe()','https://docs.rs');INSERT INTO api_items VALUES('unsafe',1,'sample::unsafe','sample::unsafe','function',1,'pub unsafe fn unsafe()','https://docs.rs');`,
  );
  const env = {
    DB: binding,
    ENVIRONMENT: "staging",
    APP_ORIGIN: "https://example.test",
    TERMS_VERSION: "test",
    EMAIL_ALLOWLIST: "",
    ARCHIVE: { put: async () => {} },
    ASSETS: { fetch: async () => new Response("assets") },
  } as unknown as Env;
  async function request(
    path: string,
    method = "GET",
    body?: any,
    user = "alice",
    headers: Record<string, string> = {},
  ) {
    const response = await app.request(
      "https://example.test/api/v1" + path,
      {
        method,
        headers: {
          Origin: env.APP_ORIGIN,
          Cookie: "__Host-proofsr_session=" + user,
          "X-CSRF-Token": "csrf",
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
    return { status: response.status, body: (await response.json()) as any };
  }
  return { db, env, request };
}
const claim = {
  api_item_id: "safe",
  property: "no_ub",
  title: "No UB",
  precondition: "",
  explanation: "Reason",
  trusted_assumptions: "Compiler",
  tool_version_id: "kani-0.68.0",
  environment: "",
  evidence_url: "https://example.test/proof",
  limitations: "",
};
test("claim revisions, idempotency, authorization, accepts and karma", async () => {
  const { request, db } = await fixture();
  const key = { "Idempotency-Key": "repeat-claim-key-123" };
  let r = await request("/claims", "POST", claim, "alice", key);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;
  assert.equal(
    (await request("/claims", "POST", claim, "alice", key)).body.id,
    id,
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM claims").get()?.n, 1);
  assert.equal(
    (
      await request(
        "/claims",
        "POST",
        { ...claim, title: "different" },
        "alice",
        key,
      )
    ).status,
    409,
  );
  assert.equal(
    (await request("/claims", "POST", { ...claim, api_item_id: "unsafe" }))
      .status,
    400,
  );
  assert.equal(
    (
      await request(
        `/claims/${id}/revisions`,
        "POST",
        { ...claim, expected_revision: 1 },
        "bob",
      )
    ).status,
    403,
  );
  assert.equal(
    (await request(`/claims/${id}/revisions/1/accept`, "PUT", {}, "alice"))
      .status,
    403,
  );
  assert.equal(
    (await request(`/claims/${id}/revisions/1/accept`, "PUT", {}, "bob"))
      .status,
    200,
  );
  assert.equal((await request("/users/alice")).body.karma, 1);
  assert.equal(
    (
      await request(`/claims/${id}/revisions`, "POST", {
        ...claim,
        title: "New",
        expected_revision: 1,
      })
    ).status,
    201,
  );
  assert.equal((await request(`/claims/${id}`)).body.accept_count, 0);
  assert.equal(
    (await request(`/claims/${id}/revisions/2/accept`, "PUT", {}, "bob"))
      .status,
    200,
  );
  assert.equal((await request("/users/alice")).body.karma, 1);
  assert.equal(
    (
      await request(`/claims/${id}/revisions`, "POST", {
        ...claim,
        expected_revision: 1,
      })
    ).status,
    409,
  );
  assert.throws(() =>
    db.prepare("UPDATE claim_revisions SET title=?").run("changed"),
  );
  assert.equal(
    (await request(`/claims/${id}/withdrawal`, "PUT", {})).status,
    200,
  );
  assert.equal((await request("/users/alice")).body.karma, 0);
});
test("nested replies, edit conflicts, private history, deletion and vote removal", async () => {
  const { request, db } = await fixture();
  const id = (await request("/claims", "POST", claim)).body.id;
  const comment = await request(
    `/claims/${id}/comments`,
    "POST",
    { body: "old", revision_no: 1 },
    "bob",
  );
  assert.equal(comment.status, 201, JSON.stringify(comment.body));
  const cid = comment.body.id;
  const reply = (
    await request(`/claims/${id}/comments`, "POST", {
      body: "reply",
      revision_no: 1,
      reply_to_id: cid,
    })
  ).body.id;
  const reply2 = (
    await request(
      `/claims/${id}/comments`,
      "POST",
      { body: "reply again", revision_no: 1, reply_to_id: reply },
      "bob",
    )
  ).body.id;
  assert.deepEqual((await request("/comments/" + reply2)).body.ancestors, [
    cid,
    reply,
    reply2,
  ]);
  assert.equal(
    (await request("/comments/" + cid + "/vote", "PUT", { value: 1 }, "bob"))
      .status,
    403,
  );
  assert.equal(
    (await request("/comments/" + cid + "/vote", "PUT", { value: 1 })).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/comments/" + cid,
        "PATCH",
        { body: "new", edit_version: 1 },
        "bob",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/comments/" + cid,
        "PATCH",
        { body: "stale", edit_version: 1 },
        "bob",
      )
    ).status,
    409,
  );
  assert.equal(
    (await request("/comments/" + cid, "DELETE", { edit_version: 2 }, "bob"))
      .status,
    200,
  );
  const deleted = (await request("/comments/" + cid)).body;
  assert.equal(deleted.body, null);
  assert.equal(deleted.score, 0);
  assert.equal(deleted.reply_count, 1);
  assert.deepEqual(
    db
      .prepare(
        "SELECT body FROM comment_history WHERE comment_id=? ORDER BY history_no",
      )
      .all(cid)
      .map((x) => x.body),
    ["old", "new", null],
  );
  assert.equal(
    (await request("/admin/comments/" + cid + "/history")).status,
    403,
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM outbox_events").get()?.n, 3);
});
test("CSRF, consent gate, private email and SQL search", async () => {
  const { request, db } = await fixture();
  assert.equal(
    (
      await request("/claims", "POST", claim, "alice", {
        "X-CSRF-Token": "bad",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/claims", "POST", claim, "alice", {
        Origin: "https://evil.test",
      })
    ).status,
    403,
  );
  db.prepare("UPDATE users SET accepted_terms_version=? WHERE id=?").run(
    "old",
    "alice",
  );
  assert.equal((await request("/claims", "POST", claim)).status, 428);
  assert.equal(
    (await request("/me/terms-acceptance", "POST", { version: "test" })).status,
    200,
  );
  await request("/claims", "POST", claim);
  assert.equal((await request("/crates?q=sam")).status, 200);
  assert.equal((await request("/crates?q=%25")).body.items.length, 0);
  assert.equal((await request("/users/alice")).body.github_id, undefined);
  assert.equal((await request("/claims/1/comments")).status, 200);
});
test("rustdoc fixture: public free functions, inherent methods, reexports, no trait methods; unknown formats fail", () => {
  const fn = {
    header: { is_unsafe: false, abi: "Rust" },
    generics: { params: [], where_predicates: [] },
    sig: { inputs: [], output: null },
  };
  const doc: any = {
    format_version: 61,
    root: 0,
    crate_version: "1.0.0",
    index: {
      0: { name: "sample", inner: { module: { items: [1, 2, 3, 6] } } },
      1: { name: "safe", visibility: "public", inner: { function: fn } },
      2: { name: "private", visibility: "default", inner: { function: fn } },
      3: {
        name: "Thing",
        visibility: "public",
        inner: { struct: { impls: [4, 7] } },
      },
      4: {
        inner: {
          impl: {
            for: { resolved_path: { path: "Thing" } },
            items: [5],
            generics: {},
          },
        },
      },
      5: {
        name: "run",
        visibility: "public",
        inner: {
          function: { ...fn, header: { is_unsafe: true, abi: "Rust" } },
        },
      },
      6: {
        name: "renamed",
        visibility: "public",
        inner: { use: { id: 1, name: "renamed", is_glob: false } },
      },
      7: { inner: { impl: { trait: { path: "Debug" }, items: [8] } } },
      8: { name: "fmt", visibility: "public", inner: { function: fn } },
    },
  };
  const apis = extractAPIs(doc, "sample", "1.0.0");
  assert.deepEqual(
    apis.map((a) => a.display_path),
    ["sample::safe", "sample::Thing::run", "sample::renamed"],
  );
  assert.equal(apis[1].is_unsafe, 1);
  assert.throws(() =>
    extractAPIs({ ...doc, format_version: 999 }, "sample", "1.0.0"),
  );
});
