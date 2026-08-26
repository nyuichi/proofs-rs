import { describe, expect, it } from "vitest";

import { normalizeRepositoryPath, parsePublicationMetadata } from "../app/lib/metadata";

const commit = "a".repeat(40);

function validMetadata() {
  return {
    message: "Verify semaphore permit accounting\n\nDetails go here.",
    crate_name: "tokio",
    crate_version: "1.48.0",
    upstream_repository: "tokio-rs/tokio",
    upstream_commit: commit,
    upstream_path: "/tokio/src/sync",
    verification_repository: "alice/tokio-verification",
    verification_commit: "b".repeat(64),
    verification_path: "verification",
  };
}

describe("publication metadata", () => {
  it("normalizes repository paths and preserves the message", () => {
    const parsed = parsePublicationMetadata(validMetadata());
    expect(parsed.message).toContain("Verify semaphore");
    expect(parsed.upstream_path).toBe("tokio/src/sync");
  });

  it("requires owner/repository and a full commit hash", () => {
    expect(() => parsePublicationMetadata({ ...validMetadata(), upstream_repository: "https://github.com/a/b" })).toThrow();
    expect(() => parsePublicationMetadata({ ...validMetadata(), upstream_commit: "abc" })).toThrow();
  });

  it("rejects paths containing traversal", () => {
    expect(() => normalizeRepositoryPath("verification/../secrets")).toThrow("'..'");
    expect(normalizeRepositoryPath("verification/foo..bar")).toBe("verification/foo..bar");
  });

  it("enforces the first line length", () => {
    expect(() => parsePublicationMetadata({ ...validMetadata(), message: "x".repeat(81) })).toThrow(
      "first line",
    );
    expect(() => parsePublicationMetadata({ ...validMetadata(), message: "   \nlong description" })).toThrow(
      "first line",
    );
    const spaced = parsePublicationMetadata({ ...validMetadata(), message: "  Verify this  \n\nDetails" });
    expect(spaced.message).toBe("  Verify this  \n\nDetails");
  });
});
