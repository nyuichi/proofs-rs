# hex 0.4.3 rustdoc fixture

Source: https://docs.rs/crate/hex/0.4.3/json.gz (retrieved 2026-09-24).
Format: 60; crate version: 0.4.3.

The JSON retains the public module/reexport graph and associated impl entries
used by extractAPIs, plus paths needed for unnamed trait projections. Unrelated
index entries and documentation text are removed. Function signatures and
generic bounds are copied from the response, not synthesized. CI reads this
fixture without contacting docs.rs.
