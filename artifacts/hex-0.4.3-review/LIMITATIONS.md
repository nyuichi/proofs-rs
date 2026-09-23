# Scope and limitations

1. The claim covers the annotated encode_to_slice and decode_to_slice implementation and wrappers at the pinned verification commit. The upstream slice loops have been rewritten; equivalence to the unmodified crates.io implementation is not itself mechanically proved.

2. Public generic inputs rely on the trusted AsRef<[u8]> byte-sequence bridge. Creusot library specifications, the verifier, Why3 and SMT solvers are part of the trusted computing base.

3. The generic iterator-based encoding behind encode/encode_upper/ToHex, serde protocols, formatting and arbitrary downstream trait implementations are outside this publication claim. Four passing feature configurations do not prove all feature implementations.

4. The retained proof archive contains the final all-features output and sessions accumulated across four sequential runs, not four independently archived proof trees. File counts are not proof-obligation counts.

5. The run emitted missing dependency-metadata warnings. All four proof commands reported success; this evidence does not establish the bodies of the missing dependencies.

6. SARIF is a curated summary of source contracts and execution logs, not native Creusot output or an independently checked proof certificate. Tests are supplementary evidence, not a proof of equivalence.
