import type { PublisherRecord } from "./repository.server";
import { upsertPublisher } from "./repository.server";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const OAUTH_TTL_SECONDS = 60 * 10;
const SESSION_COOKIE = "__Host-proofsr_session";
const DEV_SESSION_COOKIE = "proofsr_session";
const OAUTH_STATE_COOKIE = "__Host-proofsr_oauth_state";
const OAUTH_VERIFIER_COOKIE = "__Host-proofsr_oauth_verifier";
const OAUTH_RETURN_TO_COOKIE = "__Host-proofsr_return_to";
const DEV_OAUTH_STATE_COOKIE = "proofsr_oauth_state";
const DEV_OAUTH_VERIFIER_COOKIE = "proofsr_oauth_verifier";
const DEV_OAUTH_RETURN_TO_COOKIE = "proofsr_return_to";

export interface AuthEnv {
  // Keeping the optional binding here lets generated Cloudflare Env objects
  // pass through without requiring secrets to be present in their type.
  DB?: unknown;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  APP_ORIGIN?: string;
}

export interface SessionRecord {
  token_hash: string;
  publisher_id: string;
  expires_at: string;
  created_at: string;
}

export function isOAuthConfigured(env: AuthEnv): boolean {
  return Boolean(env.GITHUB_CLIENT_ID?.trim() && env.GITHUB_CLIENT_SECRET?.trim());
}

export function applicationOrigin(request: Request, env: AuthEnv): string {
  if (env.APP_ORIGIN?.trim()) {
    const configured = new URL(env.APP_ORIGIN.trim());
    return configured.origin;
  }
  return new URL(request.url).origin;
}

export function githubRedirectUri(request: Request, env: AuthEnv): string {
  return new URL("/auth/github/callback", applicationOrigin(request, env)).toString();
}

function isHttps(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

function cookieNames(request: Request): {
  session: string;
  state: string;
  verifier: string;
  returnTo: string;
} {
  return isHttps(request)
    ? {
        session: SESSION_COOKIE,
        state: OAUTH_STATE_COOKIE,
        verifier: OAUTH_VERIFIER_COOKIE,
        returnTo: OAUTH_RETURN_TO_COOKIE,
      }
    : {
        session: DEV_SESSION_COOKIE,
        state: DEV_OAUTH_STATE_COOKIE,
        verifier: DEV_OAUTH_VERIFIER_COOKIE,
        returnTo: DEV_OAUTH_RETURN_TO_COOKIE,
      };
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return sha256(verifier);
}

export function parseCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  const header = request.headers.get("Cookie");
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, decodeURIComponent(value));
  }
  return cookies;
}

export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) segments.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.expires) segments.push(`Expires=${options.expires.toUTCString()}`);
  segments.push(`Path=${options.path ?? "/"}`);
  if (options.httpOnly !== false) segments.push("HttpOnly");
  if (options.secure !== false) segments.push("Secure");
  segments.push(`SameSite=${options.sameSite ?? "Lax"}`);
  return segments.join("; ");
}

function appendNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function redirectResponse(location: string | URL, status = 302): Response {
  return new Response(null, { status, headers: { Location: location.toString() } });
}

function clearCookie(request: Request, name: string): string {
  return serializeCookie(name, "", {
    maxAge: 0,
    expires: new Date(0),
    secure: isHttps(request),
  });
}

function appendOAuthClearCookies(response: Response, request: Request): void {
  const names = cookieNames(request);
  response.headers.append("Set-Cookie", clearCookie(request, names.state));
  response.headers.append("Set-Cookie", clearCookie(request, names.verifier));
  response.headers.append("Set-Cookie", clearCookie(request, names.returnTo));
}

export function normalizeReturnTo(request: Request, value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  try {
    const target = new URL(value, request.url);
    if (target.origin !== new URL(request.url).origin) return "/";
    return `${target.pathname}${target.search}`;
  } catch {
    return "/";
  }
}

export async function startGitHubOAuth(request: Request, env: AuthEnv): Promise<Response> {
  if (!isOAuthConfigured(env)) {
    return appendNoStore(new Response("GitHub OAuth is not configured.", { status: 503 }));
  }
  const state = randomToken();
  const verifier = randomToken(48);
  const challenge = await pkceChallenge(verifier);
  const returnTo = normalizeReturnTo(request, new URL(request.url).searchParams.get("returnTo"));
  const authorization = new URL("https://github.com/login/oauth/authorize");
  authorization.searchParams.set("client_id", env.GITHUB_CLIENT_ID!.trim());
  authorization.searchParams.set("redirect_uri", githubRedirectUri(request, env));
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");

  const response = redirectResponse(authorization, 302);
  const names = cookieNames(request);
  const options = { maxAge: OAUTH_TTL_SECONDS, secure: isHttps(request), httpOnly: true, sameSite: "Lax" as const };
  response.headers.append("Set-Cookie", serializeCookie(names.state, state, options));
  response.headers.append("Set-Cookie", serializeCookie(names.verifier, verifier, options));
  response.headers.append("Set-Cookie", serializeCookie(names.returnTo, returnTo, options));
  return appendNoStore(response);
}

export function isSafeGitHubUser(value: unknown): value is { id: number; login: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { id?: unknown; login?: unknown };
  return (
    typeof candidate.id === "number" &&
    Number.isSafeInteger(candidate.id) &&
    candidate.id > 0 &&
    typeof candidate.login === "string" &&
    candidate.login.trim().length > 0
  );
}

export async function completeGitHubOAuth(
  request: Request,
  env: AuthEnv,
  db: D1Database,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!isOAuthConfigured(env)) {
    return appendNoStore(new Response("GitHub OAuth is not configured.", { status: 503 }));
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(request);
  const names = cookieNames(request);
  const storedState = cookies.get(names.state);
  const verifier = cookies.get(names.verifier);
  if (!code || !state || !storedState || !verifier || state !== storedState) {
    const response = appendNoStore(new Response("Invalid or expired OAuth state.", { status: 400 }));
    appendOAuthClearCookies(response, request);
    return response;
  }

  const tokenResponse = await fetcher("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: githubRedirectUri(request, env),
      code_verifier: verifier,
    }),
  });
  if (!tokenResponse.ok) {
    const response = appendNoStore(new Response("GitHub token exchange failed.", { status: 502 }));
    appendOAuthClearCookies(response, request);
    return response;
  }
  const tokenPayload = (await tokenResponse.json()) as { access_token?: unknown };
  if (typeof tokenPayload.access_token !== "string" || tokenPayload.access_token.length === 0) {
    const response = appendNoStore(new Response("GitHub token exchange returned no token.", { status: 502 }));
    appendOAuthClearCookies(response, request);
    return response;
  }

  const userResponse = await fetcher("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenPayload.access_token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "proofs.rs",
    },
  });
  if (!userResponse.ok) {
    const response = appendNoStore(new Response("GitHub identity lookup failed.", { status: 502 }));
    appendOAuthClearCookies(response, request);
    return response;
  }
  const user: unknown = await userResponse.json();
  if (!isSafeGitHubUser(user)) {
    const response = appendNoStore(new Response("GitHub identity response was invalid.", { status: 502 }));
    appendOAuthClearCookies(response, request);
    return response;
  }

  // The token is intentionally only held in this function and is never persisted or logged.
  const publisher = await upsertPublisher(db, String(user.id), user.login, new Date());
  const sessionToken = randomToken();
  const tokenHash = await sha256(sessionToken);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_SECONDS * 1_000);
  await db
    .prepare(
      "INSERT INTO sessions (token_hash, publisher_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(tokenHash, publisher.id, expiresAt.toISOString(), createdAt.toISOString())
    .run();

  const destinationPath = normalizeReturnTo(request, cookies.get(names.returnTo));
  const destination = new URL(destinationPath, applicationOrigin(request, env));
  const response = appendNoStore(redirectResponse(destination, 303));
  response.headers.append(
    "Set-Cookie",
    serializeCookie(names.session, sessionToken, {
      maxAge: SESSION_TTL_SECONDS,
      secure: isHttps(request),
      httpOnly: true,
      sameSite: "Lax",
    }),
  );
  appendOAuthClearCookies(response, request);
  return response;
}

export async function createSession(
  db: D1Database,
  publisherId: string,
  now = new Date(),
): Promise<{ token: string; record: SessionRecord }> {
  const token = randomToken();
  const record: SessionRecord = {
    token_hash: await sha256(token),
    publisher_id: publisherId,
    expires_at: new Date(now.getTime() + SESSION_TTL_SECONDS * 1_000).toISOString(),
    created_at: now.toISOString(),
  };
  await db
    .prepare("INSERT INTO sessions (token_hash, publisher_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(record.token_hash, record.publisher_id, record.expires_at, record.created_at)
    .run();
  return { token, record };
}

export async function getOptionalPublisher(request: Request, db: D1Database): Promise<PublisherRecord | null> {
  const token = parseCookies(request).get(cookieNames(request).session);
  if (!token) return null;
  const hash = await sha256(token);
  const now = new Date().toISOString();
  const session = await db
    .prepare(
      `SELECT s.publisher_id, p.id, p.github_user_id, p.github_login, p.created_at
       FROM sessions AS s
       JOIN publishers AS p ON p.id = s.publisher_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(hash, now)
    .first<PublisherRecord & { publisher_id: string }>();
  return session ?? null;
}

export async function requirePublisher(request: Request, db: D1Database): Promise<PublisherRecord> {
  const publisher = await getOptionalPublisher(request, db);
  if (!publisher) throw Response.redirect("/auth/github", 303);
  return publisher;
}

export async function destroySession(request: Request, db: D1Database): Promise<Response> {
  const names = cookieNames(request);
  const token = parseCookies(request).get(names.session);
  if (token) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  }
  const response = appendNoStore(redirectResponse(new URL("/", request.url), 303));
  response.headers.append("Set-Cookie", clearCookie(request, names.session));
  return response;
}

export function assertSameOrigin(request: Request, env: AuthEnv): void {
  const origin = request.headers.get("Origin");
  if (!origin) return;
  if (origin !== applicationOrigin(request, env)) {
    throw new Response("Cross-origin mutation rejected.", { status: 403 });
  }
}

export function sessionCookieName(request: Request): string {
  return cookieNames(request).session;
}
