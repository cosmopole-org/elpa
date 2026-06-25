// =============================================================================
// Elpa SDK — Core runtime
// -----------------------------------------------------------------------------
// The foundation every other SDK module builds on. It contains:
//
//   * Host    — a typed facade over the VM's `askHost(api, payload)` seam. Every
//               capability the Rust host exposes (the message pipe, the clock,
//               randomness, storage, networking, the GPU) is reached through one
//               small, documented object instead of scattered `askHost` strings.
//   * EventBus — turns widget callback *closures* into the string handler ids the
//               wire protocol carries, and routes inbound `flutter.event`s back to
//               the right closure. Handlers are namespaced per render scope so an
//               isolated patch only re-registers its own handlers.
//   * BuildEnv — the per-build context threaded through `Widget.toJson`; it knows
//               the current scope and registers events into the bus.
//   * App     — the single application runtime: owns the host, the event bus, the
//               scheduler, the navigator and the theme; drives full renders and
//               scoped patches; and fans the VM lifecycle callbacks
//               (`onHostMessage` / `onFrame` / `onResize`) out to the SDK.
//
// The SDK is authored in the Elpian JS subset: classes, closures and arrow
// functions are fine; array/string helpers are the function-style builtins
// (`len(a)`, `push(a, x)`, `keys(o)`, `has(o, k)`, `split(s, sep)`, `str(x)`).
// =============================================================================

// The canonical "no value" sentinel. The Elpian VM compiles the `null`/`undefined`
// keywords to the integer 0, which the `isNull` builtin does NOT recognise as null
// (it tests the real Null type). Reading an unset field, by contrast, yields a real
// null — so we capture one here and use `NIL` everywhere a true null is meant, and
// `isNull(x)` to test for it.
var NIL = ({}).nothing;

// The live application instance. Components reach it for scoped patching without
// threading a reference through every constructor. Set by `App`'s constructor.
var ELPA_APP = NIL;

// Reserved pipe channels — the Elpa <-> Flutter contract (mirrors the Rust
// `engine::channel` module and the Dart shell's subscriptions).
var CH_RENDER = "flutter.render";
var CH_PATCH = "flutter.patch";
var CH_INVALIDATE = "flutter.invalidate";
var CH_DEFINE = "flutter.define";
var CH_EVENT = "flutter.event";
var CH_TICK = "flutter.tick";

/// Typed facade over the host-call seam. One instance lives on the `App`.
class Host {
  // ---- The custom messaging pipe (guest -> host) ----------------------------

  /// Fire-and-forget: push a message out on a pipe channel.
  send(channel, message) {
    askHost("host.send", [channel, message]);
  }

  /// Synchronous round-trip: returns the host's reply value (or NIL when no
  /// responder is installed).
  request(channel, message) {
    return askHost("host.request", [channel, message]);
  }

  /// Diagnostic log line, drained by the host's `takeLog`.
  log(message) {
    askHost("log", [message]);
  }

  // ---- Clock (capability-gated `time.*`) ------------------------------------
  // The host clock is advanced by the render host on every animation frame, so
  // it is a real, monotonic, host-backed timer — the substrate the Scheduler and
  // animations measure against. Returns milliseconds.

  /// Wall-ish time in ms (monotonic on this host; advances with frames).
  now() {
    let reply = askHost("time.now", []);
    if (isNull(reply)) return 0;
    if (isNull(reply.ms)) return 0;
    return reply.ms;
  }

  /// Monotonic time in ms (never goes backwards).
  monotonic() {
    let reply = askHost("time.monotonic", []);
    if (isNull(reply)) return 0;
    if (isNull(reply.ms)) return 0;
    return reply.ms;
  }

  // ---- Randomness (capability-gated `random.*`) -----------------------------

  /// A uniform random number in [0, 1). Falls back to 0 when randomness is not
  /// provisioned, so callers stay correct on a locked-down host.
  random() {
    let reply = askHost("random.next", []);
    if (isNull(reply)) return 0;
    if (isNull(reply.value)) return 0;
    return reply.value;
  }

  /// A random integer in [lo, hi].
  randomInt(lo, hi) {
    return lo + int(this.random() * (hi - lo + 1));
  }

  // ---- Surface geometry -----------------------------------------------------

  surfaceInfo() {
    return askHost("gpu.surfaceInfo", []);
  }

  // ---- Drawing (the Vello scene pipe — see graphics.js for the high-level API) --

  /// Submit a Vello scene: a batch of high-level vector drawing ops (the primary
  /// drawing path). An embedded `rawWgpu` op composites a raw wgpu frame.
  sceneSubmit(scene) {
    askHost("scene.submit", [scene]);
  }

  // ---- GPU (the raw wgpu command pipe — now a `rawWgpu` subset op) -----------

  gpuSubmit(frame) {
    askHost("gpu.submit", [frame]);
  }

  gpuDefine(definition) {
    askHost("gpu.define", [definition]);
  }

  gpuUndefine(id) {
    askHost("gpu.undefine", [id]);
  }

  // ---- Storage (capability-gated `fs.*`) ------------------------------------

  storageWrite(path, data) {
    return askHost("fs.write", [{ path: path, data: data }]);
  }

  storageRead(path) {
    let reply = askHost("fs.read", [{ path: path }]);
    if (isNull(reply)) return NIL;
    if (!reply.ok) return NIL;
    return reply.data;
  }

  storageExists(path) {
    let reply = askHost("fs.exists", [{ path: path }]);
    if (isNull(reply)) return false;
    return reply.exists;
  }
}

/// Translates widget callback closures into wire handler ids and back.
///
/// Handlers are namespaced per render scope (`scope#index`). On every render of a
/// scope its old handlers are cleared and the fresh closures re-registered, so an
/// isolated patch never disturbs a sibling scope's handlers, and the registry
/// stays bounded by the number of live interactive widgets.
class EventBus {
  constructor() {
    this.scopes = {};
  }

  /// Drop every handler registered under `scope` (called before re-rendering it).
  clearScope(scope) {
    this.scopes[scope] = {};
  }

  /// Register a closure under the current scope, returning its wire id.
  register(scope, fn) {
    if (!has(this.scopes, scope)) this.scopes[scope] = {};
    let table = this.scopes[scope];
    let id = scope + "#" + str(len(keys(table)));
    table[id] = fn;
    return id;
  }

  /// Invoke the closure addressed by a wire id, passing the event payload.
  dispatch(id, payload) {
    if (isNull(id)) return;
    let parts = split(id, "#");
    let scope = parts[0];
    if (!has(this.scopes, scope)) return;
    let table = this.scopes[scope];
    if (!has(table, id)) return;
    let fn = table[id];
    fn(payload);
  }
}

/// The context threaded through a widget tree's serialization. It carries the
/// event bus and the scope currently being built; `register` binds a callback to
/// the active scope and yields its wire id.
class BuildEnv {
  constructor(bus, scope) {
    this.bus = bus;
    this.scope = scope;
  }

  /// A child env rooted at a new scope (used when descending into a Component).
  child(scope) {
    return new BuildEnv(this.bus, scope);
  }

  register(fn) {
    return this.bus.register(this.scope, fn);
  }
}

// NOTE: the `App` runtime class lives in `07_app.js` and is loaded LAST, after
// every class it constructs (Host/EventBus/BuildEnv here, plus Gpu, Scheduler,
// Navigator and Theme from later modules). The Elpian VM resolves a *static*
// method call on a class (`Theme.telegramDark()`) at the call site's run time, but
// a forward reference to a class not yet defined resolves to null — so `App` must
// follow its dependencies in load order.
