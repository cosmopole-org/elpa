//! End-to-end tests for the instance-governance and environmental-interface
//! layer, driven through the real `Elpa` instance: the fabricated filesystem,
//! capability gating, resource limits, and pause / terminate — exercised over
//! the full VM → runtime → host-environment stack.

use elpa::headless::HeadlessBackend;
use elpa::{Capability, Elpa, ResourceLimits, RunState, SurfaceInfo};
use serde_json::{json, Value};

fn strv(s: &str) -> Value {
    json!({ "type": "string", "data": { "value": s } })
}
fn ident(n: &str) -> Value {
    json!({ "type": "identifier", "data": { "name": n } })
}
fn obj(map: Value) -> Value {
    json!({ "type": "object", "data": { "value": map } })
}
fn def(name: &str, value: Value) -> Value {
    json!({ "type": "definition", "data": { "leftSide": ident(name), "rightSide": value } })
}
fn host_call(name: &str, args: Vec<Value>) -> Value {
    json!({ "type": "host_call", "data": { "name": name, "args": args } })
}
fn assign(name: &str, value: Value) -> Value {
    json!({ "type": "assignment", "data": { "leftSide": ident(name), "rightSide": value } })
}
fn i64v(n: i64) -> Value {
    json!({ "type": "i64", "data": { "value": n } })
}
fn arith(op: &str, a: Value, b: Value) -> Value {
    json!({ "type": "arithmetic", "data": { "operation": op, "operand1": a, "operand2": b } })
}
fn program(body: Vec<Value>) -> String {
    json!({ "type": "program", "body": body }).to_string()
}

fn instance(ast: &str) -> Elpa<HeadlessBackend> {
    Elpa::new(HeadlessBackend::default(), SurfaceInfo::new(64, 64, 1.0), ast).expect("compiles")
}

#[test]
fn fabricated_filesystem_persists_and_reads_back() {
    // App: write a file, read it back, and log the reply so the test can see it.
    let ast = program(vec![
        host_call("fs.write", vec![obj(json!({ "path": strv("/save.txt"), "data": strv("hello-fs") }))]),
        def("content", host_call("fs.read", vec![obj(json!({ "path": strv("/save.txt") }))])),
        host_call("log", vec![ident("content")]),
    ]);
    let mut app = instance(&ast);
    app.start();
    let log = app.take_log();
    assert!(log.iter().any(|l| l.contains("hello-fs")), "read-back logged: {log:?}");
    // And the host-side store really holds it.
    assert!(app.env().fs().exists("/save.txt"));
}

#[test]
fn revoking_storage_capability_short_circuits_fs_calls() {
    let ast = program(vec![
        host_call("fs.write", vec![obj(json!({ "path": strv("/x.txt"), "data": strv("data") }))]),
        def("content", host_call("fs.read", vec![obj(json!({ "path": strv("/x.txt") }))])),
        host_call("log", vec![ident("content")]),
    ]);
    let mut app = instance(&ast);
    // Turn the storage capability off at the VM level: the fs.* calls never even
    // reach the host environment — they resolve to null inside the VM.
    app.set_capability(Capability::Storage, false);
    app.start();
    let log = app.take_log();
    assert!(log.iter().any(|l| l.contains("undefined") || l.contains("null") || l == "null"),
        "gated read should be null: {log:?}");
    assert!(!app.env().fs().exists("/x.txt"), "nothing was written to the host store");
}

#[test]
fn instruction_limit_terminates_a_runaway_app() {
    let loop_stmt = json!({ "type": "loopStmt", "data": {
        "condition": arith("<", ident("i"), i64v(100_000_000)),
        "body": [ assign("i", arith("+", ident("i"), i64v(1))) ]
    }});
    let ast = program(vec![def("i", i64v(0)), loop_stmt]);
    let app = instance(&ast);
    app.set_limits(ResourceLimits { max_instructions: Some(5000), ..ResourceLimits::unlimited() });
    // Re-borrow mutably to start (set_limits took &self).
    let mut app = app;
    app.start();
    assert_eq!(app.run_state(), Some(RunState::Terminated));
    assert!(app.trap_reason().unwrap().contains("instructions"));
    assert!(app.usage().unwrap().instructions <= 5000);
}

#[test]
fn terminate_makes_app_inert() {
    let ast = program(vec![host_call("log", vec![strv("ran")])]);
    let mut app = instance(&ast);
    app.start();
    assert!(app.take_log().iter().any(|l| l.contains("ran")));

    assert!(app.terminate());
    assert_eq!(app.run_state(), Some(RunState::Terminated));
    // A subsequent drive does nothing (the log stays empty).
    app.send_event(&elpa::InputEvent::PointerDown { x: 0.0, y: 0.0, button: 0 });
    assert!(app.take_log().is_empty(), "terminated app produced no further effects");
}

#[test]
fn network_is_denied_until_provisioned() {
    let ast = program(vec![
        def("r", host_call("net.fetch", vec![obj(json!({ "url": strv("https://x/y") }))])),
        host_call("log", vec![ident("r")]),
    ]);
    let mut app = instance(&ast);
    // Network capability is on at the VM level so the call reaches the host, but
    // the host environment must be toggled on AND given a provider.
    app.set_capability(Capability::Network, true);
    app.env_mut().set_family("net", true);
    app.env_mut().set_net(Box::new(elpa::ClosureNet(|req: &elpa::NetRequest| {
        Ok(elpa::NetResponse { status: 200, body: format!("body-of-{}", req.url), bytes: None })
    })));
    app.start();
    let log = app.take_log();
    assert!(log.iter().any(|l| l.contains("body-of-https://x/y")), "fetched via provider: {log:?}");
}
