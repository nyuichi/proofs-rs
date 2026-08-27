import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { loader as homeLoader } from "../app/routes/home";
import { action as publishAction, loader as publishLoader } from "../app/routes/publish";
import { createPublication, upsertPublisher } from "../app/lib/repository.server";
import { parsePublicationMetadata } from "../app/lib/metadata";
import { parseSarif } from "../app/lib/sarif";

const db = env.DB;

async function clearData() {
  await db.batch([
    db.prepare("DELETE FROM sarif_runs"),
    db.prepare("DELETE FROM publications"),
    db.prepare("DELETE FROM sessions"),
    db.prepare("DELETE FROM publishers"),
  ]);
}

async function thrownResponse(run: () => Promise<unknown>): Promise<Response> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(Response);
    return error as Response;
  }
  throw new Error("Expected the loader to throw a response.");
}

function routeMetadata(index: number) {
  return parsePublicationMetadata({
    message: `Route publication ${index}`,
    crate_name: "tokio",
    crate_version: `1.48.${index}`,
    upstream_repository: "tokio-rs/tokio",
    upstream_commit: "0123456789abcdef0123456789abcdef01234567",
    upstream_path: "tokio/src/sync",
    verification_repository: "alice/tokio-verification",
    verification_commit: "abcdef0123456789abcdef0123456789abcdef01",
    verification_path: "proofs",
  });
}

function routeSarif() {
  return parseSarif(
    JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "kani" } },
          results: [{ ruleId: "route-rule", message: { text: "claim" } }],
        },
      ],
    }),
  );
}

function callHomeLoader(url: string) {
  return homeLoader({ request: new Request(url) } as Parameters<typeof homeLoader>[0]);
}

describe("publication list route pagination", () => {
  beforeEach(clearData);

  it("serves an empty canonical first page", async () => {
    await expect(callHomeLoader("https://proofs.example/")).resolves.toMatchObject({
      page: 1,
      publications: [],
      totalCount: 0,
      totalPages: 1,
    });
  });

  it("redirects an explicit first page to slash", async () => {
    const response = await thrownResponse(() => callHomeLoader("https://proofs.example/?page=1"));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
  });

  it("rejects malformed, unsafe, and duplicate page values", async () => {
    for (const query of [
      "?page=",
      "?page=0",
      "?page=-1",
      "?page=1.5",
      "?page=1e2",
      "?page=9007199254740992",
      "?page=2&page=2",
    ]) {
      const response = await thrownResponse(() => callHomeLoader(`https://proofs.example/${query}`));
      expect(response.status, query).toBe(400);
    }
  });

  it("returns 404 for a page beyond the current result set", async () => {
    const publisher = await upsertPublisher(
      env.DB,
      "route-user",
      "route-user",
      new Date("2026-08-26T00:00:00.000Z"),
    );
    await createPublication({
      db: env.DB,
      publisherId: publisher.id,
      metadata: routeMetadata(1),
      sarif: routeSarif(),
      now: new Date("2026-08-26T01:00:00.000Z"),
    });

    const response = await thrownResponse(() => callHomeLoader("https://proofs.example/?page=2"));
    expect(response.status).toBe(404);
  });
});

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
