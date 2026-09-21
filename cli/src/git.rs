use anyhow::{bail, ensure, Context, Result};
use reqwest::Url;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

pub fn run(dir: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .context("Run git")?;
    ensure!(
        out.status.success(),
        "git {} failed: {}",
        args.first().unwrap_or(&""),
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(String::from_utf8(out.stdout)?.trim().into())
}
pub struct Repository {
    pub root: PathBuf,
    pub common: PathBuf,
    pub head: String,
    pub github: String,
}
impl Repository {
    pub fn open(dir: &Path) -> Result<Self> {
        let root = PathBuf::from(run(dir, &["rev-parse", "--show-toplevel"])?).canonicalize()?;
        let common = PathBuf::from(run(
            &root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?);
        let head = run(&root, &["rev-parse", "HEAD"])?;
        Ok(Self {
            root,
            common,
            head,
            github: String::new(),
        })
    }
    pub fn clean(&self, config: &Path) -> Result<()> {
        ensure!(
            run(&self.root, &["rev-parse", "HEAD"])? == self.head,
            "HEAD changed during publication; retry"
        );
        let out = Command::new("git")
            .current_dir(&self.root)
            .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
            .output()?;
        ensure!(out.status.success(), "Cannot inspect Git status");
        let config = config.canonicalize()?;
        let allowed = config
            .strip_prefix(&self.root)
            .context("proofs.toml is outside repository")?
            .to_string_lossy();
        let mut entries = out.stdout.split(|b| *b == 0).filter(|b| !b.is_empty());
        let mut dirty = vec![];
        while let Some(entry) = entries.next() {
            ensure!(entry.len() > 3, "Unexpected Git status");
            let path = String::from_utf8_lossy(&entry[3..]);
            if path != allowed {
                dirty.push(path.into_owned());
            }
            if entry[..2].contains(&b'R') || entry[..2].contains(&b'C') {
                if let Some(old) = entries.next() {
                    dirty.push(String::from_utf8_lossy(old).into_owned());
                }
            }
        }
        ensure!(
            dirty.is_empty(),
            "Commit changes before publishing (proofs.toml may remain uncommitted):\n{}",
            dirty.join("\n")
        );
        Ok(())
    }
    pub fn check_pushed(&mut self, explicit: Option<&str>) -> Result<()> {
        let remotes: Vec<String> = run(&self.root, &["remote"])?
            .lines()
            .map(String::from)
            .collect();
        let tracking = run(&self.root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .ok()
            .and_then(|b| {
                run(
                    &self.root,
                    &["config", "--get", &format!("branch.{b}.remote")],
                )
                .ok()
            })
            .filter(|s| s != ".");
        let remote = explicit
            .map(String::from)
            .or(tracking)
            .or_else(|| remotes.iter().find(|r| *r == "origin").cloned())
            .or_else(|| {
                if remotes.len() == 1 {
                    Some(remotes[0].clone())
                } else {
                    None
                }
            })
            .context("Set [git].remote in proofs.toml; cannot choose a remote")?;
        ensure!(remotes.contains(&remote), "Unknown Git remote {remote}");
        self.github = github_url(&run(&self.root, &["remote", "get-url", "--", &remote])?)?;
        eprintln!("Checking pushed commit {} on {remote}…", &self.head[..12]);
        self.verify_pushed(&remote)
    }
    fn verify_pushed(&self, remote: &str) -> Result<()> {
        // Dedicated temporary refs: do not trust or modify the user's tracking refs.
        let prefix = format!("refs/cargo-proofs-check/{}", uuid::Uuid::new_v4());
        let head_spec = format!("+refs/heads/*:{prefix}/heads/*");
        let tag_spec = format!("+refs/tags/*:{prefix}/tags/*");
        let fetched = run(
            &self.root,
            &[
                "fetch",
                "--quiet",
                "--no-tags",
                "--no-write-fetch-head",
                "--",
                remote,
                &head_spec,
                &tag_spec,
            ],
        );
        let checked = (|| -> Result<bool> {
            fetched.context("Cannot verify remote; publication stopped")?;
            for reference in run(
                &self.root,
                &["for-each-ref", "--format=%(refname)", &prefix],
            )?
            .lines()
            {
                let commit = format!("{reference}^{{commit}}");
                if Command::new("git")
                    .current_dir(&self.root)
                    .args(["merge-base", "--is-ancestor", &self.head, &commit])
                    .status()?
                    .success()
                {
                    return Ok(true);
                }
            }
            Ok(false)
        })();
        if let Ok(refs) = run(
            &self.root,
            &["for-each-ref", "--format=%(refname)", &prefix],
        ) {
            for r in refs.lines() {
                let _ = run(&self.root, &["update-ref", "-d", r]);
            }
        }
        ensure!(checked?, "HEAD is not reachable from a branch/tag on {remote}. Push this commit first (shallow history may require git fetch --unshallow).");
        Ok(())
    }
    pub fn evidence(&self, file: &Path, first: usize, last: usize) -> Result<String> {
        let relative = file.canonicalize()?.strip_prefix(&self.root)?.to_owned();
        // Reject untracked/ignored files even when status doesn't list them.
        run(
            &self.root,
            &[
                "ls-files",
                "--error-unmatch",
                "--",
                relative.to_str().context("Non-UTF8 source path")?,
            ],
        )?;
        ensure!(
            !fs::symlink_metadata(file)?.file_type().is_symlink(),
            "Symlinked evidence source is unsupported"
        );
        let mut url = Url::parse(&self.github)?;
        {
            let mut parts = url
                .path_segments_mut()
                .map_err(|_| anyhow::anyhow!("Invalid GitHub URL"))?;
            parts.extend(["blob", &self.head]);
            for p in &relative {
                parts.push(p.to_str().context("Non-UTF8 path")?);
            }
        }
        url.set_fragment(Some(&format!("L{first}-L{last}")));
        Ok(url.into())
    }
    pub fn shared_evidence(&self) -> String {
        format!("{}/tree/{}", self.github, self.head)
    }
}
pub fn github_url(remote: &str) -> Result<String> {
    let normalized = if let Some(p) = remote.strip_prefix("git@github.com:") {
        format!("https://github.com/{p}")
    } else {
        remote.into()
    };
    let url = Url::parse(&normalized).context("Expected a GitHub HTTPS or SSH remote")?;
    ensure!(
        url.host_str() == Some("github.com") && matches!(url.scheme(), "https" | "ssh"),
        "Only github.com HTTPS/SSH remotes are supported"
    );
    let path = url.path().trim_matches('/').trim_end_matches(".git");
    let bits: Vec<_> = path.split('/').collect();
    if bits.len() != 2
        || bits.iter().any(|s| {
            s.is_empty()
                || !s
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        })
    {
        bail!("Invalid GitHub repository path");
    }
    Ok(format!("https://github.com/{path}"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remotes() {
        for input in [
            "git@github.com:owner/repo.git",
            "ssh://git@github.com/owner/repo.git",
            "https://github.com/owner/repo",
        ] {
            assert_eq!(github_url(input).unwrap(), "https://github.com/owner/repo");
        }
        assert!(github_url("https://github.com.attacker.test/o/r").is_err());
        assert!(github_url("file:///tmp/repo").is_err());
    }
    #[test]
    fn fresh_remote_reachability_and_ancestor() {
        let d = tempfile::tempdir().unwrap();
        let bare = d.path().join("remote.git");
        let work = d.path().join("work");
        fs::create_dir(&work).unwrap();
        run(d.path(), &["init", "--bare", "-q", bare.to_str().unwrap()]).unwrap();
        run(&work, &["init", "-q"]).unwrap();
        run(&work, &["config", "user.email", "test@example.test"]).unwrap();
        run(&work, &["config", "user.name", "Test"]).unwrap();
        fs::write(work.join("lib.rs"), "one").unwrap();
        run(&work, &["add", "."]).unwrap();
        run(&work, &["commit", "-qm", "one"]).unwrap();
        let first = Repository::open(&work).unwrap();
        assert!(first.verify_pushed(bare.to_str().unwrap()).is_err());
        run(
            &work,
            &["push", "-q", bare.to_str().unwrap(), "HEAD:refs/heads/main"],
        )
        .unwrap();
        first.verify_pushed(bare.to_str().unwrap()).unwrap();
        fs::write(work.join("lib.rs"), "two").unwrap();
        run(&work, &["commit", "-qam", "two"]).unwrap();
        let second = Repository::open(&work).unwrap();
        assert!(second.verify_pushed(bare.to_str().unwrap()).is_err());
        run(
            &work,
            &["push", "-q", bare.to_str().unwrap(), "HEAD:refs/heads/main"],
        )
        .unwrap();
        first.verify_pushed(bare.to_str().unwrap()).unwrap();
        second.verify_pushed(bare.to_str().unwrap()).unwrap();
        assert!(run(
            &work,
            &[
                "for-each-ref",
                "--format=%(refname)",
                "refs/cargo-proofs-check"
            ]
        )
        .unwrap()
        .is_empty());
    }
    #[test]
    fn dirty_files_and_line_urls() {
        let d = tempfile::tempdir().unwrap();
        run(d.path(), &["init", "-q"]).unwrap();
        run(d.path(), &["config", "user.email", "test@example.test"]).unwrap();
        run(d.path(), &["config", "user.name", "Test"]).unwrap();
        fs::write(d.path().join("lib.rs"), "pub fn f() {}\n").unwrap();
        run(d.path(), &["add", "lib.rs"]).unwrap();
        run(d.path(), &["commit", "-qm", "fixture"]).unwrap();
        let mut repo = Repository::open(d.path()).unwrap();
        repo.github = "https://github.com/o/r".into();
        fs::write(d.path().join("proofs.toml"), "title = 'new'").unwrap();
        repo.clean(&d.path().join("proofs.toml")).unwrap();
        assert!(repo
            .evidence(&d.path().join("lib.rs"), 1, 2)
            .unwrap()
            .ends_with("/lib.rs#L1-L2"));
        fs::write(d.path().join("lib.rs"), "changed").unwrap();
        assert!(repo.clean(&d.path().join("proofs.toml")).is_err());
    }
}
