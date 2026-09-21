import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { app } from "../src/worker";
import { hash, Env } from "../src/core";
import { extractAPIs, importJob } from "../src/imports";
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
const reportInput = {
  crate: "sample",
  version: "1.0.0",
  title: "A verification report",
  tool_version_id: "kani-0.68.0",
  explanation: "",
  trusted_assumptions: "",
  environment: "test",
  evidence_url: "https://example.test/proof",
  claims: [
    {
      api_item_id: "safe",
      property: "no_ub",
      title: "",
      precondition: "",
      explanation: "",
      trusted_assumptions: "",
      evidence_url: "",
    },
  ],
};
test("atomic reports, stable claims, immutable targets, revision conflicts and permanent stars", async () => {
  const { request, db } = await fixture();
  let v = await request("/reports/validate", "POST", reportInput);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(
    v.body.claims[0].title,
    "No undefined behavior for sample::safe (with Kani 0.68.0)",
  );
  const key = { "Idempotency-Key": "report-create-key-123" };
  const made = await request("/reports", "POST", reportInput, "alice", key);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id;
  assert.equal(
    (await request("/reports", "POST", reportInput, "alice", key)).body.id,
    id,
  );
  assert.equal(
    (
      await request(
        "/reports",
        "POST",
        { ...reportInput, title: "changed" },
        "alice",
        key,
      )
    ).status,
    409,
  );
  let r = (await request("/reports/" + id)).body;
  const claimID = r.claims[0].id;
  assert.equal(
    (await request(`/reports/${id}/star`, "PUT", {}, "alice")).status,
    200,
  );
  assert.equal((await request("/users/alice")).body.karma, 0);
  await request(`/reports/${id}/star`, "PUT", {}, "bob");
  await request(`/claims/${claimID}/star`, "PUT", {}, "bob");
  assert.equal((await request("/users/alice")).body.karma, 1);
  const rev = {
    ...reportInput,
    title: "Revised",
    expected_revision: 1,
    claims: [
      { ...reportInput.claims[0], id: claimID, explanation: "New content" },
      { ...reportInput.claims[0], title: "Another scope" },
    ],
  };
  assert.equal(
    (await request(`/reports/${id}/revisions`, "POST", rev, "bob")).status,
    403,
  );
  v = await request(`/reports/${id}/revisions`, "POST", rev);
  assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.equal(
    (await request(`/reports/${id}/revisions`, "POST", rev)).status,
    409,
  );
  r = (await request("/reports/" + id)).body;
  assert.equal(r.star_count, 2);
  assert.equal(r.claims[0].id, claimID);
  assert.equal(r.claims[0].star_count, 1);
  assert.equal(
    (await request(`/claims/${claimID}?report_revision=1`)).body.explanation,
    "",
  );
  assert.equal(
    (
      await request(`/reports/${id}/revisions`, "POST", {
        ...rev,
        expected_revision: 2,
        claims: [
          {
            ...rev.claims[0],
            property: "panic_contract",
            precondition: "true",
          },
        ],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/reports/${id}/revisions`, "POST", {
        ...rev,
        expected_revision: 2,
        claims: [r.claims[1]],
      })
    ).status,
    201,
  );
  let removed = (await request("/claims/" + claimID)).body;
  assert.equal(removed.in_current_report, 0);
  assert.equal(removed.star_count, 1);
  assert.equal((await request("/apis/safe/claims")).body.items.length, 1);
  assert.equal(
    (await request("/me/starred-claims", "GET", undefined, "bob")).body.items[0]
      .id,
    claimID,
  );
  assert.equal(
    (await request("/me/starred-reports", "GET", undefined, "bob")).body
      .items[0].id,
    id,
  );
  assert.throws(
    () => db.prepare("UPDATE report_revisions SET title=?").run("bad"),
    /immutable/,
  );
  assert.equal(
    (await request(`/reports/${id}/withdrawal`, "PUT", {})).status,
    200,
  );
  assert.equal((await request("/apis/safe/claims")).body.items.length, 0);
  assert.equal((await request("/users/alice")).body.karma, 0);
});
test("whole-report validation, membership, required evidence, no partial writes and removed endpoints", async () => {
  const { request, db } = await fixture();
  for (const input of [
    { ...reportInput, title: "" },
    { ...reportInput, claims: [] },
    { ...reportInput, evidence_url: "" },
    {
      ...reportInput,
      claims: [
        ...reportInput.claims,
        { api_item_id: "unsafe", property: "no_ub", precondition: "" },
      ],
    },
    { ...reportInput, claims: [{ ...reportInput.claims[0], id: "fake" }] },
  ]) {
    assert.equal((await request("/reports", "POST", input)).status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM reports").get()?.n, 0);
  }
  const a = await request("/reports", "POST", reportInput);
  const c = (await request("/reports/" + a.body.id)).body.claims[0];
  const b = await request("/reports", "POST", {
    ...reportInput,
    evidence_url: "",
    claims: [
      {
        ...reportInput.claims[0],
        evidence_url: "https://example.test/individual",
      },
    ],
  });
  assert.equal(b.status, 201);
  assert.equal(
    (
      await request(`/reports/${b.body.id}/revisions`, "POST", {
        ...reportInput,
        expected_revision: 1,
        claims: [c],
      })
    ).status,
    400,
  );
  for (const [method, path] of [
    ["POST", "/claims"],
    ["POST", "/claims/validate"],
    ["POST", "/claims/1/revisions"],
    ["GET", "/claims/1/revisions/1"],
    ["PUT", "/claims/1/withdrawal"],
    ["GET", "/claims/1/comments"],
    ["POST", "/claims/1/comments"],
    ["PUT", "/claims/1/revisions/1/accept"],
    ["GET", "/claims/1/revisions/1/accepts"],
    ["GET", "/me/accepts"],
    ["GET", "/me/claims"],
    ["GET", "/users/alice/claims"],
  ])
    assert.equal(
      (await request(path, method, method === "GET" ? undefined : {})).status,
      404,
      method + " " + path,
    );
});
test("report-only nested comments, history, tombstones, activity and moderation", async () => {
  const { request, db } = await fixture();
  const id = (await request("/reports", "POST", reportInput)).body.id;
  let r = await request(
    `/reports/${id}/comments`,
    "POST",
    { body: "First", revision_no: 1 },
    "bob",
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const root = r.body.id;
  const child = (
    await request(`/reports/${id}/comments`, "POST", {
      body: "Reply",
      revision_no: 1,
      reply_to_id: root,
    })
  ).body.id;
  await request(
    `/reports/${id}/comments`,
    "POST",
    { body: "Third level", revision_no: 1, reply_to_id: child },
    "bob",
  );
  assert.equal((await request("/comments/" + child)).body.ancestors.length, 2);
  await request(
    "/comments/" + root,
    "PATCH",
    { body: "Edited", edit_version: 1 },
    "bob",
  );
  await request("/comments/" + root, "DELETE", { edit_version: 2 }, "bob");
  assert.equal(
    (await request(`/reports/${id}/comments`)).body.items[0].body,
    null,
  );
  assert.equal((await request("/users/bob/comments")).body.items.length, 1);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM report_comment_history WHERE comment_id=?",
      )
      .get(root)?.n,
    3,
  );
  assert.equal((await request("/reports/" + id)).body.comment_count, 2);
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        {
          action: "report_visibility",
          target: String(id),
          value: "hidden",
          reason: "test",
        },
        "admin",
      )
    ).status,
    200,
  );
  assert.equal((await request("/comments/" + child)).status, 404);
  assert.equal((await request("/reports/" + id)).status, 404);
});
test("CSRF, terms and publication scope remain enforced", async () => {
  const { request, db } = await fixture();
  assert.equal(
    (
      await request("/reports", "POST", reportInput, "alice", {
        "X-CSRF-Token": "wrong",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/reports", "POST", reportInput, "alice", {
        Origin: "https://other.test",
      })
    ).status,
    403,
  );
  db.prepare(
    "UPDATE users SET accepted_terms_version='old' WHERE id='alice'",
  ).run();
  assert.equal((await request("/reports", "POST", reportInput)).status, 428);
  assert.equal(
    (await request("/me/terms-acceptance", "POST", { version: "test" })).status,
    200,
  );
  assert.equal((await request("/reports", "POST", reportInput)).status, 201);
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

test("OpenAPI covers non-admin routes and excludes administrative schemas", () => {
  const spec = JSON.parse(
    readFileSync(new URL("../public/openapi.json", import.meta.url), "utf8"),
  );
  const actual = new Set(
    app.routes
      .filter(
        (r) =>
          r.method !== "ALL" &&
          !r.path.includes("*") &&
          !r.path.startsWith("/api/v1/admin/") &&
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
  assert.doesNotMatch(
    JSON.stringify(spec),
    /Administration|\/admin\/|comment_history|audit_events/,
  );
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
    (await request("/reports", "POST", reportInput, "", headers)).status,
    201,
  );
  assert.equal(
    (
      await request(
        "/reports/1/revisions",
        "POST",
        { ...reportInput, expected_revision: 1, title: "Updated" },
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
        "/reports/1/comments",
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
    (await request("/reports", "POST", reportInput, "", headers)).status,
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
  let signedInUser = "alice";
  w.fetch = async (path: any, init: any = {}) => {
    const p = String(path).replace("/api/v1", "");
    const result = await request(
      p,
      init.method || "GET",
      init.body ? JSON.parse(init.body) : undefined,
      signedInUser,
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
    await until("#report-form");
    (w.document.querySelector('[data-field="property"]') as any).value =
      "no_ub";
    w.document
      .querySelector('[data-field="property"]')!
      .dispatchEvent(new w.Event("change", { bubbles: true }));
    assert.match(
      w.document.querySelector("[data-pre-label]")!.textContent!,
      /optional; mandatory for unsafe APIs/,
    );
    assert.equal(
      (w.document.querySelector('[data-field="precondition"]') as any).required,
      false,
    );
    for (const [k, v] of Object.entries(reportInput))
      if (w.document.querySelector('[name="' + k + '"]')) input(k, String(v));
    submit("#report-form");
    await until("#publish");
    assert.match(
      w.document.querySelector("#app")!.textContent!,
      /Review before publishing/,
    );
    ((await until("#publish")) as any).click();
    await until("#comment-form");
    assert.match(
      w.document.querySelector("h1")!.textContent!,
      /A verification report/,
    );
    const claimLink = w.document
      .querySelector('a[href^="#/claim/"]')!
      .getAttribute("href")!;
    w.location.hash = claimLink;
    await until(".report-context");
    assert.equal(w.document.querySelector("#comment-form"), null);
    assert.match(
      w.document.querySelector("#app")!.textContent!,
      /No undefined behavior for sample::safe/,
    );
    w.location.hash = "/report/1";
    await until("#comment-form");
    assert.equal(
      w.document.querySelector('.report-actions a[href*="discussion"]'),
      null,
    );
    assert.doesNotMatch(
      w.document.querySelector("#app")!.textContent!,
      /(?:report|claim) stars/,
    );
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
    w.location.hash = "/publish?update=1";
    await until("#report-form");
    assert.equal(
      (w.document.querySelector('[data-field="property"]') as any).disabled,
      true,
    );
    input("title", "Revised in the browser");
    submit("#report-form");
    await until("#publish");
    assert.match(w.document.querySelector("#app")!.textContent!, /1 retained/);
    (w.document.querySelector("#publish") as any).click();
    await until("#comment-form");
    assert.equal(
      w.document.querySelector("h1")!.textContent,
      "Revised in the browser",
    );
    assert.match(w.document.querySelector("#app")!.textContent!, /v2/);
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
    w.location.hash = "/";
    await until(".home-columns");
    assert.deepEqual(
      Array.from(
        w.document.querySelectorAll(".home-columns > section > h2"),
        (el) => el.textContent,
      ),
      ["Recent reports", "Latest discussion"],
    );
    assert.doesNotMatch(
      w.document.querySelector("#app")!.textContent!,
      /Recently updated crates/,
    );
    w.location.hash = "/crates";
    await until("#crate-rows tr");
    assert.equal(
      w.document.querySelector("#crate-count")!.textContent,
      "1 crate total",
    );
    assert.deepEqual(
      Array.from(
        w.document.querySelectorAll(".crate-list th"),
        (el) => el.textContent,
      ),
      ["Crate", "APIs", "Reports", "Claims", "Updated"],
    );
    assert.equal(
      w.document.querySelector("#crate-rows tr td:nth-child(2)")!.textContent,
      "2",
    );
    signedInUser = "";
    await w.eval("refreshMe()");
    assert.equal(
      w.document
        .querySelector("#account-nav .signin > a")!
        .getAttribute("href"),
      "/auth/github",
    );
    assert.match(
      w.document.querySelector(".signin-notice")!.textContent!,
      /By signing up/,
    );
    w.location.hash = "/publish";
    await until('#app a[href="/auth/github"]');
    assert.equal(
      w.document.querySelector("#app")!.textContent,
      "PublishPlease sign in to publish.",
    );
    assert.equal(w.document.querySelector('#app a[href="#/terms"]'), null);
  } finally {
    w.close();
  }
});

test("moderation redacts shared and individual revision text and user erasure removes stars", async () => {
  const { request, db } = await fixture();
  const made = await request("/reports", "POST", reportInput);
  const id = made.body.id;
  const claimID = (await request("/reports/" + id)).body.claims[0].id;
  await request(`/reports/${id}/star`, "PUT", {}, "bob");
  await request(`/claims/${claimID}/star`, "PUT", {}, "bob");
  const redacted = await request(
    "/admin/action",
    "POST",
    {
      action: "redact_revision",
      target: id,
      revision_no: 1,
      reason: "Remove private text",
    },
    "admin",
  );
  assert.equal(redacted.status, 200, JSON.stringify(redacted.body));
  const r = (await request("/reports/" + id)).body;
  assert.equal(r.title, "[Redacted]");
  assert.equal(r.claims[0].title, "[Redacted]");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM maintenance").get()!.n, 0);
  assert.throws(
    () => db.exec("UPDATE report_revisions SET title='illegal'"),
    /immutable_revision/,
  );
  assert.equal(
    (
      await request(
        "/admin/action",
        "POST",
        { action: "delete_user", target: "bob", reason: "User request" },
        "admin",
      )
    ).status,
    200,
  );
  assert.equal((await request("/reports/" + id)).body.star_count, 0);
  assert.equal((await request("/claims/" + claimID)).body.star_count, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("staging fixture is repeatable and exposes report catalogue without imported snapshots", async () => {
  const { request, db } = await fixture();
  const sql = readFileSync(
    new URL("../fixtures/staging-demo.sql", import.meta.url),
    "utf8",
  );
  db.exec(sql);
  db.exec(sql);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reports").get()!.n, 8);
  const home = await request("/home");
  assert.equal(home.status, 200, JSON.stringify(home.body));
  assert.equal(home.body.reports.length, 7);
  assert.equal("crates" in home.body, false);
  const allCrates = await request("/crates");
  assert.equal(allCrates.status, 200, JSON.stringify(allCrates.body));
  assert.equal(allCrates.body.total_count, 6);
  assert.equal(allCrates.body.matching_count, 6);
  const found = await request("/crates?q=array");
  assert.equal(found.body.total_count, 6);
  assert.equal(found.body.matching_count, 1);
  assert.equal(found.body.items[0].api_count, 6);
  assert.equal(found.body.items[0].report_count, 2);
  assert.equal(found.body.items[0].claim_count, 7);
  assert.equal((await request("/crates?q=%25")).body.matching_count, 0);

  const list = await request("/crates/arrayvec/0.7.6-demo.1/apis");
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.items.length, 6);
  const first = home.body.reports.find(
    (x: any) => x.crate === "arrayvec" && x.tool === "Kani (demo)",
  );
  const detail = await request("/reports/" + first.id);
  assert.equal(detail.body.claims.length, 5);
  const comments = await request("/reports/" + first.id + "/comments");
  assert.equal(comments.status, 200);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("import stores normalized crate description using the existing metadata request", async (t) => {
  const { db, env } = await fixture();
  db.exec(
    "DELETE FROM doc_snapshots; INSERT INTO import_jobs(id,release_id,status,created_at) VALUES('description-import',1,'pending','2026-09-21T00:00:00.000Z')",
  );
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: any) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith("https://crates.io/"))
      return Response.json({
        version: {
          num: "1.0.0",
          checksum: "checksum",
          yanked: false,
          description: "A crate.\n  Short description.",
        },
      });
    if (url.startsWith("https://docs.rs/"))
      return Response.json({
        format_version: 61,
        root: 0,
        crate_version: "1.0.0",
        index: {
          0: { name: "sample", inner: { module: { items: [1] } } },
          1: {
            name: "safe",
            visibility: "public",
            inner: {
              function: {
                header: { is_unsafe: false, abi: "Rust" },
                generics: { params: [], where_predicates: [] },
                sig: { inputs: [], output: null },
              },
            },
          },
        },
      });
    throw Error("Unexpected request: " + url);
  });
  assert.equal(await importJob(env, "description-import"), true);
  assert.equal(
    db
      .prepare(
        "SELECT status,error_code FROM import_jobs WHERE id='description-import'",
      )
      .get()!.status,
    "ready",
  );
  assert.equal(
    db.prepare("SELECT description FROM crates WHERE name='sample'").get()!
      .description,
    "A crate. Short description.",
  );
  assert.equal(urls.length, 2);
});
