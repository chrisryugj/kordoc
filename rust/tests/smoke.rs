//! Smoke tests. Real HWP/HWPX fixtures are NOT checked in — wire them up
//! against kordoc's existing `tests/fixtures/` once the PR lands upstream.

#[test]
fn crate_version_is_exposed() {
    assert!(!kordoc_rust::VERSION.is_empty());
}

#[test]
fn modules_are_reachable() {
    // Just ensure the public re-exports compile.
    let _ = std::marker::PhantomData::<kordoc_rust::HwpParser>;
    let _ = std::marker::PhantomData::<kordoc_rust::HwpxParser>;
}
