use elpa::{Elpa, HeadlessBackend, SurfaceInfo};
#[test]
fn bytecode_runs() {
    let bc = include_bytes!("../assets/demo.bc");
    let mut app = Elpa::new_from_bytecode(HeadlessBackend::default(), SurfaceInfo::new(1000,800,1.0), bc.to_vec()).expect("bytecode loads");
    app.start();
    assert!(app.trap_reason().is_none(), "no trap: {:?}", app.trap_reason());
    // The kit paints through the Vello scene path, so the first scene presents.
    assert!(app.last_scene_stats().presented, "scene presented from bytecode");
    assert!(app.last_scene().is_some(), "a Vello scene was submitted from bytecode");
}
