import { legal } from "./legal";
const root = document.querySelector<HTMLElement>("#app")!;
let me: any = null,
  config: any = {},
  draft: any = {},
  draftTarget: any = null,
  editing: number | null = null,
  expected = 0,
  formKey = crypto.randomUUID(),
  routeID = 0;
const esc = (v: any) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );
const enc = encodeURIComponent;
const date = (v: string) =>
  v ? new Date(v).toISOString().replace("T", " ").replace(".000Z", " UTC") : "";
const user = (id: string, name: string) =>
  id
    ? `<a class="user-link" href="#/user/${enc(id)}">${esc(name || "ghost")}</a>`
    : "ghost";
const prop = (p: string) =>
  p === "no_ub" ? "No undefined behavior" : "Panic contract";
const notice =
  '<p class="meta">By publishing, you agree to the <a href="#/terms">Terms</a> and license your original contribution under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. See our <a href="#/privacy">Privacy Policy</a>.</p>';
class NavigationChanged extends Error {}
async function request(path: string, method = "GET", body?: any, key?: string) {
  const generation = routeID;
  const r = await fetch(path.startsWith("/auth/") ? path : "/api/v1" + path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { "X-CSRF-Token": me?.csrf || "" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const v = await r.json();
  if (generation !== routeID) throw new NavigationChanged();
  if (!r.ok) {
    if (r.status === 428) location.hash = "/terms-update";
    throw new Error(v.message || v.error || `Request failed (${r.status})`);
  }
  return v;
}
function error(e: unknown) {
  if (e instanceof NavigationChanged) return;
  let box = root.querySelector<HTMLElement>('[role="alert"]');
  if (!box) {
    box = document.createElement("p");
    box.role = "alert";
    root.prepend(box);
  }
  box.className = "error";
  box.textContent = e instanceof Error ? e.message : String(e);
}
function bind(selector: string, fn: (e: any) => any, event = "click") {
  root.querySelectorAll<HTMLElement>(selector).forEach((el) =>
    el.addEventListener(event, async (e) => {
      e.preventDefault();
      const button =
        el instanceof HTMLButtonElement
          ? el
          : el.querySelector<HTMLButtonElement>(
              'button[type="submit"],button:not([type])',
            );
      if (button) button.disabled = true;
      try {
        await fn(e);
      } catch (err) {
        error(err);
      } finally {
        if (button) button.disabled = false;
      }
    }),
  );
}
function current() {
  return new URL(location.hash.slice(1) || "/", "https://local");
}
function navigate(path: string) {
  if (location.hash === "#" + path) void route();
  else location.hash = path;
}
async function refreshMe() {
  me = await request("/me");
  document.querySelector("#account-nav")!.innerHTML = me.user
    ? `<details><summary>${esc(me.user.username)}</summary><div class="profile-menu"><a href="#/account">My activity (${me.karma} karma)</a><a href="#/my-claims">My claims</a><a href="#/my-comments">My comments</a><a href="#/my-accepts">My accepts</a><a href="#/settings">Settings</a><button id="logout">Sign out</button></div></details>`
    : '<a href="#/login">Sign in with GitHub</a>';
  document.querySelector("#logout")?.addEventListener("click", async () => {
    try {
      await request("/auth/logout", "POST", {});
      draft = {};
      await refreshMe();
      navigate("/");
    } catch (e) {
      error(e);
    }
  });
}
function needUser() {
  if (!me?.user) {
    login();
    return false;
  }
  if (me.terms_required) {
    void termsUpdate();
    return false;
  }
  return true;
}
function claimItem(c: any) {
  return `<article class="claim-item"><a href="#/claim/${c.id}?v=${c.revision_no}">#${c.id} ${esc(c.title)}</a> · v${c.revision_no}${c.latest_revision_no > c.revision_no ? " · Past revision" : ""}${c.accepted_at ? " · Accepted " + date(c.accepted_at) : ""}${c.withdrawn_at ? " · <strong>Withdrawn</strong>" : ""}<div class="meta">${esc(c.crate)} ${esc(c.version)} · <code>${esc(c.display_path)}</code> · ${prop(c.property)}${c.is_unsafe ? " · <strong>unsafe</strong>" : ""}</div><p class="meta">${user(c.author_id, c.username)} · ${date(c.created_at)} · ${c.accept_count} accepts · ${c.comment_count} comments</p></article>`;
}
function pager(data: any, fn: (cursor: number) => any, container: HTMLElement) {
  if (data.next_cursor !== null && data.next_cursor !== undefined) {
    const b = document.createElement("button");
    b.className = "pager";
    b.textContent = "More";
    b.onclick = async () => {
      b.disabled = true;
      try {
        await fn(data.next_cursor);
        b.remove();
      } catch (e) {
        error(e);
        b.disabled = false;
      }
    };
    container.append(b);
  }
}
async function claimsList(path: string, container: HTMLElement, cursor = 0) {
  const data = await request(
    path + (path.includes("?") ? "&" : "?") + "cursor=" + cursor,
  );
  container.insertAdjacentHTML(
    "beforeend",
    data.items.map(claimItem).join("") || (!cursor ? "<p>No claims.</p>" : ""),
  );
  pager(data, (n) => claimsList(path, container, n), container);
}
async function home() {
  const d = await request("/home");
  root.innerHTML = `<section class="home-search"><h1>proofs.rs</h1><p>Verification claims and discussions for Rust APIs.</p><form id="search" class="searchbar"><input name="q" aria-label="Crate name" placeholder="Search crates"><button>Search</button></form></section><div class="home-columns"><section><h2>Recently updated crates</h2>${d.crates.map((c: any) => `<article class="home-entry"><a href="#/crate/${enc(c.name)}">${esc(c.name)}</a> · ${c.claim_count} claims<p class="meta">${date(c.updated_at)}</p></article>`).join("") || "<p>No published claims yet.</p>"}</section><section><h2>Latest discussion</h2>${d.discussion.map((c: any) => `<article class="home-entry"><a href="#/claim/${c.claim_id}?comment=${enc(c.id)}">Claim #${c.claim_id} · comment #${c.sequence_no}</a><p>${esc(c.body.slice(0, 200))}</p><p class="meta">${user(c.author_id, c.username)} · ${date(c.created_at)}</p></article>`).join("") || "<p>No comments yet.</p>"}</section></div>`;
  bind(
    "#search",
    (e) =>
      navigate("/crates?q=" + enc(new FormData(e.target).get("q") as string)),
    "submit",
  );
}
async function crates() {
  const q = current().searchParams.get("q") || "";
  root.innerHTML = `<h1>Crates</h1><form id="search" class="searchbar"><input name="q" aria-label="Crate name" value="${esc(q)}"><button>Search</button></form><div id="results"></div>`;
  bind(
    "#search",
    (e) =>
      navigate("/crates?q=" + enc(new FormData(e.target).get("q") as string)),
    "submit",
  );
  const target = root.querySelector<HTMLElement>("#results")!;
  async function load(n = 0) {
    const d = await request("/crates?q=" + enc(q) + "&cursor=" + n);
    target.insertAdjacentHTML(
      "beforeend",
      d.items
        .map(
          (c: any) =>
            `<p><a href="#/crate/${enc(c.name)}">${esc(c.name)}</a> · ${c.claim_count} claims</p>`,
        )
        .join("") ||
        (!n ? "<p>No matching crates with published claims.</p>" : ""),
    );
    pager(d, load, target);
  }
  await load();
}
async function cratePage(name: string) {
  const d = await request("/crates/" + enc(name) + "/releases");
  const version = current().searchParams.get("version") || d.default_version;
  root.innerHTML = `<h1>${esc(name)}</h1>${version ? `<p>Version <select id="version" aria-label="Version">${d.items.map((r: any) => `<option value="${esc(r.version)}" ${r.version === version ? "selected" : ""}>${esc(r.version)}${r.yanked ? " (yanked)" : ""}</option>`).join("")}</select></p><p><a href="#/publish?crate=${enc(name)}&version=${enc(version)}">Publish a claim</a></p><p class="meta">Public free functions and inherent methods from the docs.rs build. Trait and Deref methods are excluded.</p><form id="filter"><input name="q" aria-label="Filter APIs" placeholder="Filter API paths"><button>Filter</button></form><div id="apis"></div>` : "<p>No published versions.</p>"}`;
  if (!version) return;
  root
    .querySelector("#version")!
    .addEventListener("change", (e) =>
      navigate(
        "/crate/" +
          enc(name) +
          "?version=" +
          enc((e.target as HTMLSelectElement).value),
      ),
    );
  const box = root.querySelector<HTMLElement>("#apis")!;
  async function load(n = 0, q = "") {
    if (!n) box.innerHTML = "";
    const d = await request(
      `/crates/${enc(name)}/${enc(version)}/apis?q=${enc(q)}&cursor=${n}`,
    );
    box.insertAdjacentHTML(
      "beforeend",
      d.items
        .map(
          (a: any) =>
            `<article class="claim-item"><a class="code" href="#/api/${a.id}">${esc(a.display_path)}</a>${a.is_unsafe ? " · <strong>unsafe</strong>" : ""}<p class="meta">Panic contract: ${a.panic_count} · No UB: ${a.no_ub_count}</p></article>`,
        )
        .join("") || "<p>No matching APIs.</p>",
    );
    pager(d, (m) => load(m, q), box);
  }
  bind(
    "#filter",
    (e) => load(0, String(new FormData(e.target).get("q"))),
    "submit",
  );
  await load();
}
async function apiPage(id: string) {
  const a = await request("/apis/" + enc(id));
  root.innerHTML = `<p><a href="#/crate/${enc(a.crate)}?version=${enc(a.version)}">${esc(a.crate)} ${esc(a.version)}</a></p><h1 class="code">${esc(a.display_path)}</h1>${a.is_unsafe ? "<p><strong>unsafe API — callers must uphold its safety requirements.</strong></p>" : ""}<pre class="signature">${esc(a.signature)}</pre><p><a href="${esc(a.upstream_url)}" target="_blank" rel="noopener noreferrer">Documentation on docs.rs</a></p><p class="meta">Target: ${esc(a.target)}. Catalogue uses the docs.rs build configuration.</p><p><a href="#/publish?api=${enc(a.id)}">Publish a claim</a></p><h2>Claims</h2><div id="claims"></div>`;
  await claimsList(
    "/apis/" + enc(id) + "/claims",
    root.querySelector("#claims")!,
  );
}
function detail(c: any) {
  return `<article><h1>#${c.id || "Preview"}: ${esc(c.title)}</h1><p>${esc(c.crate || draftTarget?.crate)} ${esc(c.version || draftTarget?.version)} · <code>${esc(c.display_path || draftTarget?.display_path)}</code>${c.is_unsafe || draftTarget?.is_unsafe ? " · <strong>unsafe</strong>" : ""}</p><h2>${prop(c.property)}</h2>${c.withdrawn_at ? "<p><strong>Withdrawn by the author.</strong></p>" : ""}<dl><dt>Preconditions</dt><dd class="code preserve">${esc(c.precondition || "None stated")}</dd><dt>Explanation</dt><dd class="preserve">${esc(c.explanation)}</dd><dt>Trusted assumptions</dt><dd class="preserve">${esc(c.trusted_assumptions)}</dd><dt>Tool</dt><dd>${esc(c.tool || draft.tool_name || "")} ${esc(c.tool_version || draft.tool_version || "")}</dd><dt>Environment</dt><dd class="preserve">${esc(c.environment || "Not specified")}</dd><dt>Evidence</dt><dd><a href="${esc(c.evidence_url)}" target="_blank" rel="noopener noreferrer">${esc(c.evidence_url)}</a></dd><dt>Limitations</dt><dd class="preserve">${esc(c.limitations || "None stated")}</dd></dl></article>`;
}
let commentReply: any = null;
async function claimPage(id: number) {
  const base = await request("/claims/" + id),
    version = Number(current().searchParams.get("v") || base.revision_no);
  const c =
    version === base.revision_no
      ? base
      : await request(`/claims/${id}/revisions/${version}`);
  commentReply = null;
  root.innerHTML = `${detail(c)}<p>${user(c.author_id, c.username)} · ${date(c.created_at)}</p><p class="versions">Revision ${base.versions.map((v: any) => `<a ${v.revision_no === version ? 'aria-current="page"' : ""} href="#/claim/${id}?v=${v.revision_no}">v${v.revision_no}</a>`).join(" · ")}${version !== base.revision_no ? " · <strong>Past revision</strong>" : ""}</p>${me.user?.id === c.author_id ? `<p><a href="#/publish?update=${id}">Publish new revision</a>${!c.withdrawn_at ? ' · <button id="withdraw">Withdraw claim</button>' : ""}</p>` : ""}<section id="accepts"><h2>Accepts (${c.accept_count})</h2><p>An Accept means the reader considers the evidence reasonable. It is not a certificate of correctness.</p><div id="accept-list"></div>${me.user && me.user.id !== c.author_id ? '<button id="accept">Accept this revision</button> <button id="unaccept">Withdraw my Accept</button>' : ""}</section><section class="discussion"><h2>Comments (${base.comment_count})</h2><div class="thread-container" id="comments"></div><h3 id="reply-label">Add a comment</h3>${me.user ? `<form id="comment-form" class="comment-form"><label>Revision <select name="revision_no">${base.versions.map((v: any) => `<option value="${v.revision_no}" ${v.revision_no === version ? "selected" : ""}>v${v.revision_no}</option>`).join("")}</select></label><textarea name="body" required maxlength="5000" aria-label="Comment"></textarea>${notice}<button>Post comment</button> <button type="button" id="cancel-reply" hidden>Cancel reply</button></form>` : '<p><a href="#/login">Sign in to comment.</a></p>'}</section>`;
  const acceptBox = root.querySelector<HTMLElement>("#accept-list")!;
  async function acceptList(n = 0) {
    const a = await request(
      `/claims/${id}/revisions/${version}/accepts?cursor=${n}`,
    );
    acceptBox.insertAdjacentHTML(
      "beforeend",
      a.items
        .map(
          (x: any) =>
            `<p>${user(x.user_id, x.username)} · ${date(x.created_at)}</p>`,
        )
        .join("") || (!n ? "<p>No accepts for this revision.</p>" : ""),
    );
    pager(a, acceptList, acceptBox);
  }
  await acceptList();
  bind("#accept", async () => {
    await request(`/claims/${id}/revisions/${version}/accept`, "PUT", {});
    await refreshMe();
    await route();
  });
  bind("#unaccept", async () => {
    await request(`/claims/${id}/revisions/${version}/accept`, "DELETE");
    await refreshMe();
    await route();
  });
  bind("#withdraw", async () => {
    if (
      confirm(
        "Withdraw this claim? Its revisions and discussion remain public.",
      )
    ) {
      await request(`/claims/${id}/withdrawal`, "PUT", {});
      await refreshMe();
      await route();
    }
  });
  const box = root.querySelector<HTMLElement>("#comments")!;
  const focus = current().searchParams.get("comment");
  if (focus) {
    const x = await request("/comments/" + enc(focus));
    box.innerHTML = `<p>Linked thread · <a href="#/claim/${id}?v=${version}">Show all comments</a></p>`;
    let parent = box;
    for (const cid of x.ancestors) {
      const row = cid === focus ? x : await request("/comments/" + enc(cid));
      const nested = renderComment(row, parent, id);
      parent = nested;
    }
    await loadComments(id, focus, parent);
    root.querySelector("#comment-" + CSS.escape(focus))?.scrollIntoView();
  } else await loadComments(id, null, box);
  const form = root.querySelector<HTMLFormElement>("#comment-form");
  if (form) {
    let key = crypto.randomUUID();
    bind(
      "#comment-form",
      async () => {
        const f = new FormData(form);
        await request(
          `/claims/${id}/comments`,
          "POST",
          {
            body: f.get("body"),
            revision_no: Number(f.get("revision_no")),
            reply_to_id: commentReply?.id || null,
          },
          key,
        );
        key = crypto.randomUUID();
        await route();
      },
      "submit",
    );
    bind("#cancel-reply", () => {
      commentReply = null;
      root.querySelector("#reply-label")!.textContent = "Add a comment";
      (root.querySelector("#cancel-reply") as HTMLElement).hidden = true;
    });
  }
}
async function loadComments(
  claimID: number,
  parentID: string | null,
  container: HTMLElement,
  cursor = 0,
) {
  const d = await request(
    `/claims/${claimID}/comments?cursor=${cursor}${parentID ? "&parent_id=" + enc(parentID) : ""}`,
  );
  for (const cm of d.items) {
    const child = renderComment(cm, container, claimID);
    if (cm.reply_count) await loadComments(claimID, cm.id, child);
  }
  if (!parentID && !d.items.length && !cursor)
    container.insertAdjacentHTML("beforeend", "<p>No comments.</p>");
  pager(d, (n) => loadComments(claimID, parentID, container, n), container);
}
function renderComment(cm: any, container: HTMLElement, claimID: number) {
  const article = document.createElement("article");
  article.className = "comment";
  article.id = "comment-" + cm.id;
  article.innerHTML = `<div class="comment-top">${user(cm.author_id, cm.username)} <time>${date(cm.created_at)}</time><a href="#/claim/${claimID}?v=${cm.revision_no}&comment=${enc(cm.id)}">v${cm.revision_no} · #${cm.sequence_no}</a>${!cm.deleted_at && !cm.hidden ? `<span class="vote"><button data-vote="1" aria-label="Upvote" aria-pressed="${cm.my_vote === 1}">▲</button> ${cm.score} <button data-vote="-1" aria-label="Downvote" aria-pressed="${cm.my_vote === -1}">▼</button></span>` : ""}</div><div class="comment-content"><p class="preserve">${cm.deleted_at ? "<em>deleted comment</em>" : cm.hidden ? "<em>hidden comment</em>" : esc(cm.body)}</p>${cm.edited_at && !cm.deleted_at ? `<p class="meta">Edited ${date(cm.edited_at)}</p>` : ""}</div><div class="comment-actions">${me.user ? "<button data-reply>Reply</button>" : ""}${me.user?.id === cm.author_id && !cm.deleted_at && !cm.hidden ? "<button data-edit>Edit</button><button data-delete>Delete</button>" : ""}</div><div class="editor"></div>`;
  container.append(article);
  const children = document.createElement("div");
  children.className = "comment-children";
  container.append(children);
  const action = (sel: string, fn: (el: HTMLElement) => any) =>
    article.querySelectorAll<HTMLElement>(sel).forEach(
      (el) =>
        (el.onclick = async () => {
          try {
            await fn(el);
          } catch (e) {
            error(e);
          }
        }),
    );
  action("[data-reply]", () => {
    commentReply = cm;
    root.querySelector("#reply-label")!.textContent =
      `Reply to #${cm.sequence_no}`;
    const f = root.querySelector<HTMLFormElement>("#comment-form")!;
    (f.elements.namedItem("revision_no") as HTMLSelectElement).value = String(
      cm.revision_no,
    );
    (root.querySelector("#cancel-reply") as HTMLElement).hidden = false;
    (f.elements.namedItem("body") as HTMLTextAreaElement).focus();
  });
  action("[data-vote]", async (el) => {
    if (!needUser()) return;
    const v = Number(el.dataset.vote);
    await request(
      "/comments/" + cm.id + "/vote",
      cm.my_vote === v ? "DELETE" : "PUT",
      cm.my_vote === v ? undefined : { value: v },
    );
    await route();
  });
  action("[data-delete]", async () => {
    if (
      confirm("Delete this comment? Its previous text is retained privately.")
    ) {
      await request("/comments/" + cm.id, "DELETE", {
        edit_version: cm.edit_version,
      });
      await route();
    }
  });
  action("[data-edit]", () => {
    const box = article.querySelector<HTMLElement>(".editor")!;
    box.innerHTML = `<form><textarea name="body" required maxlength="5000" aria-label="Edit comment">${esc(cm.body)}</textarea>${notice}<button>Save</button> <button type="button">Cancel</button></form>`;
    box
      .querySelector('button[type="button"]')!
      .addEventListener("click", () => (box.innerHTML = ""));
    box.querySelector("form")!.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await request("/comments/" + cm.id, "PATCH", {
          body: new FormData(e.target as HTMLFormElement).get("body"),
          edit_version: cm.edit_version,
        });
        await route();
      } catch (e) {
        error(e);
      }
    };
  });
  return children;
}
function login() {
  root.innerHTML = `<h1>Sign in</h1><p>Use your GitHub account to sign in or create an account.</p><p>By signing up, you agree to the <a href="#/terms">Terms</a> and acknowledge the <a href="#/privacy">Privacy Policy</a>.</p>${config.oauth_configured ? '<a href="/auth/github">Continue with GitHub</a>' : "<p>GitHub sign-in is currently unavailable.</p>"}`;
}
async function termsUpdate() {
  if (!me.user) return login();
  root.innerHTML = `<h1>Updated terms</h1>${legal.terms.body}<p>Version: ${esc(config.terms_version)}</p><button id="agree">Agree and continue</button>`;
  bind("#agree", async () => {
    await request("/me/terms-acceptance", "POST", {
      version: config.terms_version,
    });
    await refreshMe();
    navigate("/account");
  });
}
async function activity(id: string) {
  const u = await request("/users/" + enc(id));
  root.innerHTML = `<h1>${esc(u.username)}</h1><p><a href="https://github.com/${enc(u.username)}" rel="noopener noreferrer">GitHub profile</a></p><p>${u.karma} karma · joined ${date(u.created_at)}</p><h2>Claims</h2><div id="claims"></div><h2>Comments</h2><div id="activity-comments"></div>`;
  await claimsList(
    "/users/" + enc(u.id) + "/claims",
    root.querySelector("#claims")!,
  );
  await commentsList(
    "/users/" + enc(u.id) + "/comments",
    root.querySelector("#activity-comments")!,
  );
}
async function mine(kind: string) {
  if (!needUser()) return;
  root.innerHTML = `<h1>My ${esc(kind)}</h1><div id="items"></div>`;
  const box = root.querySelector<HTMLElement>("#items")!;
  if (kind !== "comments") return claimsList("/me/" + kind, box);
  await commentsList("/me/comments", box);
}
async function commentsList(path: string, box: HTMLElement, cursor = 0) {
  const d = await request(path + "?cursor=" + enc(String(cursor)));
  box.insertAdjacentHTML(
    "beforeend",
    d.items
      .map(
        (x: any) =>
          `<article><p><a href="#/claim/${x.claim_id}?comment=${enc(x.id)}">Claim #${x.claim_id} · v${x.revision_no} · comment #${x.sequence_no}</a> · ${date(x.created_at)}</p><p class="preserve">${x.deleted_at ? "<em>deleted comment</em>" : esc(x.body)}</p></article>`,
      )
      .join("") || "<p>No comments.</p>",
  );
  pager(d, (n) => commentsList(path, box, n), box);
}
async function settings() {
  if (!me.user) return login();
  const p = await request("/me/notification-preferences");
  root.innerHTML = `<h1>Settings</h1><h2>Account</h2><p>GitHub username: ${esc(me.user.username)}</p><p>Your GitHub username is refreshed when you sign in again.</p><h2>Email notifications</h2><p>Email: ${esc(me.email?.address || "Unavailable")}</p><p>This is the verified primary GitHub email. Your email is refreshed when you sign in again.</p>${current().searchParams.get("email") === "retry" ? "<p>GitHub email lookup failed. Please sign in again to refresh your email.</p>" : ""}${config.email_disabled ? "<p>Email notifications are currently disabled.</p>" : !config.email_configured ? "<p>Email delivery is currently unavailable.</p>" : ""}<form id="prefs"><p><label><input type="checkbox" name="replies" ${p.replies ? "checked" : ""}> Replies to my comments</label></p><p><label><input type="checkbox" name="claim_comments" ${p.claim_comments ? "checked" : ""}> Comments on my claims</label></p><button>Save preferences</button></form><h2>Delete my account</h2><p>For account deletion, contact the operator through <a href="#/contact">Contact</a>.</p>`;

  bind(
    "#prefs",
    async (e) => {
      const f = new FormData(e.target);
      await request("/me/notification-preferences", "PATCH", {
        replies: f.has("replies"),
        claim_comments: f.has("claim_comments"),
      });
      await route();
    },
    "submit",
  );
}
async function toolsPage(id?: string) {
  if (id) {
    const t = await request("/tools/" + enc(id));
    root.innerHTML = `<h1>${esc(t.name)}</h1><p>${esc(t.description)}</p><p><a href="${esc(t.official_url)}" rel="noopener noreferrer">Tool website</a></p><h2>Supported versions</h2><ul>${t.versions.map((v: any) => `<li>${esc(v.version)}${v.selectable ? "" : " (retired)"}</li>`).join("")}</ul><h2>Claims</h2><div id="items"></div>`;
    return claimsList(
      "/tools/" + enc(id) + "/claims",
      root.querySelector("#items")!,
    );
  }
  const d = await request("/tools");
  root.innerHTML = `<h1>Verification tools</h1>${d.items.map((t: any) => `<article><h2><a href="#/tool/${enc(t.id)}">${esc(t.name)}</a></h2><p>${esc(t.description)}</p></article>`).join("") || "<p>No tools have been registered yet.</p>"}<p><a href="https://github.com/nyuichi/proofs-rs/issues/new">Request a tool or version</a></p>`;
}
async function publish() {
  if (!needUser()) return;
  const params = current().searchParams,
    update = Number(params.get("update") || 0);
  if (update && editing !== update) {
    const c = await request("/claims/" + update);
    if (c.author_id !== me.user.id)
      throw new Error("Only the author can revise this claim.");
    draft = { ...c };
    draftTarget = await request("/apis/" + enc(c.api_item_id));
    editing = update;
    expected = c.revision_no;
    formKey = crypto.randomUUID();
  } else if (!update && editing) {
    draft = {};
    draftTarget = null;
    editing = null;
    formKey = crypto.randomUUID();
  }
  if (params.get("api") && !draftTarget)
    draftTarget = await request("/apis/" + enc(params.get("api")!));
  if (draftTarget) return claimForm();
  root.innerHTML = `<h1>Publish a claim</h1><p>Prepare the public API catalogue for one exact crate version. The first request imports it; later requests reuse the cached catalogue.</p><form id="prepare"><label>Crate <input name="crate" required pattern="[A-Za-z0-9_-]+" value="${esc(params.get("crate") || "")}"></label><label>Exact version <input name="version" required placeholder="1.2.3" value="${esc(params.get("version") || "")}"></label><button>Prepare API catalogue</button></form><p id="import-status" role="status"></p><div id="api-select"></div>`;
  bind(
    "#prepare",
    async (e) => {
      const f = new FormData(e.target),
        crate = String(f.get("crate")),
        version = String(f.get("version"));
      let job = await request(
        "/publish/prepare",
        "POST",
        { crate, version },
        formKey,
      );
      const status = root.querySelector("#import-status")!;
      const page = routeID;
      while (job.status !== "ready") {
        if (job.status === "failed")
          throw new Error(job.error || job.error_code || "Import failed.");
        status.textContent =
          "Preparing API catalogue… You can leave this page; the import will continue.";
        await new Promise((r) => setTimeout(r, 2500));
        if (page !== routeID) return;
        job = await request("/imports/" + enc(job.id));
      }
      status.textContent = "Catalogue ready. Select a public API.";
      const box = root.querySelector<HTMLElement>("#api-select")!;
      box.innerHTML =
        '<form id="api-search"><input name="q" aria-label="Filter API" placeholder="Filter API path"><button>Search</button></form><div id="api-results"></div>';
      async function results(q = "", n = 0) {
        const out = box.querySelector<HTMLElement>("#api-results")!;
        if (!n) out.innerHTML = "";
        const d = await request(
          `/crates/${enc(crate)}/${enc(version)}/apis?q=${enc(q)}&cursor=${n}`,
        );
        for (const a of d.items) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "api-option";
          b.textContent = a.display_path + (a.is_unsafe ? " (unsafe)" : "");
          b.onclick = async () => {
            draftTarget = await request("/apis/" + enc(a.id));
            claimForm().catch(error);
          };
          out.append(b);
        }
        pager(d, (m) => results(q, m), out);
      }
      bind(
        "#api-search",
        (e) => results(String(new FormData(e.target).get("q"))),
        "submit",
      );
      await results();
    },
    "submit",
  );
}
async function claimForm() {
  const all = await request("/tools");
  root.innerHTML = `<h1>${editing ? "Publish a new revision" : "Publish a claim"}</h1><p>${esc(draftTarget.crate)} ${esc(draftTarget.version)} · <code>${esc(draftTarget.display_path)}</code>${draftTarget.is_unsafe ? " · <strong>unsafe</strong>" : ""}</p><pre class="signature">${esc(draftTarget.signature)}</pre>${!editing ? '<button id="change-target">Change API</button>' : ""}<form id="claim-form" class="publish-form"><label>Property <select name="property" ${editing ? "disabled" : ""}><option value="panic_contract" ${draft.property === "panic_contract" ? "selected" : ""}>Panic contract</option><option value="no_ub" ${draft.property === "no_ub" ? "selected" : ""}>No undefined behavior</option></select></label><label>Title <input name="title" required maxlength="1000" value="${esc(draft.title)}"></label><label>Preconditions <span id="pre-label"></span><textarea name="precondition" maxlength="10000">${esc(draft.precondition)}</textarea></label><label>Explanation <textarea name="explanation" required maxlength="10000">${esc(draft.explanation)}</textarea></label><label>Trusted assumptions <textarea name="trusted_assumptions" required maxlength="10000">${esc(draft.trusted_assumptions)}</textarea></label><label>Tool / version <select name="tool_version_id" required><option value="">Select a version</option>${all.versions
    .filter(
      (v: any) =>
        v.selectable &&
        all.items.some((t: any) => t.id === v.tool_id && t.active),
    )
    .map(
      (v: any) =>
        `<option value="${esc(v.id)}" ${draft.tool_version_id === v.id ? "selected" : ""}>${esc(all.items.find((t: any) => t.id === v.tool_id)?.name)} ${esc(v.version)}</option>`,
    )
    .join(
      "",
    )}</select></label><p><a href="https://github.com/nyuichi/proofs-rs/issues/new">Request another tool/version</a></p><label>Environment (optional)<textarea name="environment" maxlength="10000">${esc(draft.environment)}</textarea></label><label>Evidence URL <input name="evidence_url" type="url" required value="${esc(draft.evidence_url)}"></label><label>Limitations (optional)<textarea name="limitations" maxlength="10000">${esc(draft.limitations)}</textarea></label>${notice}<button>Preview</button></form>`;
  const form = root.querySelector<HTMLFormElement>("#claim-form")!,
    property = form.querySelector<HTMLSelectElement>('[name="property"]')!;
  function pre() {
    root.querySelector("#pre-label")!.textContent =
      property.value === "no_ub"
        ? "(optional; mandatory for unsafe APIs)"
        : "(required)";
    form.querySelector<HTMLTextAreaElement>('[name="precondition"]')!.required =
      property.value !== "no_ub" || !!draftTarget.is_unsafe;
  }
  form.addEventListener("input", () => {
    draft = {
      ...draft,
      ...Object.fromEntries(new FormData(form)),
      property: editing ? draft.property : property.value,
    };
  });
  property.onchange = pre;
  pre();
  bind("#change-target", () => {
    draftTarget = null;
    navigate("/publish");
  });
  bind(
    "#claim-form",
    async () => {
      draft = {
        ...Object.fromEntries(new FormData(form)),
        property: editing ? draft.property : property.value,
        api_item_id: draftTarget.id,
      };
      await request("/claims/validate", "POST", draft);
      const tv = all.versions.find((v: any) => v.id === draft.tool_version_id);
      draft.tool_name = all.items.find((t: any) => t.id === tv?.tool_id)?.name;
      draft.tool_version = tv?.version;
      root.innerHTML =
        detail(draft) +
        notice +
        '<button id="back">Back to edit</button> <button id="publish">Publish</button>';
      bind("#back", claimForm);
      bind("#publish", async () => {
        const result = await request(
          editing ? `/claims/${editing}/revisions` : "/claims",
          "POST",
          { ...draft, ...(editing ? { expected_revision: expected } : {}) },
          formKey,
        );
        draft = {};
        draftTarget = null;
        editing = null;
        formKey = crypto.randomUUID();
        await refreshMe();
        navigate(
          "/claim/" +
            result.id +
            (result.revision_no ? "?v=" + result.revision_no : ""),
        );
      });
    },
    "submit",
  );
}
async function unsubscribe() {
  const p = current().searchParams;
  root.innerHTML =
    '<h1>Unsubscribe</h1><p>Turn off all comment email notifications?</p><button id="unsubscribe">Unsubscribe</button>';
  bind("#unsubscribe", async () => {
    await request("/notifications/unsubscribe", "POST", {
      user: p.get("user"),
      signature: p.get("signature"),
    });
    root.innerHTML =
      "<h1>Unsubscribed</h1><p>You can re-enable notifications in your account settings.</p>";
  });
}
async function route() {
  const generation = ++routeID;
  root.inert = true;
  root.setAttribute("aria-busy", "true");
  root.innerHTML = "<p>Loading…</p>";
  try {
    const parts = current()
        .pathname.split("/")
        .filter(Boolean)
        .map(decodeURIComponent),
      [p, id] = parts;
    if (!p) await home();
    else if (p === "crates" && id) {
      if (parts[3]) {
        const a = await request(
          "/resolve-api?" +
            new URLSearchParams({
              crate: id,
              version: parts[2],
              path: parts[3],
            }),
        );
        navigate("/api/" + a.id);
      } else
        navigate(
          "/crate/" + enc(id) + (parts[2] ? "?version=" + enc(parts[2]) : ""),
        );
    } else if (p === "crates") await crates();
    else if (p === "crate") await cratePage(id);
    else if (p === "api" && parts[2]) {
      const releases = await request("/crates/" + enc(id) + "/releases");
      const a = await request(
        "/resolve-api?" +
          new URLSearchParams({
            crate: id,
            version:
              current().searchParams.get("v") || releases.default_version || "",
            path: parts[2],
          }),
      );
      navigate("/api/" + a.id);
    } else if (p === "api") await apiPage(id);
    else if (p === "claim") await claimPage(Number(id));
    else if (p === "publish") await publish();
    else if (p === "login") login();
    else if (p === "terms-update") await termsUpdate();
    else if (p === "user") await activity(id);
    else if (p === "account") {
      if (me.user) await activity(me.user.id);
      else login();
    } else if (p.startsWith("my-")) await mine(p.slice(3));
    else if (p === "settings") await settings();
    else if (p === "tools" || p === "tool") await toolsPage(id);
    else if (p === "unsubscribe") await unsubscribe();
    else if (p in legal)
      root.innerHTML = "<h1>" + esc(legal[p].title) + "</h1>" + legal[p].body;
    else root.innerHTML = "<h1>Page not found</h1>";
  } catch (e) {
    if (e instanceof NavigationChanged) return;
    root.innerHTML = "<h1>Unable to load this page</h1>";
    error(e);
  } finally {
    if (generation === routeID) {
      root.inert = false;
      root.setAttribute("aria-busy", "false");
    }
  }
}
window.addEventListener("hashchange", () => void route());
(async () => {
  try {
    config = await request("/config");
    await refreshMe();
    await route();
  } catch (e) {
    error(e);
  }
})();
