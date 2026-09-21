# proofs.rs

A registry of verification reports and per-API claims for Rust APIs. The service records evidence URLs; it does not run proofs or certify correctness.

Cloudflare Workers (Hono/TypeScript), D1, private R2, Queues, Cron, Workers Assets, GitHub OAuth and optional Cloudflare Email Service. The frontend retains the approved plain-document design. See [backend design](docs/backend-design.md) and [operations](docs/operations.md).

## Development

Requires Node 24. `npm ci`, `npm run build`, `npm run db:local`, then `npm run dev`. Copy `.dev.vars.example` to `.dev.vars` and configure a development GitHub OAuth app to enable sign-in. Callback: `http://localhost:8787/auth/github/callback`. No local auth bypass is exposed by the Worker. `npm test` uses an in-memory SQLite adapter and fixture rustdoc JSON, never a live docs.rs request or email send.

`npm run typecheck`, `npm test`, `npm run build` are the deployment gates. The first migration creates immutable revisions, transaction guards, comment history, independent report/claim stars, comment votes, outbox events and delivery states. A keyset cursor is used for lists. The tool catalogue starts empty. Tools and versions are stored in D1 and can be added or updated through the audited admin API without a deployment.

## Staging

Pushes to `main` run `.github/workflows/deploy.yml`. `scripts/provision.mjs` creates/reuses only resources named `proofs-rs-staging-*` and writes the ignored `wrangler.staging.json`. Staging is public on workers.dev, with no Cloudflare Access gate and `noindex` headers. Old Worker and database resources are not modified. The custom domain is intentionally left unconfigured.

Required GitHub Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`: scoped to the account, Workers Scripts edit, D1 edit, R2 edit, Queues edit, and account/subdomain read as required by Cloudflare. R2 and Queues must be enabled. The account uses Workers Paid. Email sending is explicitly disabled.

Optional integration settings (missing integrations are visibly marked, not silently simulated):

- Repository variable `STAGING_GITHUB_CLIENT_ID`, secret `STAGING_GITHUB_CLIENT_SECRET`. OAuth callback: the deployed origin plus `/auth/github/callback`. Use a separate staging OAuth app.
- Variable `ADMIN_GITHUB_IDS`, comma-separated GitHub numeric IDs. Defaults to repository owner nyuichi (`540144`).
- `STAGING_EMAIL_FROM`, `STAGING_EMAIL_ALLOWLIST`, `STAGING_EMAIL_DOMAIN`, `STAGING_EMAIL_EVENT_SUBSCRIPTION`: variables after Email Service onboarding and event subscription to `proofs-rs-staging-email-events`. Staging delivers only to the explicit allowlist.
- Secret `CLOUDFLARE_D1_BACKUP_TOKEN`, with D1 export permission. This is separate from the deploy token.
- Optional secret `STAGING_TOKEN_SECRET`. A random Worker-only secret is generated on first deployment and preserved on subsequent deployments. It signs unsubscribe URLs.

No GitHub tokens or client secrets are committed or included in the browser build. Workflow logs contain secret names, not values.

## Data and behavior

- First explicit preparation of a crate/version imports crates.io metadata plus one docs.rs rustdoc JSON; later publications reuse D1. Unsupported rustdoc formats fail closed. Initial allowlist: format 61. No whole-registry crawl, no re-run of proofs, no HTML scraping fallback.
- Reports publish one crate/version and tool/version with 1–100 claims in one transaction. Claim API/property and IDs are immutable. Shared and individual fields are additive; empty claim titles are generated. Full-report revisions retain stars and history.
- Independent report/claim stars survive revisions. Only non-self report stars contribute to karma; one replaceable policy in `src/core.ts` supplies profile and list/detail scores.
- Comments belong only to reports. Removed claims keep permanent links to their historical report revision.
- Replies form an unbounded-depth tree; every reply level indents. Deleted comments retain a public tombstone and private history.
- Notifications arise only from new comments, deduplicate recipients and skip the author. Unknown send outcomes are not automatically retried.
- Admin APIs require the same session/CSRF/terms guards plus the admin role. Every moderation action and history read is audited. There is no public history endpoint.

## Email disabled

`EMAIL_DISABLED=true` skips new email notifications and cancels pending/retry deliveries; it never accumulates a backlog for later sending. The email binding and email-event consumer are omitted. Existing user preferences are retained. docs.rs imports are implemented. No live import or email tests are run. Enabling arbitrary-recipient email later requires Workers Paid and deliberate configuration changes.

## Release boundary

Before production: configure OAuth, domain/DNS and contact mailbox, Email Service if desired, backup credentials, billing notifications, restore access and operator procedures. Publishing the GitHub repository and attaching proofs.rs are separate later actions. No external docs.rs import or email delivery verification is performed by CI.


## CLI authentication and API documentation

Open `/docs/api` for the API reference and `/openapi.json` for OpenAPI 3.1.
The fixed public client ID is `proofs-cli`. Start at `POST /auth/device/code`,
show the returned user code, open the verification URL, and poll
`POST /auth/device/token`. Tokens have publishing scope, expire after 90 days,
and can be revoked in Settings or through `POST /api/v1/tokens/revoke`.
The Rust CLI lives in [`cli/`](cli/README.md) so API and client changes can be reviewed together.
Install it from this repository with `cargo install --path cli --locked` (Rust 1.91+).
CLI versions and future releases remain independent of service deployments.

The `CLI and service checks` workflow runs Rust formatting, tests, Clippy and a local
HTTP/Git end-to-end test on Linux/macOS, alongside service type checks, tests and build.
It does not deploy, publish a crate, or send reports to a running proofs.rs instance.

Regenerate the checked-in API specification with `python3 scripts/openapi.py`.
The test suite checks coverage against every non-administrative API/auth route.
