// Pure configuration: run before provisioning any Cloudflare resources.
export function configureDeployment(config, target, env) {
  const customDomain =
    target === "production" && env.PRODUCTION_CUSTOM_DOMAIN !== "false";
  if (customDomain && (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET))
    throw Error(
      "Configure production GitHub OAuth for https://proofs.rs/auth/github/callback before domain activation.",
    );
  if (
    env.PRODUCTION_EMAIL_ENABLED &&
    !["true", "false"].includes(env.PRODUCTION_EMAIL_ENABLED)
  )
    throw Error("PRODUCTION_EMAIL_ENABLED must be true or false.");
  const emailEnabled =
    target === "production" && env.PRODUCTION_EMAIL_ENABLED === "true";
  config.vars.EMAIL_DISABLED = emailEnabled ? "false" : "true";
  delete config.send_email;
  if (emailEnabled) {
    if (!customDomain)
      throw Error("Production email requires the proofs.rs custom domain.");
    if (!env.EMAIL_EVENT_SUBSCRIPTION?.trim())
      throw Error(
        "Configure the proofs.rs Email Sending event subscription and set PRODUCTION_EMAIL_EVENT_SUBSCRIPTION before enabling email.",
      );
    config.vars.EMAIL_FROM = "notifications@proofs.rs";
    config.vars.EMAIL_DOMAIN = "proofs.rs";
    config.vars.EMAIL_EVENT_SUBSCRIPTION = env.EMAIL_EVENT_SUBSCRIPTION.trim();
    // Do not set an empty destination allowlist: production notifies opted-in users.
    config.send_email = [
      { name: "EMAIL", allowed_sender_addresses: [config.vars.EMAIL_FROM] },
    ];
  }
  return customDomain;
}
