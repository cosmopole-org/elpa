// =============================================================================
// Elpa SDK — Application runtime
// -----------------------------------------------------------------------------
// `App` ties the SDK together: it owns the host services (`Host`, `Gpu`), the
// event bus, the scheduler, the navigator and the theme; it drives full renders
// and scoped patches; and it fans the VM lifecycle callbacks
// (`onHostMessage` / `onFrame` / `onResize`) into the SDK.
//
// This module is loaded LAST (after every class `App` constructs), because the
// VM resolves a forward reference to a not-yet-defined class as null — and the
// constructor makes a *static* call (`Theme.telegramDark()`) plus several `new`s
// into the later modules.
// =============================================================================

class App {
  constructor() {
    this.host = new Host();
    this.bus = new EventBus();
    this.gpu = new Gpu(this.host);
    this.scheduler = new Scheduler(this);
    this.navigator = new Navigator(this);
    this.theme = Theme.telegramDark();
    this.surface = {
      width: 0,
      height: 0,
      scaleFactor: 1,
      logicalWidth: 0,
      logicalHeight: 0,
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    };
    this.rootBuilder = NIL;
    this.resizeListeners = [];
    ELPA_APP = this;
  }

  /// Register the function that builds the root widget tree (usually
  /// `() => app.navigator.build()`), then render the first frame.
  start(rootBuilder) {
    this.rootBuilder = rootBuilder;
    this.render();
  }

  /// Re-render the entire tree under the "root" scope. Components inside switch to
  /// their own scopes, so the rev cache and isolated patching still apply.
  render() {
    // No-op until a root builder is installed (so navigation can seed the stack
    // before `start()` without rendering a half-built app).
    if (isNull(this.rootBuilder)) return;
    let widget = this.rootBuilder();
    this.bus.clearScope("root");
    let env = new BuildEnv(this.bus, "root");
    let node = widget.toJson(env);
    this.host.send(CH_RENDER, node);
  }

  /// Re-render a single mounted Component in place (a scoped `flutter.patch`).
  /// Only this component's subtree and handlers are rebuilt; the rest of the tree
  /// is neither re-serialized nor repainted.
  patch(component) {
    let env = new BuildEnv(this.bus, "root");
    let node = component.toJson(env);
    this.host.send(CH_PATCH, { key: component.key, node: node });
  }

  /// Subscribe to surface-size / safe-area changes (orientation, keyboard).
  onResize(listener) {
    push(this.resizeListeners, listener);
  }

  // ---- VM lifecycle entry points (wired from the top-level handlers) ---------

  handleHostMessage(msg) {
    if (msg.channel === CH_EVENT) {
      this.bus.dispatch(msg.message.handler, msg.message);
    }
  }

  handleFrame(dt) {
    this.scheduler.tick(dt);
  }

  handleResize(info) {
    this.surface = info;
    for (let i = 0; i < len(this.resizeListeners); i++) {
      this.resizeListeners[i](info);
    }
  }
}
