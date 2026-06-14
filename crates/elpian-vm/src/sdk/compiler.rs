use std::{cell::RefCell, collections::HashMap, rc::Rc};

use serde_json::{json, Value};

// #[wasm_bindgen]
// extern "C" {
//     #[wasm_bindgen(js_namespace = console)]
//     fn log(s: &str);

//     #[wasm_bindgen(js_namespace = console, js_name = log)]
//     fn log_u32(a: u32);

//     #[wasm_bindgen(js_namespace = console, js_name = log)]
//     fn log_many(a: &str, b: &str);
// }

fn log(s: &str) {
    println!("{}", s);
}

fn serialize_expr(val: serde_json::Value) -> Vec<u8> {
    // log(&val.to_string());
    let mut result: Vec<u8> = vec![];
    match val["type"].as_str().unwrap() {
        "i16" => {
            result.push(1);
            result.append(
                &mut i16::to_be_bytes(val["data"]["value"].as_i64().unwrap() as i16).to_vec(),
            );
        }
        "i32" => {
            result.push(2);
            result.append(
                &mut i32::to_be_bytes(val["data"]["value"].as_i64().unwrap() as i32).to_vec(),
            );
        }
        "i64" => {
            result.push(3);
            result.append(
                &mut i64::to_be_bytes(val["data"]["value"].as_i64().unwrap() as i64).to_vec(),
            );
        }
        "f32" => {
            result.push(4);
            result.append(
                &mut f32::to_be_bytes(val["data"]["value"].as_f64().unwrap() as f32).to_vec(),
            );
        }
        "f64" => {
            result.push(5);
            result.append(
                &mut f64::to_be_bytes(val["data"]["value"].as_f64().unwrap() as f64).to_vec(),
            );
        }
        "bool" => {
            result.push(6);
            result.push(if val["data"]["value"].as_bool().unwrap() {
                0x01
            } else {
                0x00
            });
        }
        "string" => {
            result.push(7);
            let mut value_bytes = val["data"]["value"].as_str().unwrap().as_bytes().to_vec();
            result.append(&mut i32::to_be_bytes(value_bytes.len() as i32).to_vec());
            result.append(&mut value_bytes);
        }
        "identifier" => {
            result.push(0x0b);
            let mut value_bytes = val["data"]["name"].as_str().unwrap().as_bytes().to_vec();
            result.append(&mut i32::to_be_bytes(value_bytes.len() as i32).to_vec());
            result.append(&mut value_bytes);
        }
        "indexer" => {
            result.push(0x0c);
            result.append(&mut serialize_expr(val["data"]["target"].clone()));
            result.append(&mut serialize_expr(val["data"]["index"].clone()));
        }
        "cast" => {
            result.push(0xfd);
            result.append(&mut serialize_expr(val["data"]["value"].clone()));
            let mut tt_bytes = val["data"]["targetType"]
                .as_str()
                .unwrap()
                .as_bytes()
                .to_vec();
            result.append(&mut i32::to_be_bytes(tt_bytes.len() as i32).to_vec());
            result.append(&mut tt_bytes);
        }
        "object" => {
            result.push(8);
            result.append(&mut i64::to_be_bytes(-2).to_vec());
            result.append(&mut i32::to_be_bytes(val["data"]["value"].as_object().unwrap().iter().len() as i32).to_vec());
            for (k, v) in val["data"]["value"].as_object().unwrap().iter() {
                result.push(7);
                let mut key_bytes = k.as_bytes().to_vec();
                result.append(&mut i32::to_be_bytes(key_bytes.len() as i32).to_vec());
                result.append(&mut key_bytes);
                result.append(&mut serialize_expr(v.clone()));
            }
        }
        "array" => {
            result.push(9);
            result.append(
                &mut i32::to_be_bytes(val["data"]["value"].as_array().unwrap().iter().len() as i32)
                    .to_vec(),
            );
            for v in val["data"]["value"].as_array().unwrap().iter() {
                result.append(&mut serialize_expr(v.clone()));
            }
        }
        "callback" => {
            result.append(&mut serialize_expr(val["data"]["value"]["funcId"].clone()));
        }
        "not" => {
            result.push(0xfc);
            result.append(&mut serialize_expr(val["data"]["value"].clone()));
        }
        "arithmetic" => {
            match val["data"]["operation"].as_str().unwrap() {
                "==" => {
                    result.push(0xf0);
                }
                ">" => {
                    result.push(0xf1);
                }
                ">=" => {
                    result.push(0xf2);
                }
                "<" => {
                    result.push(0xf3);
                }
                "<=" => {
                    result.push(0xf4);
                }
                "!=" => {
                    result.push(0xf5);
                }
                "+" => {
                    result.push(0xf6);
                }
                "-" => {
                    result.push(0xf7);
                }
                "*" => {
                    result.push(0xf8);
                }
                "/" => {
                    result.push(0xf9);
                }
                "%" => {
                    result.push(0xfa);
                }
                "^" => {
                    result.push(0xfb);
                }
                _ => {}
            };
            result.append(&mut serialize_expr(val["data"]["operand1"].clone()));
            result.append(&mut serialize_expr(val["data"]["operand2"].clone()));
        }
        "functionCall" => {
            result.push(0x0d);
            result.append(&mut serialize_expr(val["data"]["callee"].clone()));
            result.append(
                &mut i32::to_be_bytes(val["data"]["args"].as_array().unwrap().len() as i32)
                    .to_vec(),
            );
            val["data"]["args"]
                .as_array()
                .unwrap()
                .iter()
                .for_each(|arg| {
                    result.append(&mut serialize_expr(arg.clone()));
                });
        }
        "host_call" => {
            result.push(0x0d);
            result.append(&mut serialize_expr(json!(
                {
                    "type": "identifier",
                    "data": {
                        "name": "askHost",
                    }
                }
            )));
            result.append(&mut i32::to_be_bytes(2).to_vec());
            result.append(&mut serialize_expr(json!(
                {
                    "type": "string",
                    "data": {
                        "value": val["data"]["name"].as_str().unwrap().to_string(),
                    }
                }
            )));
            let args = val["data"]["args"].as_array().unwrap().clone();
            let input = json!({
                "type": "array",
                "data": {
                    "value": args
                },
            });
            result.append(&mut serialize_expr(input.clone()));
        }
        _ => {
            panic!("unknown val type");
        }
    }
    result
}

fn serialize_condition_chain(
    operation: Value,
    is_conditioned: bool,
    start_point: usize,
) -> (Vec<u8>, Vec<usize>) {
    let mut result: Vec<u8> = vec![];
    let mut baps: Vec<usize> = vec![];
    result.push(0x10);
    if is_conditioned {
        result.push(0x01);
        result.append(&mut serialize_expr(operation["data"]["condition"].clone()).to_vec());
    } else {
        result.push(0x00);
    }
    let body_start = if is_conditioned {
        start_point + result.len() + 8 + 8 + 8 + 8
    } else {
        start_point + result.len() + 8 + 8 + 8
    };
    let body = compile_ast(operation["data"].clone(), body_start);
    let body_end = body_start + body.len();
    result.append(&mut i64::to_be_bytes(body_start as i64).to_vec());
    result.append(&mut i64::to_be_bytes(body_end as i64).to_vec());
    let mut after_body: Vec<u8> = vec![];
    if let Some(elseif_stmt) = operation["data"].get("elseifStmt") {
        let (mut compiled_body, mut branch_after_points) =
            serialize_condition_chain(elseif_stmt.clone(), true, body_end);
        after_body.append(&mut compiled_body);
        baps.append(&mut branch_after_points);
    } else if let Some(else_stmt) = operation["data"].get("elseStmt") {
        let (mut compiled_body, mut branch_after_points) =
            serialize_condition_chain(else_stmt.clone(), false, body_end);
        after_body.append(&mut compiled_body);
        baps.append(&mut branch_after_points);
    }
    if is_conditioned {
        result.append(&mut i64::to_be_bytes(body_end as i64).to_vec());
    }
    baps.push(start_point + result.len());
    result.append(&mut vec![0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    result.append(&mut body.clone());
    result.append(&mut after_body);
    (result, baps)
}

pub fn compile_ast(program: serde_json::Value, start_point: usize) -> Vec<u8> {
    let mut result: Vec<u8> = vec![];
    let mut op_counter: i64 = 1;
    let mut step_start_map: HashMap<i64, usize> = HashMap::new();
    let mut reserved_branch_map: HashMap<i64, Vec<usize>> = HashMap::new();
    for operation in program["body"].as_array().unwrap().iter() {
        step_start_map
            .entry(op_counter)
            .or_insert(start_point + result.len());
        match operation["type"].as_str().unwrap() {
            "jumpOperation" => {
                result.push(0x15);
                let true_branch = result.len();
                result.extend_from_slice(&[0u8; 8]);
                let true_step = operation["data"]["stepNumber"].as_i64().unwrap();
                reserved_branch_map
                    .entry(true_step)
                    .or_default()
                    .push(true_branch);
            }
            "conditionalBranch" => {
                result.push(0x16);
                result.append(&mut serialize_expr(operation["data"]["condition"].clone()));
                let true_branch = result.len();
                result.extend_from_slice(&[0u8; 8]);
                let false_branch = result.len();
                result.extend_from_slice(&[0u8; 8]);
                let true_step = operation["data"]["trueBranch"].as_i64().unwrap();
                let false_step = operation["data"]["falseBranch"].as_i64().unwrap();
                reserved_branch_map
                    .entry(true_step)
                    .or_default()
                    .push(true_branch);
                reserved_branch_map
                    .entry(false_step)
                    .or_default()
                    .push(false_branch);
            }
            "host_call" => {
                result.push(0x0d);
                result.append(&mut serialize_expr(json!(
                    {
                        "type": "identifier",
                        "data": {
                            "name": "askHost",
                        }
                    }
                )));
                result.append(&mut i32::to_be_bytes(2).to_vec());
                result.append(&mut serialize_expr(json!(
                    {
                        "type": "string",
                        "data": {
                            "value": operation["data"]["name"].as_str().unwrap().to_string(),
                        }
                    }
                )));
                let args = operation["data"]["args"].as_array().unwrap().clone();
                let input = json!({
                    "type": "array",
                    "data": {
                        "value": args
                    },
                });
                result.append(&mut serialize_expr(input.clone()));
            }
            "returnOperation" => {
                result.push(0x14);
                result.append(&mut serialize_expr(operation["data"]["value"].clone()).to_vec());
            }
            "ifStmt" => {
                let (mut compiled_code, baps) =
                    serialize_condition_chain(operation.clone(), true, start_point + result.len());
                let branch_after =
                    i64::to_be_bytes((start_point + result.len() + compiled_code.len()) as i64)
                        .to_vec();
                for bap in baps.iter() {
                    let s = *bap - start_point - result.len();
                    let e = *bap + 8 - start_point - result.len();
                    compiled_code[s..e].copy_from_slice(branch_after.as_slice());
                }
                result.append(&mut compiled_code);
            }
            "loopStmt" => {
                let loop_start = start_point + result.len();
                result.push(0x11);
                result.append(&mut serialize_expr(operation["data"]["condition"].clone()).to_vec());
                let body_start = start_point + result.len() + 8 + 8 + 8;
                let mut body = compile_ast(operation["data"].clone(), body_start);
                body.push(0x15);
                body.append(&mut i64::to_be_bytes(loop_start as i64).to_vec());
                let body_end = body_start + body.len();
                result.append(&mut i64::to_be_bytes(body_start as i64).to_vec());
                result.append(&mut i64::to_be_bytes(body_end as i64).to_vec());
                result.append(&mut i64::to_be_bytes(body_end as i64).to_vec());
                result.append(&mut body.clone());
            }
            "switchStmt" => {
                result.push(0x12);
                result.append(&mut serialize_expr(operation["data"]["value"].clone()).to_vec());
                let mut inner: Vec<u8> = vec![];
                for case_val in operation["data"]["cases"].as_array().unwrap().iter() {
                    inner.append(&mut serialize_expr(case_val["value"].clone()));
                    let body_start = start_point + result.len() + 8 + 8 + inner.len() + 8 + 8;
                    let mut body: Vec<u8> = compile_ast(case_val["body"].clone(), body_start);
                    let body_end = body_start + body.len();
                    inner.append(&mut i64::to_be_bytes(body_start as i64).to_vec());
                    inner.append(&mut i64::to_be_bytes(body_end as i64).to_vec());
                    inner.append(&mut body);
                }
                result.append(
                    &mut i64::to_be_bytes(
                        (start_point + result.len() + inner.len() + 8 + 8) as i64,
                    )
                    .to_vec(),
                );
                result.append(
                    &mut i64::to_be_bytes(
                        operation["data"]["cases"].as_array().unwrap().len() as i64
                    )
                    .to_vec(),
                );
                result.append(&mut inner);
            }
            "functionDefinition" => {
                result.push(0x13);
                let mut str_bytes = operation["data"]["name"]
                    .as_str()
                    .unwrap()
                    .as_bytes()
                    .to_vec();
                let mut len_bytes = i32::to_be_bytes(str_bytes.len() as i32).to_vec();
                result.append(&mut len_bytes);
                result.append(&mut str_bytes);
                result.append(
                    &mut i32::to_be_bytes(
                        operation["data"]["params"].as_array().unwrap().len() as i32
                    )
                    .to_vec(),
                );
                for p_name in operation["data"]["params"].as_array().unwrap().iter() {
                    let mut str_bytes = p_name.as_str().unwrap().as_bytes().to_vec();
                    let mut len_bytes = i32::to_be_bytes(str_bytes.len() as i32).to_vec();
                    result.append(&mut len_bytes);
                    result.append(&mut str_bytes);
                }
                let func_start = start_point + result.len() + 8 + 8;
                let body = compile_ast(operation["data"].clone(), func_start);
                let func_end = func_start + body.len();
                result.append(&mut i64::to_be_bytes(func_start as i64).to_vec());
                result.append(&mut i64::to_be_bytes(func_end as i64).to_vec());
                result.append(&mut body.clone());
            }
            "functionCall" => {
                result.push(0x0d);
                result.append(&mut serialize_expr(operation["data"]["callee"].clone()));
                result.append(
                    &mut i32::to_be_bytes(
                        operation["data"]["args"].as_array().unwrap().len() as i32
                    )
                    .to_vec(),
                );
                operation["data"]["args"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .for_each(|arg| {
                        result.append(&mut serialize_expr(arg.clone()));
                    });
            }
            "definition" => {
                result.push(0x0e);
                if operation["data"]["leftSide"]["type"].as_str().unwrap() == "identifier" {
                    result.push(0x0b);
                    let mut str_bytes = operation["data"]["leftSide"]["data"]["name"]
                        .as_str()
                        .unwrap()
                        .as_bytes()
                        .to_vec();
                    let mut len_bytes = i32::to_be_bytes(str_bytes.len() as i32).to_vec();
                    result.append(&mut len_bytes);
                    result.append(&mut str_bytes);
                    result.append(&mut serialize_expr(operation["data"]["rightSide"].clone()));
                }
            }
            "assignment" => {
                result.push(0x0f);
                if operation["data"]["leftSide"]["type"].as_str().unwrap() == "identifier" {
                    result.push(0x0b);
                    let mut str_bytes = operation["data"]["leftSide"]["data"]["name"]
                        .as_str()
                        .unwrap()
                        .as_bytes()
                        .to_vec();
                    let mut len_bytes = i32::to_be_bytes(str_bytes.len() as i32).to_vec();
                    result.append(&mut len_bytes);
                    result.append(&mut str_bytes);
                    result.append(&mut serialize_expr(operation["data"]["rightSide"].clone()));
                } else if operation["data"]["leftSide"]["type"].as_str().unwrap() == "indexer" {
                    result.push(0x0c);
                    let mut str_bytes = operation["data"]["leftSide"]["data"]["target"]["data"]
                        ["name"]
                        .as_str()
                        .unwrap()
                        .as_bytes()
                        .to_vec();
                    let mut len_bytes = i32::to_be_bytes(str_bytes.len() as i32).to_vec();
                    result.append(&mut len_bytes);
                    result.append(&mut str_bytes);
                    result.append(&mut serialize_expr(operation["data"]["rightSide"].clone()));
                }
            }
            _ => {
                // skip
            }
        }
        op_counter += 1;
    }
    for (key, value) in reserved_branch_map {
        let step_point = *step_start_map.get(&key).unwrap();
        let sp_bytes = i64::to_be_bytes(step_point as i64).to_vec();
        for space in value.iter() {
            let address: usize = *space;
            result[address..address + 8].copy_from_slice(sp_bytes.as_slice());
        }
    }
    if result.is_empty() {
        result.push(0x00);
    }
    result
}

pub fn parse_code(program: String) -> serde_json::Value {
    let temp_prog = program.clone();
    let mut tokens: Vec<String> = vec![];
    let mut temp_token = "".to_string();
    let mut inside_string = false;
    for c in temp_prog.chars() {
        if c == '"' {
            if inside_string {
                inside_string = false;
                temp_token.push(c);
                tokens.push(temp_token);
                temp_token = "".to_string();
            } else {
                inside_string = true;
                temp_token.push(c);
            }
            continue;
        }
        let c_stred: &str = &c.to_string();
        if c == ' ' || c == '\n' || c == '\t' {
            if temp_token.len() > 0 {
                tokens.push(temp_token);
                temp_token = "".to_string();
            }
            continue;
        } else if vec![
            "=", "+", "-", "*", "/", "^", "%", "==", ">", "<", ">=", "<=", "!=", ".", "(", ")",
            "[", "]", "{", "}", ":", ",",
        ]
        .contains(&c_stred)
        {
            if temp_token.len() > 0 {
                tokens.push(temp_token);
                temp_token = "".to_string();
            }
            tokens.push(c.to_string());
            continue;
        }
        temp_token.push(c);
    }
    if temp_token.len() > 0 {
        tokens.push(temp_token);
    }
    // log(&format!("{:?}", tokens));
    let mut result = json!({});
    let mut state_num = 0;
    let mut stack: Vec<HashMap<String, Value>> = vec![];
    let mut first_stage: HashMap<String, Value> = HashMap::new();
    first_stage.insert("body".to_string(), json!([]));
    first_stage.insert("type".to_string(), json!("program".to_string()));
    stack.push(first_stage);
    let mut p: usize = 0;
    let mut current_reg: Value = json!(0);
    let mut counter = 0;
    let mut reserved_identifier = "".to_string();
    loop {
        counter += 1;
        // log(&p.to_string());
        // log(&state_num.to_string());
        // log(&format!("{:?}", stack));
        if counter > 50 {
            break;
        }
        if stack.len() == 0 && p >= tokens.len() {
            break;
        }
        if p >= tokens.len() {
            if state_num == 0 {
                result["type"] = json!("program");
                result["body"] = stack.last().unwrap().get("body").unwrap().clone();
                stack.pop();
                continue;
            } else if state_num == 101 {
                if current_reg
                    .get("type")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
                    == "functionCall"
                {
                    stack
                        .last_mut()
                        .unwrap()
                        .get_mut("body")
                        .unwrap()
                        .as_array_mut()
                        .unwrap()
                        .push(current_reg.clone());
                    state_num = 0;
                    continue;
                }
                let last_stage = stack.last().unwrap().clone();
                stack.pop();
                let last_type = last_stage["type"].as_str().unwrap().to_string();
                if last_type == "arithmetic" {
                    current_reg = json!({
                        "type": "arithmetic",
                        "data": {
                            "operation": last_stage.get("operation").unwrap().clone(),
                            "operand1": last_stage.get("operand1").unwrap().clone(),
                            "operand2": current_reg
                        }
                    });
                } else if last_type == "definition" {
                    stack.last_mut().unwrap().get_mut("body").unwrap().as_array_mut().unwrap().push(json!({
                        "type": "definition",
                        "data": {
                            "leftSide": {
                                "type": "identifier",
                                "data": {
                                    "name": last_stage.get("leftSide").unwrap().as_str().unwrap().to_string()
                                }
                            },
                            "rightSide": current_reg
                        }
                    }));
                    state_num = 0;
                } else if last_type == "assignment" {
                    stack.last_mut().unwrap().get_mut("body").unwrap().as_array_mut().unwrap().push(json!({
                        "type": "assignment",
                        "data": {
                            "leftSide": {
                                "type": "identifier",
                                "data": {
                                    "name": last_stage.get("leftSide").unwrap().as_str().unwrap().to_string()
                                }
                            },
                            "rightSide": current_reg
                        }
                    }));
                    state_num = 0;
                }
                continue;
            }
        }
        let token = tokens[p].clone();
        if state_num == 0 {
            if token == "def" {
                p += 1;
                state_num = 1;
                stack.push(HashMap::new());
                stack
                    .last_mut()
                    .unwrap()
                    .insert("type".to_string(), json!("definition"));
                continue;
            } else {
                p += 1;
                reserved_identifier = token.clone();
                state_num = 3;
            }
        } else if state_num == 1 {
            p += 1;
            stack
                .last_mut()
                .unwrap()
                .insert("leftSide".to_string(), json!(token.clone()));
            state_num = 2;
            continue;
        } else if state_num == 2 {
            if token == "=" {
                p += 1;
                state_num = 100;
                continue;
            }
        } else if state_num == 3 {
            if token == "=" {
                p += 1;
                stack.push(HashMap::new());
                stack
                    .last_mut()
                    .unwrap()
                    .insert("type".to_string(), json!("assignment"));
                stack
                    .last_mut()
                    .unwrap()
                    .insert("leftSide".to_string(), json!(reserved_identifier.clone()));
                reserved_identifier = "".to_string();
                state_num = 100;
                continue;
            } else if token == "(" {
                p += 1;
                stack.push(HashMap::new());
                stack
                    .last_mut()
                    .unwrap()
                    .insert("type".to_string(), json!("functionCall"));
                stack.last_mut().unwrap().insert(
                    "callee".to_string(),
                    json!({
                        "type": "identifier",
                        "data": {
                            "name": reserved_identifier.clone(),
                        }
                    }),
                );
                stack
                    .last_mut()
                    .unwrap()
                    .insert("args".to_string(), json!(vec![] as Vec<Value>));
                reserved_identifier = "".to_string();
                state_num = 100;
                continue;
            }
        } else if state_num == 100 {
            if token == "{" {
                stack.push(HashMap::new());
                stack
                    .last_mut()
                    .unwrap()
                    .insert("objectData".to_string(), json!({}));
                stack
                    .last_mut()
                    .unwrap()
                    .insert("type".to_string(), json!("objectExpr"));
                p += 1;
                state_num = 102;
                continue;
            }
            if token == "(" {
                stack.push(HashMap::new());
                stack
                    .last_mut()
                    .unwrap()
                    .insert("type".to_string(), json!("paren"));
                p += 1;
                continue;
            }
            let parse_res_i16 = token.parse::<i16>();
            if parse_res_i16.is_ok() {
                current_reg = json!({
                    "type": "i16",
                    "data": { "value": parse_res_i16.unwrap() }
                });
                p += 1;
                state_num = 101;
                continue;
            }
            let parse_res_i32 = token.parse::<i32>();
            if parse_res_i32.is_ok() {
                current_reg = json!({
                    "type": "i32",
                    "data": { "value": parse_res_i32.unwrap() }
                });
                p += 1;
                state_num = 101;
                continue;
            }
            let parse_res_i64 = token.parse::<i64>();
            if parse_res_i64.is_ok() {
                current_reg = json!({
                    "type": "i64",
                    "data": { "value": parse_res_i64.unwrap() }
                });
                p += 1;
                state_num = 101;
                continue;
            }
            let parse_res_f32 = token.parse::<f32>();
            if parse_res_f32.is_ok() {
                current_reg = json!({
                    "type": "f32",
                    "data": { "value": parse_res_f32.unwrap() }
                });
                p += 1;
                state_num = 101;
                continue;
            }
            let parse_res_f64 = token.parse::<f64>();
            if parse_res_f64.is_ok() {
                current_reg = json!({
                    "type": "f64",
                    "data": { "value": parse_res_f64.unwrap() }
                });
                p += 1;
                state_num = 101;
                continue;
            }
            let parse_res_bool = token.parse::<bool>();
            if parse_res_bool.is_ok() {
                current_reg = json!({
                    "type": "bool",
                    "data": { "value": parse_res_bool.unwrap() }
                });
                p += 1;
                state_num = 101;
                continue;
            }
            if token.len() >= 2 && token.starts_with('"') && token.ends_with('"') {
                current_reg = json!({
                    "type": "string",
                    "data": { "value": token[1..token.len()-1] }
                });
                p += 1;
                state_num = 101;
                continue;
            }
            current_reg = json!({
                "type": "identifier",
                "data": { "name": token }
            });
            p += 1;
            state_num = 101;
            continue;
        } else if state_num == 101 {
            if stack.last().unwrap().get("type").unwrap() == "objectExpr"
                && stack.last().unwrap().contains_key("currentKey")
            {
                let key = stack
                    .last_mut()
                    .unwrap()
                    .remove("currentKey")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string();
                stack
                    .last_mut()
                    .unwrap()
                    .get_mut("objectData")
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .insert(key, current_reg.clone());
                state_num = 103;
                continue;
            } else if stack
                .last()
                .unwrap()
                .get("type")
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
                == "arithmetic"
            {
                let last_stage = stack.last().unwrap().clone();
                stack.pop();
                current_reg = json!({
                    "type": "arithmetic",
                    "data": {
                        "operation": last_stage.get("operation").unwrap().clone(),
                        "operand1": last_stage.get("operand1").unwrap().clone(),
                        "operand2": current_reg
                    }
                });
                continue;
            } else if stack
                .last()
                .unwrap()
                .get("type")
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
                == "definition"
            {
                let last_stage = stack.last().unwrap().clone();
                stack.pop();
                stack.last_mut().unwrap().get_mut("body").unwrap().as_array_mut().unwrap().push(json!({
                        "type": "definition",
                        "data": {
                            "leftSide": {
                                "type": "identifier",
                                "data": {
                                    "name": last_stage.get("leftSide").unwrap().as_str().unwrap().to_string()
                                }
                            },
                            "rightSide": current_reg
                        }
                    }));
                state_num = 0;
                continue;
            } else if stack
                .last()
                .unwrap()
                .get("type")
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
                == "assignment"
            {
                let last_stage = stack.last().unwrap().clone();
                stack.pop();
                stack.last_mut().unwrap().get_mut("body").unwrap().as_array_mut().unwrap().push(json!({
                        "type": "assignment",
                        "data": {
                            "leftSide": {
                                "type": "identifier",
                                "data": {
                                    "name": last_stage.get("leftSide").unwrap().as_str().unwrap().to_string()
                                }
                            },
                            "rightSide": current_reg
                        }
                    }));
                state_num = 0;
                continue;
            } else {
                if token == "}" {
                    p += 1;
                    if stack
                        .last()
                        .unwrap()
                        .get("type")
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .to_string()
                        == "objPropValue"
                    {
                        stack.pop();
                        let last_stage = stack.last_mut().unwrap();
                        let ck = last_stage
                            .get("currentKey")
                            .unwrap()
                            .as_str()
                            .unwrap()
                            .to_string();
                        last_stage
                            .get_mut("objectData")
                            .unwrap()
                            .as_object_mut()
                            .unwrap()
                            .insert(ck, current_reg.clone());
                    }
                    let last_stage = stack.last().unwrap().clone();
                    stack.pop();
                    if last_stage
                        .get("type")
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .to_string()
                        == "objectExpr"
                    {
                        current_reg = json!({
                            "type": "object",
                            "data": {
                                "value": last_stage.get("objectData").unwrap().clone(),
                            }
                        });
                    }
                    continue;
                } else if token == ")" {
                    if stack
                        .last()
                        .unwrap()
                        .get("type")
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .to_string()
                        == "paren"
                    {
                        p += 1;
                        stack.pop();
                        continue;
                    } else if stack
                        .last()
                        .unwrap()
                        .get("type")
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .to_string()
                        == "functionCall"
                    {
                        p += 1;
                        let mut last_sage = stack.pop().unwrap();
                        last_sage
                            .get_mut("args")
                            .unwrap()
                            .as_array_mut()
                            .unwrap()
                            .push(current_reg.clone());
                        current_reg = json!({
                            "type": "functionCall",
                            "data": {
                                "callee": last_sage.get("callee").unwrap().clone(),
                                "args": last_sage.get("args").unwrap().clone(),
                            }
                        });
                        continue;
                    }
                } else if vec!["+", "-", "/", "*", "^", "%"]
                    .iter()
                    .any(|op| op.to_string() == token)
                {
                    stack.push(HashMap::new());
                    stack
                        .last_mut()
                        .unwrap()
                        .insert("type".to_string(), json!("arithmetic"));
                    stack
                        .last_mut()
                        .unwrap()
                        .insert("operand1".to_string(), current_reg.clone());
                    stack
                        .last_mut()
                        .unwrap()
                        .insert("operation".to_string(), json!(token.clone()));
                    p += 1;
                    state_num = 100;
                    continue;
                } else if token == "," {
                    if stack
                        .last()
                        .unwrap()
                        .get("type")
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .to_string()
                        == "functionCall"
                    {
                        p += 1;
                        stack
                            .last_mut()
                            .unwrap()
                            .get_mut("args")
                            .unwrap()
                            .as_array_mut()
                            .unwrap()
                            .push(current_reg.clone());
                        state_num = 100;
                        continue;
                    }
                }
            }
            if !stack.last().unwrap().get("body").is_none() {
                if current_reg
                    .get("type")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
                    == "functionCall"
                {
                    stack
                        .last_mut()
                        .unwrap()
                        .get_mut("body")
                        .unwrap()
                        .as_array_mut()
                        .unwrap()
                        .push(current_reg.clone());
                    current_reg = json!({});
                }
                state_num = 0;
                continue;
            }
        } else if state_num == 102 {
            stack.last_mut().unwrap().insert(
                "currentKey".to_string(),
                json!(token[1..token.len() - 1].to_string()),
            );
            stack.push(HashMap::new());
            stack
                .last_mut()
                .unwrap()
                .insert("type".to_string(), json!("objPropValue".to_string()));
            p += 1;
            state_num = 104;
            continue;
        } else if state_num == 103 {
            if token == "," {
                state_num = 102;
                p += 1;
                continue;
            } else if token == "}" {
                state_num = 101;
                continue;
            }
        } else if state_num == 104 {
            if token == ":" {
                p += 1;
                state_num = 100;
            }
        }
    }
    result
}

#[derive(Clone, Debug)]
struct Path {
    id: i32,
    prefix: String,
    nexts: Vec<Rc<RefCell<Path>>>,
}

pub fn compile_code(p: String) -> Vec<u8> {
    let program = p;

    let temp_prog = program;
    let mut tokens: Vec<String> = vec![];
    let mut temp_token = "".to_string();
    let mut inside_string = false;
    for c in temp_prog.chars() {
        if c == '"' {
            if inside_string {
                inside_string = false;
                temp_token.push(c);
                tokens.push(temp_token);
                temp_token = "".to_string();
            } else {
                inside_string = true;
                temp_token.push(c);
            }
            continue;
        }
        if inside_string {
            temp_token.push(c);
            continue;
        }
        let c_stred: &str = &c.to_string();
        if c == ' ' || c == '\n' || c == '\t' {
            if temp_token.len() > 0 {
                tokens.push(temp_token);
                temp_token = "".to_string();
            }
            continue;
        } else if vec![
            "=", "+", "-", "*", "/", "^", "%", "==", ">", "<", ">=", "<=", "!=", ".", "(", ")",
            "[", "]", "{", "}", ":", ",",
        ]
        .contains(&c_stred)
        {
            if temp_token.len() > 0 {
                tokens.push(temp_token);
                temp_token = "".to_string();
            }
            tokens.push(c.to_string());
            continue;
        }
        temp_token.push(c);
    }
    if temp_token.len() > 0 {
        tokens.push(temp_token);
    }
    log(&format!("{:?}", tokens));

    let mut stack: Vec<(String, Path, i32, usize, i32)> = vec![];

    let start_path = Rc::new(RefCell::new(Path {
        id: 1,
        prefix: "start".to_string(),
        nexts: vec![],
    }));
    let end_path = Rc::new(RefCell::new(Path {
        id: 2,
        prefix: "end".to_string(),
        nexts: vec![],
    }));
    {
        start_path.borrow_mut().nexts.push(end_path.clone());
    }
    let expr_path = Rc::new(RefCell::new(Path {
        id: 3,
        prefix: "".to_string(),
        nexts: vec![],
    }));
    {
        start_path.borrow_mut().nexts.push(expr_path.clone());
    }
    let expr_2_path = Rc::new(RefCell::new(Path {
        id: 4,
        prefix: "string".to_string(),
        nexts: vec![],
    }));
    {
        expr_path.borrow_mut().nexts.push(expr_2_path.clone());
    }
    {
        expr_path.borrow_mut().nexts.push(end_path.clone());
    }
    let expr_3_path = Rc::new(RefCell::new(Path {
        id: 5,
        prefix: "+".to_string(),
        nexts: vec![],
    }));
    {
        expr_2_path.borrow_mut().nexts.push(expr_3_path.clone());
    }
    let expr_4_path = Rc::new(RefCell::new(Path {
        id: 6,
        prefix: "string".to_string(),
        nexts: vec![],
    }));
    {
        expr_3_path.borrow_mut().nexts.push(expr_4_path.clone());
    }
    {
        expr_4_path.borrow_mut().nexts.push(expr_3_path.clone());
    }
    {
        expr_4_path.borrow_mut().nexts.push(end_path.clone());
    }

    let function_call_path = Rc::new(RefCell::new(Path {
        id: 7,
        prefix: "id".to_string(),
        nexts: vec![],
    }));
    {
        start_path
            .borrow_mut()
            .nexts
            .push(function_call_path.clone());
    }
    let function_call_2_path = Rc::new(RefCell::new(Path {
        id: 8,
        prefix: "(".to_string(),
        nexts: vec![],
    }));
    {
        function_call_path
            .borrow_mut()
            .nexts
            .push(function_call_2_path.clone());
    }
    {
        function_call_2_path
            .borrow_mut()
            .nexts
            .push(expr_path.clone());
    }
    let function_call_4_path = Rc::new(RefCell::new(Path {
        id: 10,
        prefix: ")".to_string(),
        nexts: vec![],
    }));
    {
        expr_4_path
            .borrow_mut()
            .nexts
            .push(function_call_4_path.clone());
        expr_2_path
            .borrow_mut()
            .nexts
            .push(function_call_4_path.clone());
        function_call_4_path
            .borrow_mut()
            .nexts
            .push(end_path.clone());
    }

    let genesis_path = Rc::new(RefCell::new(Path {
        id: 11,
        prefix: "".to_string(),
        nexts: vec![start_path.clone()],
    }));

    stack.push(("".to_string(), genesis_path.borrow_mut().clone(), 0, 0, 0));

    let mut keyword_map: HashMap<String, bool> = HashMap::new();
    keyword_map.insert("start".to_string(), true);
    keyword_map.insert("end".to_string(), true);
    keyword_map.insert("(".to_string(), true);
    keyword_map.insert(")".to_string(), true);
    keyword_map.insert("+".to_string(), true);

    loop {
        let mut found = false;
        let paths = stack.last().unwrap().1.nexts.clone();
        let checkpoint = stack.last().unwrap().2;
        let mut counter = 0;
        let curr_token = tokens[stack.last().unwrap().4 as usize].clone();
        for pa in paths.iter() {
            if counter < checkpoint {
                counter += 1;
                continue;
            }
            let path = pa.borrow().clone();
            if path.prefix == "" {
                let mut prev_exists = false;
                for hist in stack.clone().into_iter().rev() {
                    if hist.1.id == path.id && hist.3 == stack.len() {
                        prev_exists = true;
                        break;
                    }
                }
                if prev_exists {
                    counter += 1;
                    continue;
                }
                println!("trying non-prefix {}", curr_token);
                counter += 1;
                stack.last_mut().unwrap().2 = counter;
                found = true;
                stack.push((
                    curr_token,
                    path.clone(),
                    0,
                    stack.len(),
                    stack.last().unwrap().4,
                ));
                break;
            } else if !keyword_map.contains_key(&curr_token) {
                if curr_token.starts_with("\"")
                    && curr_token.ends_with("\"")
                    && path.prefix == "string"
                {
                    println!("matched string {}", curr_token);
                    counter += 1;
                    stack.last_mut().unwrap().2 = counter;
                    found = true;
                    stack.push((
                        curr_token,
                        path.clone(),
                        0,
                        stack.len(),
                        stack.last().unwrap().4 + 1,
                    ));
                    break;
                } else if path.prefix == "id" {
                    println!("matched identifier {}", curr_token);
                    counter += 1;
                    stack.last_mut().unwrap().2 = counter;
                    found = true;
                    stack.push((
                        curr_token,
                        path.clone(),
                        0,
                        stack.len(),
                        stack.last().unwrap().4 + 1,
                    ));
                    break;
                }
            } else if path.prefix == curr_token {
                println!("matched {}", curr_token);
                counter += 1;
                stack.last_mut().unwrap().2 = counter;
                found = true;
                stack.push((
                    curr_token,
                    path.clone(),
                    0,
                    stack.len(),
                    stack.last().unwrap().4 + 1,
                ));
                break;
            }
            counter += 1;
        }
        if stack.last().unwrap().0 == "end" {
            println!("Finished !");
            break;
        }
        if !found {
            if stack.len() > 0 {
                stack.pop();
            }
        }
        if stack.len() == 0 {
            break;
        }
    }

    vec![]
}

// ============================================================================
// JavaScript front-end
//
// `parse_js` turns a practical subset of JavaScript source into the very same
// Elpian AST JSON that the hand-written test helpers and external front-ends
// emit (see the node shapes consumed by `compile_ast` / `serialize_expr`
// above). It is intentionally self-contained — a tokenizer plus a
// recursive-descent / precedence-climbing parser — so the VM can build an Elpa
// instance straight from JS code without an off-VM toolchain.
//
// The pipeline mirrors the AST path exactly:
//
//     JS source ──parse_js──▶ Elpian AST JSON ──compile_ast──▶ bytecode
//
// i.e. JS is first lowered to the documented AST and then handed to the same
// `from ast` compiler that every other entry point uses.
//
// Supported subset (everything the AST/bytecode actually models):
//   * `let` / `const` / `var` declarations (→ `definition`).
//   * assignment, including `+= -= *= /= %=` and `++` / `--` (→ `assignment`).
//   * `function name(params) { ... }` (→ `functionDefinition`).
//   * `return` (→ `returnOperation`).
//   * `if` / `else if` / `else` (→ `ifStmt` chains).
//   * `while` and C-style `for` loops (→ `loopStmt`; `for` is desugared into an
//     init prefix plus a `loopStmt` whose body carries the update step).
//   * `switch` / `case` (→ `switchStmt`; `default` and `break` are accepted but
//     not modelled by the bytecode, so they are dropped).
//   * expressions: numbers, strings, booleans, identifiers, arrays, objects,
//     member access (`a.b` / `a[i]` → `indexer`), calls (→ `functionCall`),
//     the arithmetic/comparison operators the VM understands
//     (`+ - * / % ** == === != !== < <= > >=`, with `**`→`^`,
//     `===`→`==`, `!==`→`!=`) and the `!` / unary `-` prefixes.

#[derive(Clone, Debug, PartialEq)]
enum JsTok {
    Num(String),
    Str(String),
    Ident(String),
    Punct(String),
    Eof,
}

fn tokenize_js(src: &str) -> Vec<JsTok> {
    let chars: Vec<char> = src.chars().collect();
    let n = chars.len();
    let mut i = 0usize;
    let mut toks: Vec<JsTok> = vec![];
    // Longest punctuators first so the greedy scan never splits `===` into
    // `==` + `=`, `<=` into `<` + `=`, and so on.
    let puncts: &[&str] = &[
        "===", "!==", "**", "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=",
        "%=", "(", ")", "{", "}", "[", "]", ";", ",", ".", ":", "?", "<", ">", "=", "+", "-", "*",
        "/", "%", "!", "^", "&", "|",
    ];
    while i < n {
        let c = chars[i];
        if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
            i += 1;
            continue;
        }
        // Comments.
        if c == '/' && i + 1 < n && chars[i + 1] == '/' {
            i += 2;
            while i < n && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && i + 1 < n && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < n && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i += 2;
            continue;
        }
        // String literals (single or double quoted) with the common escapes.
        if c == '"' || c == '\'' {
            let quote = c;
            i += 1;
            let mut s = String::new();
            while i < n && chars[i] != quote {
                if chars[i] == '\\' && i + 1 < n {
                    match chars[i + 1] {
                        'n' => s.push('\n'),
                        't' => s.push('\t'),
                        'r' => s.push('\r'),
                        '\\' => s.push('\\'),
                        '\'' => s.push('\''),
                        '"' => s.push('"'),
                        '0' => s.push('\0'),
                        other => s.push(other),
                    }
                    i += 2;
                } else {
                    s.push(chars[i]);
                    i += 1;
                }
            }
            i += 1; // closing quote
            toks.push(JsTok::Str(s));
            continue;
        }
        // Numeric literals (integer, fractional, exponent).
        if c.is_ascii_digit() {
            let start = i;
            while i < n && chars[i].is_ascii_digit() {
                i += 1;
            }
            if i < n && chars[i] == '.' {
                i += 1;
                while i < n && chars[i].is_ascii_digit() {
                    i += 1;
                }
            }
            if i < n && (chars[i] == 'e' || chars[i] == 'E') {
                i += 1;
                if i < n && (chars[i] == '+' || chars[i] == '-') {
                    i += 1;
                }
                while i < n && chars[i].is_ascii_digit() {
                    i += 1;
                }
            }
            toks.push(JsTok::Num(chars[start..i].iter().collect()));
            continue;
        }
        // Identifiers and keywords.
        if c.is_alphabetic() || c == '_' || c == '$' {
            let start = i;
            while i < n && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '$') {
                i += 1;
            }
            toks.push(JsTok::Ident(chars[start..i].iter().collect()));
            continue;
        }
        // Punctuators, greedily matching the longest spelling.
        let mut matched = false;
        for p in puncts.iter() {
            let pl = p.chars().count();
            if i + pl <= n {
                let slice: String = chars[i..i + pl].iter().collect();
                if &slice == p {
                    toks.push(JsTok::Punct((*p).to_string()));
                    i += pl;
                    matched = true;
                    break;
                }
            }
        }
        if !matched {
            // Unknown character: skip it rather than abort the whole parse.
            i += 1;
        }
    }
    toks.push(JsTok::Eof);
    toks
}

// ---- AST node builders (exact shapes consumed by `compile_ast`) -------------

fn js_num_literal(s: &str) -> Value {
    if s.contains('.') || s.contains('e') || s.contains('E') {
        json!({ "type": "f64", "data": { "value": s.parse::<f64>().unwrap_or(0.0) } })
    } else {
        match s.parse::<i64>() {
            Ok(v) => json!({ "type": "i64", "data": { "value": v } }),
            Err(_) => json!({ "type": "f64", "data": { "value": s.parse::<f64>().unwrap_or(0.0) } }),
        }
    }
}
fn js_int(n: i64) -> Value {
    json!({ "type": "i64", "data": { "value": n } })
}
fn js_ident(name: &str) -> Value {
    json!({ "type": "identifier", "data": { "name": name } })
}
fn js_string(s: &str) -> Value {
    json!({ "type": "string", "data": { "value": s } })
}
fn js_arith(op: &str, a: Value, b: Value) -> Value {
    json!({ "type": "arithmetic", "data": { "operation": op, "operand1": a, "operand2": b } })
}
fn js_def(name: &str, val: Value) -> Value {
    json!({ "type": "definition", "data": { "leftSide": js_ident(name), "rightSide": val } })
}
/// Build an `assignment` node, but only for the lvalues the bytecode models
/// (a bare identifier or an `a.b` / `a[i]` indexer). Anything else yields
/// `None`, so the caller can drop the meaningless statement.
fn js_assign(target: Value, rhs: Value) -> Option<Value> {
    match target["type"].as_str().unwrap_or("") {
        "identifier" | "indexer" => {
            Some(json!({ "type": "assignment", "data": { "leftSide": target, "rightSide": rhs } }))
        }
        _ => None,
    }
}
/// Fold a unary minus into the literal where possible, else lower to `0 - x`.
fn js_negate(v: Value) -> Value {
    if v["type"] == "i64" {
        if let Some(n) = v["data"]["value"].as_i64() {
            return js_int(-n);
        }
    }
    if v["type"] == "f64" {
        if let Some(n) = v["data"]["value"].as_f64() {
            return json!({ "type": "f64", "data": { "value": -n } });
        }
    }
    js_arith("-", js_int(0), v)
}

struct JsParser {
    toks: Vec<JsTok>,
    pos: usize,
}

impl JsParser {
    fn new(toks: Vec<JsTok>) -> Self {
        JsParser { toks, pos: 0 }
    }
    fn peek(&self) -> &JsTok {
        &self.toks[self.pos]
    }
    fn advance(&mut self) -> JsTok {
        let t = self.toks[self.pos].clone();
        if self.pos + 1 < self.toks.len() {
            self.pos += 1;
        }
        t
    }
    fn at_eof(&self) -> bool {
        matches!(self.peek(), JsTok::Eof)
    }
    fn at_punct(&self, p: &str) -> bool {
        matches!(self.peek(), JsTok::Punct(s) if s == p)
    }
    fn eat_punct(&mut self, p: &str) -> bool {
        if self.at_punct(p) {
            self.advance();
            true
        } else {
            false
        }
    }
    fn expect_punct(&mut self, p: &str) {
        if !self.eat_punct(p) {
            panic!("js: expected '{}', found {:?}", p, self.peek());
        }
    }
    fn at_ident(&self, name: &str) -> bool {
        matches!(self.peek(), JsTok::Ident(s) if s == name)
    }
    fn eat_ident(&mut self, name: &str) -> bool {
        if self.at_ident(name) {
            self.advance();
            true
        } else {
            false
        }
    }
    fn expect_ident(&mut self, name: &str) {
        if !self.eat_ident(name) {
            panic!("js: expected keyword '{}', found {:?}", name, self.peek());
        }
    }
    fn expect_ident_name(&mut self) -> String {
        match self.advance() {
            JsTok::Ident(s) => s,
            t => panic!("js: expected identifier, found {:?}", t),
        }
    }

    fn parse_program(&mut self) -> Value {
        let mut body: Vec<Value> = vec![];
        while !self.at_eof() {
            body.extend(self.parse_statement());
        }
        json!({ "type": "program", "body": body })
    }

    // ---- Statements ---------------------------------------------------------

    fn parse_statement(&mut self) -> Vec<Value> {
        if self.eat_punct(";") {
            return vec![];
        }
        if self.at_ident("function") {
            return vec![self.parse_function_decl()];
        }
        if self.at_ident("if") {
            return vec![self.parse_if()];
        }
        if self.at_ident("while") {
            return vec![self.parse_while()];
        }
        if self.at_ident("for") {
            return self.parse_for();
        }
        if self.at_ident("switch") {
            return vec![self.parse_switch()];
        }
        if self.at_ident("return") {
            self.advance();
            let val = if self.at_punct(";") || self.at_punct("}") || self.at_eof() {
                js_int(0)
            } else {
                self.parse_expr()
            };
            self.eat_punct(";");
            return vec![json!({ "type": "returnOperation", "data": { "value": val } })];
        }
        if self.at_ident("break") || self.at_ident("continue") {
            // No break/continue opcode in the bytecode; accept and drop.
            self.advance();
            self.eat_punct(";");
            return vec![];
        }
        if self.at_punct("{") {
            // A bare block: inline its statements (the VM has one flat scope).
            return self.parse_block();
        }
        let s = self.parse_simple();
        self.eat_punct(";");
        s
    }

    /// A block `{ ... }` or, when unbraced, a single statement — returned as the
    /// flat operation list the AST uses for `body` arrays.
    fn parse_block_or_single(&mut self) -> Vec<Value> {
        if self.at_punct("{") {
            self.parse_block()
        } else {
            self.parse_statement()
        }
    }
    fn parse_block(&mut self) -> Vec<Value> {
        self.expect_punct("{");
        let mut out: Vec<Value> = vec![];
        while !self.at_punct("}") && !self.at_eof() {
            out.extend(self.parse_statement());
        }
        self.expect_punct("}");
        out
    }

    fn parse_function_decl(&mut self) -> Value {
        self.expect_ident("function");
        let name = self.expect_ident_name();
        self.expect_punct("(");
        let mut params: Vec<String> = vec![];
        while !self.at_punct(")") && !self.at_eof() {
            params.push(self.expect_ident_name());
            if !self.eat_punct(",") {
                break;
            }
        }
        self.expect_punct(")");
        let body = self.parse_block();
        json!({ "type": "functionDefinition", "data": { "name": name, "params": params, "body": body } })
    }

    fn parse_if(&mut self) -> Value {
        self.expect_ident("if");
        self.expect_punct("(");
        let cond = self.parse_expr();
        self.expect_punct(")");
        let body = self.parse_block_or_single();
        let mut data = json!({ "condition": cond, "body": body });
        if self.eat_ident("else") {
            if self.at_ident("if") {
                // `else if` — attach the whole nested `ifStmt` as the elseif
                // chain; `serialize_condition_chain` walks `node["data"]`.
                data["elseifStmt"] = self.parse_if();
            } else {
                let else_body = self.parse_block_or_single();
                data["elseStmt"] = json!({ "data": { "body": else_body } });
            }
        }
        json!({ "type": "ifStmt", "data": data })
    }

    fn parse_while(&mut self) -> Value {
        self.expect_ident("while");
        self.expect_punct("(");
        let cond = self.parse_expr();
        self.expect_punct(")");
        let body = self.parse_block_or_single();
        json!({ "type": "loopStmt", "data": { "condition": cond, "body": body } })
    }

    /// Desugar `for (init; cond; update) body` into the init statement(s)
    /// followed by a `loopStmt` whose body ends with the update step.
    fn parse_for(&mut self) -> Vec<Value> {
        self.expect_ident("for");
        self.expect_punct("(");
        let mut out: Vec<Value> = vec![];
        if !self.at_punct(";") {
            out.extend(self.parse_simple());
        }
        self.expect_punct(";");
        let cond = if self.at_punct(";") {
            json!({ "type": "bool", "data": { "value": true } })
        } else {
            self.parse_expr()
        };
        self.expect_punct(";");
        let update = if self.at_punct(")") {
            vec![]
        } else {
            self.parse_simple()
        };
        self.expect_punct(")");
        let mut body = self.parse_block_or_single();
        body.extend(update);
        out.push(json!({ "type": "loopStmt", "data": { "condition": cond, "body": body } }));
        out
    }

    fn parse_switch(&mut self) -> Value {
        self.expect_ident("switch");
        self.expect_punct("(");
        let val = self.parse_expr();
        self.expect_punct(")");
        self.expect_punct("{");
        let mut cases: Vec<Value> = vec![];
        while !self.at_punct("}") && !self.at_eof() {
            if self.eat_ident("case") {
                let cv = self.parse_expr();
                self.expect_punct(":");
                let body = self.parse_case_body();
                cases.push(json!({ "value": cv, "body": { "body": body } }));
            } else if self.eat_ident("default") {
                // No default opcode in the bytecode; parse and drop it.
                self.expect_punct(":");
                let _ = self.parse_case_body();
            } else {
                break;
            }
        }
        self.expect_punct("}");
        json!({ "type": "switchStmt", "data": { "value": val, "cases": cases } })
    }
    fn parse_case_body(&mut self) -> Vec<Value> {
        let mut body: Vec<Value> = vec![];
        while !self.at_ident("case")
            && !self.at_ident("default")
            && !self.at_punct("}")
            && !self.at_eof()
        {
            body.extend(self.parse_statement());
        }
        body
    }

    /// A "simple" statement with no trailing `;`: a declaration, an assignment
    /// (including compound and `++`/`--` forms), or a bare call expression.
    /// Used directly for `for` init/update clauses and wrapped by
    /// `parse_statement` for ordinary statements.
    fn parse_simple(&mut self) -> Vec<Value> {
        if self.at_ident("let") || self.at_ident("const") || self.at_ident("var") {
            self.advance();
            let mut out: Vec<Value> = vec![];
            loop {
                let name = self.expect_ident_name();
                let val = if self.eat_punct("=") {
                    self.parse_expr()
                } else {
                    js_int(0)
                };
                out.push(js_def(&name, val));
                if !self.eat_punct(",") {
                    break;
                }
            }
            return out;
        }
        // Prefix increment / decrement.
        if self.eat_punct("++") {
            let t = self.parse_postfix();
            return js_assign(t.clone(), js_arith("+", t, js_int(1)))
                .into_iter()
                .collect();
        }
        if self.eat_punct("--") {
            let t = self.parse_postfix();
            return js_assign(t.clone(), js_arith("-", t, js_int(1)))
                .into_iter()
                .collect();
        }
        let target = self.parse_expr();
        // Postfix increment / decrement.
        if self.eat_punct("++") {
            return js_assign(target.clone(), js_arith("+", target, js_int(1)))
                .into_iter()
                .collect();
        }
        if self.eat_punct("--") {
            return js_assign(target.clone(), js_arith("-", target, js_int(1)))
                .into_iter()
                .collect();
        }
        if self.eat_punct("=") {
            let rhs = self.parse_expr();
            return js_assign(target, rhs).into_iter().collect();
        }
        for (pp, op) in [("+=", "+"), ("-=", "-"), ("*=", "*"), ("/=", "/"), ("%=", "%")] {
            if self.eat_punct(pp) {
                let rhs = self.parse_expr();
                return js_assign(target.clone(), js_arith(op, target, rhs))
                    .into_iter()
                    .collect();
            }
        }
        // A bare expression only carries meaning to the bytecode when it is a
        // call (e.g. `log(x)`); otherwise it has no operation to emit.
        if target["type"] == "functionCall" {
            return vec![target];
        }
        vec![]
    }

    // ---- Expressions (precedence climbing) ----------------------------------

    fn parse_expr(&mut self) -> Value {
        self.parse_binary(0)
    }

    /// Map a punctuator to `(precedence, elpian operator, right-associative)`.
    fn binop(p: &str) -> Option<(u8, &'static str, bool)> {
        match p {
            "**" => Some((7, "^", true)),
            "*" => Some((6, "*", false)),
            "/" => Some((6, "/", false)),
            "%" => Some((6, "%", false)),
            "+" => Some((5, "+", false)),
            "-" => Some((5, "-", false)),
            "<" => Some((4, "<", false)),
            "<=" => Some((4, "<=", false)),
            ">" => Some((4, ">", false)),
            ">=" => Some((4, ">=", false)),
            "==" | "===" => Some((3, "==", false)),
            "!=" | "!==" => Some((3, "!=", false)),
            _ => None,
        }
    }

    fn parse_binary(&mut self, min_prec: u8) -> Value {
        let mut left = self.parse_unary();
        loop {
            let op_punct = match self.peek() {
                JsTok::Punct(p) => p.clone(),
                _ => break,
            };
            let (prec, op, right_assoc) = match Self::binop(&op_punct) {
                Some(x) => x,
                None => break,
            };
            if prec < min_prec {
                break;
            }
            self.advance();
            let next_min = if right_assoc { prec } else { prec + 1 };
            let right = self.parse_binary(next_min);
            left = js_arith(op, left, right);
        }
        left
    }

    fn parse_unary(&mut self) -> Value {
        if self.eat_punct("!") {
            return json!({ "type": "not", "data": { "value": self.parse_unary() } });
        }
        if self.at_punct("-") {
            self.advance();
            let v = self.parse_unary();
            return js_negate(v);
        }
        if self.at_punct("+") {
            self.advance();
            return self.parse_unary();
        }
        self.parse_postfix()
    }

    fn parse_postfix(&mut self) -> Value {
        let mut e = self.parse_primary();
        loop {
            if self.eat_punct(".") {
                let name = self.expect_ident_name();
                e = json!({ "type": "indexer", "data": { "target": e, "index": js_string(&name) } });
            } else if self.at_punct("[") {
                self.advance();
                let idx = self.parse_expr();
                self.expect_punct("]");
                e = json!({ "type": "indexer", "data": { "target": e, "index": idx } });
            } else if self.at_punct("(") {
                let args = self.parse_args();
                e = json!({ "type": "functionCall", "data": { "callee": e, "args": args } });
            } else {
                break;
            }
        }
        e
    }

    fn parse_args(&mut self) -> Vec<Value> {
        self.expect_punct("(");
        let mut args: Vec<Value> = vec![];
        while !self.at_punct(")") && !self.at_eof() {
            args.push(self.parse_expr());
            if !self.eat_punct(",") {
                break;
            }
        }
        self.expect_punct(")");
        args
    }

    fn parse_primary(&mut self) -> Value {
        match self.peek().clone() {
            JsTok::Num(s) => {
                self.advance();
                js_num_literal(&s)
            }
            JsTok::Str(s) => {
                self.advance();
                js_string(&s)
            }
            JsTok::Ident(name) => match name.as_str() {
                "true" => {
                    self.advance();
                    json!({ "type": "bool", "data": { "value": true } })
                }
                "false" => {
                    self.advance();
                    json!({ "type": "bool", "data": { "value": false } })
                }
                // The bytecode has no null literal; model the empty value as 0.
                "null" | "undefined" => {
                    self.advance();
                    js_int(0)
                }
                "function" => panic!("js: function expressions are not supported"),
                _ => {
                    self.advance();
                    js_ident(&name)
                }
            },
            JsTok::Punct(p) => match p.as_str() {
                "(" => {
                    self.advance();
                    let e = self.parse_expr();
                    self.expect_punct(")");
                    e
                }
                "[" => self.parse_array(),
                "{" => self.parse_object(),
                other => panic!("js: unexpected token '{}'", other),
            },
            JsTok::Eof => panic!("js: unexpected end of input"),
        }
    }

    fn parse_array(&mut self) -> Value {
        self.expect_punct("[");
        let mut items: Vec<Value> = vec![];
        while !self.at_punct("]") && !self.at_eof() {
            items.push(self.parse_expr());
            if !self.eat_punct(",") {
                break;
            }
        }
        self.expect_punct("]");
        json!({ "type": "array", "data": { "value": items } })
    }

    fn parse_object(&mut self) -> Value {
        self.expect_punct("{");
        let mut map = serde_json::Map::new();
        while !self.at_punct("}") && !self.at_eof() {
            let key = match self.advance() {
                JsTok::Ident(s) => s,
                JsTok::Str(s) => s,
                JsTok::Num(s) => s,
                t => panic!("js: invalid object key {:?}", t),
            };
            let val = if self.eat_punct(":") {
                self.parse_expr()
            } else {
                // Shorthand `{ a }` is `{ a: a }`.
                js_ident(&key)
            };
            map.insert(key, val);
            if !self.eat_punct(",") {
                break;
            }
        }
        self.expect_punct("}");
        json!({ "type": "object", "data": { "value": Value::Object(map) } })
    }
}

/// Parse JavaScript source into Elpian AST JSON (a `program` node). Panics on a
/// syntax error in the supported subset; use [`try_parse_js`] for a fallible
/// variant.
pub fn parse_js(src: &str) -> serde_json::Value {
    JsParser::new(tokenize_js(src)).parse_program()
}

/// Parse JavaScript source into Elpian AST JSON, returning an error instead of
/// panicking when the source is outside the supported subset.
pub fn try_parse_js(src: &str) -> Result<serde_json::Value, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| parse_js(src)))
        .map_err(|_| "javascript parse error".to_string())
}

/// Compile JavaScript source straight to bytecode by lowering it to the Elpian
/// AST and feeding that to [`compile_ast`] — the same `from ast` path every
/// other entry point uses.
pub fn compile_js(src: &str) -> Vec<u8> {
    compile_ast(parse_js(src), 0)
}
