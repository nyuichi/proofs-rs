# proofs.rs

proofs.rs is a small public registry for software-verification publications. A publication records one upstream crate/version, one immutable verification-source reference, and one SARIF 2.1.0 document that may contain multiple tool runs.

The accepted user flow, ER diagram, query shape, deployment order, and current Free-plan cost envelope are documented in [`docs/architecture.md`](docs/architecture.md).

The PoC deliberately keeps the storage model small:

- Cloudflare Worker + React Router v8
- Cloudflare D1
- `publishers`, `sessions`, `publications`, and `sarif_runs` tables
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

## Checks

```sh
pnpm test
pnpm typecheck
pnpm build
```

The unit tests cover metadata constraints, SARIF extraction, PKCE/session helpers, and cookie handling. The production database should start empty; use local fixtures for development tests.

## Publication input

The web form accepts a commit-message-style publication message plus `owner/repository` and an immutable 40- or 64-character hexadecimal commit for the upstream and verification repositories. Paths are optional and are stored without leading slashes; traversal segments are rejected.

SARIF input is limited to 1,000,000 UTF-8 bytes. The root must be SARIF `2.1.0`, contain at least one run and one result, and every result must have a non-empty `ruleId`. External property references are unsupported. Rule IDs are kept in SARIF order, including duplicates. `fullyQualifiedName` is preferred over `name` for logical targets; results without logical targets appear under `Target not specified`.

The Worker performs only shallow structural validation. It does not decide whether a tool actually passed, verify GitHub references, or interpret the meaning of a rule ID.

## Security notes

GitHub OAuth requests no scopes and use `state` plus PKCE S256. GitHub's short-lived access token is used only to fetch `/user`, then discarded. Sessions use opaque random cookies; D1 stores only a SHA-256 token hash. HTTPS uses the `__Host-proofsr_session` cookie with `HttpOnly`, `Secure`, and `SameSite=Lax`; local HTTP uses a development-safe cookie name.

Mutating routes validate the `Origin` header when one is sent. Responses set no-store caching, `nosniff`, frame denial, a strict referrer policy, permissions policy, and `X-Robots-Tag: noindex`. The current CSP uses a narrow `'unsafe-inline'` fallback because React Router's generated document scripts do not yet receive an application nonce; this can be tightened when nonce propagation is wired through the root document.
