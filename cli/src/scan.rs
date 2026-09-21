//! Source-only discovery. Never treats the presence of a harness as a successful run.
use crate::config::Project;
use anyhow::{bail, ensure, Context, Result};
use quote::ToTokens;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
use syn::{
    parse::Parser, punctuated::Punctuated, spanned::Spanned, Attribute, Item, Meta, Token, UseTree,
};

#[derive(Clone, Debug)]
pub struct Contract {
    pub api_paths: Vec<String>,
    pub precondition: String,
    pub file: PathBuf,
    pub first_line: usize,
    pub last_line: usize,
    pub harness: String,
}
struct Function {
    path: String,
    module: Vec<String>,
    owner: Option<syn::Path>,
    name: String,
    public: bool,
    requires: Vec<String>,
    target: Option<syn::Path>,
    file: PathBuf,
    first: usize,
    last: usize,
}
#[derive(Clone)]
struct Import {
    module: Vec<String>,
    alias: String,
    target: Vec<String>,
    public: bool,
}
struct Scanner<'a> {
    project: &'a Project,
    functions: Vec<Function>,
    imports: Vec<Import>,
    public_modules: BTreeSet<String>,
    visited: BTreeSet<PathBuf>,
    ordinary: usize,
}
fn segments(path: &syn::Path) -> Result<Vec<String>> {
    ensure!(
        path.leading_colon.is_none(),
        "Absolute extern paths are unsupported"
    );
    Ok(path
        .segments
        .iter()
        .map(|x| x.ident.to_string().trim_start_matches("r#").to_owned())
        .collect())
}
fn list(meta: &syn::MetaList) -> Result<Punctuated<Meta, Token![,]>> {
    Ok(Punctuated::parse_terminated.parse2(meta.tokens.clone())?)
}
fn predicate(meta: &Meta, p: &Project) -> Result<bool> {
    match meta {
        Meta::Path(path) => {
            let name = path.to_token_stream().to_string();
            ensure!(
                matches!(
                    name.as_str(),
                    "kani" | "test" | "unix" | "windows" | "debug_assertions" | "proc_macro"
                ) || p.cfg.contains(&name),
                "Unsupported cfg({name}); cannot safely select verification sources"
            );
            Ok(p.cfg.contains(&name))
        }
        Meta::NameValue(nv) => {
            let key = nv.path.to_token_stream().to_string();
            let syn::Expr::Lit(syn::ExprLit {
                lit: syn::Lit::Str(value),
                ..
            }) = &nv.value
            else {
                bail!("Unsupported cfg value");
            };
            if key == "feature" {
                return Ok(p.features.contains(&value.value()));
            }
            ensure!(
                key.starts_with("target_") || key == "panic",
                "Unsupported cfg key {key}"
            );
            Ok(p.cfg.contains(&format!("{}={:?}", key, value.value())))
        }
        Meta::List(l) => {
            let ps: Vec<bool> = list(l)?
                .iter()
                .map(|m| predicate(m, p))
                .collect::<Result<_>>()?;
            if l.path.is_ident("all") {
                Ok(ps.iter().all(|b| *b))
            } else if l.path.is_ident("any") {
                Ok(ps.iter().any(|b| *b))
            } else if l.path.is_ident("not") && ps.len() == 1 {
                Ok(!ps[0])
            } else {
                bail!("Unsupported cfg predicate")
            }
        }
    }
}
fn expand(meta: &Meta, p: &Project, out: &mut Vec<Meta>) -> Result<()> {
    if let Meta::List(l) = meta {
        if l.path.is_ident("cfg_attr") {
            let args = list(l)?;
            let mut iter = args.iter();
            if predicate(iter.next().context("Empty cfg_attr")?, p)? {
                for m in iter {
                    expand(m, p, out)?;
                }
            }
            return Ok(());
        }
    }
    out.push(meta.clone());
    Ok(())
}
fn attrs(attrs: &[Attribute], p: &Project) -> Result<Option<Vec<Meta>>> {
    let mut out = vec![];
    for a in attrs {
        expand(&a.meta, p, &mut out)?;
    }
    for m in &out {
        if let Meta::List(l) = m {
            if l.path.is_ident("cfg") && !predicate(&syn::parse2(l.tokens.clone())?, p)? {
                return Ok(None);
            }
        }
    }
    Ok(Some(out))
}
fn kani(meta: &Meta, name: &str) -> bool {
    let p = meta.path();
    p.segments.len() == 2 && p.segments[0].ident == "kani" && p.segments[1].ident == name
}
impl Scanner<'_> {
    fn file(&mut self, file: &Path, module: &[String], public: bool) -> Result<()> {
        let file = file
            .canonicalize()
            .with_context(|| format!("Read module {}", file.display()))?;
        ensure!(
            self.visited.insert(file.clone()),
            "Module included more than once: {}",
            file.display()
        );
        let parsed = syn::parse_file(&fs::read_to_string(&file)?)
            .with_context(|| format!("Parse {}", file.display()))?;
        if attrs(&parsed.attrs, self.project)?.is_none() {
            return Ok(());
        }
        let module_dir = if module.is_empty() || file.file_name().is_some_and(|n| n == "mod.rs") {
            file.parent().unwrap().to_owned()
        } else {
            file.parent().unwrap().join(file.file_stem().unwrap())
        };
        self.items(&parsed.items, &file, &module_dir, module, public)
    }
    fn items(
        &mut self,
        items: &[Item],
        file: &Path,
        module_dir: &Path,
        module: &[String],
        public: bool,
    ) -> Result<()> {
        if public {
            self.public_modules.insert(module.join("::"));
        }
        for item in items {
            match item {
                Item::Mod(m) => {
                    let Some(ms) = attrs(&m.attrs, self.project)? else {
                        continue;
                    };
                    let mut child = module.to_vec();
                    child.push(m.ident.to_string());
                    let pub_child = public && matches!(m.vis, syn::Visibility::Public(_));
                    if let Some((_, items)) = &m.content {
                        self.items(
                            items,
                            file,
                            &module_dir.join(m.ident.to_string()),
                            &child,
                            pub_child,
                        )?;
                    } else {
                        let explicit = ms.iter().find_map(|m| match m {
                            Meta::NameValue(v) if v.path.is_ident("path") => match &v.value {
                                syn::Expr::Lit(syn::ExprLit {
                                    lit: syn::Lit::Str(s),
                                    ..
                                }) => Some(s.value()),
                                _ => None,
                            },
                            _ => None,
                        });
                        let path = if let Some(path) = explicit {
                            module_dir.join(path)
                        } else {
                            let a = module_dir.join(format!("{}.rs", m.ident));
                            let b = module_dir.join(m.ident.to_string()).join("mod.rs");
                            ensure!(!(a.exists() && b.exists()), "Ambiguous module {}", m.ident);
                            if a.exists() {
                                a
                            } else {
                                b
                            }
                        };
                        self.file(&path, &child, pub_child)?;
                    }
                }
                Item::Fn(f) => {
                    self.function(&f.attrs, &f.sig, &f.vis, f.span(), file, module, None)?
                }
                Item::Impl(i) => {
                    if attrs(&i.attrs, self.project)?.is_none() {
                        continue;
                    }
                    let syn::Type::Path(owner) = &*i.self_ty else {
                        continue;
                    };
                    for method in &i.items {
                        if let syn::ImplItem::Fn(f) = method {
                            if i.trait_.is_some() {
                                let ms = attrs(&f.attrs, self.project)?.unwrap_or_default();
                                ensure!(
                                    !ms.iter().any(|m| kani(m, "proof_for_contract")),
                                    "Trait contract harnesses are unsupported"
                                );
                                continue;
                            }
                            self.function(
                                &f.attrs,
                                &f.sig,
                                &f.vis,
                                f.span(),
                                file,
                                module,
                                Some(owner.path.clone()),
                            )?;
                        }
                    }
                }
                Item::Use(u) => {
                    if attrs(&u.attrs, self.project)?.is_some() {
                        self.use_tree(
                            &u.tree,
                            vec![],
                            module,
                            matches!(u.vis, syn::Visibility::Public(_)),
                        )?;
                    }
                }
                Item::Macro(m) => {
                    let active_include =
                        m.mac.path.is_ident("include") && attrs(&m.attrs, self.project)?.is_some();
                    ensure!(
                        !active_include,
                        "include! sources are unsupported: {}",
                        file.display()
                    );
                }
                _ => {}
            }
        }
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    fn function(
        &mut self,
        attributes: &[Attribute],
        sig: &syn::Signature,
        vis: &syn::Visibility,
        span: proc_macro2::Span,
        file: &Path,
        module: &[String],
        owner: Option<syn::Path>,
    ) -> Result<()> {
        let Some(ms) = attrs(attributes, self.project)? else {
            return Ok(());
        };
        let mut requires = vec![];
        let mut target = None;
        for m in &ms {
            if kani(m, "proof") {
                self.ordinary += 1;
            }
            if kani(m, "requires") {
                let Meta::List(l) = m else {
                    bail!("Invalid requires attribute");
                };
                let expression: syn::Expr = syn::parse2(l.tokens.clone())?;
                requires.push(expression.to_token_stream().to_string());
            }
            if kani(m, "proof_for_contract") {
                ensure!(target.is_none(), "Duplicate proof_for_contract attribute");
                let Meta::List(l) = m else {
                    bail!("Invalid proof_for_contract attribute");
                };
                target = Some(
                    syn::parse2::<syn::Path>(l.tokens.clone())
                        .context("Unsupported contract target path")?,
                );
            }
        }
        let name = sig.ident.to_string().trim_start_matches("r#").to_owned();
        let path = module
            .iter()
            .chain(std::iter::once(&name))
            .cloned()
            .collect::<Vec<_>>()
            .join("::");
        self.functions.push(Function {
            path,
            name,
            module: module.to_vec(),
            owner,
            public: matches!(vis, syn::Visibility::Public(_)),
            requires,
            target,
            file: file.into(),
            first: attributes
                .first()
                .map_or(span.start().line, |a| a.span().start().line),
            last: span.end().line,
        });
        Ok(())
    }
    fn use_tree(
        &mut self,
        tree: &UseTree,
        mut prefix: Vec<String>,
        module: &[String],
        public: bool,
    ) -> Result<()> {
        match tree {
            UseTree::Path(p) => {
                prefix.push(p.ident.to_string());
                self.use_tree(&p.tree, prefix, module, public)?;
            }
            UseTree::Name(n) => {
                let alias = if n.ident == "self" {
                    prefix.last().context("Invalid use self")?.clone()
                } else {
                    prefix.push(n.ident.to_string());
                    n.ident.to_string()
                };
                self.imports.push(Import {
                    module: module.to_vec(),
                    alias,
                    target: prefix,
                    public,
                });
            }
            UseTree::Rename(r) => {
                if r.ident != "self" {
                    prefix.push(r.ident.to_string());
                }
                self.imports.push(Import {
                    module: module.to_vec(),
                    alias: r.rename.to_string(),
                    target: prefix,
                    public,
                });
            }
            UseTree::Group(g) => {
                for t in &g.items {
                    self.use_tree(t, prefix.clone(), module, public)?;
                }
            }
            UseTree::Glob(_) => {} // Never guess a target through a glob import.
        }
        Ok(())
    }
    fn resolve(&self, parts: &[String], module: &[String], depth: usize) -> Result<String> {
        ensure!(depth < 32, "Cyclic or excessively nested import aliases");
        ensure!(!parts.is_empty(), "Empty target path");
        let mut base = module.to_vec();
        let mut rest = parts;
        if parts[0] == "crate" || parts[0] == self.project.lib_name {
            base.clear();
            rest = &parts[1..];
        } else if parts[0] == "self" {
            rest = &parts[1..];
        } else if parts[0] == "super" {
            while rest.first().is_some_and(|x| x == "super") {
                ensure!(base.pop().is_some(), "super escapes crate root");
                rest = &rest[1..];
            }
        }
        if let Some(first) = rest.first() {
            let aliases: Vec<_> = self
                .imports
                .iter()
                .filter(|i| i.module == base && i.alias == *first)
                .collect();
            ensure!(aliases.len() <= 1, "Ambiguous import {first}");
            if let Some(i) = aliases.first() {
                let target = self.resolve(&i.target, &i.module, depth + 1)?;
                return Ok(std::iter::once(target)
                    .chain(rest[1..].iter().cloned())
                    .collect::<Vec<_>>()
                    .join("::"));
            }
        }
        base.extend_from_slice(rest);
        Ok(base.join("::"))
    }
}
pub fn discover(project: &Project) -> Result<Vec<Contract>> {
    let mut s = Scanner {
        project,
        functions: vec![],
        imports: vec![],
        public_modules: BTreeSet::new(),
        visited: BTreeSet::new(),
        ordinary: 0,
    };
    s.file(&project.root_source, &[], true)?;
    let mut functions = BTreeMap::<String, Vec<usize>>::new();
    for (i, f) in s.functions.iter().enumerate() {
        let path = if let Some(owner) = &f.owner {
            format!(
                "{}::{}",
                s.resolve(&segments(owner)?, &f.module, 0)?,
                f.name
            )
        } else {
            f.path.clone()
        };
        functions.entry(path).or_default().push(i);
    }
    let mut result = vec![];
    let mut targets = BTreeSet::new();
    for h in &s.functions {
        let Some(target) = &h.target else {
            continue;
        };
        let mut parts = segments(target)?;
        if parts.first().is_some_and(|p| p == "Self") {
            let owner = h.owner.as_ref().context("Self outside an impl")?;
            let mut replacement = segments(owner)?;
            replacement.extend(parts.into_iter().skip(1));
            parts = replacement;
        }
        let path = s.resolve(&parts, &h.module, 0)?;
        let indices = functions.get(&path).with_context(|| format!("Cannot resolve {} in harness {}. Glob imports, generated functions and trait methods are unsupported.", path, h.path))?;
        ensure!(indices.len() == 1, "Ambiguous contract target {path}");
        ensure!(
            targets.insert(path.clone()),
            "Multiple contract harnesses target {path}; only one per API is supported"
        );
        let f = &s.functions[indices[0]];
        ensure!(
            f.public,
            "Contract target {path} is not a public function/method"
        );
        let mut paths = BTreeSet::from([path.clone()]);
        // Resolve explicit public reexports, including reexported types/modules.
        for _ in 0..16 {
            let before = paths.len();
            for import in s
                .imports
                .iter()
                .filter(|i| i.public && s.public_modules.contains(&i.module.join("::")))
            {
                let source = s.resolve(&import.target, &import.module, 0)?;
                for candidate in paths.clone() {
                    if candidate == source || candidate.starts_with(&(source.clone() + "::")) {
                        let alias = import
                            .module
                            .iter()
                            .chain(std::iter::once(&import.alias))
                            .cloned()
                            .collect::<Vec<_>>()
                            .join("::");
                        paths.insert(format!("{}{}", alias, &candidate[source.len()..]));
                    }
                }
            }
            if paths.len() == before {
                break;
            }
        }
        let precondition = if f.requires.is_empty() {
            "true".into()
        } else {
            f.requires
                .iter()
                .map(|r| format!("({r})"))
                .collect::<Vec<_>>()
                .join(" && ")
        };
        result.push(Contract {
            api_paths: paths.into_iter().collect(),
            precondition,
            file: h.file.clone(),
            first_line: h.first,
            last_line: h.last,
            harness: h.path.clone(),
        });
    }
    if s.ordinary > 0 {
        eprintln!(
            "Note: {} ordinary #[kani::proof] harness(es) are not publication targets.",
            s.ordinary
        );
    }
    ensure!(
        !result.is_empty(),
        "No #[kani::proof_for_contract] harnesses found in the selected library/configuration"
    );
    result.sort_by(|a, b| a.api_paths.cmp(&b.api_paths));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn project(source: &str) -> (tempfile::TempDir, Project) {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("lib.rs");
        fs::write(&root, source).unwrap();
        let p = Project {
            name: "demo".into(),
            lib_name: "demo".into(),
            version: "1.0.0".into(),
            manifest: d.path().join("Cargo.toml"),
            root_source: root,
            features: BTreeSet::new(),
            cfg: BTreeSet::from(["kani".into()]),
        };
        (d, p)
    }
    #[test]
    fn extracts_cfg_attrs_conditions_aliases_and_lines() {
        let (_d, p) = project("\n#[cfg_attr(kani, kani::requires(x > 0))]\n#[kani::requires(x < 10)]\npub fn f(x: u8) {}\n#[cfg(kani)]\nmod verification {\nuse super::f as target;\n#[kani::proof_for_contract(target)]\nfn check() {}\n}\n");
        let c = discover(&p).unwrap();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].api_paths, ["f"]);
        assert_eq!(c[0].precondition, "(x > 0) && (x < 10)");
        assert_eq!(c[0].first_line, 8);
        assert_eq!(c[0].last_line, 9);
    }
    #[test]
    fn rejects_multiple_harnesses() {
        let (_d, p) = project("pub fn f() {} #[kani::proof_for_contract(f)] fn a() {} #[kani::proof_for_contract(f)] fn b() {}");
        assert!(discover(&p).unwrap_err().to_string().contains("Multiple"));
    }
    #[test]
    fn method_reexport_and_true() {
        let (_d, p) = project("mod inner { pub struct S; impl S { pub fn f() {} } #[kani::proof_for_contract(S::f)] fn check() {} } pub use inner::S;");
        let c = discover(&p).unwrap();
        assert!(c[0].api_paths.contains(&"S::f".into()));
        assert_eq!(c[0].precondition, "true");
    }
    #[test]
    fn ignores_disabled_module_and_ordinary_proof() {
        let (_d, p) = project("#[cfg(feature=\"other\")] mod missing; pub fn f() {} #[kani::proof] fn ordinary() {} #[kani::proof_for_contract(f)] fn check() {}");
        assert_eq!(discover(&p).unwrap().len(), 1);
    }
    #[test]
    fn external_module_and_unknown_target() {
        let (d, p) = project("pub mod child;");
        fs::write(
            d.path().join("child.rs"),
            "pub fn f() {} #[kani::proof_for_contract(self::f)] fn check() {}",
        )
        .unwrap();
        assert_eq!(discover(&p).unwrap()[0].api_paths, ["child::f"]);
        fs::write(
            d.path().join("child.rs"),
            "#[kani::proof_for_contract(missing)] fn check() {}",
        )
        .unwrap();
        assert!(discover(&p).is_err());
    }
}
