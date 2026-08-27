# proofs.rs

[![Deploy](https://github.com/nyuichi/proofs-rs/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/nyuichi/proofs-rs/actions/workflows/deploy.yml)

proofs.rs is a small public registry for software-verification publications. A publication records one upstream crate/version, one immutable verification-source reference, and one SARIF 2.1.0 document that may contain multiple tool runs.

The accepted user flow, ER diagram, query shape, deployment order, and current Free-plan cost envelope are documented in [`docs/architecture.md`](docs/architecture.md).

The PoC deliberately keeps the storage model small:

- Cloudflare Worker + React Router v8
- Cloudflare D1
- `publishers`, `sessions`, `publications`, `publication_labels`, and `sarif_runs` tables
- Evidence source files remain in the publisher's GitHub repository
- Rule and result rows are not normalized; SARIF run JSON is parsed when it is displayed

## Local development

Use Node 24+ and pnpm 11+.

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm dev
```

Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.dev.vars` to enable OAuth locally. The callback URL is `http://localhost:5173/auth/github/callback` unless `APP_ORIGIN` is set. Real credentials must never be committed.

Apply the local D1 migration with:

```sh
pnpm exec wrangler d1 migrations apply proofs-rs-db --local
```

## Production deployment

Pushing to `main` runs [the deploy workflow](https://github.com/nyuichi/proofs-rs/actions/workflows/deploy.yml). You can also run it manually with `workflow_dispatch`, but runs are guarded to the `main` branch. Deployments are serialized so that only one production deployment runs at a time.

Before the first run, add these repository secrets under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN`: a scoped Cloudflare API token with the Workers Scripts Edit and D1 Edit permissions required by Wrangler.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account that owns the Worker and `proofs-rs-db` D1 database.

See Cloudflare's [GitHub Actions setup guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) for creating and scoping the token. These values are passed to GitHub Actions only for the migration and deploy steps; do not commit them to `wrangler.jsonc` or `.dev.vars`.

Production OAuth also needs the Worker secret `GITHUB_CLIENT_SECRET`. Set it once from a trusted, authenticated environment after the initial deployment:

```sh
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --config wrangler.jsonc
```

The workflow runs each deployment in this order: install the frozen lockfile, run tests, typecheck, build, apply pending remote D1 migrations with `wrangler d1 migrations apply proofs-rs-db --remote`, and then deploy the Worker with `wrangler deploy`. Migrations therefore complete before new Worker code is published. Keep migrations backward-compatible with the currently deployed Worker; a failed deploy does not roll back migrations.

## Checks

```sh
pnpm test
pnpm typecheck
pnpm build
```

The unit tests cover metadata constraints, SARIF extraction, PKCE/session helpers, and cookie handling. The production database should start empty; use local fixtures for development tests.

## Publication input

The web form accepts a commit-message-style publication message, up to eight neutral publication labels, plus `owner/repository` and an immutable 40- or 64-character hexadecimal commit for the upstream and verification repositories. Labels are trimmed, limited to 32 Unicode characters, and unique per publication after case-insensitive NFKC normalization. Paths are optional and are stored without leading slashes; traversal segments are rejected.

SARIF input is limited to 1,000,000 UTF-8 bytes. The root must be SARIF `2.1.0`, contain at least one run and one result, and every result must have a non-empty `ruleId`. External property references are unsupported. Rule IDs are kept in SARIF order, including duplicates. `fullyQualifiedName` is preferred over `name` for logical targets; results without logical targets appear under `Target not specified`.

The Worker performs only shallow structural validation. It does not decide whether a tool actually passed, verify GitHub references, or interpret the meaning of a rule ID.

## Security notes

GitHub OAuth requests no scopes and use `state` plus PKCE S256. GitHub's short-lived access token is used only to fetch `/user`, then discarded. Sessions use opaque random cookies; D1 stores only a SHA-256 token hash. HTTPS uses the `__Host-proofsr_session` cookie with `HttpOnly`, `Secure`, and `SameSite=Lax`; local HTTP uses a development-safe cookie name.

Mutating routes validate the `Origin` header when one is sent. Responses set no-store caching, `nosniff`, frame denial, a strict referrer policy, permissions policy, and `X-Robots-Tag: noindex`. The current CSP uses a narrow `'unsafe-inline'` fallback because React Router's generated document scripts do not yet receive an application nonce; this can be tightened when nonce propagation is wired through the root document.
