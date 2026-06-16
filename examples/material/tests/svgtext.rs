use elpa::protocol::ResourceDesc;
use elpa::{Elpa, HeadlessBackend, SurfaceInfo};

fn inst(app: &Elpa<HeadlessBackend>) -> Vec<f32> {
    let f = app.last_frame().unwrap();
    // The layered SDK buckets geometry into per-scope snapshot buffers; aggregate
    // them (z-order) into the full instance stream the assertions expect.
    let mut out = Vec::new();
    for scope in ["body", "chrome", "drawer", "overlay", "root"] {
        let id = format!("elpa.layer.{scope}.inst");
        if let Some(d) = f.resources.iter().find_map(|r| match r {
            ResourceDesc::Buffer(b) if b.id == id => b.data_f32.clone(),
            _ => None,
        }) {
            out.extend(d);
        }
    }
    out
}

fn run(app_js: &str) -> Elpa<HeadlessBackend> {
    let prog = format!("{}\n{}", elpa_material::MODULE_JS, app_js);
    let mut a = Elpa::new_from_js(HeadlessBackend::default(), SurfaceInfo::new(800,800,1.0), &prog)
        .expect("compiles");
    a.start();
    a
}

#[test]
fn svg_icon_and_text_styles_render() {
    // An SVG path stroked icon + text with explicit weight and pixel size.
    let app = run(r#"
        registerIcon("bolt", "M13 2 L4 14 L11 14 L9 22 L20 9 L13 9 Z", 24.0);
        let App = defineComponent(function(props, update) {
            return Scaffold({
                appBar: AppBar({ title: "SVG" }),
                body: Column({ gap: 3.0, children: [
                    Icon({ svg: "M4 12 L10 18 L20 6", size: 12.0 }),
                    Icon({ icon: "bolt", size: 12.0 }),
                    Text("Bold 20px", { px: 20.0, weight: "bold" }),
                    Text("LIGHT", { size: "title", weight: "light" }),
                ] }),
            });
        });
        runApp(App);
    "#);
    assert!(app.trap_reason().is_none(), "no trap: {:?}", app.trap_reason());
    let n = inst(&app).len() / 16;
    println!("instances={}", n);
    assert!(n > 20, "svg path + styled text emitted instances (got {n})");
}
