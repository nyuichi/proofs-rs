# Operations

## Deployment and recovery

The Staging workflow provisions a separate D1 database, R2 bucket and job and dead-letter Queues. A failure at provisioning generally means missing API-token scopes or a service not enabled; fix configuration and rerun the workflow. Do not substitute the legacy database ID. A successful deploy is followed by public, read-only checks of HTML and the API. GitHub/Email integration configuration is reported separately.

Back up D1 daily at 02:17 UTC through its export API; poll pending exports on the five-minute Cron. Store SQL dumps privately in R2 `backups/`, retaining the newest 30. Requires `CLOUDFLARE_D1_BACKUP_TOKEN`. RPO target: 24 hours. RTO target: one business day. Check Worker Cron errors and R2 backup timestamps. D1 Time Travel is an additional platform recovery mechanism, not the only backup.

Restore into a new private database, never directly into a serving database. Download the selected SQL backup and **all latest** `erasures/` objects from the current R2 bucket with operator access. Import SQL into a local SQLite file, then run `node scripts/sanitize-restore.mjs private.sqlite latest-erasure-markers/`. This reapplies user erasures and exceptional body redactions, invalidates sessions, cancels pending mail and pauses imports/mail. Export the sanitized database and import it into a new D1 instance. Check integrity and bindings, then change the Worker DB binding. Restore service only after confirming erasures and moderation records. Keep downloaded backups in private temporary storage and remove them after use. The erasure ledger must not be restored from an older snapshot. If ledger access fails, stop the restore.

## Administrative API

Sign in as an admin. Use the browser session and `/api/v1/me` CSRF value, same-origin requests. Never copy a session into an issue. `POST /api/v1/admin/action` takes `{action,target,reason,...}`. Reason is mandatory.

| Action                                | Additional fields                                      | Result                                                                  |
| ------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| report_visibility / comment_visibility | value: public or hidden                                | Hide/restore content                                                    |
| suspend / restore_user                | none                                                   | Account status; suspension revokes sessions                             |
| redact_comment                        | none                                                   | Erase current and retained text, remove votes, preserve thread          |
| redact_revision                       | revision_no                                            | Exceptional redaction with audit and restore marker                     |
| delete_user                           | none                                                   | Ghost attribution, remove private profile/contact/session/votes/stars |
| pause                                 | target: imports_paused or email_paused; value: boolean | Background work stop                                                    |
| retry_email                           | none                                                   | Explicit operator-approved retry, including unknown outcomes            |
| tool                                  | name, description, url, active                         | Curated tool catalogue                                                  |
| tool_version                          | tool_id, version, selectable                           | Curated version catalogue                                               |

`GET /api/v1/admin/comments/:id/history` audits the read. `GET /api/v1/admin/audit` lists recent audit records. `GET /api/v1/admin/deliveries` lists unresolved delivery failures. Keep unknown delivery outcomes under review; retry only after evaluating possible duplicate mail. Inspect the dead-letter Queue in Cloudflare. Replaying an outbox event is safe; creating a new delivery for an uncertain send is not automatically safe.

## Email and authentication

Use separate OAuth registrations for local/staging/production. GitHub username and confirmed primary email synchronize on sign-in. A failure to fetch email preserves a previously confirmed address and the callback shows an email-retry hint. An unverified/no-primary-email response disables the address. Never store GitHub OAuth access tokens.

Cloudflare Email Service requires an onboarded DNS domain. The custom domain is a later setup step; deploy the application independently. Set the sending binding, allowlist and event subscription metadata together. Unknown event sources are refused and go to the dead-letter queue. The service does not parse or link @mentions. Notification content is plain text and contains a permalink, not the comment body.

## Terms updates and contact

Update the Terms and summary, increment `TERMS_VERSION`, then deploy. Existing accounts must explicitly agree before publishing, starring or voting. Reading, notification preferences, logout and requesting account deletion remain available. Signup consent is a notice beside the GitHub button. Retain the last accepted version/time on the account, not a per-post consent log. Keep `contact@proofs.rs` reachable before production and document a temporary direct operator channel during staging while the domain is not configured.

## Billing and service controls

The approved planning estimate is approximately USD 5/month at small scale with Workers Paid, plus usage beyond included quotas. The design contains the detailed assumptions and source links; this is not a spending cap. Set Cloudflare billing/usage notifications around the agreed USD 10/month review threshold in the account dashboard. Notifications do not automatically stop charges. Investigate spikes in Worker requests/CPU, D1 rows read/written, R2 operations/storage, Queues and email. Pause imports/email with the admin API when necessary. Cloudflare account-level budgets and email notifications are operator configuration, not activated by this repository.

## Known integration limits

The parser allowlists rustdoc format 61 and rejects unsupported syntax or unresolved external reexports instead of fabricating API data. crates.io/docs.rs calls happen only on explicit user preparation. This implementation deliberately has no live import/email test in CI. Staging includes explicitly synthetic examples without shared demo logins.

## Report schema reset (2026-09-21)

The report model initializes a new D1 database and R2 bucket named
`proofs-rs-staging-reports-v1` / `proofs-rs-production-reports-v1`, plus separate
`*-reports-jobs` / `*-reports-dead` queues. No old claims, users, tokens, sessions,
imports, mail deliveries or audit records are copied. Old resources are retained
unbound for now; this deployment does not delete their contents. Remove obsolete
resources separately once the new deployment is accepted. Never bind the rewritten
migration set to a pre-report database or restore an old claim-schema backup into it.

The account has been upgraded to Workers Paid. Email remains explicitly disabled
in both committed configurations (`EMAIL_DISABLED=true`), with no sending binding
or event consumer. Existing OAuth secrets are reused. A new database requires
users to sign in again and reauthorize CLIs. Production gets an empty tool catalogue;
staging alone gets fixture tools. Live import/email tests remain excluded.

## Production deployment and proofs.rs

The Production workflow uses `wrangler.production.base.json`, generates an ignored
`wrangler.production.json`, and creates `proofs-rs-production-reports-v1` D1/R2 plus
`proofs-rs-production-reports-jobs`/`proofs-rs-production-reports-dead` Queues. Staging data is not
copied. Email remains disabled. Production deploys require explicit approval through
Actions (`Production` → `Run workflow`, branch `main`). Pushes never deploy production.
Only GitHub user ID `540144` (nyuichi), with triggering actor `nyuichi`, may execute
or rerun Production. Before production credentials are accessed, a separate job
checks that the exact selected commit has a successful Staging run from this repository
on main. A newer push does not change the commit of an already approved run.
If staging has not passed for the selected commit, Production fails without deploying;
wait for Staging and start Production again. This promotes source commits, rebuilding
with npm ci and the committed lockfile; it does not reuse a staging build artifact.

Daily flow: push main → inspect Staging → follow the production link in its summary →
nyuichi clicks Run workflow on main. If main advanced, first inspect that newer staging
version. The authorization summary records the selected SHA and successful staging run.

This workflow-level approval works while the repository is private. GitHub Free/Pro/Team
only support environment required reviewers on public repositories. After making this
repository public, native environment approval can replace manual dispatch: required
reviewer nyuichi only, administrator bypass disabled, self-review allowed (otherwise the
sole reviewer cannot approve their own push). Repository administrators and users able to
change workflows/secrets can change this policy; the actor check does not replace GitHub
repository access controls. Do not grant workflow write access to untrusted accounts.

Before custom-domain activation:

1. Add `proofs.rs` to the same Cloudflare account, Free website plan. Preserve and
   verify the existing DNS records, especially MX/TXT and `mail.proofs.rs`; public
   DNS checks do not enumerate all existing subdomains. Export the Istanco DNS
   zone or review its full record list before switching nameservers. Check DNSSEC
   and remove an old DS record if required by Cloudflare's onboarding instructions.
2. At Istanco, set the two nameservers assigned by Cloudflare; wait for Active.
   Do not invent a CNAME at the domain apex or overwrite existing email records.
3. Create a separate GitHub OAuth App: homepage `https://proofs.rs`, callback
   `https://proofs.rs/auth/github/callback`. Save client ID as repository variable
   `PRODUCTION_GITHUB_CLIENT_ID` and client secret as repository secret
   `PRODUCTION_GITHUB_CLIENT_SECRET`. Keep the staging registration unchanged.
4. Set repository variable `PRODUCTION_CUSTOM_DOMAIN=true`, then run Production.
   Wrangler attaches `proofs.rs` as a Worker Custom Domain and provisions HTTPS.
   The deployment token needs zone access for custom domain creation in addition
   to its existing Workers/D1/R2/Queues permissions. Do not broaden to all zones.
5. Verify HTTPS, GitHub login, Tokens, the API docs link, and `contact@proofs.rs`
   delivery before announcing launch. Tool catalogue starts empty.

Until activation, the production Worker is accessible via its workers.dev URL;
OAuth can remain unconfigured during this preparation phase. All callbacks and
CSRF checks use the configured APP_ORIGIN. Production tokens/users are separate
from staging. `scripts/domain-status.mjs` only reads onboarding status and cannot
change nameservers. The Cloudflare account credentials remain in GitHub Secrets.

## Staging demo fixtures

`Seed staging demo` adds the original Sites-style examples to the existing staging
D1 database only. It runs at the end of a staging deploy, or manually on main.
It is separate from migrations and the Production workflow. The runner verifies
both the staging health response and the exact database name before writing.
All statements are INSERT OR IGNORE: repeats do not duplicate fixtures or overwrite
existing rows. Current fixture set: 6 crates, 8 reports, 13 claims, 10 report revisions, 16 comments,
4 synthetic users, nested/deleted/edited comments, independent report/claim stars and comment votes.

Demo usernames use `demo_` and impossible negative GitHub IDs, no login sessions,
email contacts or notification events. Version suffix `-demo.1` isolates these
releases from real imports. Evidence URLs use example.com and text marks the data
as synthetic. Demo API signatures are illustrative and have no doc_snapshots;
they are for browsing, comments and voting, not publishing new reports or testing
docs.rs import. Use a real release for publication tests. No proof was run.
The generator and original sample data are retained in scripts/fixtures.


## Reviewed tool documentation

Tool registration requires `documentation_id`. Documents live in
`content/tool-docs/manifest.json` and numbered Markdown files. Add a reviewed
non-empty document before calling the admin `tool` action. The initial real
document is `kani`; `demo` is exclusively for synthetic staging examples.
There is no generated editorial content and no end-user editing UI.

Append a numbered file and manifest entry for each revision; do not rewrite
published revisions. Run `node scripts/build-tool-docs.mjs`, commit its generated
`src/tool-doc-content.ts`, and review the Markdown in the same PR. Tests detect
stale generated content. Markdown HTML and images are not executed/rendered;
external links are restricted to HTTP(S).

Versions inherit their tool's document. The admin `tool_version` action can
supply `documentation_id` to bind a different reviewed document. Shared documents
update all referencing versions on deployment. Report revisions are not changed.
The public documentation page defaults to the newest document revision and
provides links to the retained older text.

Migration 0003 maps existing Kani entries and synthetic `demo-*` entries. Before
deploying to an existing environment, inventory other tools; register reviewed
documents and bindings for them in the deployment change. Do not silently assign
Kani documentation to unrelated tools. A missing binding blocks new publication.

## Branch UI preview without deploying

Run `npm run build` then `npm run preview:build`. Open
`dist/branch-preview.html` in a browser. This uses the actual built frontend and
responses from the actual API against an in-memory SQLite database seeded with
synthetic staging fixtures. It does not contact production/staging or allow
sign-in or writes. The preview contains all listing pages; pagination is flattened.
It is suitable for layout, navigation and content review, not live authentication
or editing tests. Existing integration tests exercise authenticated editing.

PR CI attaches this HTML as the `branch-ui-preview` artifact. No merge, staging
migration, production deployment or Cloudflare secret is needed to review it.
