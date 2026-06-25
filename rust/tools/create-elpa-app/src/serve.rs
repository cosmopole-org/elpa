//! `dev` — build the project to bytecode and serve it over HTTP for the
//! prebuilt Elpa + Flutter **wasm** host (produced by `install`).
//!
//! The flow: build → copy the fresh `app.bc` into the host's web root → serve
//! that root on `127.0.0.1:<port>`. The wasm host fetches `/app.bc` at startup
//! and runs it. The static file server below is pure `std` (no deps); the wasm
//! host itself is what `install` produces (see install.rs) and needs the Flutter
//! + wasm toolchain, which is why `install` is a prerequisite here.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;

use crate::builder;
use crate::install;
use crate::manifest::Manifest;

pub fn dev(start_dir: &Path, port: u16) -> Result<(), String> {
    let m = Manifest::find(start_dir)?;
    let out = builder::build(&m, false)?;

    // The prebuilt wasm host (web root) must already exist.
    let host = install::host_dir();
    if !host.join("index.html").is_file() {
        return Err(format!(
            "no prebuilt wasm host at {}.\nRun `create-elpa-app install` first to build the Elpa + Flutter wasm host.",
            host.display()
        ));
    }

    // Publish the freshly built bytecode into the host's web root.
    std::fs::copy(&out.bc, host.join("app.bc")).map_err(|e| format!("publish app.bc: {e}"))?;

    let addr = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&addr).map_err(|e| format!("bind {addr}: {e}"))?;
    println!("\x1b[32m✓\x1b[0m dev server: http://{addr}  (serving {})", host.display());
    println!("  rebuild with `create-elpa-app build`; refresh the page to pick it up. Ctrl-C to stop.");

    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                if let Err(e) = serve_one(s, &host) {
                    eprintln!("  request error: {e}");
                }
            }
            Err(e) => eprintln!("  accept error: {e}"),
        }
    }
    Ok(())
}

/// Serve a single request: map the URL path to a file under `root` and stream it
/// back with a sensible content type. Directory traversal (`..`) is rejected.
fn serve_one(mut stream: TcpStream, root: &Path) -> Result<(), String> {
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let path = req
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    let path = path.split('?').next().unwrap_or("/");

    let rel = if path == "/" { "index.html" } else { path.trim_start_matches('/') };
    if rel.split('/').any(|seg| seg == "..") {
        return respond(&mut stream, 403, "text/plain", b"forbidden");
    }
    let file = root.join(rel);

    match std::fs::read(&file) {
        Ok(body) => respond(&mut stream, 200, content_type(&file), &body),
        Err(_) => respond(&mut stream, 404, "text/plain", b"not found"),
    }
}

fn respond(stream: &mut TcpStream, code: u16, ctype: &str, body: &[u8]) -> Result<(), String> {
    let reason = match code {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "OK",
    };
    let header = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCross-Origin-Opener-Policy: same-origin\r\nCross-Origin-Embedder-Policy: require-corp\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).map_err(|e| e.to_string())?;
    stream.write_all(body).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "wasm" => "application/wasm",
        "json" => "application/json",
        "css" => "text/css; charset=utf-8",
        "bc" => "application/octet-stream",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ttf" => "font/ttf",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// The default dev port.
pub const DEFAULT_PORT: u16 = 8787;
