use crate::{config::Project, scan, snapshot, state, ProjectArgs};
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Instant,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contract {
    pub api_paths: Vec<String>,
    pub precondition: String,
    pub file: String,
    pub first_line: usize,
    pub last_line: usize,
    pub harness: String,
    pub properties: Vec<String>,
}
#[derive(Serialize, Deserialize)]
pub struct Record {
    pub metadata: Value,
    pub contracts: Vec<Contract>,
    pub files: BTreeMap<String, String>,
    pub config_tool: Value,
}
pub fn state_dir(project: &Project) -> Result<PathBuf> {
    let base = dirs::data_local_dir()
        .context("Cannot locate local data directory")?
        .join("cargo-proofs");
    Ok(base.join(state::digest(&project.manifest.to_string_lossy())))
}
pub fn load(project: &Project, selected: Option<&str>) -> Result<(PathBuf, Record)> {
    let base = state_dir(project)?;
    let run = match selected {
        Some(s) => s.to_owned(),
        None => state::read::<String>(&base.join("latest.json"))?
            .context("No recorded run. Run cargo proofs run -- cargo kani ... first")?,
    };
    ensure!(uuid::Uuid::parse_str(&run).is_ok(), "Invalid run ID");
    let dir = base.join("runs").join(run);
    let record: Record =
        state::read(&dir.join("record.json"))?.context("Recorded run not found")?;
    ensure!(
        record.metadata["execution_successful"] == true && !record.contracts.is_empty(),
        "This run did not produce publishable verification results"
    );
    ensure!(record.metadata["source"]["commit"].is_string(),
        "Recorded run is missing its source commit");
    ensure!(
        snapshot::sha(&fs::read(dir.join("run.sarif.json"))?)
            == record.metadata["sarif_sha256"].as_str().unwrap_or(""),
        "Recorded SARIF changed; run verification again"
    );
    let tool = serde_json::to_value(project.config()?.tool)?;
    ensure!(
        tool == record.config_tool,
        "Tool configuration changed; run verification again"
    );
    ensure!(
        record.metadata["crate"] == project.name && record.metadata["version"] == project.version,
        "Recorded run targets a different crate/version"
    );
    Ok((dir, record))
}
fn output(cmd: &mut Command) -> Result<String> {
    let out = cmd.output()?;
    ensure!(
        out.status.success(),
        "Command failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(String::from_utf8(out.stdout)?.trim().into())
}
fn metadata(manifest: &Path) -> Result<Value> {
    Ok(serde_json::from_str(&output(
        Command::new("cargo")
            .args([
                "metadata",
                "--format-version",
                "1",
                "--no-deps",
                "--manifest-path",
            ])
            .arg(manifest),
    )?)?)
}
pub fn run(args: &ProjectArgs, command: Vec<String>) -> Result<()> {
    ensure!(
        args.features.is_empty()
            && !args.all_features
            && !args.no_default_features
            && args.target.is_none(),
        "Pass compilation flags after -- as part of the verifier command"
    );
    let project = Project::load(args)?;
    let config = project.config()?;
    ensure!(
        command.len() >= 2
            && command[0] == "cargo"
            && command[1].eq_ignore_ascii_case(&config.tool.name),
        "Use cargo proofs run -- cargo {} ...",
        config.tool.name
    );
    validate_command(&command, config.tool.is_creusot())?;
    let m = metadata(&project.manifest)?;
    let workspace = PathBuf::from(
        m["workspace_root"]
            .as_str()
            .context("Missing workspace root")?,
    )
    .canonicalize()?;
    // A Git root can also hold sibling path dependencies outside the Cargo workspace.
    let root = crate::git::run(&workspace, &["rev-parse", "--show-toplevel"])
        .ok()
        .map(PathBuf::from)
        .unwrap_or(workspace.clone())
        .canonicalize()?;
    let cwd = std::env::current_dir()?.canonicalize()?;
    let relative_cwd = cwd
        .strip_prefix(&root)
        .context("Run from within the source root")?;
    let relative_manifest = project.manifest.strip_prefix(&root)?.to_owned();
    let version = output(Command::new("cargo").args([config.tool.name.as_str(), "--version"]))?;
    ensure!(
        version.split_whitespace().any(|s| s == config.tool.version),
        "Installed tool differs from proofs.toml: {version}"
    );
    // Resolve before freezing the source, preserving existing locked versions while
    // updating stale workspace/package entries exactly as Cargo normally does.
    output(
        Command::new("cargo")
            .args(["metadata", "--format-version", "1", "--manifest-path"])
            .arg(&project.manifest),
    )?;
    let source_ref = crate::git::published_source(
        &root,
        config
            .git
            .as_ref()
            .and_then(|g| g.remote.as_deref())
            .unwrap_or("origin"),
    )?;
    // Every verification input must be available at the external commit, including lockfiles.
    for name in snapshot::files(&root)?.keys() {
        crate::git::run(&root, &["ls-files", "--error-unmatch", "--", name]).with_context(
            || format!("Commit and push {name} before recording (including Cargo.lock)"),
        )?;
    }
    let rid = uuid::Uuid::new_v4().to_string();
    let base = state_dir(&project)?;
    let dir = base.join("runs").join(&rid);
    fs::create_dir_all(&dir)?;
    let stage = tempfile::tempdir()?;
    let source = stage.path().join("source");
    fs::create_dir(&source)?;
    // macOS temporary paths can be aliases (/var -> /private/var).
    let source = source.canonicalize()?;
    let hashes = snapshot::capture(&root, &source)?;
    // Check the actual copied bytes against the fixed commit, closing checkout races.
    let commit = source_ref["commit"]
        .as_str()
        .context("Missing source commit")?;
    for name in hashes.keys() {
        let expected = crate::git::run(&root, &["rev-parse", &format!("{commit}:{name}")])?;
        let actual = crate::git::run(
            &root,
            &[
                "hash-object",
                "--no-filters",
                "--",
                source.join(name).to_str().context("Non-UTF8 path")?,
            ],
        )?;
        ensure!(
            expected == actual,
            "Input {name} differs from the published commit; commit and push before recording"
        );
    }

    ensure!(
        source.join(&relative_manifest).exists()
            && source
                .join(workspace.strip_prefix(&root)?)
                .join("Cargo.lock")
                .exists(),
        "Snapshot is missing Cargo.toml or Cargo.lock"
    );
    // Resolve the copied project, never the user's mutable checkout.
    let resolved: Value = serde_json::from_str(&output(
        Command::new("cargo")
            .args([
                "metadata",
                "--locked",
                "--format-version",
                "1",
                "--manifest-path",
            ])
            .arg(source.join(&relative_manifest))
            .current_dir(&source),
    )?)?;
    for package in resolved["packages"]
        .as_array()
        .context("Missing packages")?
    {
        if package["source"].is_null() {
            ensure!(
                Path::new(package["manifest_path"].as_str().unwrap_or("")).starts_with(&source),
                "Local dependencies must be contained in the source root"
            );
        }
    }
    let mut selected = args.clone();
    selected.manifest_path = Some(source.join(&relative_manifest));
    apply_cargo_flags(&mut selected, &command)?;
    let mut captured = Project::load(&selected)?;
    captured.cfg.insert(config.tool.name.clone());
    ensure!(
        captured.name == project.name,
        "Command selects a different package"
    );
    let discovered = scan::discover_for_tool(&captured, &config.tool)?;
    ensure!(!discovered.is_empty(), "No publishable contracts found");
    let contracts: Vec<Contract> = discovered
        .iter()
        .map(|c| {
            Ok(Contract {
                api_paths: c
                    .api_paths
                    .iter()
                    .map(|p| format!("{}::{p}", captured.lib_name))
                    .collect(),
                precondition: c.precondition.clone(),
                file: c
                    .file
                    .strip_prefix(&source)?
                    .to_string_lossy()
                    .replace('\\', "/"),
                first_line: c.first_line,
                last_line: c.last_line,
                harness: format!("{}::{}", captured.lib_name, c.harness),
                properties: config
                    .tool
                    .properties()
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
            })
        })
        .collect::<Result<_>>()?;
    // Existing proof sessions may be useful inputs; only newly written proof files count as results.
    let before = proof_files(&source)?;
    let started = chrono::Utc::now();
    let clock = Instant::now();
    println!(
        "Recording run {rid}; source snapshot contains {} files",
        hashes.len()
    );
    let env: BTreeMap<String, String> = ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTDOCFLAGS"]
        .iter()
        .filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v)))
        .collect();
    let mut child = Command::new(&command[0])
        .args(&command[1..])
        .current_dir(source.join(relative_cwd))
        .env("CARGO_TARGET_DIR", stage.path().join("target"))
        .env("CARGO_TERM_COLOR", "never")
        .env("NO_COLOR", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("Start verification tool")?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = std::thread::spawn(move || tee(stdout, false));
    let err = std::thread::spawn(move || tee(stderr, true));
    let status = child.wait()?;
    let stdout = out
        .join()
        .map_err(|_| anyhow::anyhow!("stdout capture failed"))??;
    let stderr = err
        .join()
        .map_err(|_| anyhow::anyhow!("stderr capture failed"))??;
    let duration = clock.elapsed().as_millis() as u64;
    let finished = chrono::Utc::now();
    let stdout =
        String::from_utf8_lossy(&stdout).replace(&source.to_string_lossy().to_string(), ".");
    let stderr =
        String::from_utf8_lossy(&stderr).replace(&source.to_string_lossy().to_string(), ".");
    let parsed = if config.tool.is_creusot() {
        creusot_results(&source, &before, &contracts)
    } else {
        kani_results(&stdout, &contracts)
    };
    let (results, verified, diagnostic) = match parsed {
        Ok((r, c)) => (r, c, None),
        Err(e) => (vec![], vec![], Some(format!("{e:#}"))),
    };
    let unchanged = snapshot::unchanged(&source, &hashes);
    let successful =
        status.success() && diagnostic.is_none() && unchanged.is_ok() && !verified.is_empty();
    let mut invocation = json!({"arguments":&command[1..],"commandLine":shell_command(&command),"workingDirectory":{"uri":format!("{}/",path_string(relative_cwd))},"startTimeUtc":started.to_rfc3339(),"endTimeUtc":finished.to_rfc3339(),"executionSuccessful":status.success(),"environmentVariables":env});
    if let Some(code) = status.code() {
        invocation["exitCode"] = json!(code);
    }
    if let Some(d) = &diagnostic {
        invocation["toolExecutionNotifications"] = json!([{"level":"error","message":{"text":d}}]);
    }
    let mut artifacts: Vec<Value> = hashes
        .iter()
        .map(|(name, hash)| json!({"location":{"uri":name},"hashes":{"sha-256":hash}}))
        .collect();
    invocation["stdout"] = json!({"index":artifacts.len()});
    artifacts.push(json!({"contents":{"text":stdout}}));
    invocation["stderr"] = json!({"index":artifacts.len()});
    artifacts.push(json!({"contents":{"text":stderr}}));
    let sarif = json!({"version":"2.1.0","$schema":"https://json.schemastore.org/sarif-2.1.0.json","runs":[{"tool":{"driver":{"name":config.tool.name,"version":config.tool.version}},"invocations":[invocation],"results":results,"artifacts":artifacts,"versionControlProvenance":[{"repositoryUri":source_ref["repository"],"revisionId":source_ref["commit"]}],"properties":{"recorderVersion":env!("CARGO_PKG_VERSION")}}]});
    let bytes = serde_json::to_vec_pretty(&sarif)?;
    fs::write(dir.join("run.sarif.json"), &bytes)?;
    ensure!(
        bytes.len() <= 8 * 1024 * 1024,
        "SARIF including logs exceeds 8 MiB"
    );
    let metadata = json!({"id":rid,"crate":project.name,"version":project.version,"command":command,"working_directory":path_string(relative_cwd),"started_at":started.to_rfc3339(),"finished_at":finished.to_rfc3339(),"duration_ms":duration,"exit_code":status.code(),"execution_successful":successful,"platform":format!("{} {}",std::env::consts::OS,std::env::consts::ARCH),"rustc":output(Command::new("rustc").arg("-vV").current_dir(source.join(relative_cwd))).unwrap_or_default(),"environment":env,"sarif_sha256":snapshot::sha(&bytes),"source":source_ref,"contracts":verified,"diagnostic":diagnostic});
    let record = Record {
        metadata,
        contracts: verified,
        files: hashes,
        config_tool: serde_json::to_value(&config.tool)?,
    };
    state::write(&dir.join("record.json"), &record)?;
    state::write(&base.join("latest.json"), &rid)?;
    println!("Saved run {rid}: {}", dir.display());
    unchanged?;
    ensure!(
        successful,
        "Verification did not produce publishable results. SARIF including logs saved locally. {}",
        diagnostic.unwrap_or_default()
    );
    Ok(())
}
fn path_string(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    if s.is_empty() {
        ".".into()
    } else {
        s
    }
}
fn tee(mut input: impl Read, stderr: bool) -> Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut buf = [0; 8192];
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        if result.len() + n <= 8 * 1024 * 1024 {
            result.extend_from_slice(&buf[..n]);
        } else {
            bail!("Verification log exceeds 8 MiB");
        }
        if stderr {
            std::io::stderr().write_all(&buf[..n])?;
        } else {
            std::io::stdout().write_all(&buf[..n])?;
        }
    }
    Ok(result)
}
pub fn shell_command(args: &[String]) -> String {
    args.iter()
        .map(|s| format!("'{}'", s.replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join(" ")
}
fn validate_command(cmd: &[String], creusot: bool) -> Result<()> {
    for arg in &cmd[2..] {
        ensure!(
            !arg.contains('\0') && !arg.starts_with('/') && !arg.contains("../"),
            "Command paths must stay within the snapshot"
        );
        let flag = arg.split('=').next().unwrap_or("");
        ensure!(
            !matches!(
                flag,
                "--target-dir"
                    | "--out-dir"
                    | "--output"
                    | "--output-format"
                    | "--quiet"
                    | "-q"
                    | "--dry-run"
                    | "--dry-run-why3find"
                    | "--only"
                    | "--no-assertion-checks"
                    | "--no-memory-safety-checks"
                    | "--no-unwinding-checks"
                    | "--cbmc-args"
                    | "--concrete-playback"
                    | "--visualize"
            ),
            "Unsupported recording option: {flag}"
        );
    }
    if !creusot {
        ensure!(
            !cmd[2..]
                .iter()
                .any(|s| s == "--jobs" || s.starts_with("--jobs=") || s.starts_with("-j")),
            "Parallel Kani output cannot be attributed reliably; omit --jobs/-j when recording"
        );
    }
    if creusot {
        ensure!(
            !cmd.iter().any(|x| matches!(
                x.as_str(),
                "--replay" | "--ide-always" | "-i" | "--ide-on-fail"
            )),
            "Record a noninteractive proof run"
        );
    }
    Ok(())
}
fn apply_cargo_flags(args: &mut ProjectArgs, cmd: &[String]) -> Result<()> {
    let mut i = 2;
    while i < cmd.len() {
        let a = &cmd[i];
        let (flag, inline) = a
            .split_once('=')
            .map_or((a.as_str(), None), |(k, v)| (k, Some(v)));
        if matches!(flag, "--features" | "--target" | "--package" | "-p") {
            let v = if let Some(v) = inline {
                v.to_owned()
            } else {
                i += 1;
                cmd.get(i).context("Missing Cargo option value")?.clone()
            };
            match flag {
                "--features" => {
                    args.features = v
                        .split([',', ' '])
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .collect()
                }
                "--target" => args.target = Some(v),
                _ => args.package = Some(v),
            }
        }
        if flag == "--all-features" {
            args.all_features = true;
        }
        if flag == "--no-default-features" {
            args.no_default_features = true;
        }
        i += 1;
    }
    Ok(())
}
pub fn kani_results(output: &str, contracts: &[Contract]) -> Result<(Vec<Value>, Vec<Contract>)> {
    let mut results = vec![];
    let mut verified = vec![];
    let mut harness = String::new();
    let mut current: Option<Value> = None;
    let mut start = 0;
    for line in output.lines().map(str::trim) {
        ensure!(
            !line.starts_with("Thread "),
            "Parallel Kani output is unsupported"
        );
        if let Some(h) = line
            .strip_prefix("Checking harness ")
            .and_then(|s| s.strip_suffix("..."))
        {
            ensure!(current.is_none(), "Incomplete Kani check");
            harness = h.into();
            start = results.len();
        } else if line.starts_with("Check ") {
            if let Some(r) = current.take() {
                ensure!(r.get("kind").is_some(), "Missing Kani status");
                results.push(r);
            }
            let name = line.split_once(": ").context("Invalid Kani check")?.1;
            current = Some(
                json!({"ruleId":name,"message":{"text":name},"properties":{"harness":harness,"check":name}}),
            );
        } else if let Some(status) = line.strip_prefix("- Status: ") {
            let r = current.as_mut().context("Kani status without a check")?;
            let kind = match status {
                "SUCCESS" => "pass",
                "FAILURE" => "fail",
                "UNREACHABLE" => "notApplicable",
                "UNDETERMINED" => "open",
                "SATISFIED" | "UNSATISFIABLE" => "informational",
                _ => bail!("Unknown Kani status {status}"),
            };
            r["kind"] = json!(kind);
            r["level"] = json!(if kind == "fail" { "error" } else { "none" });
            r["properties"]["status"] = json!(status);
        } else if let Some(desc) = line.strip_prefix("- Description: ") {
            if let Some(r) = current.as_mut() {
                r["message"] = json!({"text":desc.trim_matches('"')});
            }
        } else if let Some(loc) = line.strip_prefix("- Location: ") {
            if let Some(r) = current.as_mut() {
                r["properties"]["location"] = json!(loc);
            }
        } else if let Some(outcome) = line.strip_prefix("VERIFICATION:- ") {
            if let Some(r) = current.take() {
                ensure!(r.get("kind").is_some(), "Missing Kani status");
                results.push(r);
            }
            let matches: Vec<_> = contracts
                .iter()
                .filter(|c| {
                    c.harness == harness
                        || harness.strip_prefix(&format!(
                            "{}::",
                            c.api_paths
                                .first()
                                .and_then(|s| s.split("::").next())
                                .unwrap_or("")
                        )) == Some(c.harness.as_str())
                })
                .collect();
            if outcome == "SUCCESSFUL"
                && results.len() > start
                && results[start..].iter().all(|r| {
                    matches!(
                        r["kind"].as_str(),
                        Some("pass" | "notApplicable" | "informational")
                    )
                })
                && matches.len() == 1
            {
                let c = matches[0].clone();
                for r in &mut results[start..] {
                    r["properties"]["harness"] = json!(c.harness);
                    r["relatedLocations"] = json!([{"id":0,"physicalLocation":{"artifactLocation":{"uri":c.file},"region":{"startLine":c.first_line,"endLine":c.last_line}}}]);
                }
                verified.push(c);
            }
        }
    }
    ensure!(current.is_none(), "Incomplete Kani output");
    ensure!(
        !results.is_empty(),
        "No regular Kani check results found; quiet/terse output cannot be published"
    );
    Ok((results, verified))
}
fn proof_files(root: &Path) -> Result<BTreeMap<PathBuf, String>> {
    let mut out = BTreeMap::new();
    for e in ignore::WalkBuilder::new(root)
        .hidden(false)
        .ignore(false)
        .git_ignore(false)
        .build()
    {
        let e = e?;
        if e.file_name() == "proof.json" && e.file_type().is_some_and(|t| t.is_file()) {
            out.insert(e.path().to_owned(), snapshot::sha(&fs::read(e.path())?));
        }
    }
    Ok(out)
}
fn creusot_results(
    root: &Path,
    before: &BTreeMap<PathBuf, String>,
    contracts: &[Contract],
) -> Result<(Vec<Value>, Vec<Contract>)> {
    let mut results = vec![];
    let mut verified = vec![];
    for (path, hash) in proof_files(root)? {
        if before.get(&path) == Some(&hash) {
            continue;
        }
        let relative = path
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");
        let matching: Vec<_> = contracts
            .iter()
            .filter(|c| {
                let suffix = format!(
                    "/{}/proof.json",
                    c.harness.split("::").skip(1).collect::<Vec<_>>().join("/")
                );
                relative.ends_with(&suffix)
            })
            .collect();
        if matching.len() != 1 {
            continue;
        }
        let c = matching[0];
        let proof: Value = serde_json::from_slice(&fs::read(&path)?)?;
        let modules = proof["proofs"]
            .as_object()
            .context("Unknown Creusot proof.json format")?;
        let mut local = vec![];
        for (module, goals) in modules {
            for (goal, tree) in goals.as_object().context("Invalid Creusot goals")? {
                let pass = proved(tree);
                local.push(json!({"ruleId":format!("{module}/{goal}"),"kind":if pass {"pass"}else{"open"},"level":"none","message":{"text":goal},"properties":{"harness":c.harness,"proof":tree,"proofFile":relative},"locations":[{"physicalLocation":{"artifactLocation":{"uri":c.file},"region":{"startLine":c.first_line,"endLine":c.last_line}}}]}));
            }
        }
        if !local.is_empty() && local.iter().all(|r| r["kind"] == "pass") {
            verified.push(c.clone());
        }
        results.extend(local);
    }
    ensure!(!results.is_empty(),"No fresh Creusot proof.json results could be mapped to source APIs. Run the prover (not compilation only); unsupported proof layouts are rejected");
    Ok((results, verified))
}
fn proved(v: &Value) -> bool {
    if v.get("prover").and_then(Value::as_str).is_some() {
        return true;
    }
    if let Some(o) = v.as_object() {
        return !o.is_empty()
            && o.values().all(|v| {
                v.as_array()
                    .is_some_and(|a| !a.is_empty() && a.iter().all(proved))
            });
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    fn contract() -> Contract {
        Contract {
            api_paths: vec!["demo::f".into()],
            precondition: "true".into(),
            file: "src/lib.rs".into(),
            first_line: 1,
            last_line: 3,
            harness: "demo::check_f".into(),
            properties: vec!["no_ub".into(), "panic_contract".into()],
        }
    }
    fn output(status: &str, outcome: &str) -> String {
        format!("Checking harness demo::check_f...\nRESULTS:\nCheck 1: f.pointer.1\n - Status: {status}\n - Description: \"pointer check\"\n - Location: src/lib.rs:1:2 in function f\nVERIFICATION:- {outcome}\n")
    }
    #[test]
    fn maps_only_observed_harnesses() {
        let c = contract();
        let (r, v) =
            kani_results(&output("SUCCESS", "SUCCESSFUL"), std::slice::from_ref(&c)).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(r[0]["kind"], "pass");
        assert_eq!(
            r[0]["properties"]["location"],
            "src/lib.rs:1:2 in function f"
        );
        let mut other = c;
        other.harness = "demo::unexecuted".into();
        assert!(kani_results(&output("SUCCESS", "SUCCESSFUL"), &[other])
            .unwrap()
            .1
            .is_empty());
    }
    #[test]
    fn rejects_missing_unknown_and_failed_results() {
        assert!(kani_results("VERIFICATION:- SUCCESSFUL", &[contract()]).is_err());
        assert!(kani_results(&output("NEW_STATUS", "SUCCESSFUL"), &[contract()]).is_err());
        for status in ["FAILURE", "UNDETERMINED"] {
            assert!(kani_results(&output(status, "SUCCESSFUL"), &[contract()])
                .unwrap()
                .1
                .is_empty());
        }
    }
    #[test]
    fn unreachable_is_not_labeled_pass() {
        assert_eq!(
            kani_results(&output("UNREACHABLE", "SUCCESSFUL"), &[contract()])
                .unwrap()
                .0[0]["kind"],
            "notApplicable"
        );
    }
    #[test]
    fn creusot_requires_fresh_proof_files() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("verif/demo/check_f/proof.json");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(
            &p,
            r#"{"proofs":{"M":{"vc_f":{"prover":"z3","time":0.1}}}}"#,
        )
        .unwrap();
        assert_eq!(
            creusot_results(d.path(), &BTreeMap::new(), &[contract()])
                .unwrap()
                .1
                .len(),
            1
        );
        assert!(creusot_results(d.path(), &proof_files(d.path()).unwrap(), &[contract()]).is_err());
    }
    #[test]
    fn shell_quotes_literal_arguments() {
        assert_eq!(
            shell_command(&["x;y".into(), "a'b".into()]),
            "'x;y' 'a'\\''b'"
        );
    }
}
