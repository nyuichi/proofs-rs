# hex 0.4.3 rustdoc fixture

Source: https://docs.rs/crate/hex/0.4.3/json.gz (retrieved 2026-09-24).
Format: 60; crate version: 0.4.3.

The JSON retains the public module/reexport graph and associated impl entries
used by extractAPIs, plus paths needed for unnamed trait projections. Unrelated
index entries and documentation text are removed. Function signatures and
generic bounds are copied from the response, not synthesized. CI reads this
fixture without contacting docs.rs.

`hex-0.4.3-legacy-apis.json` freezes all 11 prior extraction results, including
keys, signatures and URLs, to detect compatibility regressions.

`hex-0.4.3-trait-impls.json` is a separate format-60 snapshot retrieved from the
same endpoint on 2026-09-26. Its root contains only the public ToHex and FromHex
traits; all their declarations, implementations and impl items are retained,
along with referenced path summaries. IDs are kept from that response (they
are not stable across docs.rs rebuilds). Documentation, spans and attributes
are omitted; each index item is on one line to keep the 159 macro-expanded
array impls manageable. It covers 162 newly reachable method entries. Neither
fixture is a production catalogue refresh.
