(async () => {
  const root = document.querySelector("#endpoints");
  const esc = (x) =>
    String(x ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  try {
    const r = await fetch("/openapi.json");
    if (!r.ok) throw Error("Unable to load specification.");
    const spec = await r.json();
    const resolve = (s) =>
      s?.$ref
        ? spec.components[s.$ref.split("/")[2]][s.$ref.split("/").pop()]
        : s;
    const shape = (s) => {
      s = resolve(s);
      if (s?.allOf) {
        const parts = s.allOf.map(shape);
        return {
          properties: Object.assign({}, ...parts.map((x) => x.properties)),
          required: parts.flatMap((x) => x.required || []),
        };
      }
      return s;
    };
    const fields = (s) => {
      const o = shape(s);
      if (!o?.properties)
        return `<pre>${esc(JSON.stringify(s, null, 2))}</pre>`;
      return `<div class="table-wrap"><table><thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr></thead><tbody>${Object.entries(
        o.properties,
      )
        .map(
          ([k, v]) =>
            `<tr><td><code>${esc(k)}</code></td><td>${esc(v.type || (v.enum ? "enum" : v.$ref?.split("/").pop() || "object"))}</td><td>${o.required?.includes(k) ? "Yes" : "No"}</td><td>${esc(v.description || "")}${v.enum ? " " + esc(v.enum.join(", ")) : ""}${v.const ? " " + esc(v.const) : ""}${v.maxLength ? " Max " + v.maxLength + " characters." : ""}</td></tr>`,
        )
        .join("")}</tbody></table></div>`;
    };
    const schema = (s) =>
      fields(s) +
      `<details><summary>JSON schema</summary><pre>${esc(JSON.stringify(s, null, 2))}</pre></details>`;
    const render = () => {
      const q = document.querySelector("#filter").value.toLowerCase();
      root.innerHTML =
        Object.entries(spec.paths)
          .flatMap(([path, methods]) =>
            Object.entries(methods).map(([method, op]) => ({
              path,
              method,
              op,
            })),
          )
          .filter(({ path, op }) =>
            (path + " " + op.summary + " " + op.tags.join(" "))
              .toLowerCase()
              .includes(q),
          )
          .map(
            ({ path, method, op }) =>
              `<section class="api-docs"><h2 id="${esc(op.operationId)}"><code>${esc(method.toUpperCase())} ${esc(path)}</code></h2><p>${esc(op.summary)}</p><p>${esc(op.description)}</p><p class="meta">Authentication: ${op.security.length ? op.security.map((x) => Object.keys(x).join(" + ") || "public").join(" or ") : "public"}</p>${op.parameters.length ? `<details><summary>Parameters</summary>${fields({ properties: Object.fromEntries(op.parameters.map((p) => [p.name, { ...p.schema, description: p.in + ": " + (p.description || p.schema.description || "") }])), required: op.parameters.filter((p) => p.required).map((p) => p.name) })}</details>` : ""}${op.requestBody ? `<details><summary>Request body</summary><p>${esc(Object.keys(op.requestBody.content).join(" or "))}</p>${schema(Object.values(op.requestBody.content)[0].schema)}</details>` : ""}<details><summary>Responses</summary>${Object.entries(
                op.responses,
              )
                .map(([status, raw]) => {
                  const r = resolve(raw);
                  return `<details><summary>${esc(status)} — ${esc(r.description)}</summary>${r.content ? schema(r.content["application/json"].schema) : ""}</details>`;
                })
                .join("")}</details></section>`,
          )
          .join("") || "<p>No matching endpoints.</p>";
    };
    document.querySelector("#filter").addEventListener("input", render);
    render();
  } catch (e) {
    root.textContent = e.message;
  }
})();
