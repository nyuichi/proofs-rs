import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { action as publishAction, loader as publishLoader } from "../app/routes/publish";

const db = env.DB;

async function clearData() {
  await db.batch([
    db.prepare("DELETE FROM sarif_runs"),
    db.prepare("DELETE FROM publications"),
    db.prepare("DELETE FROM sessions"),
    db.prepare("DELETE FROM publishers"),
  ]);
}

describe("publish route protection", () => {
  beforeEach(clearData);

  it("redirects an unauthenticated publish page request to GitHub OAuth", async () => {
    try {
      await publishLoader({
        request: new Request("https://proofs.example/publish"),
      } as Parameters<typeof publishLoader>[0]);
      throw new Error("expected the loader to throw a redirect response");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      const response = error as Response;
      expect(response.status).toBe(303);
      expect(response.headers.get("Location")).toBe("/auth/github?returnTo=%2Fpublish");
    }
  });

  it("redirects an unauthenticated publish submission without reading or storing it", async () => {
    const response = await publishAction({
      request: new Request("https://proofs.example/publish", {
        method: "POST",
        body: new URLSearchParams({ message: "must not be stored" }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    } as Parameters<typeof publishAction>[0]);

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/auth/github?returnTo=%2Fpublish");
    expect(await db.prepare("SELECT COUNT(*) AS count FROM publications").first<{ count: number }>()).toEqual({
      count: 0,
    });
  });
});
