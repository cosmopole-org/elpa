use elpa_runtime::{ClosureNet, EnvToggles, HostEnv, NetResponse};
use elpa_protocol::HostCall;

// A real TrueType font used to stand in for the runtime's *downloaded* default
// font (the runtime no longer bundles one — it fetches it through the host's
// `NetProvider`). These tests serve the fixture instead of hitting the network.
const FIXTURE_TTF: &[u8] = include_bytes!("fonts/LiberationSans-Regular.ttf");

/// A `HostEnv` whose network provider serves the fixture font for any request, so
/// `text.atlas` can resolve the default font offline (as it would download it).
fn env_with_default_font() -> HostEnv {
    let mut env = HostEnv::default();
    env.set_toggles(EnvToggles::all_on());
    env.set_net(Box::new(ClosureNet(|_r| {
        Ok(NetResponse { status: 200, body: String::new(), bytes: Some(FIXTURE_TTF.to_vec()) })
    })));
    env
}

#[test]
fn atlas_builds() {
    // With no font bundled, the default atlas is built from the font the runtime
    // downloads through the network provider.
    let mut env = env_with_default_font();
    let call = HostCall { machine_id: "m".into(), api_name: "text.atlas".into(), payload: r#"[{"size":44}]"#.into() };
    let reply = env.service(&call).expect("text family handled");
    let v: serde_json::Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(v["ok"], serde_json::json!(true));
    assert_eq!(v["source"], serde_json::json!("default"), "the default font is the downloaded one");
    let w = v["width"].as_u64().unwrap();
    let h = v["height"].as_u64().unwrap();
    let dlen = v["data"].as_str().unwrap().len();
    let nreg = v["regular"].as_object().unwrap().len();
    let nbold = v["bold"].as_object().unwrap().len();
    let ga = &v["regular"]["A"];
    println!("atlas {}x{} b64len={} reg_glyphs={} bold_glyphs={} A={:?}", w, h, dlen, nreg, nbold, ga);
    assert!(w == 512 && h >= 64);
    assert!(nreg == 95 && nbold == 95);
    assert!(ga["adv"].as_f64().unwrap() > 0.0);
}

#[test]
fn atlas_without_network_reports_no_font() {
    // No network provisioned and no source → no font to rasterise. The call must
    // not trap; it returns an error reply so the caller can fall back to its own
    // vector text.
    let mut env = HostEnv::default(); // network off by default, no provider
    let call = HostCall { machine_id: "m".into(), api_name: "text.atlas".into(), payload: r#"[{"size":44}]"#.into() };
    let reply = env.service(&call).expect("text family handled");
    let v: serde_json::Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(v["ok"], serde_json::json!(false), "no font available without a network provider");
}

#[test]
fn atlas_source_path_and_url() {
    const TTF: &[u8] = include_bytes!("fonts/LiberationSans-Bold.ttf");
    let mut env = HostEnv::default();
    env.set_toggles(EnvToggles::all_on());
    env.fs_mut().write("/f.ttf", TTF).unwrap();
    let pcall = HostCall { machine_id: "m".into(), api_name: "text.atlas".into(), payload: r#"[{"size":44,"path":"/f.ttf"}]"#.into() };
    let pr: serde_json::Value = serde_json::from_str(&env.service(&pcall).unwrap()).unwrap();
    assert_eq!(pr["source"], serde_json::json!("path:/f.ttf"));
    println!("PATH source={:?}", pr["source"]);
    env.set_net(Box::new(ClosureNet(|_r| Ok(NetResponse{status:200, body:String::new(), bytes: Some(TTF.to_vec())}))));
    let ucall = HostCall { machine_id: "m".into(), api_name: "text.atlas".into(), payload: r#"[{"size":44,"url":"https://x/f.ttf"}]"#.into() };
    let ur: serde_json::Value = serde_json::from_str(&env.service(&ucall).unwrap()).unwrap();
    assert_eq!(ur["source"], serde_json::json!("url:https://x/f.ttf"));
    println!("URL source={:?}", ur["source"]);
}
