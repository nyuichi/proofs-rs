# hex 0.4.3 — Creusot re-verification evidence

This directory contains evidence and a **proposed, not yet published** proofs.rs record.

The publication claim is limited to `encode_to_slice` and `decode_to_slice`: exact lowercase encoding, mixed-case decoding, error precedence, first invalid character/index, and unchanged output outside the successfully decoded prefix. Read [Scope and limitations](LIMITATIONS.md) before interpreting the successful runs.

## Source identity

- [Verification source](https://github.com/nyuichi/rust-crate-proofs/tree/3ecf33ddab79f30b840c4e3fe108b75101f92a36/hex/0.4.3)
- [Upstream revision](https://github.com/KokaKiwi/rust-hex/tree/b2b4370b5bf021b98ee7adc92233e8de3f2de792)
- Official hex 0.4.3 archive SHA-256: `7f24254aa9a54b5c858eaee2f5bccdb46aaf0e486a595ed5fd8f86ba55232a70`
- Execution date: 2026-09-24 JST (2026-09-23 UTC).

## Observed results

| Configuration | Command after `cargo creusot prove --` | Result |
| --- | --- | --- |
| No default features | `--no-default-features` | Proved (21 files) |
| alloc only | `--no-default-features --features alloc` | Proved (26 files) |
| serde only | `--no-default-features --features serde` | Proved (21 files) |
| All features | `--all-features` | Proved (26 files) |

The crate-local `verify-all.bash` exited 0. Ordinary `cargo test --offline --all-features` exited 0: 14 unit, 4 serde integration, 2 version-audit and 11 documentation tests passed. Dependency-metadata warnings are retained in the proof log.

## Evidence files

- [verification.log](verification.log): complete proof run output.
- [tests.log](tests.log): ordinary all-feature test output.
- [environment.json](environment.json): tool details, executable hashes and result summary. The exact Creusot source revision was not recovered; binary hashes identify the installed executables.
- [Cargo.lock](Cargo.lock): resolved dependencies used in this run.
- [proof-evidence.tar.gz](proof-evidence.tar.gz): generated Coma files, Why3find proof sessions and crate prover configuration. This is the final output, not a separate snapshot per configuration.
- [upstream-lib.diff](upstream-lib.diff): `src/lib.rs` comparison with the official archive; this is not a complete repository diff or an equivalence proof.
- [SHA256SUMS](SHA256SUMS): checksums for all other files in this directory.

## Reproduction

Check out verification commit `3ecf33ddab79f30b840c4e3fe108b75101f92a36`, preserving its `creusot-libs` directory. Install the matching Creusot toolchain, Why3 and provers described in `environment.json`. Copy this evidence directory's `Cargo.lock` into `hex/0.4.3/`. Ensure dependencies are cached, since `verify-all.bash` forces offline mode.

From `hex/0.4.3/`, run:

```sh
./verify-all.bash
cargo test --offline --all-features
```

Why3 needs working Unix-domain sockets; this environment required execution outside its filesystem sandbox. The run started from a fresh source export without existing build/proof output; caches can be reused between the four sequential configurations.

## Proposed publication

[Review in Japanese](review.md), [publication fields](publication.json), [exact message](publication-message.txt), and [SARIF](hex-0.4.3.sarif.json) are prepared for user review. SARIF is curated from logs and reviewed source contracts and contains explicit limitations and displayable scope metadata. The proofs.rs application validators accepted the fields and SARIF. This GitHub upload does not publish the record to proofs.rs.
