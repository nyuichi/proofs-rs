# cargo-proofs

A Rust CLI for publishing existing Kani or Creusot verification to [proofs.rs](https://proofs.rs). For Kani, it discovers `#[kani::proof_for_contract(...)]` harnesses and publishes two claims per API: `no_ub` and `panic_contract`, both under the target's `requires` conditions.

Creusot publishes only `panic_contract`, not `no_ub` or functional correctness claims.

Publishing does **not** run either verifier, inspect a previous run's success, or certify correctness. It records the author's claims and links to the verification source. A contract harness may constrain inputs, concrete types, stubs, or execution in ways that are not captured by the extracted `requires`. Review the preview and describe such restrictions in the report's assumptions/limitations. No verification logs or proofs-specific source comments are required.

## Install

Rust 1.91 or newer, Cargo, and Git must be installed. Once the initial release is published:

```sh
cargo install cargo-proofs --locked
cargo proofs --help
```

The CLI is developed in `cli/` alongside the service. To install a checkout, run `cargo install --path cli --locked` from the repository root. Only the CLI package is distributed on crates.io; access to the service repository is not required to install a published version.

## Quick start

Run inside a crate whose contract verification you have already performed:

```sh
cargo proofs init --tool-version 0.66.0 --title 'Contract verification of my crate'
cargo proofs login
cargo proofs publish --dry-run
cargo proofs publish
```

`init` can detect the installed Kani version if `--tool-version` is omitted. Check that this is the version actually used for verification. It never overwrites an existing `proofs.toml`.

```toml
[report]
title = "Contract verification of my crate" # required
# explanation = "Optional report explanation"
# trusted_assumptions = "Optional shared assumptions"
# limitations = "Optional scope restrictions"
# environment = "Optional verification environment"

[tool]
name = "kani"
version = "0.66.0" # must be registered/selectable on the selected service

# [git]
# remote = "origin" # optional
```

Crate name/version come from Cargo metadata, including workspace inheritance. There is no `[crate]` section. One selected library crate and one tool/version are supported per publication. Use `-p NAME` or `--manifest-path PATH` to select a workspace package. A virtual workspace with multiple packages requires `-p`.

Staging has separate login credentials and publication state:

```sh
cargo proofs login --server https://proofs-rs-staging.proofs-rs.workers.dev
cargo proofs publish --server https://proofs-rs-staging.proofs-rs.workers.dev --dry-run
```

You may set `PROOFS_SERVER` instead. The default is `https://proofs.rs`. Tokens are stored in a per-server file in the OS user config directory (`cargo-proofs`), with mode 0600 on Unix. Set `PROOFS_CONFIG_DIR` to override that credentials directory. Tokens are never saved in the repository. `logout` revokes the token before removing it. HTTP is allowed only for loopback development servers; redirects are not followed.

## Discovery

- Supports library free functions and inherent methods, nested/ordinary external modules, explicit `use` aliases and public reexports, `#[kani::...]` and `#[cfg_attr(kani, kani::...)]`.
- `requires` predicates are conjoined. No `requires` means `true`, for both claims, including safe APIs.
- Ordinary `#[kani::proof]` harnesses are ignored with a notice. Their target/scope cannot be safely inferred from arbitrary code.
- Multiple contract harnesses for one API, ambiguous targets/reexports, trait methods, and `include!` source trees stop publication. Glob imports are not used to guess targets. Macro-generated functions/harnesses are not expanded or discovered; this is a source parser, not a Rust compiler frontend.
- Conditional compilation is evaluated with `kani`, the selected Cargo features, and `rustc --print cfg` for the host or `--target`. Pass `--features foo,bar`, `--all-features`, `--no-default-features`, and `--target` to match verification. Build-script/custom cfgs are not inferred; encountered unsupported cfgs stop discovery. Integration-test targets are not scanned. Target-dependent dependency feature unification and RUSTFLAGS are not used to infer library features.
- The service's imported public API catalogue is authoritative. Missing APIs or multiple public API matches stop publication; no silent skipping.
- The local fork's implementation may differ from the published crate with the same name/version. The CLI does not prove equivalence; evidence identifies the exact fork commit.

## Creusot

```sh
cargo proofs init --tool creusot --tool-target annotated --tool-version VERSION --title 'My verification report'
cargo proofs login
cargo proofs publish --dry-run
cargo proofs publish
```

Use the version actually used for verification; it must be registered on the service. `init` tries `cargo creusot --version` when `--tool-version` is omitted. Review tool-version limitations on proofs.rs, including any panics outside the verifier's coverage.

```toml
[report]
title = "My verification report"

[tool]
name = "creusot"
version = "VERSION"
target = "annotated" # required: "annotated" or "all"
```

- `annotated`: public free functions and inherent methods with `requires` or `ensures`.
- `all`: public free functions and inherent methods even without these annotations. This selects source APIs; it does not attest that every function was verified.
- Both exclude `trusted`, `logic`, `predicate`, `law`, and `check(ghost)` functions, including explicitly imported aliases. Private functions/types and APIs without a public path are excluded. Trait methods, macro-generated APIs and glob reexports are not discovered. Explicit function/type/module reexports are supported; complex reexport chains may require future compiler-backed discovery.
- Recognizes bare attributes, `creusot_std::...` / legacy `creusot_contracts::...`, and `cfg_attr`. Explicit macro imports/aliases are resolved; arbitrary user-defined wrapper macros and renamed dependency crates are unsupported. Bare attribute names are interpreted as Creusot attributes under this tool selection.
- `requires` retains its original Pearlite source text, including `@`, `^`, quantifiers and implication. Multiple predicates are parenthesized and joined with `&&`; absence means `true`. `ensures` only selects an API, never becomes a precondition or functional correctness claim.
- Evidence points to the API declaration and body, including its attributes. Logic bodies are not parsed as Rust expressions.
- Conditional compilation uses `creusot` instead of `kani`, together with selected Cargo features and platform cfgs. The existing source-discovery limitations still apply.

`[tool].target` selects APIs; CLI `--target` selects the Rust compilation target. They are separate settings. Kani does not accept `[tool].target`: its targets remain explicit `proof_for_contract` harnesses.

## Git and evidence

Select a remote from `[git].remote`, the branch's tracking remote, `origin`, or the sole remote, in that order. Only GitHub HTTPS/SSH remotes are supported.

Publication fetches remote heads/tags into temporary refs and verifies that HEAD is reachable from a freshly fetched remote commit. Stale tracking refs are not trusted. Unpushed or unverifiable commits stop publication. No automatic commit or push occurs. Shallow history may require `git fetch --unshallow`.

Commit working-tree changes before publishing. The initial implementation conservatively rejects all nonignored changes across the repository, except the selected `proofs.toml`. This also covers workspace configuration/dependencies. Keep unrelated generated files ignored. The shared evidence is a commit-fixed GitHub tree URL; each claim links directly to its Kani harness or Creusot API's file and line range at that commit. Source files must be tracked and within the repository.

## Revisions, conflicts, and recovery

Publication state is stored under the Git common directory in `cargo-proofs/`, isolated by server, author, package manifest, crate and version. It is not committed. One process may publish a given package/state at a time.

- Repeat `publish` revises the same report and preserves existing claim IDs. An unchanged report produces no revision.
- A changed crate version starts a new report (the service makes report crate/version immutable).
- On another machine, or after losing local state, use `publish --report ID` to attach explicitly. The CLI matches claims by API/property and refuses duplicate matches.
- Titles/explanations and other individual editorial fields from the server are preserved. The report title is controlled by TOML; shared optional fields are preserved when absent, or cleared when explicitly `""`. Contracts and evidence are controlled by the current source/Git state.
- If the server revision changed since the last publication, show the differences and stop. `publish --dry-run` previews the prospective update. `publish --force` applies the local/config-owned fields over the latest server state, preserving unspecified editorial fields. It still sends `expected_revision` so a concurrent edit after fetching is rejected.
- Missing contracts remove claims only after a yes/no prompt. Noninteractive approval requires `--yes`. `--force` does not approve deletions or bypass Git checks. Removed claims retain their history/permanent links on the service. Locally known removed claim IDs are reused if their contracts are later restored; recovering removed IDs on a different machine is not automatic.
- Before a write, the CLI saves the exact request and idempotency key atomically. If publication is interrupted, `publish --resume` retries that saved request rather than generating another report. It prints the saved payload and uses its original evidence commit, not today's worktree. No fresh Git check is required for resending an already approved request. Definite rejected requests are cleared so they can be corrected; ambiguous/network failures retain the journal.

`--dry-run` never publishes a report or updates its local baseline, but authenticates, verifies Git, and may ask the service to import the API catalogue. Imports can take several minutes. The report limit is 100 claims (50 Kani APIs or 100 Creusot APIs) and 128 KiB; automatic splitting is deliberately unsupported.

## Development

```sh
cd cli
cargo fmt --check
cargo test
cargo clippy --all-targets -- -D warnings
cargo build --locked
python3 tests/e2e.py target/debug/cargo-proofs
```

CI runs tests on Linux and macOS. Tests use temporary Git repositories and local HTTP servers; they never publish to proofs.rs, run Kani/Creusot, or push user source repositories.
