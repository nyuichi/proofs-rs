import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

type MigrationEnv = typeof env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const testEnv = env as MigrationEnv;

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
