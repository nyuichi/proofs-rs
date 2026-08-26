import { describe, expect, it } from "vitest";

import { withSecurityHeaders } from "../app/lib/security.server";

describe("response security policy", () => {
  it("marks application responses as private and hidden from indexing", () => {
    const response = withSecurityHeaders(new Response("ok"));

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });
});
