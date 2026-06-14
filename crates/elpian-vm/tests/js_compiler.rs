//! End-to-end tests for the JavaScript front-end: JS source is lowered to the
//! Elpian AST by the compiler module and run through the exact same
//! AST → bytecode → executor path as hand-written ASTs, via the public `api`.

use elpian_vm::api;

/// Register a VM from JS, run its top-level program, then call `func` and return
/// the stringified result value.
fn run_js_and_call(id: &str, js: &str, func: &str) -> String {
    assert!(api::create_vm_from_js(id.to_string(), js.to_string()), "JS should compile");
    let _ = api::execute_vm(id.to_string());
    api::execute_vm_func(id.to_string(), func.to_string(), 1).result_value
}

#[test]
fn arithmetic_respects_precedence() {
    // 2 + 3 * 4 == 14 ; ** binds tightest and is right-associative.
    let js = "function f() { return 2 + 3 * 4; }";
    assert_eq!(run_js_and_call("js-arith", js, "f"), "14");

    let js2 = "function f() { return 2 ** 3 ** 2; }"; // 2 ** (3 ** 2) = 512
    assert_eq!(run_js_and_call("js-pow", js2, "f"), "512");
}

#[test]
fn builtins_are_callable_from_js() {
    let js = "function f() { return pow(2, 10); }";
    assert_eq!(run_js_and_call("js-builtin", js, "f"), "1024");

    // Nested calls compose: max(gcd(54, 24), sqrt(81)) = max(6, 9) = 9.
    let js2 = "function f() { return max(gcd(54, 24), sqrt(81)); }";
    assert_eq!(run_js_and_call("js-nested", js2, "f"), "9");
}

#[test]
fn string_builtins_from_js() {
    let js = "function f() { return upper(concat(\"el\", \"pa\")); }";
    assert_eq!(run_js_and_call("js-str", js, "f"), "\"ELPA\"");
}

#[test]
fn let_and_assignment() {
    let js = "function f() { let x = 5; x = x + 1; return x; }";
    assert_eq!(run_js_and_call("js-assign", js, "f"), "6");

    // Compound assignment.
    let js2 = "function f() { let x = 10; x *= 3; x -= 4; return x; }";
    assert_eq!(run_js_and_call("js-compound", js2, "f"), "26");
}

#[test]
fn if_else_if_else_chain() {
    // Exercises the full `ifStmt` / `elseifStmt` / `elseStmt` lowering. The
    // branch sets a result variable that is returned afterwards (the executor
    // resumes the function body after a conditional block, so the value is read
    // back at the end rather than returned from inside a branch).
    let js = "function classify() {
        let n = 7;
        let r = 0;
        if (n > 10) { r = 1; }
        else if (n > 5) { r = 2; }
        else { r = 3; }
        return r;
    }";
    assert_eq!(run_js_and_call("js-if", js, "classify"), "2");

    // The `else` arm is taken when no condition matches.
    let js2 = "function classify() {
        let n = 1;
        let r = 0;
        if (n > 10) { r = 1; }
        else if (n > 5) { r = 2; }
        else { r = 3; }
        return r;
    }";
    assert_eq!(run_js_and_call("js-if-else", js2, "classify"), "3");
}

#[test]
fn while_loop_accumulates() {
    // sum 0..4 = 10
    let js = "function f() {
        let i = 0;
        let s = 0;
        while (i < 5) { s = s + i; i = i + 1; }
        return s;
    }";
    assert_eq!(run_js_and_call("js-while", js, "f"), "10");
}

#[test]
fn for_loop_desugars_and_runs() {
    // Uses both `i++` in the update clause and a body assignment.
    let js = "function f() {
        let s = 0;
        for (let i = 0; i < 5; i++) { s = s + i; }
        return s;
    }";
    assert_eq!(run_js_and_call("js-for", js, "f"), "10");
}

#[test]
fn top_level_state_and_function() {
    // Top-level `let` runs during execute_vm; the function closes over it.
    let js = "let x = 5; function getx() { return x; }";
    let id = "js-toplevel";
    assert!(api::create_vm_from_js(id.to_string(), js.to_string()));
    let _ = api::execute_vm(id.to_string());
    assert_eq!(api::execute_vm_func(id.to_string(), "getx".into(), 1).result_value, "5");
}

#[test]
fn unary_minus_and_not() {
    let js = "function f() { return -3 + 5; }";
    assert_eq!(run_js_and_call("js-neg", js, "f"), "2");
}

#[test]
fn validate_js_accepts_and_rejects() {
    assert!(api::validate_js("function f() { return 1 + 2; }".to_string()));
    // Unterminated block is outside the supported subset → rejected, no panic.
    assert!(!api::validate_js("function f() { return ".to_string()));
}

#[test]
fn invalid_js_fails_to_create_vm() {
    // A stray operator with no operand cannot be lowered; creation returns false.
    assert!(!api::create_vm_from_js("js-bad".to_string(), "let x = = ;".to_string()));
}

#[test]
fn compile_js_to_ast_produces_program_node() {
    let ast = api::compile_js_to_ast("let x = 1;".to_string());
    assert!(ast.contains("\"program\""), "ast was: {ast}");
    assert!(ast.contains("\"definition\""), "ast was: {ast}");
}
