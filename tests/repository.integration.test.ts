import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createPublication,
  getPublication,
  listPublications,
  PUBLICATION_DAILY_LIMIT,
  PUBLICATION_PAGE_SIZE,
  PublicationRateLimitError,
  upsertPublisher,
} from "../app/lib/repository.server";
import { parsePublicationMetadata } from "../app/lib/metadata";
import { parseSarif } from "../app/lib/sarif";

const db = env.DB;

const upstreamCommit = "0123456789abcdef0123456789abcdef01234567";
const verificationCommit = "abcdef0123456789abcdef0123456789abcdef01";

function metadata(index: number) {
  return parsePublicationMetadata({
    message: `Publication ${index}\n\nLonger context for publication ${index}.`,
    crate_name: "tokio",
    crate_version: `1.48.${index}`,
    upstream_repository: "tokio-rs/tokio",
    upstream_commit: upstreamCommit,
    upstream_path: "tokio/src/sync",
    verification_repository: "alice/tokio-verification",
    verification_commit: verificationCommit,
    verification_path: "proofs",
  });
}

function sarif(index: number) {
  return parseSarif(
    JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "kani",
              version: "0.66.0",
              rules: [
                {
                  id: "no_duplicate_permits",
                  shortDescription: { text: "Semaphore permits are never duplicated" },
                },
              ],
            },
          },
          results: [
            {
              ruleId: "no_duplicate_permits",
              message: { text: `claim ${index}` },
              locations: [
                {
                  logicalLocations: [
                    { fullyQualifiedName: "tokio::sync::Semaphore::acquire" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
}

describe("D1 publication repository", () => {
  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM sarif_runs"),
      db.prepare("DELETE FROM publications"),
      db.prepare("DELETE FROM sessions"),
      db.prepare("DELETE FROM publishers"),
    ]);
  });

  it("starts empty and returns no publication for an unknown id", async () => {
    const page = await listPublications(db);
    expect(page.publications).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
    expect(await getPublication(db, "01J00000000000000000000000")).toBeNull();
  });

  it("persists one publication with multiple SARIF runs and loads them in order", async () => {
    const publisher = await upsertPublisher(db, "1001", "alice", new Date("2026-08-26T00:00:00.000Z"));
    const first = await createPublication({
      db,
      publisherId: publisher.id,
      metadata: metadata(1),
      sarif: {
        version: "2.1.0",
        runs: [...sarif(1).runs, ...sarif(2).runs],
      },
      now: new Date("2026-08-26T01:00:00.000Z"),
    });

    const loaded = await getPublication(db, first);
    expect(loaded?.publisher_login).toBe("alice");
    expect(loaded?.runs.map((run) => run.run_index)).toEqual([0, 1]);
    expect(loaded?.runs.map((run) => JSON.parse(run.run_json).results[0].message.text)).toEqual([
      "claim 1",
      "claim 2",
    ]);
  });

  it("orders newest first and returns a stable cursor for the next page", async () => {
    const publisher = await upsertPublisher(db, "1002", "bob", new Date("2026-08-26T00:00:00.000Z"));
    const older = await createPublication({
      db,
      publisherId: publisher.id,
      metadata: metadata(1),
      sarif: sarif(1),
      now: new Date("2026-08-26T01:00:00.000Z"),
    });
    const newer = await createPublication({
      db,
      publisherId: publisher.id,
      metadata: metadata(2),
      sarif: sarif(2),
      now: new Date("2026-08-26T02:00:00.000Z"),
    });

    const firstPage = await listPublications(db, undefined, 1);
    expect(firstPage.publications.map((publication) => publication.id)).toEqual([newer]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await listPublications(db, firstPage.nextCursor, 1);
    expect(secondPage.publications.map((publication) => publication.id)).toEqual([older]);
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it("enforces the per-publisher UTC-day publication limit", async () => {
    const publisher = await upsertPublisher(db, "1003", "limit-user", new Date("2026-08-26T00:00:00.000Z"));
    const now = new Date("2026-08-26T03:00:00.000Z");
    for (let index = 0; index < PUBLICATION_DAILY_LIMIT; index += 1) {
      await createPublication({
        db,
        publisherId: publisher.id,
        metadata: metadata(index),
        sarif: sarif(index),
        now: new Date(now.getTime() + index * 1_000),
      });
    }
    await expect(
      createPublication({
        db,
        publisherId: publisher.id,
        metadata: metadata(99),
        sarif: sarif(99),
        now: new Date("2026-08-26T23:59:59.999Z"),
      }),
    ).rejects.toBeInstanceOf(PublicationRateLimitError);
  });
});
