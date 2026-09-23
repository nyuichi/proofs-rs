const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const quote = (s: string) =>
  /^[a-zA-Z0-9_./:=+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
export function reproduceSection(runIds: string[]) {
  return runIds?.length
    ? '<details class="reproduce" id="reproduce"><summary>Reproduce</summary><div class="reproduce-body"></div></details>'
    : "";
}
export function bindReproduce(root: HTMLElement, report: any) {
  const section = root.querySelector<HTMLDetailsElement>("#reproduce");
  if (!section) return;
  const body = section.querySelector<HTMLElement>(".reproduce-body")!;
  let loaded = false;
  section.addEventListener("toggle", async () => {
    if (!section.open || loaded) return;
    loaded = true;
    body.textContent = "Loading recorded runs…";
    try {
      const rendered = await Promise.all(
        report.run_ids.map(async (id: string, index: number) => {
          const base = "/api/v1/runs/" + encodeURIComponent(id);
          const [run, sarif] = await Promise.all([
            getJSON(base),
            getJSON(base + "/sarif"),
          ]);
          const results = sarif.runs.flatMap((r: any) => r.results || []);
          const passed = results.filter((r: any) => r.kind === "pass").length;
          const failed = results.filter((r: any) => r.kind === "fail").length;
          const other = results.length - passed - failed;
          const dir = "report-" + report.id + "-source-" + (index + 1);
          const cwd =
            run.working_directory === "."
              ? dir
              : dir + "/" + run.working_directory;
          const environment = Object.entries(run.environment || {}).map(
            ([k, v]) => quote(k + "=" + v),
          );
          const command = (environment.length ? ["env", ...environment] : [])
            .concat(run.command.map(quote))
            .join(" ");
          const script = [
            `curl -fL ${quote(location.origin + base + "/source")} -o source.tar.gz`,
            `mkdir ${quote(dir)}`,
            `tar -xzf source.tar.gz -C ${quote(dir)}`,
            `cd ${quote(cwd)}`,
            "",
            command,
          ].join("\n");
          const rows = results
            .map((r: any) => {
              const harness = r.properties?.harness || "";
              const contract = run.contracts.find(
                (x: any) => x.harness === harness,
              );
              const claims = contract
                ? report.claims.filter(
                    (c: any) =>
                      contract.api_paths.includes(c.display_path) &&
                      contract.properties.includes(c.property),
                  )
                : [];
              const place =
                r.locations?.[0]?.physicalLocation ||
                r.relatedLocations?.[0]?.physicalLocation;
              const loc = place
                ? `${place.artifactLocation?.uri || ""}${place.region?.startLine ? ":" + place.region.startLine : ""}`
                : r.properties?.location || "";
              const status =
                r.properties?.status ||
                (
                  {
                    pass: "Passed",
                    fail: "Failed",
                    open: "Undetermined",
                    notApplicable: "Unreachable",
                    informational: "Information",
                  } as any
                )[r.kind] ||
                r.kind;
              return `<tr><td>${esc(r.message?.text || r.ruleId)}<div class="meta"><code>${esc(harness)}</code></div>${loc ? `<div class="meta"><code>${esc(loc)}</code></div>` : ""}</td><td>${esc(status)}</td><td>${claims.map((c: any) => `<a href="#/claim/${encodeURIComponent(c.id)}?report_revision=${report.revision_no}">${esc(c.property.replaceAll("_", "-"))}</a>`).join(" · ") || "—"}</td></tr>`;
            })
            .join("");
          const item = (label: string, value: any) =>
            `<dt>${esc(label)}</dt><dd class="plain-text">${esc(value)}</dd>`;
          return `<article class="recorded-run">${report.run_ids.length > 1 ? `<h3>Run ${index + 1}</h3>` : ""}<h3>Run locally</h3><pre><code>${esc(script)}</code></pre><p class="meta">Uses the source snapshot captured for this run. Install the report’s tool version before running.</p><p class="run-downloads"><a href="${base}/source">Source (.tar.gz)</a> · <a href="${base}/sarif">SARIF (.json)</a> · <a href="${base}/logs">Logs (.txt)</a></p><h3>Recorded run</h3><p>${run.execution_successful ? "Completed" : "Unsuccessful"} · ${passed} checks passed · ${failed} failed${other ? ` · ${other} other` : ""}</p><p class="meta">${esc(run.started_at)} · ${(run.duration_ms / 1000).toFixed(1)} seconds · Exit code ${esc(run.exit_code ?? "unavailable")}</p><p class="meta">Recorded on the author’s machine.</p><table><thead><tr><th>Check</th><th>Result</th><th>Claim</th></tr></thead><tbody>${rows}</tbody></table><details><summary>Execution details</summary><dl>${item("Started", run.started_at)}${item("Finished", run.finished_at)}${item("Platform", run.platform)}${item("Rust compiler", run.rustc)}${item("Working directory", run.working_directory)}${item(
            "Environment overrides",
            Object.entries(run.environment || {})
              .map(([k, v]) => k + "=" + v)
              .join("\n") || "None recorded",
          )}${item("Source SHA-256", run.artifacts.source)}${run.git_commit ? item("Git commit", run.git_commit) : ""}${item("Git context", run.git_dirty ? "Uncommitted changes included in the snapshot." : run.git_commit ? "Clean working tree." : "No Git repository.")}</dl></details><details class="run-logs" data-run="${esc(id)}"><summary>Diagnostics &amp; logs</summary><pre class="run-log-content">Open to load recorded output.</pre></details></article>`;
        }),
      );
      body.innerHTML = rendered.join("");
      body
        .querySelectorAll<HTMLDetailsElement>(".run-logs")
        .forEach((details) => {
          let ready = false;
          details.addEventListener("toggle", async () => {
            if (!details.open || ready) return;
            ready = true;
            const pre = details.querySelector("pre")!;
            pre.textContent = "Loading…";
            try {
              const response = await fetch(
                "/api/v1/runs/" +
                  encodeURIComponent(details.dataset.run!) +
                  "/logs",
              );
              if (!response.ok) throw Error("Unable to load logs");
              pre.textContent = await response.text();
            } catch (e) {
              pre.textContent = String(e);
              ready = false;
            }
          });
        });
    } catch (e) {
      body.textContent = String(e);
      loaded = false;
    }
  });
}
async function getJSON(path: string) {
  const r = await fetch(path);
  if (!r.ok)
    throw Error("Unable to load recorded run. Close and reopen to retry.");
  return r.json();
}
