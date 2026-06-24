// =============================================================================
// Elpa SDK — Reactivity
// -----------------------------------------------------------------------------
// The stateful building blocks layered on top of the render-scope machinery:
//
//   * Component — a self-contained, repaint-isolated piece of UI. It renders into
//                 its own scope (a `boundary`), holds local `state`, and on
//                 `setState(...)` re-renders ONLY itself via a `flutter.patch`.
//                 Subclasses implement `build()` returning a `Widget`.
//   * Signal    — a single observable value with listeners; the smallest unit of
//                 shared, reactive state between components.
//   * Store     — an observable bag of named values for app-wide model state.
//
// A Component's isolation is real: a `setState` marks only its Flutter element
// dirty and its surrounding RepaintBoundary confines the repaint — siblings and
// ancestors are neither rebuilt nor repainted (see `dsl/cache.dart`).
// =============================================================================

/// A stateful, isolated piece of UI. Give it a unique scope key, keep a reference
/// to the instance (so its state and mounted scope persist across patches), and
/// implement `build()`.
class Component extends Widget {
  constructor(scopeKey) {
    super("Fragment", NIL);
    this.key = scopeKey;
    this.state = {};
    this._rev = 0;
  }

  /// Override to return the widget tree for this component.
  build() {
    return new Text("");
  }

  /// Mutate state (optional callback receives `this.state`) and re-render only
  /// this component in place.
  setState(mutator) {
    if (!isNull(mutator)) mutator(this.state);
    this._rev = this._rev + 1;
    if (!isNull(ELPA_APP)) ELPA_APP.patch(this);
  }

  /// Force a re-render of just this component without mutating state.
  invalidate() {
    this.setState(NIL);
  }

  toJson(env) {
    // Render the subtree under this component's own scope so an isolated patch
    // only clears and re-registers this component's handlers.
    env.bus.clearScope(this.key);
    let childEnv = env.child(this.key);
    let root = this.build();
    let node = root.toJson(childEnv);
    node.key = this.key;
    node.boundary = true;
    node.rev = this._rev;
    return node;
  }
}

/// A single observable value. `listen` to be called on every `write`.
class Signal {
  constructor(initial) {
    this.value = initial;
    this.listeners = [];
  }
  read() {
    return this.value;
  }
  write(next) {
    this.value = next;
    let ls = this.listeners;
    for (let i = 0; i < len(ls); i++) {
      ls[i](next);
    }
  }
  listen(fn) {
    push(this.listeners, fn);
  }
}

/// An observable bag of named values for shared model state.
class Store {
  constructor(initial) {
    this.data = isNull(initial) ? {} : initial;
    this.listeners = [];
  }
  read(propName) {
    return this.data[propName];
  }
  write(propName, val) {
    this.data[propName] = val;
    this._notify();
  }
  subscribe(fn) {
    push(this.listeners, fn);
  }
  _notify() {
    for (let i = 0; i < len(this.listeners); i++) {
      this.listeners[i](this.data);
    }
  }
}
