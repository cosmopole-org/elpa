use elpa_runtime::HostEnv;
use elpa_protocol::HostCall;

#[test]
fn atlas_builds() {
    let mut env = HostEnv::default();
    let call = HostCall { machine_id: "m".into(), api_name: "text.atlas".into(), payload: r#"[{"size":44}]"#.into() };
    let reply = env.service(&call).expect("text family handled");
    let v: serde_json::Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(v["ok"], serde_json::json!(true));
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
fn atlas_source_path_and_url() {
    use elpa_runtime::{EnvToggles, ClosureNet, NetResponse};
    const TTF: &[u8] = include_bytes!("../assets/fonts/LiberationSans-Bold.ttf");
    let mut env = HostEnv::default();
    env.set_toggles(EnvToggles::all_on());
    env.fs_mut().write("/f.ttf", TTF).unwrap();
    let pcall = HostCall { machine_id: "m".into(), api_name: "text.atlas".into(), payload: r#"[{"size":44,"path":"/f.ttf"}]"#.into() };
    let pr: serde_json::Value = serde_json::from_str(&env.service(&pcall).unwrap()).unwrap();
    println!("PATH source={:?}", pr["source"]);
    env.set_net(Box::new(ClosureNet(|_r| Ok(NetResponse{status:200, body:String::new(), bytes: Some(TTF.to_vec())}))));
    let ucall = HostCall { machine_id: "m".into(), api_name: "text.atlas".into(), payload: r#"[{"size":44,"url":"https://x/f.ttf"}]"#.into() };
    let ur: serde_json::Value = serde_json::from_str(&env.service(&ucall).unwrap()).unwrap();
    println!("URL source={:?}", ur["source"]);
}
