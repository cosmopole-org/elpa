// =============================================================================
// Elpa SDK — Navigation
// -----------------------------------------------------------------------------
// A stack-based router. A `Page` builds a full screen (a `Scaffold`); the
// `Navigator` keeps a stack of live page instances and renders the top one.
// `push` / `pop` / `replace` / `reset` move between screens and trigger a full
// re-render — but components inside a page keep their state across patches because
// the page instance (and its component fields) live on the stack.
//
// Pages get lifecycle hooks: `onEnter()` when pushed/shown, `onLeave()` when
// popped — the place to start/stop timers, subscriptions and animations.
// =============================================================================

/// Base class for a screen. Subclass and implement `build()` to return the page's
/// widget tree (usually a `Scaffold`). Construct child components in the
/// constructor and reference them from `build()` so their state persists.
class Page {
  constructor(name) {
    this.name = name;
    this.app = ELPA_APP;
  }
  /// Override: return this page's widget tree.
  build() {
    return new Scaffold();
  }
  /// Called when the page becomes the active (top) screen.
  onEnter() {}
  /// Called when the page is popped off the stack.
  onLeave() {}
}

/// The stack-based router. One per app (`app.navigator`).
class Navigator {
  constructor(app) {
    this.app = app;
    this.stack = [];
  }

  current() {
    if (len(this.stack) === 0) return NIL;
    return this.stack[len(this.stack) - 1];
  }

  depth() {
    return len(this.stack);
  }

  /// Seed the initial page WITHOUT rendering (call before `app.start`).
  mount(page) {
    push(this.stack, page);
    page.onEnter();
    return this;
  }

  push(page) {
    push(this.stack, page);
    page.onEnter();
    this.app.render();
  }

  pop() {
    if (len(this.stack) <= 1) return;
    let top = this.stack[len(this.stack) - 1];
    top.onLeave();
    pop(this.stack);
    this.app.render();
  }

  replace(page) {
    if (len(this.stack) > 0) {
      let top = this.stack[len(this.stack) - 1];
      top.onLeave();
      pop(this.stack);
    }
    push(this.stack, page);
    page.onEnter();
    this.app.render();
  }

  /// Clear the whole stack and start fresh at `page`.
  reset(page) {
    for (let i = 0; i < len(this.stack); i++) {
      this.stack[i].onLeave();
    }
    this.stack = [page];
    page.onEnter();
    this.app.render();
  }

  build() {
    let page = this.current();
    if (isNull(page)) return new Scaffold().background("#000000");
    return page.build();
  }
}
