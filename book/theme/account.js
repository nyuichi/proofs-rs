(() => {
  const container = document.querySelector("#account-nav");
  if (!container) return;
  const showError = () => {
    let message = container.querySelector('[role="alert"]');
    if (!message) {
      message = document.createElement("p");
      message.setAttribute("role", "alert");
      container.append(message);
    }
    message.textContent = "Unable to sign out. Please try again.";
  };
  async function refresh() {
    try {
      const response = await fetch("/api/v1/me", {
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("Unable to check sign-in");
      const me = await response.json();
      window.proofsAccountNavigation(
        container,
        me,
        "/",
        async () => {
          const response = await fetch("/auth/logout", {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": me.csrf || "",
            },
            body: "{}",
          });
          if (!response.ok) throw new Error("Unable to sign out");
          await refresh();
        },
        showError,
      );
    } catch {
      container.innerHTML = '<a href="/#/account">Account</a>';
    }
  }
  void refresh();
})();
