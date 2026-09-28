# Report layout staging review

Staging deployment: https://github.com/proofs-rs/proofs-rs/actions/runs/36380075000 (commit `40d3a7f`). Production has not been changed.

All added records are explicitly synthetic and additive/idempotent. No proof was run. The reproduction commands and source commit are illustrative, not executable proof instructions.

| Case | Page | Checks |
| --- | --- | --- |
| Crate catalogue | https://proofs-rs-staging.proofs-rs.workers.dev/#/crate/report-layout-demo?version=1.0.0-demo.1 | 7 APIs, 3 active reports; all four categories plus blanket implementations; external trait paths; unsafe; long names; collapsed multiple implementations |
| Full report | https://proofs-rs-staging.proofs-rs.workers.dev/#/report/345 | 7 API groups, 15 claim links; both labels; two Panic contract claims on decode; expanded trait groups; 55 revisions and 55 comments without More; two runs with SARIF downloads; environment after final diagnostics |
| Past revision | https://proofs-rs-staging.proofs-rs.workers.dev/#/report/345?v=1 | Past revision indicator; claim links retain revision 1; reproduction remains present |
| Minimal content | https://proofs-rs-staging.proofs-rs.workers.dev/#/report/346 | No explanation, evidence, trust text, environment or runs; tool limitations still present; one API/claim |
| Environment without runs | https://proofs-rs-staging.proofs-rs.workers.dev/#/report/347 | Reproduce contains Environment despite no recorded run; no empty run/error output |
| Withdrawn | https://proofs-rs-staging.proofs-rs.workers.dev/#/report/348 | Withdrawn notice and accessible history/claim links; excluded from active crate reports |
| Existing fixtures | https://proofs-rs-staging.proofs-rs.workers.dev/#/crates | arrayvec/bytes retain nested, edited and deleted comments and stars; trait-demo retains original catalogue examples |

## Review steps

- At desktop and at 600px/390px widths, check long API names and both property labels. The right column groups labels with claim links; mobile stacks under the API name.
- Open each API and each property claim link from the full report. Claim detail retains its title, preconditions, explanation, trust, limitations and report-revision context.
- Open Reproduce, both Execution details and Diagnostics & logs, then Environment. Download both SARIF files. Collapse/reopen without another data request.
- Open tool technical limitations and the tool version page; confirm the updated labels.
- Check the last history entry and last comment. Open an old revision and a linked comment thread.
- Sign in on staging to try report/claim stars and commenting/replies on demo reports. Author-only edit/delete/withdraw controls require a report or comment owned by your account; synthetic demo authors cannot be logged into. These authenticated interactions are covered by automated tests, but were not manually exercised in the staging browser session.

## Verification performed

51 tests, typecheck and build passed locally and in deployment. The staging browser showed the crate categories/counts and all report claim groups, 55 revisions, 55 comments, two loaded runs and nested Environment. Both SARIF endpoints returned HTTP 200 with attachment headers. All four report endpoints returned HTTP 200, including the withdrawn record. Narrow viewport visual checks and signed-in interactions remain manual review items.

Fixture source: `scripts/build-staging-demo.py`. Regenerate with `python3 scripts/build-staging-demo.py`. The staging deployment seeds the SQL in bounded additive batches and uploads the two reserved synthetic SARIF objects only to the staging bucket.
