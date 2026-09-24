import { Hono } from "hono";
import {
  App,
  Ctx,
  Fault,
  requireUser,
  one,
  stmt,
  batch,
  quota,
  jsonBody,
  text,
  now,
} from "./core";

export const runs = new Hono<App>();
const SARIF_LIMIT = 8 * 1024 * 1024;
const id = (s: string) => {
  if (
    typeof s !== "string" ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s)
  )
    throw new Fault(400, "invalid_run_id");
  return s;
};
const relative = (s: unknown) =>
  typeof s === "string" &&
  s.length > 0 &&
  s.length <= 1000 &&
  !s.startsWith("/") &&
  !s.includes("\\") &&
  !s.split("/").includes("..") &&
  !/[\x00-\x1f:]/.test(s);
const digest = async (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
async function visibleRun(c: Ctx) {
  const run = await one(
    c.env.DB,
    "SELECT * FROM verification_runs WHERE id=?",
    id(c.req.param("run") || ""),
  );
  if (!run) throw new Fault(404, "run_not_found");
  const published = await one(
    c.env.DB,
    "SELECT 1 FROM report_runs rr JOIN reports p ON p.id=rr.report_id WHERE rr.run_id=? AND p.visibility='public' LIMIT 1",
    run.id,
  );
  if (!published && run.author_id !== c.get("user")?.id)
    throw new Fault(404, "run_not_found");
  return run;
}
runs.post("/:run/sarif", async (c) => {
  const user = requireUser(c),
    run = id(c.req.param("run") || "");
  const bytes = await c.req.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > SARIF_LIMIT)
    throw new Fault(413, "artifact_too_large");
  const sha = await digest(bytes);
  const old = await one(
    c.env.DB,
    "SELECT * FROM run_sarif WHERE run_id=?",
    run,
  );
  if (old) {
    if (old.author_id !== user.id || old.sha256 !== sha)
      throw new Fault(409, "immutable_artifact");
    return c.json({ sha256: sha, size: old.size });
  }
  if (await one(c.env.DB, "SELECT 1 FROM verification_runs WHERE id=?", run))
    throw new Fault(409, "immutable_run");
  {
    let sarif;
    try {
      sarif = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Fault(400, "invalid_sarif");
    }
    validateSarif(sarif);
  }
  await batch(c.env.DB, [quota(c.env.DB, user.id, "run_artifact", 90)]);
  const key = `runs/${user.id}/${run}/sarif/${sha}`;
  await c.env.ARCHIVE.put(key, bytes, {
    httpMetadata: { contentType: "application/sarif+json" },
  });
  await stmt(
    c.env.DB,
    "INSERT OR IGNORE INTO run_sarif VALUES(?,?,?,?,?,?)",
    run,
    user.id,
    sha,
    bytes.byteLength,
    key,
    now(),
  ).run();
  const saved = await one(
    c.env.DB,
    "SELECT * FROM run_sarif WHERE run_id=?",
    run,
  );
  if (saved.author_id !== user.id || saved.sha256 !== sha)
    throw new Fault(409, "immutable_artifact");
  return c.json({ sha256: sha, size: bytes.byteLength }, 201);
});
export function validateSarif(s: any) {
  if (s?.version !== "2.1.0" || !Array.isArray(s.runs) || s.runs.length !== 1)
    throw new Fault(400, "invalid_sarif");
  const r = s.runs[0];
  if (
    typeof r?.tool?.driver?.name !== "string" ||
    !r.tool.driver.name ||
    !Array.isArray(r.invocations) ||
    r.invocations.length !== 1 ||
    typeof r.invocations[0]?.executionSuccessful !== "boolean" ||
    !Array.isArray(r.results) ||
    r.results.length > 50000
  )
    throw new Fault(400, "invalid_sarif");
  const artifacts = r.artifacts || [];
  if (!Array.isArray(artifacts)) throw new Fault(400, "invalid_sarif");
  const streams = new Set<number>();
  for (const name of ["stdout", "stderr", "stdoutStderr"]) {
    const loc = r.invocations[0][name];
    if (loc === undefined) continue;
    if (
      !Number.isInteger(loc?.index) ||
      loc.index < 0 ||
      typeof artifacts[loc.index]?.contents?.text !== "string"
    )
      throw new Fault(400, "embedded_log_required");
    streams.add(loc.index);
  }
  if (!streams.size) throw new Fault(400, "embedded_log_required");
  for (const [i, artifact] of artifacts.entries()) {
    if (
      !artifact ||
      typeof artifact !== "object" ||
      (artifact.contents !== undefined &&
        (!artifact.contents ||
          typeof artifact.contents !== "object" ||
          !streams.has(i) ||
          Object.keys(artifact.contents).some((k) => k !== "text")))
    )
      throw new Fault(400, "embedded_source_not_allowed");
  }
  for (const result of r.results)
    if (
      typeof result?.message?.text !== "string" ||
      ![
        "pass",
        "fail",
        "open",
        "notApplicable",
        "informational",
        "review",
      ].includes(result.kind)
    )
      throw new Fault(400, "invalid_sarif_result");
}
runs.post("/:run", async (c) => {
  const u = requireUser(c),
    run = id(c.req.param("run") || ""),
    b = await jsonBody(c);
  const tv = await one(
    c.env.DB,
    "SELECT v.*,t.name tool FROM tool_versions v JOIN tools t ON t.id=v.tool_id WHERE v.id=? AND v.selectable=1 AND t.active=1",
    text(b.tool_version_id, "Tool", 200, true),
  );
  if (!tv) throw new Fault(400, "tool_version_unavailable");
  if (
    !relative(b.working_directory) ||
    !Array.isArray(b.command) ||
    b.command.length < 1 ||
    b.command.length > 200 ||
    typeof b.command[0] !== "string" ||
    !b.command[0].trim() ||
    b.command.some(
      (x: any) => typeof x !== "string" || x.length > 4000 || x.includes("\0"),
    )
  )
    throw new Fault(400, "invalid_command");
  if (
    !Number.isFinite(Date.parse(b.started_at)) ||
    !Number.isFinite(Date.parse(b.finished_at)) ||
    Date.parse(b.finished_at) < Date.parse(b.started_at) ||
    !Number.isFinite(b.duration_ms) ||
    b.duration_ms < 0 ||
    (b.exit_code !== null && !Number.isInteger(b.exit_code)) ||
    typeof b.execution_successful !== "boolean"
  )
    throw new Fault(400, "invalid_run_times");
  if (
    !Array.isArray(b.contracts) ||
    !b.contracts.length ||
    b.contracts.length > 100
  )
    throw new Fault(400, "invalid_run_contracts");
  for (const contract of b.contracts) {
    if (
      !contract ||
      !relative(contract.file) ||
      !Number.isInteger(contract.first_line) ||
      contract.first_line < 1 ||
      !Number.isInteger(contract.last_line) ||
      contract.last_line < contract.first_line ||
      typeof contract.harness !== "string" ||
      !Array.isArray(contract.api_paths) ||
      !contract.api_paths.length ||
      contract.api_paths.some((p: any) => typeof p !== "string") ||
      typeof contract.precondition !== "string" ||
      !Array.isArray(contract.properties) ||
      !contract.properties.length ||
      contract.properties.some(
        (p: any) => !["no_ub", "panic_contract"].includes(p),
      )
    )
      throw new Fault(400, "invalid_run_contract");
  }
  const source = validateSource(b.source);
  const artifact = await one(
    c.env.DB,
    "SELECT * FROM run_sarif WHERE run_id=? AND author_id=?",
    run,
    u.id,
  );
  if (!artifact || b.sarif_sha256 !== artifact.sha256)
    throw new Fault(400, "incomplete_run_sarif");
  const object = await c.env.ARCHIVE.get(artifact.r2_key);
  if (!object) throw new Fault(409, "artifact_unavailable");
  const sarif = await object.json<any>();
  validateSarif(sarif);
  const s = sarif.runs[0],
    inv = s.invocations[0];
  if (
    s.tool.driver.name.toLowerCase() !== tv.tool.toLowerCase() ||
    s.tool.driver.version !== tv.version ||
    inv.executionSuccessful !== b.execution_successful ||
    inv.exitCode !== b.exit_code ||
    JSON.stringify(inv.arguments) !== JSON.stringify(b.command.slice(1))
  )
    throw new Fault(400, "run_sarif_mismatch");
  for (const contract of b.contracts) {
    const matches = s.results.filter(
      (r: any) => r.properties?.harness === contract.harness,
    );
    if (
      !matches.length ||
      matches.some(
        (r: any) =>
          !["pass", "notApplicable", "informational"].includes(r.kind),
      )
    )
      throw new Fault(400, "unverified_contract");
  }
  if (!b.execution_successful || b.exit_code !== 0)
    throw new Fault(400, "unsuccessful_run");
  const normalized = {
    id: run,
    tool_version_id: tv.id,
    source,
    sarif_sha256: artifact.sha256,
    command: b.command,
    working_directory: b.working_directory,
    started_at: b.started_at,
    finished_at: b.finished_at,
    duration_ms: b.duration_ms,
    exit_code: b.exit_code,
    execution_successful: b.execution_successful,
    contracts: b.contracts,
    platform: text(b.platform, "Platform", 1000),
    rustc: text(b.rustc, "Rust compiler", 4000),
    environment: b.environment || {},
    crate: text(b.crate, "Crate", 100, true),
    version: text(b.version, "Version", 100, true),
  };
  const encoded = JSON.stringify(normalized);
  const existing = await one(
    c.env.DB,
    "SELECT * FROM verification_runs WHERE id=?",
    run,
  );
  if (existing) {
    if (existing.author_id !== u.id || existing.metadata_json !== encoded)
      throw new Fault(409, "immutable_run");
    return c.json({ id: run });
  }
  await stmt(
    c.env.DB,
    "INSERT OR IGNORE INTO verification_runs VALUES(?,?,?,?,?,?,?)",
    run,
    u.id,
    normalized.crate,
    normalized.version,
    tv.id,
    encoded,
    now(),
  ).run();
  const saved = await one(
    c.env.DB,
    "SELECT * FROM verification_runs WHERE id=?",
    run,
  );
  if (saved.author_id !== u.id || saved.metadata_json !== encoded)
    throw new Fault(409, "immutable_run");
  return c.json({ id: run }, 201);
});
runs.get("/:run", async (c) => {
  const r = await visibleRun(c);
  return c.json(JSON.parse(r.metadata_json));
});
runs.get("/:run/sarif", async (c) => {
  const run = await visibleRun(c);
  const a = await one(
    c.env.DB,
    "SELECT * FROM run_sarif WHERE run_id=?",
    run.id,
  );
  const object = a && (await c.env.ARCHIVE.get(a.r2_key));
  if (!object) throw new Fault(404, "artifact_not_found");
  c.header("Content-Type", "application/sarif+json");
  c.header(
    "Content-Disposition",
    `attachment; filename="${run.id}.sarif.json"`,
  );
  c.header("Content-Security-Policy", "default-src 'none'; sandbox");
  return c.body(object.body);
});
export function validateSource(source: any) {
  // Immutable external Git source; no source content is accepted or retained.
  if (
    !source ||
    typeof source.repository !== "string" ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
      source.repository,
    ) ||
    typeof source.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(source.commit)
  )
    throw new Fault(400, "invalid_source_reference");
  return { repository: source.repository, commit: source.commit };
}
export async function validateReportRuns(c: Ctx, b: any, v: any) {
  if (
    !Array.isArray(b.run_ids) ||
    !b.run_ids.length ||
    b.run_ids.length > 10 ||
    new Set(b.run_ids).size !== b.run_ids.length
  )
    throw new Fault(
      400,
      "recorded_run_required",
      "Run cargo proofs run before publishing.",
    );
  const contracts: any[] = [];
  let source: string | undefined;
  for (const rid of b.run_ids) {
    const r = await one(
      c.env.DB,
      "SELECT * FROM verification_runs WHERE id=?",
      id(rid),
    );
    if (
      !r ||
      r.author_id !== requireUser(c).id ||
      r.crate !== v.crate ||
      r.version !== v.version ||
      r.tool_version_id !== v.tool_version_id
    )
      throw new Fault(400, "run_report_mismatch");
    const m = JSON.parse(r.metadata_json);
    if (source && source !== JSON.stringify(m.source))
      throw new Fault(400, "inconsistent_run_sources");
    source = JSON.stringify(m.source);
    contracts.push(...m.contracts);
  }
  for (const claim of v.claims)
    if (
      !contracts.some(
        (x) =>
          x.api_paths.includes(claim.display_path) &&
          x.properties.includes(claim.property) &&
          x.precondition === claim.precondition,
      )
    )
      throw new Fault(400, "claim_not_in_recorded_run");
  v.run_ids = b.run_ids;
}
