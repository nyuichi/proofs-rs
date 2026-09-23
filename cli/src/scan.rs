//! Source-only discovery. Never treats the presence of a harness as a successful run.
use crate::config::{CreusotTarget, Project, Tool};
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
    annotated: bool,
    excluded: bool,
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
    creusot: bool,
    public_items: BTreeSet<String>,
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
                    "kani" | "creusot" | "test" | "unix" | "windows" | "debug_assertions" | "proc_macro"
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
fn creusot(meta: &Meta, name: &str) -> bool {
    let p = meta.path();
    p.is_ident(name)
        || (p.segments.len() == 2
            && matches!(p.segments[0].ident.to_string().as_str(), "creusot_std" | "creusot_contracts")
            && p.segments[1].ident == name)
}

fn item_path(module: &[String], name: &str) -> String {
    module.iter().map(String::as_str).chain([name]).collect::<Vec<_>>().join("::")
}

fn source_text(file: &Path, span: proc_macro2::Span) -> Result<String> {
    let source = fs::read_to_string(file)?;
    let offset = |location: proc_macro2::LineColumn| -> Result<usize> {
        let line = source.split_inclusive('\n').take(location.line - 1).map(str::len).sum::<usize>();
        // proc_macro2 columns count Unicode characters, not UTF-8 bytes.
        let column = source[line..].chars().take(location.column).map(char::len_utf8).sum::<usize>();
        Ok(line + column)
    };
    Ok(source.get(offset(span.start())?..offset(span.end())?).context("Cannot locate Creusot contract in source")?.to_owned())
}

/// Discard function bodies before syn parses them: logic bodies may use Pearlite.
/// Attribute and macro token streams are otherwise retained, with original spans.
fn declarations(tokens: proc_macro2::TokenStream) -> proc_macro2::TokenStream {
    use proc_macro2::{Group, TokenTree};
    let mut function = false;
    let mut angles = 0usize;
    let tokens: Vec<_> = tokens.into_iter().collect();
    tokens.iter().enumerate().map(|(index, token)| {
        match token {
            TokenTree::Ident(i) if i == "fn" && matches!(tokens.get(index + 1), Some(TokenTree::Ident(_))) => function = true,
            TokenTree::Punct(p) if function && p.as_char() == '<' => angles += 1,
            TokenTree::Punct(p) if function && p.as_char() == '>' => angles = angles.saturating_sub(1),
            TokenTree::Punct(p) if p.as_char() == ';' => { function = false; angles = 0; },
            TokenTree::Group(g) if g.delimiter() == proc_macro2::Delimiter::Brace => {
                let stream = if function && angles == 0 {
                    function = false;
                    proc_macro2::TokenStream::new()
                } else {
                    declarations(g.stream())
                };
                let mut replacement = Group::new(g.delimiter(), stream);
                replacement.set_span(g.span());
                return TokenTree::Group(replacement);
            }
            _ => {}
        }
        token.clone()
    }).collect()
}

pub fn discover_for_tool(project: &Project, tool: &Tool) -> Result<Vec<Contract>> {
    if !tool.is_creusot() { return discover(project); }
    let target = tool.target.context("Creusot requires [tool].target")?;
    let mut s = scanner(project, true);
    s.file(&project.root_source, &[], true)?;
    let mut result = vec![];
    let mut seen = BTreeSet::new();
    for f in &s.functions {
        if !f.public || f.excluded || (target == CreusotTarget::Annotated && !f.annotated) { continue; }
        let path = if let Some(owner) = &f.owner {
            let owner = s.resolve(&segments(owner)?, &f.module, 0)?;
            if !s.public_items.contains(&owner) { continue; }
            format!("{owner}::{}", f.name)
        } else { f.path.clone() };
        let paths = s.creusot_public_paths(&path)?;
        if paths.is_empty() { continue; }
        ensure!(seen.insert(path.clone()), "Ambiguous contract target {path}");
        result.push(Contract {
            api_paths: paths,
            precondition: if f.requires.is_empty() { "true".into() } else {
                f.requires.iter().map(|r| format!("({r})")).collect::<Vec<_>>().join(" && ")
            },
            file: f.file.clone(),
            first_line: f.first,
            last_line: f.last,
            harness: path,
        });
    }
    ensure!(!result.is_empty(), "No eligible public Creusot APIs found for [tool].target in the selected library/configuration");
    result.sort_by(|a, b| a.api_paths.cmp(&b.api_paths));
    Ok(result)
}

impl Scanner<'_> {
    fn creusot_attr(&self, meta: &Meta, name: &str, module: &[String]) -> Result<bool> {
        if creusot(meta, name) { return Ok(true); }
        let path = self.resolve(&segments(meta.path())?, module, 0)?;
        // Module-local imports of an external crate acquire the local module prefix
        // in the source resolver. Match the external crate and known macro modules.
        let parts: Vec<_> = path.split("::").collect();
        Ok(parts.iter().enumerate().any(|(n, p)| {
            matches!(*p, "creusot_std" | "creusot_contracts")
                && (parts[n + 1..] == [name] || parts[n + 1..] == ["macros", name] || parts[n + 1..] == ["prelude", name])
        }))
    }
    fn creusot_public_paths(&self, path: &str) -> Result<Vec<String>> {
        // Every intermediate module/type must be public, unless explicitly reexported.
        let traversable = |path: &str, from: usize| {
            let parts: Vec<_> = path.split("::").collect();
            (from..parts.len()).all(|n| self.public_items.contains(&parts[..n].join("::")))
        };
        let mut paths = BTreeSet::new();
        if traversable(path, 1) { paths.insert(path.to_owned()); }
        for import in self.imports.iter().filter(|i| i.public) {
            if !traversable(&item_path(&import.module, &import.alias), 1) { continue; }
            let source = self.resolve(&import.target, &import.module, 0)?;
            if path == source || (path.starts_with(&(source.clone() + "::"))
                && traversable(path, source.split("::").count())) {
                paths.insert(format!("{}{}", item_path(&import.module, &import.alias), &path[source.len()..]));
            }
        }
        Ok(paths.into_iter().collect())
    }
    fn file(&mut self, file: &Path, module: &[String], public: bool) -> Result<()> {
        let file = file
            .canonicalize()
            .with_context(|| format!("Read module {}", file.display()))?;
        ensure!(
            self.visited.insert(file.clone()),
            "Module included more than once: {}",
            file.display()
        );
        let source = fs::read_to_string(&file)?;
        // Pearlite bodies need not be valid Rust. Only declarations are relevant.
        let parsed = if self.creusot {
            syn::parse2(declarations(source.parse()?))
        } else {
            syn::parse_file(&source)
        }
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
        // Imports are in scope regardless of their source order.
        for item in items {
            if let Item::Use(u) = item {
                if attrs(&u.attrs, self.project)?.is_some() {
                    self.use_tree(&u.tree, vec![], module, matches!(u.vis, syn::Visibility::Public(_)))?;
                }
            }
        }
        for item in items {
            match item {
                Item::Mod(m) => {
                    let Some(ms) = attrs(&m.attrs, self.project)? else {
                        continue;
                    };
                    if matches!(m.vis, syn::Visibility::Public(_)) {
                        self.public_items.insert(item_path(module, &m.ident.to_string()));
                    }
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
                Item::Struct(i) => {
                    if matches!(i.vis, syn::Visibility::Public(_)) && attrs(&i.attrs, self.project)?.is_some() {
                        self.public_items.insert(item_path(module, &i.ident.to_string()));
                    }
                }
                Item::Enum(i) => {
                    if matches!(i.vis, syn::Visibility::Public(_)) && attrs(&i.attrs, self.project)?.is_some() {
                        self.public_items.insert(item_path(module, &i.ident.to_string()));
                    }
                }
                Item::Union(i) => {
                    if matches!(i.vis, syn::Visibility::Public(_)) && attrs(&i.attrs, self.project)?.is_some() {
                        self.public_items.insert(item_path(module, &i.ident.to_string()));
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
                Item::Use(_) => {}
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
        let mut annotated = false;
        let mut excluded = false;
        let mut target = None;
        for m in &ms {
            if self.creusot {
                if self.creusot_attr(m, "requires", module)? || self.creusot_attr(m, "ensures", module)? {
                    annotated = true;
                }
                for name in ["trusted", "logic", "predicate", "law"] {
                    excluded |= self.creusot_attr(m, name, module)?;
                }
                if self.creusot_attr(m, "check", module)? {
                    if let Meta::List(l) = m {
                        excluded |= l.tokens.clone().into_iter().any(|t| matches!(t, proc_macro2::TokenTree::Ident(i) if i == "ghost"));
                    }
                }
                if self.creusot_attr(m, "requires", module)? {
                    let Meta::List(l) = m else { bail!("Invalid Creusot requires attribute"); };
                    ensure!(!l.tokens.is_empty(), "Empty Creusot requires attribute");
                    requires.push(source_text(file, l.tokens.span())?);
                }
                continue;
            }
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
            annotated,
            excluded,
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
fn scanner(project: &Project, creusot: bool) -> Scanner<'_> {
    Scanner {
        project,
        creusot,
        public_items: BTreeSet::new(),
        functions: vec![],
        imports: vec![],
        public_modules: BTreeSet::new(),
        visited: BTreeSet::new(),
        ordinary: 0,
    }
}
pub fn discover(project: &Project) -> Result<Vec<Contract>> {
    let mut s = scanner(project, false);
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
    fn creusot_contracts(source: &str, target: CreusotTarget) -> Vec<Contract> {
        let (_d, mut p) = project(source);
        p.cfg = BTreeSet::from(["creusot".into()]);
        discover_for_tool(&p, &Tool { name: "creusot".into(), version: "test".into(), target: Some(target) }).unwrap()
    }
    #[test]
    fn creusot_pearlite_and_exclusions() {
        let source = r#"use creusot_std::prelude::*;
#[requires(forall<i: Int> 0 <= i && i < xs@.len() ==> xs@[i] >= 0)]
#[requires(é@ > 0)]
#[ensures(result@ >= 0)]
pub fn sum(xs: &[u32], é: u32) -> u32 { 0 }
#[ensures(result)]
pub fn yes() -> bool { true }
pub fn plain() {}
#[trusted] #[requires(true)] pub fn trusted() {}
#[logic] pub fn model(x: u32) -> Int { x@ }
#[predicate] pub fn pred(x: u32) -> bool { x@ > 0 }
#[check(ghost)] pub fn lemma() {}
#[law] pub fn law() -> bool { true }
#[requires(true)] fn private() {}
#[cfg(kani)] pub fn kani_only() {}
"#;
        let c = creusot_contracts(source, CreusotTarget::Annotated);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].api_paths, ["sum"]);
        assert_eq!(c[0].precondition, "(forall<i: Int> 0 <= i && i < xs@.len() ==> xs@[i] >= 0) && (é@ > 0)");
        assert_eq!((c[0].first_line, c[0].last_line), (2, 5));
        assert_eq!(c[1].precondition, "true");
        let all = creusot_contracts(source, CreusotTarget::All);
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].api_paths, ["plain"]);
    }
    #[test]
    fn creusot_public_methods_reexports_and_cfg() {
        let c = creusot_contracts(r#"
mod hidden {
    pub struct Public;
    struct Private;
    impl Public { #[requires(true)] pub fn f(&self) {} }
    impl Private { #[requires(true)] pub fn no(&self) {} }
    #[requires(true)] pub fn hidden() {}
    #[requires(true)] pub fn exported() {}
}
pub use hidden::{Public as Alias, exported};
#[cfg_attr(creusot, creusot_std::requires(x@ > 0))]
pub fn cfg(x: u32) {}
#[cfg(not(creusot))] pub fn no() {}
#[cfg(feature="absent")] mod missing;
"#, CreusotTarget::Annotated);
        assert_eq!(c.iter().map(|c| c.api_paths[0].as_str()).collect::<Vec<_>>(), ["Alias::f", "cfg", "exported"]);
        assert_eq!(c[1].precondition, "(x@ > 0)");
    }
    #[test]
    fn creusot_imported_macro_aliases_and_external_modules() {
        let (d, mut p) = project("pub mod child;");
        p.cfg = BTreeSet::from(["creusot".into()]);
        fs::write(d.path().join("child.rs"), r#"
#[pre(x@ >= 1)] pub fn f(x: u32) {}
#[trust] pub fn skipped() {}
use creusot_std::{requires as pre, trusted as trust};
"#).unwrap();
        let tool = Tool { name: "creusot".into(), version: "test".into(), target: Some(CreusotTarget::All) };
        let c = discover_for_tool(&p, &tool).unwrap();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].api_paths, ["child::f"]);
        assert_eq!(c[0].precondition, "(x@ >= 1)");
    }
}
