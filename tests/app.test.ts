import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { app } from "../src/worker";
import { hash, Env } from "../src/core";
import { extractAPIs } from "../src/imports";
function database() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .sort())
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
async function fixture(seedTools = true) {
  const { db, binding } = database();
  if (seedTools)
    db.exec(
      "INSERT INTO tools VALUES('kani','Kani','Test verifier','https://example.test',1); INSERT INTO tool_versions VALUES('kani-0.68.0','kani','0.68.0',1);",
    );
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
  for (const [path, viewer] of [
    ["/me/comments", "bob"],
    ["/users/bob/comments", "bob"],
    ["/users/bob/comments", "alice"],
    ["/users/bob/comments", "anonymous"],
  ]) {
    const listing = await request(path, "GET", undefined, viewer);
    assert.equal(listing.status, 200);
    assert.deepEqual(
      listing.body.items.map((item: any) => item.id),
      [reply2],
    );
  }

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

test("keyset pagination remains stable after inserts, accepts include old revisions", async () => {
  const { request, db } = await fixture();
  for (let i = 0; i < 35; i++) {
    db.exec("DELETE FROM rate_limits");
    await request("/claims", "POST", { ...claim, title: "Claim " + i });
  }
  const first = (await request("/users/alice/claims")).body;
  assert.equal(first.items.length, 30);
  db.exec("DELETE FROM rate_limits");
  await request("/claims", "POST", { ...claim, title: "Newer" });
  const second = (
    await request(
      "/users/alice/claims?cursor=" + encodeURIComponent(first.next_cursor),
    )
  ).body;
  assert.deepEqual(
    second.items.map((x: any) => x.id),
    [5, 4, 3, 2, 1],
  );
  await request("/claims/1/revisions/1/accept", "PUT", {}, "bob");
  assert.equal(
    (await request("/me/accepts", "GET", undefined, "bob")).body.items[0].id,
    1,
  );
});

test("frontend publish preview, revision links and nested comment deletion", async () => {
  const { JSDOM } = await import("jsdom");
  const { transpileModule, ModuleKind, ScriptTarget } =
    await import("typescript");
  const { request } = await fixture();
  const dom = new JSDOM(
    readFileSync(new URL("../index.html", import.meta.url), "utf8"),
    {
      url: "https://example.test/#/publish?api=safe",
      runScripts: "outside-only",
    },
  );
  const w = dom.window;
  w.fetch = async (path: any, init: any = {}) => {
    const p = String(path).replace("/api/v1", "");
    const result = await request(
      p,
      init.method || "GET",
      init.body ? JSON.parse(init.body) : undefined,
      "alice",
      init.headers || {},
    );
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    }) as any;
  };
  w.confirm = () => true;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const legal = readFileSync(
    new URL("../web/legal.ts", import.meta.url),
    "utf8",
  ).replace("export const legal", "const legal");
  const main = readFileSync(
    new URL("../web/main.ts", import.meta.url),
    "utf8",
  ).replace(/import \{ legal \} from "\.\/legal";/, "");
  w.eval(
    transpileModule(legal + "\n" + main, {
      compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 },
    }).outputText,
  );
  async function until(selector: string) {
    for (let n = 0; n < 100; n++) {
      const el = w.document.querySelector(selector);
      if (
        el &&
        w.document.querySelector("#app")?.getAttribute("aria-busy") !== "true"
      )
        return el;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error(
      "Missing " +
        selector +
        ": " +
        w.document.querySelector("#app")?.textContent,
    );
  }
  const input = (name: string, value: string) => {
    (w.document.querySelector('[name="' + name + '"]') as any).value = value;
  };
  const submit = (selector: string) =>
    (w.document.querySelector(selector) as any).dispatchEvent(
      new w.Event("submit", { bubbles: true, cancelable: true }),
    );
  try {
    await until("#claim-form");
    input("property", "no_ub");
    w.document
      .querySelector('[name="property"]')!
      .dispatchEvent(new w.Event("change"));
    assert.match(
      w.document.querySelector("#pre-label")!.textContent!,
      /optional; mandatory for unsafe APIs/,
    );
    assert.equal(
      (w.document.querySelector('[name="precondition"]') as any).required,
      false,
    );
    for (const [k, v] of Object.entries(claim))
      if (w.document.querySelector('[name="' + k + '"]')) input(k, v);
    submit("#claim-form");
    await until("#publish");
    assert.match(w.document.querySelector("#app")!.textContent!, /Preview/);
    ((await until("#publish")) as any).click();
    await until("#comment-form");
    assert.match(w.document.querySelector("h1")!.textContent!, /#1: No UB/);
    input("body", "Root comment");
    submit("#comment-form");
    await until("[data-reply]");
    (w.document.querySelector("[data-reply]") as any).click();
    input("body", "Nested reply");
    submit("#comment-form");
    await until(".comment-children .comment");
    assert.match(
      w.document.querySelector(".comment-children .comment")!.textContent!,
      /Nested reply/,
    );
    (w.document.querySelector("[data-delete]") as any).click();
    await until(".comment-content em");
    assert.equal(
      w.document.querySelector(".comment-content em")!.textContent,
      "deleted comment",
    );
    assert.match(
      w.document.querySelector(".comment-children .comment")!.textContent!,
      /Nested reply/,
    );
    w.location.hash = "/account";
    await until("#claims");
    assert.equal(
      w.document.querySelector('a[href="https://github.com/alice"]')
        ?.textContent,
      "GitHub profile",
    );
    assert.equal(w.document.querySelector("#bio"), null);
    assert.match(
      w.document.querySelector("#activity-comments")!.textContent!,
      /Nested reply/,
    );
    assert.doesNotMatch(
      w.document.querySelector("#activity-comments")!.textContent!,
      /deleted comment/,
    );
    assert.doesNotMatch(
      w.document.querySelector("#activity-comments")!.textContent!,
      /Root comment/,
    );
    assert.match(
      w.document.querySelector("#account-nav")!.textContent!,
      /My activity/,
    );
    w.location.hash = "/settings?email=retry";
    await until("#prefs");
    assert.deepEqual(
      Array.from(
        w.document.querySelectorAll("#app h2"),
        (el) => el.textContent,
      ),
      ["Account", "Email notifications", "Tokens", "Delete my account"],
    );
    assert.doesNotMatch(
      w.document.querySelector("#app")!.textContent!,
      /Pending or uncertain deliveries/,
    );
    assert.match(
      w.document.querySelector("#app")!.textContent!,
      /GitHub email lookup failed/,
    );
    assert.match(
      w.document.querySelector("#app")!.textContent!,
      /For account deletion/,
    );
  } finally {
    w.close();
  }
});

test("empty catalogue can be managed through the authenticated admin API", async () => {
  const { request } = await fixture(false);
  const empty = await request("/tools");
  assert.deepEqual(empty.body.items, []);
  assert.deepEqual(empty.body.versions, []);
  const tool = {
    action: "tool",
    target: "test-verifier",
    name: "Test verifier",
    description: "A configurable tool",
    url: "https://example.test/verifier",
    reason: "Register tool",
  };
  assert.equal((await request("/admin/action", "POST", tool)).status, 403);
  assert.equal(
    (await request("/admin/action", "POST", tool, "admin")).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        {
          action: "tool_version",
          target: "test-verifier-1",
          tool_id: tool.target,
          version: "1.0",
          reason: "Register version",
        },
        "admin",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        { ...tool, name: "Updated verifier" },
        "admin",
      )
    ).status,
    200,
  );
  const catalogue = await request("/tools");
  assert.equal(catalogue.body.items.length, 1);
  assert.equal(catalogue.body.items[0].name, "Updated verifier");
  assert.equal(catalogue.body.versions[0].version, "1.0");
});

test("removing Bio preserves accounts and removes it from public and private APIs", async () => {
  const legacy = new DatabaseSync(":memory:");
  legacy.exec(
    readFileSync(
      new URL("../migrations/0001_schema.sql", import.meta.url),
      "utf8",
    ),
  );
  legacy.exec(
    "INSERT INTO users(id,github_id,username,bio,accepted_terms_version,terms_accepted_at,created_at) VALUES('legacy',42,'legacy','Old biography','test','2026-09-20','2026-09-20')",
  );
  legacy.exec(
    readFileSync(
      new URL("../migrations/0004_remove_bio.sql", import.meta.url),
      "utf8",
    ),
  );
  const retained = legacy.prepare("SELECT * FROM users").get()!;
  assert.equal(retained.id, "legacy");
  assert.equal(retained.github_id, 42);
  assert.equal("bio" in retained, false);
  legacy.close();
  const { request } = await fixture();
  const publicUser = await request("/users/alice");
  assert.equal(publicUser.status, 200);
  assert.equal("bio" in publicUser.body, false);
  assert.equal("bio" in (await request("/me")).body.user, false);
  assert.equal(
    (await request("/me", "PATCH", { bio: "Cannot save" })).status,
    404,
  );
});

test("device login, one-time exchange, scope isolation, ownership and revocation", async () => {
  const { env, db, request } = await fixture();
  async function auth(
    path: string,
    body: any,
    browser = false,
    headers: Record<string, string> = {},
  ) {
    const r = await app.request(
      "https://example.test/auth/device/" + path,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(browser
            ? {
                Origin: env.APP_ORIGIN,
                Cookie: "__Host-proofsr_session=alice",
                "X-CSRF-Token": "csrf",
              }
            : {}),
          ...headers,
        },
        body: JSON.stringify(body),
      },
      env,
    );
    return { status: r.status, body: (await r.json()) as any };
  }
  const start = await auth("code", { client_id: "proofs-cli" });
  assert.equal(start.status, 200);
  const poll = {
    client_id: "proofs-cli",
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: start.body.device_code,
  };
  assert.equal((await auth("token", poll)).body.error, "authorization_pending");
  assert.equal((await auth("token", poll)).body.error, "slow_down");
  assert.equal(
    (await auth("approve", { user_code: start.body.user_code })).status,
    403,
  );
  assert.equal(
    (
      await auth("approve", { user_code: start.body.user_code }, true, {
        "X-CSRF-Token": "wrong",
      })
    ).status,
    403,
  );
  assert.equal(
    (await auth("inspect", { user_code: start.body.user_code }, true)).body
      .state,
    "pending",
  );
  assert.equal(
    (await auth("approve", { user_code: start.body.user_code }, true)).status,
    200,
  );
  assert.equal(
    (await auth("approve", { user_code: start.body.user_code }, true)).status,
    409,
  );
  db.exec("UPDATE device_authorizations SET next_poll_at='2000-01-01'");
  const issued = await auth("token", poll);
  assert.equal(issued.status, 200);
  assert.ok(issued.body.access_token);
  assert.equal((await auth("token", poll)).body.error, "invalid_grant");
  const stored = db.prepare("SELECT * FROM api_tokens").get() as any;
  assert.equal(stored.token_hash, await hash(issued.body.access_token));
  assert.equal(stored.name, undefined);
  const headers = {
    Authorization: "Bearer " + issued.body.access_token,
    Origin: "",
    "X-CSRF-Token": "",
    Cookie: "",
  };
  assert.equal(
    (await request("/claims", "POST", claim, "", headers)).status,
    201,
  );
  assert.equal(
    (
      await request(
        "/claims/1/revisions",
        "POST",
        { ...claim, expected_revision: 1, title: "Updated" },
        "",
        headers,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await request(
        "/publish/prepare",
        "POST",
        { crate: "sample", version: "1.0.0" },
        "",
        headers,
      )
    ).body.status,
    "ready",
  );
  assert.equal(
    (await request("/admin/audit", "GET", undefined, "", headers)).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/claims/1/comments",
        "POST",
        { body: "hello", revision_no: 1 },
        "",
        headers,
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("/me/tokens", "GET", undefined, "", headers)).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/me/terms-acceptance",
        "POST",
        { version: "test" },
        "",
        headers,
      )
    ).status,
    403,
  );
  const listed = (await request("/me/tokens")).body.items;
  assert.equal(listed[0].id, issued.body.token_id);
  assert.ok(!("token_hash" in listed[0]));
  await request(
    "/me/tokens/" + issued.body.token_id,
    "DELETE",
    undefined,
    "bob",
  );
  assert.equal(
    (await request("/me", "GET", undefined, "", headers)).status,
    200,
  );
  db.exec("UPDATE users SET accepted_terms_version='old' WHERE id='alice'");
  assert.equal(
    (await request("/claims", "POST", claim, "", headers)).status,
    428,
  );
  assert.equal(
    (await request("/tokens/revoke", "POST", {}, "", headers)).status,
    200,
  );
  assert.equal(
    (await request("/me", "GET", undefined, "", headers)).status,
    401,
  );
  // Invalid Bearer must not fall back to the valid browser session.
  assert.equal(
    (
      await request("/me", "GET", undefined, "alice", {
        Authorization: "Bearer bad",
      })
    ).status,
    401,
  );
});

test("device expiry, token expiry, suspension, quotas, and user erasure", async () => {
  const { env, db, request } = await fixture();
  const token = "a".repeat(64),
    h = await hash(token),
    future = new Date(Date.now() + 86400000).toISOString();
  db.prepare(
    "INSERT INTO api_tokens(id,user_id,token_hash,scope,created_at,expires_at) VALUES('token','alice',?,'publish',?,?)",
  ).run(h, new Date().toISOString(), future);
  const headers = { Authorization: "Bearer " + token };
  db.exec("UPDATE api_tokens SET expires_at='2000-01-01'");
  assert.equal(
    (await request("/me", "GET", undefined, "", headers)).status,
    401,
  );
  db.prepare("UPDATE api_tokens SET expires_at=?").run(future);
  await request(
    "/admin/action",
    "POST",
    { action: "suspend", target: "alice", reason: "Test" },
    "admin",
  );
  await request(
    "/admin/action",
    "POST",
    { action: "restore_user", target: "alice", reason: "Test" },
    "admin",
  );
  assert.equal(
    (await request("/me", "GET", undefined, "", headers)).status,
    401,
  );
  const r = await app.request(
    "https://example.test/auth/device/code",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "client_id=proofs-cli",
    },
    env,
  );
  const start = (await r.json()) as any;
  assert.equal(r.status, 200);
  db.exec("UPDATE device_authorizations SET expires_at='2000-01-01'");
  const poll = await app.request(
    "https://example.test/auth/device/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: "proofs-cli",
        device_code: start.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    },
    env,
  );
  assert.equal(((await poll.json()) as any).error, "expired_token");
  db.exec("UPDATE rate_limits SET used=lim WHERE kind='device_start'");
  const limited = await app.request(
    "https://example.test/auth/device/code",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "proofs-cli" }),
    },
    env,
  );
  assert.equal(limited.status, 429);
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        { action: "delete_user", target: "alice", reason: "Test" },
        "admin",
      )
    ).status,
    200,
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM api_tokens").get()!.n, 0);
});

test("OpenAPI covers every registered API/auth route with resolvable schema references", () => {
  const spec = JSON.parse(
    readFileSync(new URL("../public/openapi.json", import.meta.url), "utf8"),
  );
  const actual = new Set(
    app.routes
      .filter(
        (r) =>
          r.method !== "ALL" &&
          !r.path.includes("*") &&
          (r.path.startsWith("/api/") || r.path.startsWith("/auth/")),
      )
      .map(
        (r) =>
          r.method.toLowerCase() +
          " " +
          r.path.replace(/:([a-zA-Z]+)/g, "{$1}"),
      ),
  );
  const documented = new Set(
    Object.entries(spec.paths).flatMap(([p, methods]) =>
      Object.keys(methods as any).map((m) => m + " " + p),
    ),
  );
  assert.deepEqual(documented, actual);
  function walk(v: any) {
    if (!v || typeof v !== "object") return;
    if (v.$ref) {
      assert.ok(v.$ref.startsWith("#/components/"));
      assert.ok(spec.components[v.$ref.split("/")[2]][v.$ref.split("/").pop()]);
    }
    Object.values(v).forEach(walk);
  }
  walk(spec);
});

test("browser approval returns through terms acceptance and exposes only token UUIDs", async () => {
  const { env, db } = await fixture();
  const { JSDOM } = await import("jsdom");
  const { transpileModule, ModuleKind, ScriptTarget } =
    await import("typescript");
  const start = await app.request(
    "https://example.test/auth/device/code",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"client_id":"proofs-cli"}',
    },
    env,
  );
  const device = (await start.json()) as any;
  db.exec("UPDATE users SET accepted_terms_version='old' WHERE id='alice'");
  const dom = new JSDOM(
      readFileSync(new URL("../index.html", import.meta.url), "utf8"),
      {
        url: "https://example.test/#/device?code=" + device.user_code,
        runScripts: "outside-only",
      },
    ),
    w = dom.window;
  w.fetch = async (path: any, init: any = {}) =>
    app.request(
      new URL(String(path), "https://example.test").href,
      {
        ...init,
        headers: {
          ...init.headers,
          Origin: env.APP_ORIGIN,
          Cookie: "__Host-proofsr_session=alice",
        },
      },
      env,
    ) as any;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const code =
    readFileSync(new URL("../web/legal.ts", import.meta.url), "utf8").replace(
      "export const legal",
      "const legal",
    ) +
    "\n" +
    readFileSync(new URL("../web/main.ts", import.meta.url), "utf8").replace(
      'import { legal } from "./legal";',
      "",
    );
  w.eval(
    transpileModule(code, {
      compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 },
    }).outputText,
  );
  const until = async (selector: string) => {
    for (let n = 0; n < 100; n++) {
      const el = w.document.querySelector(selector);
      if (el && !w.document.querySelector("#app")!.hasAttribute("inert"))
        return el;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error(w.document.querySelector("#app")!.textContent || selector);
  };
  try {
    ((await until("#agree")) as any).click();
    ((await until("#device-authorize")) as any).click();
    await until('a[href="#/settings"]');
    for (
      let n = 0;
      n < 100 &&
      !w.document.querySelector("#app")!.textContent!.includes("CLI connected");
      n++
    )
      await new Promise((r) => setTimeout(r, 10));
    assert.match(
      w.document.querySelector("#app")!.textContent!,
      /CLI connected/,
    );
    const issued = await app.request(
      "https://example.test/auth/device/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: "proofs-cli",
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
      env,
    );
    const token = (await issued.json()) as any;
    assert.equal(issued.status, 200);
    w.location.hash = "/settings";
    await until("[data-revoke]");
    assert.match(
      w.document.querySelector("#app")!.textContent!,
      new RegExp(token.token_id),
    );
    assert.ok(!w.document.body.textContent!.includes(token.access_token));
    (w.document.querySelector("[data-revoke]") as any).click();
    ((await until("#confirm-revoke")) as any).click();
    for (let n = 0; n < 100 && w.document.querySelector("[data-revoke]"); n++)
      await new Promise((r) => setTimeout(r, 10));
    assert.match(w.document.querySelector("#app")!.textContent!, /No tokens/);
  } finally {
    w.close();
  }
});
