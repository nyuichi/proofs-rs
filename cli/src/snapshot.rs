use anyhow::{ensure, Context, Result};
use flate2::{write::GzEncoder, Compression};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

pub const MAX_SOURCE: u64 = 32 * 1024 * 1024;
pub fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn files(root: &Path) -> Result<BTreeMap<String, PathBuf>> {
    let mut files = BTreeMap::new();
    let mut total = 0;
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|e| {
            let n = e.file_name().to_string_lossy();
            !matches!(
                n.as_ref(),
                ".git"
                    | "target"
                    | ".proofs"
                    | "node_modules"
                    | ".ssh"
                    | ".aws"
                    | "credentials"
                    | "credentials.toml"
            ) && n != ".env"
                && !n.starts_with(".env.")
                && !n.ends_with(".pem")
                && !n.ends_with(".key")
        })
        .build();
    for e in walker {
        let e = e?;
        if e.path() == root {
            continue;
        }
        ensure!(
            !e.path_is_symlink(),
            "Source symlinks are not supported: {}",
            e.path().display()
        );
        if !e.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        total += e.metadata()?.len();
        ensure!(
            total <= MAX_SOURCE,
            "Source snapshot exceeds 32 MiB; exclude generated files with .gitignore"
        );
        let name = e
            .path()
            .strip_prefix(root)?
            .to_str()
            .context("Non-UTF8 source path")?
            .replace('\\', "/");
        files.insert(name, e.path().to_owned());
    }
    // Cargo.lock is commonly gitignored by libraries; it is essential evidence.
    for entry in walk_locks(root)? {
        let name = entry
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");
        if !files.contains_key(&name) {
            total += fs::metadata(&entry)?.len();
            ensure!(
                total <= MAX_SOURCE,
                "Source snapshot including lockfiles exceeds 32 MiB"
            );
        }
        files.insert(name, entry);
    }
    ensure!(files.len() <= 10000, "Too many source files");
    Ok(files)
}
fn walk_locks(root: &Path) -> Result<Vec<PathBuf>> {
    let mut found = vec![];
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .ignore(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .filter_entry(|e| {
            !matches!(
                e.file_name().to_str(),
                Some("target" | ".git" | "node_modules" | ".proofs")
            )
        })
        .build();
    for e in walker {
        let e = e?;
        if e.file_name() == "Cargo.lock" && e.file_type().is_some_and(|t| t.is_file()) {
            found.push(e.path().to_owned());
        }
    }
    Ok(found)
}
pub fn capture(root: &Path, dest: &Path, archive: &Path) -> Result<BTreeMap<String, String>> {
    let mut hashes = BTreeMap::new();
    let mut tar = tar::Builder::new(GzEncoder::new(
        fs::File::create(archive)?,
        Compression::default(),
    ));
    for (name, path) in files(root)? {
        let bytes = fs::read(&path)?;
        let to = dest.join(&name);
        fs::create_dir_all(to.parent().unwrap())?;
        fs::write(&to, &bytes)?;
        let permissions = fs::metadata(&path)?.permissions();
        fs::set_permissions(&to, permissions)?;
        let mut h = tar::Header::new_gnu();
        h.set_size(bytes.len() as u64);
        h.set_mode(if executable(&path)? { 0o755 } else { 0o644 });
        h.set_mtime(0);
        h.set_cksum();
        tar.append_data(&mut h, &name, bytes.as_slice())?;
        hashes.insert(name, sha(&bytes));
    }
    tar.into_inner()?.finish()?;
    Ok(hashes)
}
fn executable(path: &Path) -> Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Ok(fs::metadata(path)?.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(false)
    }
}
pub fn unchanged(root: &Path, hashes: &BTreeMap<String, String>) -> Result<()> {
    for (name, expected) in hashes {
        ensure!(
            sha(&fs::read(root.join(name))
                .with_context(|| format!("Recorded source {name} disappeared"))?)
                == *expected,
            "Source changed during verification: {name}; run again"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn freezes_dirty_source_and_includes_ignored_lock_but_not_secrets() {
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("src");
        fs::create_dir(&src).unwrap();
        for (name, value) in [
            ("lib.rs", "fn a() {}"),
            ("Cargo.lock", "lock"),
            (".gitignore", "Cargo.lock\n"),
            (".env", "secret"),
        ] {
            fs::write(src.join(name), value).unwrap();
        }
        let dest = d.path().join("copy");
        let archive = d.path().join("source.tar.gz");
        let hashes = capture(&src, &dest, &archive).unwrap();
        assert!(hashes.contains_key("Cargo.lock"));
        assert!(!hashes.contains_key(".env"));
        fs::write(src.join("lib.rs"), "changed").unwrap();
        assert_eq!(
            fs::read_to_string(dest.join("lib.rs")).unwrap(),
            "fn a() {}"
        );
        unchanged(&dest, &hashes).unwrap();
        fs::write(dest.join("lib.rs"), "changed").unwrap();
        assert!(unchanged(&dest, &hashes).is_err());
    }
}
