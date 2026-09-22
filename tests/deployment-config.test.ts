import { test } from "node:test";
import assert from "node:assert/strict";
import { configureDeployment } from "../scripts/deployment-config.mjs";
const oauth = { GITHUB_CLIENT_ID: "test", GITHUB_CLIENT_SECRET: "test" };
test("production domain and email configuration fails closed; staging never sends", () => {
  const config =
    (): import("../scripts/deployment-config.mjs").DeploymentConfig => ({
      vars: {},
      send_email: [{ name: "STALE" }],
    });
  let c = config();
  assert.equal(configureDeployment(c, "production", oauth), true);
  assert.equal(c.vars.EMAIL_DISABLED, "true");
  assert.equal(c.send_email, undefined);
  assert.throws(() => configureDeployment(config(), "production", {}), /OAuth/);
  assert.throws(
    () =>
      configureDeployment(config(), "production", {
        ...oauth,
        PRODUCTION_EMAIL_ENABLED: "true",
      }),
    /subscription/,
  );
  assert.throws(
    () =>
      configureDeployment(config(), "production", {
        ...oauth,
        PRODUCTION_EMAIL_ENABLED: "true",
        PRODUCTION_CUSTOM_DOMAIN: "false",
      }),
    /custom domain/,
  );
  c = config();
  configureDeployment(c, "production", {
    ...oauth,
    PRODUCTION_EMAIL_ENABLED: "true",
    EMAIL_EVENT_SUBSCRIPTION: "test-subscription",
  });
  assert.equal(c.vars.EMAIL_DISABLED, "false");
  assert.equal(c.vars.EMAIL_DOMAIN, "proofs.rs");
  assert.equal(c.vars.EMAIL_EVENT_SUBSCRIPTION, "test-subscription");
  assert.deepEqual(c.send_email, [
    { name: "EMAIL", allowed_sender_addresses: ["notifications@proofs.rs"] },
  ]);
  c = config();
  assert.equal(
    configureDeployment(c, "staging", { PRODUCTION_EMAIL_ENABLED: "true" }),
    false,
  );
  assert.equal(c.vars.EMAIL_DISABLED, "true");
  assert.equal(c.send_email, undefined);
});
