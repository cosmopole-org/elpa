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
