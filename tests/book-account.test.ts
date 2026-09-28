import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

for (const signedIn of [false, true]) {
  test(`Book account navigation and logout (signed in: ${signedIn})`, async () => {
    const dom = new JSDOM(
      '<div id="account-nav"><a href="/#/account">Account</a></div>',
      { url: "https://example.test/book/", runScripts: "outside-only" },
    );
    const w = dom.window;
    let active = signedIn;
    let logoutCalls = 0;
    w.fetch = (async (path: string, options: RequestInit = {}) => {
      if (path === "/auth/logout") {
        assert.equal(options.method, "POST");
        assert.equal(
          (options.headers as Record<string, string>)["X-CSRF-Token"],
          "test-csrf",
        );
        active = false;
        logoutCalls++;
        return new Response("{}");
      }
      assert.equal(path, "/api/v1/me");
      return new Response(
        JSON.stringify({
          user: active
            ? { username: '<img src=x onerror="alert(1)">', role: "admin" }
            : null,
          karma: 12,
          csrf: "test-csrf",
        }),
      );
    }) as any;
    try {
      for (const file of [
        "../public/account-navigation.js",
        "../book/theme/account.js",
      ]) {
        w.eval(readFileSync(new URL(file, import.meta.url), "utf8"));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (signedIn) {
        assert.equal(w.document.querySelector("img"), null);
        assert.equal(
          w.document.querySelector("summary")?.textContent,
          '<img src=x onerror="alert(1)">',
        );
        assert.ok(w.document.querySelector('a[href="/#/account"]'));
        assert.ok(w.document.querySelector('a[href="/#/admin/catalogs"]'));
        (w.document.querySelector("#logout") as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(logoutCalls, 1);
      }
      assert.equal(
        w.document.querySelector('a[href="/auth/github"]')?.textContent,
        "Sign in with GitHub",
      );
    } finally {
      w.close();
    }
  });
}
