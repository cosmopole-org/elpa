// =============================================================================
// Elpa SDK — Timing
// -----------------------------------------------------------------------------
// Time and animation, backed by the Rust host's frame pump and clock. The render
// host advances an internal monotonic clock on every animation frame and calls
// the guest's `onFrame(dt)`; the Scheduler rides that pump:
//
//   * it asks the shell to run the animation ticker only while work is pending
//     (`flutter.tick {on:true}`) and stops it when idle, so an idle UI costs
//     nothing per vsync;
//   * `setTimeout` / `setInterval` schedule one-shot / repeating callbacks
//     measured in real host time;
//   * `Animation` tweens a value over a duration with an easing curve, calling
//     back each frame — the basis for typing indicators, fades, slide-ins.
//
// This is the SDK realisation of "timing backed by Rust Elpian timers as a host
// feature": the timers are paced by the host's frame/clock, not by busy-waiting.
// =============================================================================

/// Easing curves (t in [0,1] -> eased t).
class Ease {
  static linear(t) { return t; }
  static inOut(t) {
    if (t < 0.5) return 2.0 * t * t;
    let u = (t - 1.0);
    return 1.0 - 2.0 * u * u;
  }
  static out(t) {
    let u = 1.0 - t;
    return 1.0 - u * u;
  }
  static inCurve(t) { return t * t; }
}

/// A value tween: animates `from -> to` over `durationMs`, calling `onUpdate(v)`
/// every frame and `onDone()` at the end. Driven by the Scheduler.
class Animation {
  constructor(from, to, durationMs) {
    this.from = from;
    this.to = to;
    this.duration = durationMs;
    this.elapsed = 0;
    this.easing = Ease.inOut;
    this.onUpdate = NIL;
    this.onDone = NIL;
    this.loop = false;
    this.done = false;
  }
  curve(fn) { this.easing = fn; return this; }
  repeat() { this.loop = true; return this; }
  update(fn) { this.onUpdate = fn; return this; }
  whenDone(fn) { this.onDone = fn; return this; }

  /// Advance by `dt` ms; returns false when finished (and not looping).
  step(dt) {
    this.elapsed = this.elapsed + dt;
    let t = this.duration <= 0 ? 1.0 : this.elapsed / this.duration;
    if (t >= 1.0) {
      if (this.loop) {
        this.elapsed = 0;
        t = 0.0;
      } else {
        t = 1.0;
      }
    }
    let e = this.easing(t);
    let v = this.from + (this.to - this.from) * e;
    if (!isNull(this.onUpdate)) this.onUpdate(v);
    if (t >= 1.0 && !this.loop) {
      this.done = true;
      if (!isNull(this.onDone)) this.onDone();
      return false;
    }
    return true;
  }
}

/// Drives timers and animations off the host frame pump.
class Scheduler {
  constructor(app) {
    this.app = app;
    this.timers = [];
    this.animations = [];
    this.nextId = 1;
    this.running = false;
    this.clock = 0;
  }

  _ensureTicker() {
    if (!this.running) {
      this.running = true;
      this.app.host.send(CH_TICK, { on: true });
    }
  }

  _maybeStop() {
    if (this.running && len(this.timers) === 0 && len(this.animations) === 0) {
      this.running = false;
      this.app.host.send(CH_TICK, { on: false });
    }
  }

  /// Run `fn` once after `ms`. Returns a timer id for `cancel`.
  setTimeout(fn, ms) {
    return this._add(fn, ms, false);
  }

  /// Run `fn` every `ms`. Returns a timer id for `cancel`.
  setInterval(fn, ms) {
    return this._add(fn, ms, true);
  }

  _add(fn, ms, repeating) {
    let id = this.nextId;
    this.nextId = id + 1;
    push(this.timers, {
      id: id,
      fn: fn,
      due: this.clock + ms,
      interval: ms,
      repeat: repeating,
    });
    this._ensureTicker();
    return id;
  }

  cancel(id) {
    let kept = [];
    for (let i = 0; i < len(this.timers); i++) {
      if (this.timers[i].id !== id) push(kept, this.timers[i]);
    }
    this.timers = kept;
    this._maybeStop();
  }

  /// Start an animation; it runs until finished (or forever if looping).
  animate(animation) {
    push(this.animations, animation);
    this._ensureTicker();
    return animation;
  }

  /// Called from `App.handleFrame` on every host frame.
  tick(dt) {
    this.clock = this.clock + dt;

    // Fire due timers. Collect first so a callback that schedules/cancels does
    // not disturb the in-progress scan.
    let due = [];
    for (let i = 0; i < len(this.timers); i++) {
      if (this.clock >= this.timers[i].due) push(due, this.timers[i]);
    }
    for (let i = 0; i < len(due); i++) {
      let t = due[i];
      if (t.repeat) {
        t.due = this.clock + t.interval;
        t.fn();
      } else {
        this.cancel(t.id);
        t.fn();
      }
    }

    // Advance animations, dropping the finished ones.
    if (len(this.animations) > 0) {
      let live = [];
      for (let i = 0; i < len(this.animations); i++) {
        let a = this.animations[i];
        if (a.step(dt)) push(live, a);
      }
      this.animations = live;
    }

    this._maybeStop();
  }
}
