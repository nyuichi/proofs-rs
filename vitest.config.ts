import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

  return defineConfig({
    plugins: [
      cloudflareTest({
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
        miniflare: {
          // Keep local Miniflare compatible when the application date moves
          // ahead of the runtime package's release date.
          compatibilityDate: "2026-08-20",
          bindings: {
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ["tests/**/*.test.ts"],
      globals: false,
      setupFiles: ["./tests/apply-migrations.ts"],
    },
  });
});
