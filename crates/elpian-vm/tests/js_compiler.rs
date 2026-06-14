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
    // Exercises the full `ifStmt` / `elseifStmt` / `elseStmt` lowering with a
    // `return` inside each branch (early return out of the function).
    let js = "function classify(n) {
        if (n > 10) { return 1; }
        else if (n > 5) { return 2; }
        else { return 3; }
    }";
    let id = "js-if";
    assert!(api::create_vm_from_js(id.to_string(), js.to_string()));
    let _ = api::execute_vm(id.to_string());
    let call = |n: i64| {
        api::execute_vm_func_with_input(id.to_string(), "classify".into(), n.to_string(), 1)
            .result_value
    };
    assert_eq!(call(7), "2");
    assert_eq!(call(20), "1");
    assert_eq!(call(1), "3");
}

#[test]
fn early_return_skips_rest_of_body() {
    // The statement after the taken branch's return must not run.
    let js = "function f(n) {
        if (n > 0) { return 1; }
        return 2;
    }";
    let id = "js-early-return";
    assert!(api::create_vm_from_js(id.to_string(), js.to_string()));
    let _ = api::execute_vm(id.to_string());
    let call = |n: i64| {
        api::execute_vm_func_with_input(id.to_string(), "f".into(), n.to_string(), 1).result_value
    };
    assert_eq!(call(5), "1");
    assert_eq!(call(-5), "2");
}

#[test]
fn return_from_inside_loop() {
    // Return out of a while loop: find the first i whose square reaches 10.
    let js = "function firstBig() {
        let i = 0;
        while (i < 100) {
            if (i * i >= 10) { return i; }
            i = i + 1;
        }
        return -1;
    }";
    assert_eq!(run_js_and_call("js-ret-loop", js, "firstBig"), "4");
}

#[test]
fn guard_clause_in_called_function() {
    // An in-program call whose result comes from a guard-clause return nested in
    // an `if`, consumed by the caller's own expression.
    let js = "function pick(n) {
        if (n > 0) { return 100; }
        return 200;
    }
    function f() { return pick(5) + pick(-5); }";
    assert_eq!(run_js_and_call("js-guard", js, "f"), "300");
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
fn recursion_with_guard_clause() {
    // Recursive factorial: a base-case `return` nested in an `if`, plus a
    // recursive in-program call inside an arithmetic expression. Exercises the
    // return-unwinding across many stacked call frames.
    let js = "function fact(n) {
        if (n <= 1) { return 1; }
        return n * fact(n - 1);
    }
    function f() { return fact(5); }";
    assert_eq!(run_js_and_call("js-fact", js, "f"), "120");
}

#[test]
fn switch_with_returns() {
    // Return out of a switch case; execution after the switch is reached only
    // when no case matched.
    let js = "function classify(n) {
        switch (n) {
            case 1: return 10;
            case 2: return 20;
        }
        return 0;
    }";
    let id = "js-switch";
    assert!(api::create_vm_from_js(id.to_string(), js.to_string()));
    let _ = api::execute_vm(id.to_string());
    let call = |n: i64| {
        api::execute_vm_func_with_input(id.to_string(), "classify".into(), n.to_string(), 1)
            .result_value
    };
    assert_eq!(call(1), "10");
    assert_eq!(call(2), "20");
    assert_eq!(call(3), "0");
}

#[test]
fn function_without_return_does_not_leak_previous_result() {
    // A function with an explicit return followed by one without a return: the
    // second must not inherit the first's value (no stale pending result).
    let js = "function getfive() { return 5; } function noret() { let x = 1; }";
    let id = "js-noleak";
    assert!(api::create_vm_from_js(id.to_string(), js.to_string()));
    let _ = api::execute_vm(id.to_string());
    assert_eq!(api::execute_vm_func(id.to_string(), "getfive".into(), 1).result_value, "5");
    let noret = api::execute_vm_func(id.to_string(), "noret".into(), 2).result_value;
    assert_ne!(noret, "5", "no-return function leaked the previous result");
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
