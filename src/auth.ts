import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  App,
  Ctx,
  Fault,
  hash,
  random,
  now,
  uid,
  one,
  stmt,
  batch,
  quota,
  requireUser,
  jsonBody,
} from "./core";
const expiry = (ms: number) => new Date(Date.now() + ms).toISOString();
const secure = (c: Ctx) => new URL(c.req.url).protocol === "https:";
const cookieName = (c: Ctx) =>
  secure(c) ? "__Host-proofsr_session" : "proofsr_session";
export async function authenticate(c: Ctx) {
  c.set("user", null);
  c.set("csrf", "");
  c.set("sessionHash", "");
  c.set("tokenId", "");
  const authorization = c.req.header("authorization");
  if (authorization !== undefined) {
    if (!/^Bearer [a-f0-9]{64}$/i.test(authorization))
      throw new Fault(401, "invalid_token");
    const row = await one(
      c.env.DB,
      "SELECT u.*,t.id token_id FROM api_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>?",
      await hash(authorization.slice(7)),
      now(),
    );
    if (!row) throw new Fault(401, "invalid_token");
    c.set("user", row);
    requireUser(c);
    c.set("tokenId", row.token_id);
    await stmt(
      c.env.DB,
      "UPDATE api_tokens SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<?)",
      now(),
      row.token_id,
      new Date(Date.now() - 3600000).toISOString(),
    ).run();
    return;
  }
  const tok = getCookie(c, cookieName(c));
  if (!tok) return;
  const h = await hash(tok);
  const row = await one(
    c.env.DB,
    "SELECT u.*,s.csrf FROM sessions s JOIN users u ON s.user_id=u.id WHERE token_hash=? AND expires_at>?",
    h,
    now(),
  );
  if (row) {
    c.set("user", row);
    c.set("csrf", row.csrf);
    c.set("sessionHash", h);
  }
}
export function authRoutes() {
  const app = new Hono<App>();
  app.get("/github", async (c) => {
    if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET)
      throw new Fault(
        503,
        "oauth_not_configured",
        "GitHub sign-in is not configured for this environment yet.",
      );
    const returnTo = c.req.query("return_to") || "";
    if (/^\/#\/device(?:\?code=[A-Z2-9-]{8,9})?$/.test(returnTo))
      setCookie(c, "oauth_return", returnTo, {
        secure: secure(c),
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 600,
      });
    else deleteCookie(c, "oauth_return", { path: "/" });
    const state = random(),
      verifier = random();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await batch(c.env.DB, [
      quota(
        c.env.DB,
        await hash(c.req.header("cf-connecting-ip") || "unknown"),
        "oauth",
        100,
      ),
      stmt(
        c.env.DB,
        "INSERT INTO oauth_flows VALUES(?,?,?,?)",
        await hash(state),
        verifier,
        c.env.TERMS_VERSION,
        expiry(600000),
      ),
    ]);
    setCookie(c, "oauth_state", state, {
      secure: secure(c),
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 600,
    });
    const u = new URL("https://github.com/login/oauth/authorize");
    u.search = new URLSearchParams({
      client_id: c.env.GITHUB_CLIENT_ID,
      redirect_uri: c.env.APP_ORIGIN + "/auth/github/callback",
      scope: "read:user user:email",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return c.redirect(u.href);
  });
  app.get("/github/callback", async (c) => {
    const state = c.req.query("state"),
      code = c.req.query("code");
    if (!state || state !== getCookie(c, "oauth_state") || !code)
      throw new Fault(400, "oauth_state");
    deleteCookie(c, "oauth_state", { path: "/" });
    const flow = await stmt(
      c.env.DB,
      "DELETE FROM oauth_flows WHERE state_hash=? AND expires_at>? RETURNING *",
      await hash(state),
      now(),
    ).first<any>();
    if (!flow) throw new Fault(400, "oauth_expired");
    const response = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: c.env.GITHUB_CLIENT_ID,
          client_secret: c.env.GITHUB_CLIENT_SECRET,
          code,
          code_verifier: flow.verifier,
          redirect_uri: c.env.APP_ORIGIN + "/auth/github/callback",
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const token: any = await response.json();
    if (!token.access_token) throw new Fault(502, "oauth_failed");
    const headers = {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "proofs.rs",
    };
    const [ur, er] = await Promise.all([
      fetch("https://api.github.com/user", { headers }),
      fetch("https://api.github.com/user/emails", { headers }),
    ]);
    if (!ur.ok) throw new Fault(502, "github_unavailable");
    const user: any = await ur.json();
    if (!Number.isSafeInteger(user.id) || typeof user.login !== "string")
      throw new Fault(502, "github_response");
    const emails: any = er.ok ? await er.json() : null;
    const email = Array.isArray(emails)
      ? emails.find((x) => x.primary && x.verified)
      : undefined;
    const db = c.env.DB;
    const existing = await one(
      db,
      "SELECT * FROM users WHERE github_id=?",
      user.id,
    );
    if (existing?.status === "suspended")
      throw new Fault(403, "account_suspended");
    const id = existing?.id || uid();
    const role = c.env.ADMIN_GITHUB_IDS.split(",").includes(String(user.id))
      ? "admin"
      : "user";
    const ss = [];
    ss.push(
      stmt(
        db,
        "UPDATE users SET username=? WHERE username=? AND github_id<>?",
        `former-${uid()}`,
        user.login,
        user.id,
      ),
    );
    if (existing)
      ss.push(
        stmt(
          db,
          "UPDATE users SET username=?,role=? WHERE id=?",
          user.login,
          role,
          id,
        ),
      );
    else
      ss.push(
        stmt(
          db,
          "INSERT INTO users(id,github_id,username,role,accepted_terms_version,terms_accepted_at,created_at) VALUES(?,?,?,?,?,?,?)",
          id,
          user.id,
          user.login,
          role,
          flow.terms_version,
          now(),
          now(),
        ),
      );
    ss.push(
      stmt(
        db,
        "INSERT INTO notification_preferences(user_id) VALUES(?) ON CONFLICT DO NOTHING",
        id,
      ),
    );
    if (Array.isArray(emails))
      ss.push(
        stmt(
          db,
          `INSERT INTO email_contacts VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET address=excluded.address,verified_at=excluded.verified_at,delivery_status=excluded.delivery_status`,
          id,
          email?.email || null,
          email ? now() : null,
          email ? "active" : "unavailable",
        ),
      );
    if (!Array.isArray(emails) && !existing)
      ss.push(
        stmt(
          db,
          "INSERT INTO email_contacts(user_id,delivery_status) VALUES(?,?)",
          id,
          "unavailable",
        ),
      );
    const session = random(),
      csrf = random();
    ss.push(
      stmt(
        db,
        "INSERT INTO sessions VALUES(?,?,?,?)",
        await hash(session),
        id,
        csrf,
        expiry(30 * 86400000),
      ),
    );
    await batch(db, ss);
    setCookie(c, cookieName(c), session, {
      secure: secure(c),
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 30 * 86400,
    });
    const back = getCookie(c, "oauth_return");
    deleteCookie(c, "oauth_return", { path: "/" });
    if (back && /^\/#\/device(?:\?code=[A-Z2-9-]{8,9})?$/.test(back))
      return c.redirect(back);
    return c.redirect(er.ok ? "/#/account" : "/#/settings?email=retry");
  });
  app.post("/logout", async (c) => {
    if (c.get("sessionHash"))
      await stmt(
        c.env.DB,
        "DELETE FROM sessions WHERE token_hash=?",
        c.get("sessionHash"),
      ).run();
    deleteCookie(c, cookieName(c), { path: "/", secure: secure(c) });
    return c.json({ ok: true });
  });
  return app;
}
