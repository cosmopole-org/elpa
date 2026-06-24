use elpa::{Elpa, HeadlessBackend, SurfaceInfo};
#[test]
fn bytecode_runs() {
    let bc = include_bytes!("../assets/demo.bc");
    let mut app = Elpa::new_from_bytecode(HeadlessBackend::default(), SurfaceInfo::new(1000,800,1.0), bc.to_vec()).expect("bytecode loads");
    app.start();
    assert!(app.trap_reason().is_none(), "no trap: {:?}", app.trap_reason());
    assert!(app.last_stats().presented, "frame presented from bytecode");
}
