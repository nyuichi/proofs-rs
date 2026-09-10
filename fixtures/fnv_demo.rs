//! Illustrative harness shape ONLY. No verifier execution is claimed by the demo.
//! The seeded SARIF is synthetic and is not generated from this file.
use std::hash::Hasher;
use fnv::FnvHasher;

#[cfg(kani)]
#[kani::proof]
#[kani::unwind(17)]
fn bounded_write_example() {
    let bytes: [u8; 16] = kani::any();
    let len: usize = kani::any();
    kani::assume(len <= bytes.len());
    let mut hasher = FnvHasher::default();
    hasher.write(&bytes[..len]);
    let _hash = hasher.finish();
}
