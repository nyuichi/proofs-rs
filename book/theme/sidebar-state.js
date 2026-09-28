// Enable normal toggle animations only after the restored layout is painted.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    document.documentElement.classList.add("proofs-sidebar-ready");
  });
});
