use elpian_vm::api;
fn run(id: &str, js: &str) -> String {
    if !api::create_vm_from_js(id.to_string(), js.to_string()) { return "COMPILE_FAIL".into(); }
    let _ = api::execute_vm(id.to_string());
    api::execute_vm_func(id.to_string(), "f".to_string(), 1).result_value
}
#[test]
fn p() {
    for (id, js) in [
        ("not_zero","function f(){ if (!0) { return 1; } return 0; }"),
        ("not_obj","function f(){ let o={x:1}; if (!o) { return 1; } return 0; }"),
        ("do_while","function f(){ let i=0; do { i=i+1; } while(i<3); return i; }"),
        ("strict_eq","function f(){ if (1 === 1) { return 9; } return 0; }"),
        ("strict_ne","function f(){ if (1 !== 2) { return 9; } return 0; }"),
        ("neg","function f(){ let x = -5; return x; }"),
        ("mod","function f(){ return 17 % 5; }"),
        ("ternary_nest","function f(){ let x=2; return x>1 ? (x>3?3:2) : 1; }"),
    ] { println!("{id} => {}", run(id, js)); }
}
