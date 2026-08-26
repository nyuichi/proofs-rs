import { describe, expect, it } from "vitest";

import {
  completeGitHubOAuth,
  githubRedirectUri,
  isSafeGitHubUser,
  normalizeReturnTo,
  parseCookies,
  pkceChallenge,
  randomToken,
  serializeCookie,
  startGitHubOAuth,
} from "../app/lib/auth.server";

describe("auth helpers", () => {
  it("creates opaque random tokens and an S256 PKCE challenge", async () => {
    const first = randomToken();
    const second = randomToken();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThan(30);
    expect(await pkceChallenge("verifier")).toBe("iMnq5o6zALKXGivsnlom_0F5_WYda32GHkxlV7mq7hQ");
  });

  it("serializes and parses HttpOnly SameSite cookies", () => {
    const header = serializeCookie("session", "hello world", {
      maxAge: 60,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
    const request = new Request("https://proofs.example/", { headers: { Cookie: header } });
    expect(parseCookies(request).get("session")).toBe("hello world");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
  });

  it("uses the exact callback URI and no OAuth scope", async () => {
    const request = new Request("https://proofs.example/auth/github?returnTo=%2Fpublish%3Ffrom%3Dlist");
    const env = { GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "secret" };
    expect(githubRedirectUri(request, env)).toBe("https://proofs.example/auth/github/callback");
    const response = await startGitHubOAuth(request, env);
    expect(response.status).toBe(302);
    const location = response.headers.get("Location")!;
    expect(location).not.toContain("scope=");
    expect(location).toContain("code_challenge_method=S256");
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-proofsr_oauth_state="))).toBe(
      true,
    );
    expect(
      response.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-proofsr_return_to=%2Fpublish%3Ffrom%3Dlist")),
    ).toBe(true);
  });

  it("accepts only same-origin absolute paths for returnTo", () => {
    const request = new Request("https://proofs.example/auth/github");
    expect(normalizeReturnTo(request, "/publish?from=list")).toBe("/publish?from=list");
    expect(normalizeReturnTo(request, "https://evil.example/publish")).toBe("/");
    expect(normalizeReturnTo(request, "//evil.example/publish")).toBe("/");
  });

  it("accepts only a safe positive numeric GitHub user id", () => {
    expect(isSafeGitHubUser({ id: 123, login: "alice" })).toBe(true);
    expect(isSafeGitHubUser({ id: "123", login: "alice" })).toBe(false);
    expect(isSafeGitHubUser({ id: 0, login: "alice" })).toBe(false);
    expect(isSafeGitHubUser({ id: Number.MAX_SAFE_INTEGER + 1, login: "alice" })).toBe(false);
    expect(isSafeGitHubUser({ id: 123, login: "   " })).toBe(false);
  });

  it("redirects the callback to the returnTo path and clears its cookie", async () => {
    const startRequest = new Request("https://proofs.example/auth/github?returnTo=%2Fpublish%3Ffrom%3Dlist");
    const env = { GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "secret" };
    const startResponse = await startGitHubOAuth(startRequest, env);
    const setCookies = startResponse.headers.getSetCookie();
    const requestCookies = setCookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
    const state = parseCookies(new Request("https://proofs.example/", { headers: { Cookie: requestCookies } })).get(
      "__Host-proofsr_oauth_state",
    );
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() {
            return statement;
          },
          async first() {
            return sql.includes("FROM publishers WHERE github_user_id") ? null : undefined;
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    const fetcher: typeof fetch = async (input) => {
      if (String(input).includes("access_token")) {
        return new Response(JSON.stringify({ access_token: "temporary-token" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 123, login: "alice" }), { status: 200 });
    };
    const callbackRequest = new Request(
      `https://proofs.example/auth/github/callback?code=one-time-code&state=${encodeURIComponent(state!)}`,
      { headers: { Cookie: requestCookies } },
    );
    const response = await completeGitHubOAuth(callbackRequest, env, db, fetcher);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("https://proofs.example/publish?from=list");
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-proofsr_return_to=;"))).toBe(
      true,
    );
  });
});
