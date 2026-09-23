# Releasing cargo-proofs

The `Release cargo-proofs` workflow publishes only `cli/` to crates.io. It does not deploy the service. Registry versions cannot be overwritten; correct a released version with a new version.

## One-time setup and initial 0.1.0 release

1. The CLI is licensed under `MIT OR Apache-2.0`; both license files are included in the package. This does not set the service's license.
2. Log into crates.io and complete account/email verification. Create a short-lived API token with permission to publish `cargo-proofs` (including creation of the new crate). Do not paste it into an issue, chat, or commit.
3. In `nyuichi/proofs-rs`, create the GitHub Actions environment `crates-io` and store that token as its `CARGO_REGISTRY_TOKEN` secret.
4. Merge the release preparation into main after the CLI checks, including the package dry run, pass. Create and push `cargo-proofs-v0.1.0` at that commit. Before Trusted Publishing is configured, the automatic tag run will fail at authentication; no package is published by that failed run.
5. In Actions → Release cargo-proofs → Run workflow, select **main**, set `tag` to `cargo-proofs-v0.1.0`, and enable `bootstrap`. This explicit option uses the initial token; ordinary releases never fall back to it.
6. Once publication succeeds, configure crates.io → cargo-proofs → Settings → Trusted Publishing with owner `nyuichi`, repository `proofs-rs`, workflow filename `release-cli.yml`, and environment `crates-io`.
7. Revoke the initial API token and delete its GitHub secret. Future releases use short-lived OIDC credentials.

The crate must already exist before crates.io accepts a Trusted Publisher configuration. See https://crates.io/docs/trusted-publishing.

## Subsequent releases

1. Update `cli/Cargo.toml` and the package version in `cli/Cargo.lock` together in a PR. Keep the README current; crate contents are public even if the Git repository is private.
2. Merge after CI succeeds.
3. Tag that main commit and push the tag:

   ```sh
   git tag -a cargo-proofs-v0.1.1 -m 'cargo-proofs 0.1.1'
   git push origin cargo-proofs-v0.1.1
   ```

The workflow checks the exact version, main ancestry, license, formatting, unit/integration tests, E2E, clippy, and Cargo's package dry run before publishing. It preserves the verified commit SHA between jobs and serializes releases. Its package archive is retained as a workflow artifact.

To retry a failed publication, run the workflow on main with the same existing tag and `bootstrap` disabled. Check crates.io first: if that version was already accepted, do not republish it or move its tag. A rerun of an already published version fails rather than silently claiming another successful upload.

`workflow_dispatch` runs from branches other than main are skipped. The public package allowlist excludes service files and this internal release guide.
