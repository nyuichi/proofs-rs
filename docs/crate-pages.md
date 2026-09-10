# Crate snapshots and development demo

A publication is a snapshot for one crate/version. The latest `created_at`, with descending ID as a deterministic tie-break, wins regardless of publisher. Missing results are not inherited implicitly. All older publications remain addressable.

`/` accepts an exact crate name. `/crates/:name` fetches crates.io metadata only, defaults to the latest stable release (or latest release if none), and accepts `?version=`. No rustdoc/API crawling is performed. Missing crates return 404; registry outages return 503 rather than claiming that a crate has no verification.

Only explicitly mapped, publisher-declared public functions/methods appear on the crate page. The publisher supplies the API path, property (`no-ub` or `no-panic`), contract, configuration, and SARIF run/result position. The site validates schema and reference integrity, not the semantic adequacy of the proof. Explicit failed evidence cannot support a success tag. Existing publications retain their raw SARIF detail; tags and public visibility are never guessed during migration.

## Additive storage

`verification_records` stores immutable results and their origin publication, plus an optional superseded result. `publication_records` stores an ordered snapshot's membership. Retaining a result reuses its ID; revising creates a new result with an explicit parent. References must stay within the same crate/version, and revisions retain the same API/kind/property. Different contracts or configurations may coexist. Inserts occur in the existing atomic publication batch. No deletion/update UI is provided.

`/results/:id` shows the result, its explicit revision ancestors, and publications including it. The current implementation displays at most 100 ancestors and 100 usages; histories beyond this are not yet paginated. This is explicit attribution, not content-based inference or verification of author identity beyond the existing publisher login.

## Development environment

Only `feat/crate-pages` triggers `deploy-dev.yml`. Production remains on main and uses its existing workflow. Development creates a separate `proofs-rs-dev` Worker and `proofs-rs-dev-db` D1 using the repository's existing Cloudflare deployment credentials. Configuration is generated and ignored, and the production DB ID is checked against the dev ID before use. The build uses `PROOFS_DEV_CONFIG=wrangler.dev.json`.

The dev app has an explicit demo visitor sign-in, available only when APP_ENV=development and DEMO_MODE=true, and never at the production origin. It creates a synthetic publisher/session through the regular session mechanism. This is an intentionally shared test account on the separate demo DB; it is not a GitHub identity. Existing GitHub OAuth remains unchanged in production. Real GitHub OAuth in dev requires separate client configuration and has not been substituted with fake GitHub credentials.

The seed is idempotent and runs only against the dev config. It includes fnv 1.0.7 baseline results by demo-mika, a newer snapshot by demo-ren which inherits construction, revises bounded writes, and omits finish, plus an independent 1.0.6 snapshot. Seeded evidence is explicitly synthetic, zero commit hashes are placeholders, and the Rust harness is illustrative only. Smoke checks add further synthetic publications through the regular HTTP form/session flow.

## Try it

1. Open `/demo`, then the FNV 1.0.7 link. Expand a property to inspect its contract, configuration, evidence and author.
2. Open the write result's blame/history page; compare the 16-byte and 32-byte contracts.
3. Open the baseline publication to see the omitted finish result. Switch to 1.0.6 to see the separate release.
4. Open the serde link to see an unpublished crate.
5. Continue as demo visitor; a complete draft is prefilled. Publish it.
6. Use “Build on this publication”; retain some results, replace another with new evidence, or omit a result. Publication history preserves earlier snapshots.

Checks cover newest-wins, omissions, immutable attribution, revision chains, version isolation, invalid references, unsupported tags, failed evidence, legacy compatibility and dev authentication gating. The deployment smoke test exercises actual search, pages, login, publication, inheritance and cross-origin rejection.

## API safety and contract source

New results explicitly declare `safe` or `unsafe` and a source language (Rust, Kani, Verus, or Creusot). A single API can have both no-UB and no-panic records; their evidence and conditions remain separate. Safety declarations must agree within a snapshot. Unsafe functions are highlighted even when details are collapsed.

Safe no-UB assertions have no additional caller safety preconditions. This is an assertion supplied by the publisher, not an automatically awarded badge: a safe API can still have an unsound implementation. Configuration/scope is shown separately. Unsafe API records require actual precondition source. Safe no-panic records may be unconditional or carry source-code conditions. Source text is preserved verbatim and rendered as escaped code, not translated into prose or executed/validated by the site.

Old immutable results remain `unknown` safety / `legacy` contract format. Their prose is not presented as code or silently converted to safe/unconditional claims. New versioned demo records show both properties on a safe FNV API, and an unsafe ArrayVec insertion with Kani precondition source. Previous demo snapshots remain in history.
