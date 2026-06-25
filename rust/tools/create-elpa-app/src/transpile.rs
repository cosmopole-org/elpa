//! TypeScript → Elpian-VM JavaScript transpiler / bundler.
//!
//! The Elpian VM runs a practical JS *subset* with no ES modules and a stdlib of
//! global functions (`len`, `push`, `concat`, …) rather than Array/String
//! *methods*. This module turns an idiomatic, multi-file TypeScript project into
//! a single flat script the VM accepts, in three moves:
//!
//!   1. **Resolve** the relative-import graph from an entry file (bare/ambient
//!      imports — the vendored SDK — are left to resolve as runtime globals).
//!   2. **Strip** TypeScript types (swc) and run a **shim** pass that lowers the
//!      idioms the VM lacks: template literals → `+`, `xs.map(f)` → `map(xs, f)`,
//!      `a.length` → `len(a)`, `Math.floor` → `floor`, `JSON.stringify` →
//!      `jsonStringify`, and so on.
//!   3. **Flatten** every module into one scope (drop `import`/`export`, emit
//!      `const B = A;` for renamed imports) and concatenate in dependency order.
//!
//! The shipped `runtime/prelude.js` (prepended by the builder) supplies the
//! higher-order helpers (`map`/`filter`/`reduce`/…) in pure VM-subset JS.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use swc_core::common::{sync::Lrc, FileName, SourceMap, SyntaxContext, GLOBALS, Mark, DUMMY_SP};
use swc_core::ecma::ast::*;
use swc_core::ecma::codegen::{text_writer::JsWriter, Emitter};
use swc_core::ecma::parser::{lexer::Lexer, Parser, StringInput, Syntax, TsSyntax};
use swc_core::ecma::transforms::base::hygiene::hygiene;
use swc_core::ecma::transforms::base::resolver;
use swc_core::ecma::transforms::typescript::strip;
use swc_core::ecma::visit::{VisitMut, VisitMutWith};

/// The runtime prelude (idiomatic-method backing), prepended to every bundle.
pub const PRELUDE: &str = include_str!("runtime/prelude.js");

// ---- public entry -----------------------------------------------------------

/// Bundle the TypeScript project rooted at `entry` into one VM-subset JS string.
/// The result does *not* include the prelude or the vendored SDK — the builder
/// concatenates those ahead of it.
pub fn bundle(entry: &Path) -> Result<String, String> {
    let cm: Lrc<SourceMap> = Default::default();
    let mut graph = Graph { cm: cm.clone(), order: vec![], seen: HashSet::new(), stack: vec![] };
    let entry = entry
        .canonicalize()
        .map_err(|e| format!("entry {}: {e}", entry.display()))?;
    graph.resolve(&entry)?;

    GLOBALS.set(&Default::default(), || {
        let mut out = String::new();
        for path in &graph.order {
            let src = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
            let module = parse(&cm, path, &src)?;
            let body = lower_module(&cm, module);
            out.push_str(&format!("// ---- {} ----\n", rel_label(path)));
            out.push_str(&body);
            if !out.ends_with('\n') {
                out.push('\n');
            }
        }
        Ok(out)
    })
}

// ---- module graph -----------------------------------------------------------

struct Graph {
    cm: Lrc<SourceMap>,
    order: Vec<PathBuf>,
    seen: HashSet<PathBuf>,
    stack: Vec<PathBuf>,
}

impl Graph {
    fn resolve(&mut self, path: &Path) -> Result<(), String> {
        if self.seen.contains(path) {
            return Ok(());
        }
        if self.stack.contains(&path.to_path_buf()) {
            // A cycle: the VM scope is flat, so values still resolve by name at
            // call time; we just stop recursing to avoid looping.
            return Ok(());
        }
        self.stack.push(path.to_path_buf());
        let src = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let module = parse(&self.cm, path, &src)?;
        let dir = path.parent().unwrap_or(Path::new("."));
        for item in &module.body {
            if let ModuleItem::ModuleDecl(ModuleDecl::Import(imp)) = item {
                if let Some(spec) = imp.src.value.as_str() {
                    if let Some(dep) = resolve_specifier(dir, spec)? {
                        self.resolve(&dep)?;
                    }
                }
            }
        }
        self.stack.pop();
        // Post-order: dependencies are emitted before the modules that need them.
        self.order.push(path.to_path_buf());
        self.seen.insert(path.to_path_buf());
        Ok(())
    }
}

/// Resolve a relative import specifier to a file. Bare specifiers (the vendored
/// SDK / ambient runtime globals) return `None` — they aren't bundled.
fn resolve_specifier(dir: &Path, spec: &str) -> Result<Option<PathBuf>, String> {
    if !spec.starts_with('.') {
        return Ok(None);
    }
    let base = dir.join(spec);
    let candidates = [
        base.clone(),
        base.with_extension("ts"),
        base.with_extension("js"),
        base.join("index.ts"),
        base.join("index.js"),
    ];
    for c in candidates {
        if c.is_file() {
            return c.canonicalize().map(Some).map_err(|e| format!("resolve {spec}: {e}"));
        }
    }
    Err(format!("cannot resolve import \"{spec}\" from {}", dir.display()))
}

fn rel_label(path: &Path) -> String {
    path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
}

// ---- parse / strip / emit ---------------------------------------------------

fn parse(cm: &Lrc<SourceMap>, path: &Path, src: &str) -> Result<Module, String> {
    let fm = cm.new_source_file(Lrc::new(FileName::Real(path.to_path_buf())), src.to_string());
    let lexer = Lexer::new(
        Syntax::Typescript(TsSyntax::default()),
        EsVersion::Es2020,
        StringInput::from(&*fm),
        None,
    );
    let mut parser = Parser::new_from(lexer);
    parser
        .parse_module()
        .map_err(|e| format!("parse {}: {:?}", path.display(), e.kind()))
}

/// Strip types, downlevel the modern syntax the VM lacks, run the shim, drop
/// module syntax, and emit the flat statement body.
fn lower_module(cm: &Lrc<SourceMap>, module: Module) -> String {
    let top = Mark::new();
    let unresolved = Mark::new();
    let mut program = Program::Module(module);

    // Resolve identifiers so the downlevel passes generate hygienic temporaries,
    // then strip the TypeScript types.
    program.mutate(&mut resolver(unresolved, top, true));
    strip(unresolved, top).process(&mut program);

    // Downlevel the modern syntax the VM can't parse (for-of, destructuring) into
    // the ES5-ish forms it supports — indexed `while` loops and temporaries.
    // Classes, arrows and template literals are left intact: the VM handles them
    // and the shim wants them un-lowered.
    downlevel(unresolved, &mut program);

    // The VM has no block scoping (every `let`/`const` lands in one flat scope),
    // so two nested lowered loops both named `_i`, or any user `let` shadowed in
    // a nested block, would clobber each other. `block_scoping` rewrites
    // block-scoped bindings to function-scoped ones with textually-unique names,
    // which is exactly the VM's model; `hygiene` then resolves any remaining
    // same-name clashes.
    {
        let unresolved = Mark::new();
        program.mutate(&mut resolver(unresolved, Mark::new(), false));
        swc_ecma_compat_es2015::block_scoping(unresolved).process(&mut program);
    }
    hygiene().process(&mut program);

    let mut module = match program {
        Program::Module(m) => m,
        _ => unreachable!(),
    };
    module.visit_mut_with(&mut Shim);
    let flat = flatten_module(module);
    emit(cm, &flat)
}

fn downlevel(_unresolved: Mark, program: &mut Program) {
    use swc_ecma_compat_es2015 as es2015;

    // Only the lowerings whose output stays fully inside the VM subset and is
    // verified to run correctly:
    //   * `for…of`  → an indexed `while` loop (`loose` + `assume_array`, so no
    //                 iterator protocol / `Symbol`).
    //   * destructuring (array, object, nested, defaults, renames) → temporaries.
    //
    // The other modern forms are intentionally *not* lowered, because swc's
    // output for them relies on constructs the Elpian VM lacks — `arguments`
    // (default / rest params), assignment-and-sequence expressions (optional
    // chaining `?.`), `fn.apply` (call spread), or is subtly wrong for falsy
    // values (`??`). Left un-lowered they reach the VM front-end, which the
    // builder reports as a clean "outside the VM subset" error.
    // `assume_array` only takes the plain indexed-loop path when `loose == false`
    // (otherwise swc falls back to an iterator helper that needs `Symbol`).
    es2015::for_of(es2015::for_of::Config { loose: false, assume_array: true }).process(program);
    es2015::destructuring(es2015::destructuring::Config { loose: true }).process(program);
}

fn emit(cm: &Lrc<SourceMap>, module: &Module) -> String {
    let mut buf = Vec::new();
    {
        let mut emitter = Emitter {
            cfg: Default::default(),
            cm: cm.clone(),
            comments: None,
            wr: JsWriter::new(cm.clone(), "\n", &mut buf, None),
        };
        emitter.emit_module(module).expect("codegen");
    }
    String::from_utf8(buf).expect("utf8")
}

/// Drop `import`/`export`, turning the module into a flat list of statements.
/// Renamed imports (`import { A as B }`) become `const B = A;`.
fn flatten_module(module: Module) -> Module {
    let mut aliases: Vec<ModuleItem> = vec![];
    let mut body: Vec<ModuleItem> = vec![];
    for item in module.body {
        match item {
            ModuleItem::ModuleDecl(ModuleDecl::Import(imp)) => {
                for s in imp.specifiers {
                    if let ImportSpecifier::Named(named) = s {
                        if let Some(ModuleExportName::Ident(orig)) = named.imported {
                            // `import { orig as local }` → `const local = orig;`
                            aliases.push(const_binding(&named.local.sym, ident_expr(&orig.sym)));
                        }
                    }
                    // default / namespace specifiers are unsupported (templates
                    // use named imports only); they simply carry no binding here.
                }
            }
            ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(ExportDecl { decl, .. })) => {
                body.push(ModuleItem::Stmt(Stmt::Decl(decl)));
            }
            // `export { ... }`, `export ... from '...'`, `export default`, etc.:
            // the names already live in the flat scope, so the re-export is a
            // no-op once modules are concatenated.
            ModuleItem::ModuleDecl(_) => {}
            ModuleItem::Stmt(s) => body.push(ModuleItem::Stmt(s)),
        }
    }
    aliases.extend(body);
    Module { span: DUMMY_SP, body: aliases, shebang: None }
}

// ---- the shim: idiomatic JS → VM-subset -------------------------------------

struct Shim;

impl VisitMut for Shim {
    // Default parameters: the VM has no default-param syntax, so lower
    // `function f(a, b = expr)` to a plain param plus a guard
    // `if (isNull(b)) { b = expr; }` at the top of the body.
    fn visit_mut_function(&mut self, f: &mut Function) {
        f.visit_mut_children_with(self);
        let guards: Vec<Stmt> = f.params.iter_mut().filter_map(|p| default_guard(&mut p.pat)).collect();
        if let Some(body) = &mut f.body {
            prepend_stmts(&mut body.stmts, guards);
        }
    }

    fn visit_mut_arrow_expr(&mut self, a: &mut ArrowExpr) {
        a.visit_mut_children_with(self);
        let guards: Vec<Stmt> = a.params.iter_mut().filter_map(default_guard).collect();
        if guards.is_empty() {
            return;
        }
        // Ensure a block body so the guards have somewhere to live.
        if let BlockStmtOrExpr::Expr(e) = &mut *a.body {
            let ret = Stmt::Return(ReturnStmt { span: DUMMY_SP, arg: Some(e.clone()) });
            a.body = Box::new(BlockStmtOrExpr::BlockStmt(BlockStmt {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                stmts: vec![ret],
            }));
        }
        if let BlockStmtOrExpr::BlockStmt(b) = &mut *a.body {
            prepend_stmts(&mut b.stmts, guards);
        }
    }

    fn visit_mut_expr(&mut self, e: &mut Expr) {
        // A comparison against `void 0` (swc's `undefined` sentinel, emitted by
        // the default-value lowering) must be caught *before* children turn the
        // `void 0` into a plain `null`: `x === void 0` → `isNull(x)`, which —
        // unlike `x === null` — also matches an omitted (undefined) argument.
        if let Some(rep) = lower_void_compare(e) {
            *e = rep;
        }

        // Transform children first so rewrites compose bottom-up.
        e.visit_mut_children_with(self);

        match e {
            // `` `a${x}b` `` → ("a" + x + "b")
            Expr::Tpl(tpl) => {
                *e = lower_template(tpl);
            }
            // method / namespace / global calls
            Expr::Call(call) => {
                if let Some(rep) = lower_call(call) {
                    *e = rep;
                }
            }
            // `void 0` (emitted by the optional-chaining / nullish downlevel as
            // the `undefined` sentinel) → `null`, which the VM understands.
            Expr::Unary(u) if u.op == UnaryOp::Void => {
                *e = Expr::Lit(Lit::Null(Null { span: DUMMY_SP }));
            }
            // `obj.length` → len(obj); Math.PI / Math.E constants
            Expr::Member(m) => {
                if let MemberProp::Ident(prop) = &m.prop {
                    if prop.sym.as_str() == "length" {
                        *e = call_global("len", vec![(*m.obj).clone()]);
                    } else if let Expr::Ident(ns) = &*m.obj {
                        match (ns.sym.as_str(), prop.sym.as_str()) {
                            ("Math", "PI") => *e = ident_expr("PI"),
                            ("Math", "E") => *e = ident_expr("E"),
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

/// Rewrite a call expression if its callee is a built-in we map to a global.
fn lower_call(call: &CallExpr) -> Option<Expr> {
    let callee = match &call.callee {
        Callee::Expr(e) => e,
        _ => return None,
    };
    let args: Vec<Expr> = call.args.iter().map(|a| (*a.expr).clone()).collect();

    match &**callee {
        // recv.method(args)
        Expr::Member(m) => {
            let method = match &m.prop {
                MemberProp::Ident(id) => id.sym.as_str(),
                _ => return None,
            };
            // Namespace statics: Math.* / Object.* / JSON.* / Array.*
            if let Expr::Ident(ns) = &*m.obj {
                // Constructs with no plain stdlib rename (Math.log2, Array.isArray…).
                if let Some(rep) = namespace_special(ns.sym.as_str(), method, &args) {
                    return Some(rep);
                }
                if let Some(g) = namespace_fn(ns.sym.as_str(), method) {
                    return Some(call_global(g, args));
                }
                // Don't fall through to method-mapping for a namespace object.
                if matches!(ns.sym.as_str(), "Math" | "JSON" | "Object" | "console" | "Array") {
                    return None;
                }
            }
            // Methods that need more than a rename (charCodeAt, sort(cmp), at…).
            if let Some(rep) = method_special(method, &m.obj, &args) {
                return Some(rep);
            }
            // `recv.method(a, b)` → method(recv, a, b)
            if let Some(g) = method_fn(method) {
                let mut all = vec![(*m.obj).clone()];
                all.extend(args);
                return Some(call_global(g, all));
            }
            None
        }
        // Number(x) / String(x) / parseInt(x) …
        Expr::Ident(id) => global_fn(id.sym.as_str()).map(|g| call_global(g, args)),
        _ => None,
    }
}

/// Namespace calls that need a constructed expression rather than a rename.
fn namespace_special(ns: &str, name: &str, args: &[Expr]) -> Option<Expr> {
    let a0 = || args.first().cloned().unwrap_or_else(|| ident_expr("undefined"));
    Some(match (ns, name) {
        // log2(x) = ln(x)/ln(2); log10(x) = ln(x)/ln(10)
        ("Math", "log2") => bin_div(call_global("ln", vec![a0()]), call_global("ln", vec![num_lit(2.0)])),
        ("Math", "log10") => bin_div(call_global("ln", vec![a0()]), call_global("ln", vec![num_lit(10.0)])),
        // Array.isArray(x) → typeOf(x) == "array"
        ("Array", "isArray") => bin_eq(call_global("typeOf", vec![a0()]), str_lit("array")),
        // Array.from(x) → a copy (prelude helper, also accepts a string)
        ("Array", "from") => call_global("__from", vec![a0()]),
        // Array.of(a, b, …) → [a, b, …]
        ("Array", "of") => array_lit(args.to_vec()),
        _ => return None,
    })
}

/// Methods that need a constructed expression rather than a receiver-first rename.
fn method_special(method: &str, recv: &Expr, args: &[Expr]) -> Option<Expr> {
    let with_recv = |g: &str| {
        let mut all = vec![recv.clone()];
        all.extend(args.iter().cloned());
        call_global(g, all)
    };
    Some(match method {
        // recv.toString() → str(recv)
        "toString" if args.is_empty() => call_global("str", vec![recv.clone()]),
        // stdlib `replace` already replaces every occurrence.
        "replaceAll" => with_recv("replace"),
        // charCodeAt(i) / codePointAt(i) → ord(charAt(recv, i))
        "charCodeAt" | "codePointAt" => {
            let i = args.first().cloned().unwrap_or_else(|| num_lit(0.0));
            call_global("ord", vec![call_global("charAt", vec![recv.clone(), i])])
        }
        // sort(cmp) needs a comparator-aware prelude sort; bare sort → stdlib.
        "sort" if !args.is_empty() => with_recv("__sortCmp"),
        // prelude-backed array helpers with no stdlib equivalent
        "at" => with_recv("__at"),
        "splice" => with_recv("__splice"),
        "flatMap" => with_recv("__flatMap"),
        "lastIndexOf" => with_recv("__lastIndexOf"),
        "findLast" => with_recv("__findLast"),
        _ => return None,
    })
}

/// `recv.<method>(…)` → `<global>(recv, …)`. Returns the global's name.
fn method_fn(name: &str) -> Option<&'static str> {
    Some(match name {
        // array (stdlib globals, receiver-first)
        "push" => "push",
        "pop" => "pop",
        "shift" => "shift",
        "unshift" => "unshift",
        "slice" => "slice",
        "concat" => "concat",
        "reverse" => "reverse",
        "sort" => "sort",
        "fill" => "fill",
        "join" => "join",
        "indexOf" => "indexOf",
        "includes" => "contains",
        // array higher-order (supplied by the prelude)
        "map" => "map",
        "filter" => "filter",
        "forEach" => "forEach",
        "reduce" => "reduce",
        "find" => "find",
        "findIndex" => "findIndex",
        "some" => "some",
        "every" => "every",
        "flat" => "flat",
        // string
        "toUpperCase" => "upper",
        "toLowerCase" => "lower",
        "trim" => "trim",
        "split" => "split",
        "substring" => "substring",
        "substr" => "substring",
        "charAt" => "charAt",
        "replace" => "replace",
        "repeat" => "repeat",
        "startsWith" => "startsWith",
        "endsWith" => "endsWith",
        "padStart" => "padStart",
        "padEnd" => "padEnd",
        _ => return None,
    })
}

/// `Math.x(…)` / `Object.x(…)` / `JSON.x(…)` → global. `Math.log` is the natural
/// log, which the stdlib spells `ln`.
fn namespace_fn(ns: &str, name: &str) -> Option<&'static str> {
    Some(match (ns, name) {
        ("Math", "floor") => "floor",
        ("Math", "ceil") => "ceil",
        ("Math", "round") => "round",
        ("Math", "trunc") => "trunc",
        ("Math", "abs") => "abs",
        ("Math", "sign") => "sign",
        ("Math", "sqrt") => "sqrt",
        ("Math", "cbrt") => "cbrt",
        ("Math", "pow") => "pow",
        ("Math", "exp") => "exp",
        ("Math", "log") => "ln",
        ("Math", "sin") => "sin",
        ("Math", "cos") => "cos",
        ("Math", "tan") => "tan",
        ("Math", "asin") => "asin",
        ("Math", "acos") => "acos",
        ("Math", "atan") => "atan",
        ("Math", "atan2") => "atan2",
        ("Math", "sinh") => "sinh",
        ("Math", "cosh") => "cosh",
        ("Math", "tanh") => "tanh",
        ("Math", "asinh") => "asinh",
        ("Math", "acosh") => "acosh",
        ("Math", "atanh") => "atanh",
        ("Math", "hypot") => "hypot",
        ("Math", "min") => "min",
        ("Math", "max") => "max",
        ("Math", "random") => "__random",
        ("Object", "keys") => "keys",
        ("Object", "values") => "values",
        ("Object", "entries") => "entries",
        ("Object", "assign") => "merge",
        ("JSON", "parse") => "jsonParse",
        ("JSON", "stringify") => "jsonStringify",
        _ => return None,
    })
}

/// Bare global constructors/coercions → stdlib equivalents.
fn global_fn(name: &str) -> Option<&'static str> {
    Some(match name {
        "Number" => "num",
        "String" => "str",
        "Boolean" => "bool",
        "parseInt" => "int",
        "parseFloat" => "num",
        _ => return None,
    })
}

/// `x === void 0` / `x == void 0` → `isNull(x)`; the `!==`/`!=` forms →
/// `!isNull(x)`. Matches `void <anything>` on either side.
fn lower_void_compare(e: &Expr) -> Option<Expr> {
    let b = match e {
        Expr::Bin(b) => b,
        _ => return None,
    };
    let negate = match b.op {
        BinaryOp::EqEq | BinaryOp::EqEqEq => false,
        BinaryOp::NotEq | BinaryOp::NotEqEq => true,
        _ => return None,
    };
    let is_void = |x: &Expr| matches!(x, Expr::Unary(u) if u.op == UnaryOp::Void);
    let other = if is_void(&b.left) {
        (*b.right).clone()
    } else if is_void(&b.right) {
        (*b.left).clone()
    } else {
        return None;
    };
    let test = call_global("isNull", vec![other]);
    Some(if negate {
        Expr::Unary(UnaryExpr { span: DUMMY_SP, op: UnaryOp::Bang, arg: Box::new(test) })
    } else {
        test
    })
}

/// Lower a template literal to a left-associated `+` chain that begins with a
/// string literal (so the VM's `+` runs in string-concatenation mode).
fn lower_template(tpl: &Tpl) -> Expr {
    let quasi = |i: usize| -> String {
        if let Some(c) = tpl.quasis[i].cooked.as_ref() {
            if let Some(s) = c.as_str() {
                return s.to_string();
            }
        }
        tpl.quasis[i].raw.to_string()
    };
    let mut acc = str_lit(&quasi(0));
    for (i, expr) in tpl.exprs.iter().enumerate() {
        acc = bin_add(acc, (**expr).clone());
        let next = quasi(i + 1);
        if !next.is_empty() {
            acc = bin_add(acc, str_lit(&next));
        }
    }
    acc
}

// ---- AST constructors -------------------------------------------------------

fn ident(name: &str) -> Ident {
    Ident::new(name.into(), DUMMY_SP, SyntaxContext::empty())
}

fn ident_expr(name: &str) -> Expr {
    Expr::Ident(ident(name))
}

fn str_lit(s: &str) -> Expr {
    Expr::Lit(Lit::Str(Str { span: DUMMY_SP, value: s.into(), raw: None }))
}

fn num_lit(n: f64) -> Expr {
    Expr::Lit(Lit::Num(Number { span: DUMMY_SP, value: n, raw: None }))
}

fn array_lit(items: Vec<Expr>) -> Expr {
    Expr::Array(ArrayLit {
        span: DUMMY_SP,
        elems: items
            .into_iter()
            .map(|e| Some(ExprOrSpread { spread: None, expr: Box::new(e) }))
            .collect(),
    })
}

fn bin(op: BinaryOp, left: Expr, right: Expr) -> Expr {
    Expr::Bin(BinExpr { span: DUMMY_SP, op, left: Box::new(left), right: Box::new(right) })
}

fn bin_add(left: Expr, right: Expr) -> Expr {
    bin(BinaryOp::Add, left, right)
}

fn bin_div(left: Expr, right: Expr) -> Expr {
    bin(BinaryOp::Div, left, right)
}

fn bin_eq(left: Expr, right: Expr) -> Expr {
    bin(BinaryOp::EqEq, left, right)
}

fn call_global(name: &str, args: Vec<Expr>) -> Expr {
    Expr::Call(CallExpr {
        span: DUMMY_SP,
        ctxt: SyntaxContext::empty(),
        callee: Callee::Expr(Box::new(ident_expr(name))),
        args: args
            .into_iter()
            .map(|e| ExprOrSpread { spread: None, expr: Box::new(e) })
            .collect(),
        type_args: None,
    })
}

/// If `pat` is a defaulted simple parameter (`b = expr`), strip the default and
/// return the guard statement `if (isNull(b)) { b = expr; }`.
fn default_guard(pat: &mut Pat) -> Option<Stmt> {
    let (name, default) = match pat {
        Pat::Assign(assign) => match &*assign.left {
            Pat::Ident(bi) => (bi.id.clone(), (*assign.right).clone()),
            _ => return None,
        },
        _ => return None,
    };
    let bare = name.clone();
    let assign = Expr::Assign(AssignExpr {
        span: DUMMY_SP,
        op: AssignOp::Assign,
        left: AssignTarget::Simple(SimpleAssignTarget::Ident(BindingIdent { id: bare.clone(), type_ann: None })),
        right: Box::new(default),
    });
    let guard = Stmt::If(IfStmt {
        span: DUMMY_SP,
        test: Box::new(call_global("isNull", vec![Expr::Ident(bare.clone())])),
        cons: Box::new(Stmt::Block(BlockStmt {
            span: DUMMY_SP,
            ctxt: SyntaxContext::empty(),
            stmts: vec![Stmt::Expr(ExprStmt { span: DUMMY_SP, expr: Box::new(assign) })],
        })),
        alt: None,
    });
    *pat = Pat::Ident(BindingIdent { id: bare, type_ann: None });
    Some(guard)
}

fn prepend_stmts(body: &mut Vec<Stmt>, mut guards: Vec<Stmt>) {
    if guards.is_empty() {
        return;
    }
    guards.append(body);
    *body = guards;
}

fn const_binding(name: &str, init: Expr) -> ModuleItem {
    ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(VarDecl {
        span: DUMMY_SP,
        ctxt: SyntaxContext::empty(),
        kind: VarDeclKind::Const,
        declare: false,
        decls: vec![VarDeclarator {
            span: DUMMY_SP,
            name: Pat::Ident(BindingIdent { id: ident(name), type_ann: None }),
            init: Some(Box::new(init)),
            definite: false,
        }],
    }))))
}
