# Production domain and email activation

Prepared in code; Cloudflare onboarding and owner deployment still required.
Staging remains email-disabled. The Production workflow continues to require
nyuichi to run it from main after that exact commit passes Staging.

## Domain and OAuth

Production now defaults to custom domain `proofs.rs`; `PRODUCTION_CUSTOM_DOMAIN=false`
explicitly restores workers.dev deployment with notifications disabled.
Wrangler creates the custom-domain association and certificate during deployment.
Do not point DNS at staging. Review any conflicting existing apex DNS record before
replacing it. The deployment token must permit Workers custom-domain setup for
this zone (Zone Read and DNS Edit in addition to existing deployment permissions).

In the production GitHub OAuth app, set homepage `https://proofs.rs` and callback
`https://proofs.rs/auth/github/callback`. Keep its credentials in the existing
`PRODUCTION_GITHUB_CLIENT_ID` variable and `PRODUCTION_GITHUB_CLIENT_SECRET` secret.
The OAuth app settings are separate from repository Actions settings.

## Receive contact mail

Cloudflare dashboard → Compute → Email Service → Email Routing:

1. Onboard `proofs.rs`, reviewing existing mail records before accepting the required DNS records.
2. Add destination `yuichi.nishiwaki@icloud.com` and follow its verification email.
3. Create an enabled exact-address rule: `contact@proofs.rs` → Send to an email → that verified destination.
4. Leave catch-all disabled. This sets up forwarding, not a mailbox or an outbound email client.

## Send production notifications

Cloudflare dashboard → Compute → Email Service → Email Sending:

1. Onboard `proofs.rs` and complete the provided SPF/DKIM/DMARC/bounce-domain setup.
2. Add an Email Sending event subscription scoped to `proofs.rs`, selecting all message
   lifecycle events and destination queue `proofs-rs-production-reports-jobs`.
   The existing Worker handles delivery, failure, bounce and complaint events.
3. Copy the subscription ID into the GitHub Actions variable
   `PRODUCTION_EMAIL_EVENT_SUBSCRIPTION`.
4. Set the GitHub Actions variable `PRODUCTION_EMAIL_ENABLED=true`.

The sender is `notifications@proofs.rs`. Production has no recipient allowlist;
application preferences and suppression checks control delivery. The sending
binding is restricted to this sender. An empty recipient allowlist is deliberately
omitted. Missing subscription configuration blocks provisioning before mutations.
To pause sending, set `PRODUCTION_EMAIL_ENABLED=false` and run Production again.

## Activate

After Staging succeeds, nyuichi runs Actions → Production → Run workflow → main.
No test mail is sent by deployment. It performs public read-only HTTP checks.
Check `https://proofs.rs/api/v1/config` reports production, OAuth configured,
email_disabled=false and email_configured=true after email activation.
Configuration flags do not prove mailbox delivery; delivery and forwarding remain
unverified until a real message is received.

References:
- https://developers.cloudflare.com/email-service/get-started/send-emails/
- https://developers.cloudflare.com/email-service/get-started/route-emails/
- https://developers.cloudflare.com/email-service/platform/event-subscriptions/
