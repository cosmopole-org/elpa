#!/usr/bin/env node
// =============================================================================
// create-elpa-app — scaffold a new Elpa application from a template.
// -----------------------------------------------------------------------------
// Three project types:
//
//   wgpu          A pure-Elpa (JavaScript) project that runs on wgpu via a small
//                 native (winit) host. Ships the Game3D + Material SDKs and a demo
//                 that combines a 3D game scene with a 2D UI overlay.
//
//   flutter       A Flutter app that embeds Elpa through flutter_rust_bridge. The
//                 Elpa engine + the Flutter bridge source are vendored in; the demo
//                 is a rich 2D UI authored in JavaScript and streamed to real
//                 Flutter widgets over the message pipe.
//
//   wgpu-flutter  The Flutter app above, built with the wgpu native-widget path so
//                 the demo can host a 3D Game3D scene inside an Elpa `Native3DView`
//                 (the zero-copy surface that links wgpu to Flutter) alongside its
//                 2D UI.
//
// The CLI copies the live Elpa sources out of this repository into the generated
// project, so each project is self-contained and builds on its own. Run it from
// anywhere; it locates the repo relative to its own path (override with
// `--elpa-root`).
//
//   node create-elpa-app.mjs <name> --template <wgpu|flutter|wgpu-flutter>
//   node create-elpa-app.mjs            # interactive
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMPLATES = {
  wgpu: {
    label: "wgpu — pure Elpa/JS on wgpu (Game3D 3D scene + 2D UI overlay)",
    generate: generateWgpu,
  },
  flutter: {
    label: "flutter — Flutter + flutter_rust_bridge + Elpa, rich 2D UI demo",
    generate: generateFlutter,
  },
  "wgpu-flutter": {
    label:
      "wgpu-flutter — Flutter + Elpa with a 3D Native3DView (wgpu) inside a 2D UI",
    generate: generateWgpuFlutter,
  },
};

// ---- small utilities --------------------------------------------------------

function die(msg) {
  console.error(`\x1b[31merror:\x1b[0m ${msg}`);
  process.exit(1);
}

function info(msg) {
  console.log(msg);
}

/** A safe snake_case identifier usable as a Rust crate / Dart package name. */
function snakeCase(name) {
  const s = name
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return s.replace(/^([0-9])/, "_$1") || "elpa_app";
}

/** A human "Title Case" label from an arbitrary name. */
function titleCase(name) {
  return name
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function substitute(text, vars) {
  return text
    .replaceAll("__APP_SNAKE__", vars.snake)
    .replaceAll("__APP_TITLE__", vars.title)
    .replaceAll("__APP_NAME__", vars.name);
}

/** Recursively copy a directory, skipping build artifacts. */
function copyDir(src, dest, { skip = [] } = {}) {
  const skipNames = new Set(["target", "build", ".dart_tool", "node_modules", ...skip]);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d, { skip });
    else fs.copyFileSync(s, d);
  }
}

/** Write a template file from templates/ into the project, substituting tokens. */
function emitTemplate(relTemplatePath, destPath, vars) {
  const tpl = fs.readFileSync(path.join(__dirname, "templates", relTemplatePath), "utf8");
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, substitute(tpl, vars));
}

function editFile(file, fn) {
  fs.writeFileSync(file, fn(fs.readFileSync(file, "utf8")));
}

// ---- repository / engine vendoring -----------------------------------------

const ENGINE_CRATES = [
  "elpa",
  "elpian-vm",
  "elpa-protocol",
  "elpa-renderer",
  "elpa-runtime",
];

/** Find the Elpa repo root (the dir holding `rust/crates/elpa` and `flutter/`). */
function findElpaRoot(explicit) {
  const candidates = [];
  if (explicit) candidates.push(path.resolve(explicit));
  // tools/create-elpa-app/ -> repo root is two levels up.
  candidates.push(path.resolve(__dirname, "..", ".."));
  candidates.push(process.cwd());
  for (const c of candidates) {
    if (
      fs.existsSync(path.join(c, "rust", "crates", "elpa", "Cargo.toml")) &&
      fs.existsSync(path.join(c, "flutter", "pubspec.yaml"))
    ) {
      return c;
    }
  }
  die(
    "could not locate the Elpa repository. Pass --elpa-root <path> pointing at " +
      "the checkout that contains rust/crates/elpa and flutter/.",
  );
}

/**
 * Vendor the five core Elpa crates into `<dest>/engine/` as a self-contained
 * Cargo workspace, so the generated project builds without the original repo.
 */
function vendorEngine(elpaRoot, destEngineDir, vars) {
  for (const crate of ENGINE_CRATES) {
    copyDir(
      path.join(elpaRoot, "rust", "crates", crate),
      path.join(destEngineDir, crate),
    );
  }
  emitTemplate("_engine/Cargo.toml", path.join(destEngineDir, "Cargo.toml"), vars);
}

/** Copy a Game3D / Material SDK's `assets/sdk` JS modules into the project. */
function copySdk(elpaRoot, exampleName, destDir) {
  copyDir(
    path.join(elpaRoot, "rust", "examples", exampleName, "assets", "sdk"),
    destDir,
  );
}

// ---- generators -------------------------------------------------------------

function generateWgpu(elpaRoot, dest, vars) {
  // Project layout:
  //   engine/         vendored Elpa crates (own workspace)
  //   app/            standalone winit host crate (path-deps engine/elpa[wgpu])
  //   app/assets/     Game3D + Material SDKs + the combined demo
  vendorEngine(elpaRoot, path.join(dest, "engine"), vars);

  copySdk(elpaRoot, "game3d", path.join(dest, "app", "assets", "sdk", "game3d"));
  copySdk(elpaRoot, "material", path.join(dest, "app", "assets", "sdk", "material"));

  emitTemplate("wgpu/app/Cargo.toml", path.join(dest, "app", "Cargo.toml"), vars);
  emitTemplate("wgpu/app/build.rs", path.join(dest, "app", "build.rs"), vars);
  emitTemplate("wgpu/app/src/main.rs", path.join(dest, "app", "src", "main.rs"), vars);
  emitTemplate("wgpu/app/assets/demo.js", path.join(dest, "app", "assets", "demo.js"), vars);
  emitTemplate("wgpu/README.md", path.join(dest, "README.md"), vars);
  emitTemplate("wgpu/gitignore", path.join(dest, ".gitignore"), vars);
}

/** Shared Flutter scaffolding for both flutter and wgpu-flutter templates. */
function scaffoldFlutter(elpaRoot, dest, vars, { demoTemplate, readmeTemplate }) {
  // Copy the live Flutter app (lib + rust bridge + SDK + config) into the project.
  copyDir(path.join(elpaRoot, "flutter"), dest, { skip: ["android", "ios", "linux", "macos", "windows", "web"] });

  // Vendor the Elpa engine and repoint the bridge crate's path deps at it.
  vendorEngine(elpaRoot, path.join(dest, "engine"), vars);
  editFile(path.join(dest, "rust", "Cargo.toml"), (s) =>
    s.replaceAll("../../rust/crates/", "../engine/"),
  );

  // Name the package after the project.
  editFile(path.join(dest, "pubspec.yaml"), (s) =>
    s.replace(/^name:\s*\S+/m, `name: ${vars.snake}`),
  );

  // Swap in the template's demo program (the SDK stays as-is) and a matching
  // end-to-end smoke test (the upstream one asserts the messenger demo).
  emitTemplate(demoTemplate, path.join(dest, "assets", "app", "main.js"), vars);
  emitTemplate("flutter/demo_app.rs", path.join(dest, "rust", "tests", "demo_app.rs"), vars);
  emitTemplate(readmeTemplate, path.join(dest, "README.md"), vars);
}

function generateFlutter(elpaRoot, dest, vars) {
  scaffoldFlutter(elpaRoot, dest, vars, {
    demoTemplate: "flutter/main.js",
    readmeTemplate: "flutter/README.md",
  });
}

function generateWgpuFlutter(elpaRoot, dest, vars) {
  scaffoldFlutter(elpaRoot, dest, vars, {
    demoTemplate: "wgpu-flutter/main.js",
    readmeTemplate: "wgpu-flutter/README.md",
  });
}

// ---- argument parsing / interactive prompt ----------------------------------

function parseArgs(argv) {
  const opts = { name: null, template: null, dir: null, elpaRoot: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-t" || a === "--template") opts.template = argv[++i];
    else if (a === "--dir") opts.dir = argv[++i];
    else if (a === "--elpa-root") opts.elpaRoot = argv[++i];
    else if (a === "--force") opts.force = true;
    else if (a.startsWith("--template=")) opts.template = a.slice("--template=".length);
    else if (a.startsWith("-")) die(`unknown option: ${a}`);
    else if (opts.name === null) opts.name = a;
    else die(`unexpected argument: ${a}`);
  }
  return opts;
}

function usage() {
  info(`create-elpa-app — scaffold a new Elpa app

Usage:
  create-elpa-app <name> [--template <type>] [options]

Templates:
${Object.entries(TEMPLATES)
  .map(([k, v]) => `  ${k.padEnd(14)}${v.label}`)
  .join("\n")}

Options:
  -t, --template <type>   one of: ${Object.keys(TEMPLATES).join(", ")}
      --dir <path>        output directory (default: ./<name>)
      --elpa-root <path>  path to the Elpa checkout to vendor from
      --force             write into a non-empty directory
  -h, --help              show this help

With no name/template, the CLI prompts interactively.`);
}

/**
 * A line-oriented asker that captures input lines as they arrive (independent of
 * when a prompt is shown), so piped multi-line input is delivered in order and an
 * EOF resolves outstanding prompts with "" instead of hanging.
 */
function makeAsker() {
  const rl = readline.createInterface({ input: process.stdin });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on("line", (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else queue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()("");
  });
  return {
    ask(question) {
      process.stdout.write(question);
      return new Promise((resolve) => {
        if (queue.length) resolve(queue.shift());
        else if (closed) resolve("");
        else waiters.push(resolve);
      }).then((a) => a.trim());
    },
    close() {
      rl.close();
    },
  };
}

async function interactive(opts) {
  const asker = makeAsker();
  try {
    if (!opts.name) {
      opts.name = (await asker.ask("Project name: ")) || die("a project name is required");
    }
    if (!opts.template) {
      const keys = Object.keys(TEMPLATES);
      info("\nTemplate:");
      keys.forEach((k, i) => info(`  ${i + 1}) ${TEMPLATES[k].label}`));
      const ans = await asker.ask(`Choose [1-${keys.length}]: `);
      const idx = Number.parseInt(ans, 10);
      opts.template = keys[idx - 1] || (TEMPLATES[ans] ? ans : null);
      if (!opts.template) die("invalid template selection");
    }
  } finally {
    asker.close();
  }
}

// ---- main -------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  if (!opts.name || !opts.template) await interactive(opts);
  if (!TEMPLATES[opts.template]) {
    die(`unknown template "${opts.template}". Choose one of: ${Object.keys(TEMPLATES).join(", ")}`);
  }

  const vars = {
    name: opts.name,
    snake: snakeCase(opts.name),
    title: titleCase(opts.name),
  };

  const dest = path.resolve(opts.dir || vars.snake);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0 && !opts.force) {
    die(`directory ${dest} already exists and is not empty (use --force to override)`);
  }

  const elpaRoot = findElpaRoot(opts.elpaRoot);

  info(`\nCreating ${opts.template} project "${vars.name}"`);
  info(`  output: ${dest}`);
  info(`  engine: ${elpaRoot}\n`);

  fs.mkdirSync(dest, { recursive: true });
  TEMPLATES[opts.template].generate(elpaRoot, dest, vars);

  info(`\x1b[32m✓\x1b[0m Project ready at ${dest}`);
  printNextSteps(opts.template, dest);
}

function printNextSteps(template, dest) {
  const rel = path.relative(process.cwd(), dest) || ".";
  info("\nNext steps:");
  if (template === "wgpu") {
    info(`  cd ${rel}/app`);
    info("  cargo run --release        # opens a window with the 3D + 2D demo");
  } else {
    info(`  cd ${rel}`);
    info("  flutter create . --platforms=android,ios,linux,macos,windows,web \\");
    info("    --project-name " + path.basename(dest));
    info("  flutter_rust_bridge_codegen generate");
    info("  flutter pub get && flutter run");
  }
  info("\nSee the generated README.md for the full walkthrough.");
}

main().catch((e) => die(e?.stack || String(e)));
