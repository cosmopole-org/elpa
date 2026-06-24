// =============================================================================
// __APP_TITLE__ — Elpa + Flutter demo (a rich 2D UI)
// -----------------------------------------------------------------------------
// A small dashboard app authored entirely in JavaScript on the Elpian VM and
// streamed to real Flutter widgets over the message pipe. It shows the core of
// the Elpa SDK (see assets/app/sdk/):
//
//   * declarative widgets    — Scaffold / Column / Row / Container / Text / ...
//   * isolated components     — a counter, a live greeter and a task list, each
//                               its own repaint scope that patches only itself
//   * a live theme switch     — dark / light, re-rendering the whole tree
//
// The 3D native-widget path is not used here; see the `wgpu-flutter` template for
// a demo that hosts a 3D scene inside an Elpa Native3DView.
// =============================================================================

var app = new App();

var darkMode = true;
function colors() { return app.theme.colors; }

// ---- a reusable "card" container --------------------------------------------
function card(title, body) {
  let c = colors();
  return new Container({
    color: c.surface,
    radius: 14.0,
    padding: 16.0,
    margin: { left: 16.0, right: 16.0, top: 8.0, bottom: 8.0 },
    child: new Column({
      crossAxisAlignment: "stretch",
      children: [
        new Text(title, { size: 13.0, bold: true, color: c.textSecondary }),
        new SizedBox({ height: 12.0 }),
        body,
      ],
    }),
  });
}

// ---- a pill button (Tappable + Container, so we can style it) ----------------
function pill(label, bg, fg, onTap) {
  return new Tappable({
    onTap: onTap,
    child: new Container({
      color: bg,
      radius: 10.0,
      padding: { left: 16.0, right: 16.0, top: 10.0, bottom: 10.0 },
      alignment: "center",
      child: new Text(label, { bold: true, color: fg }),
    }),
  });
}

// ---- counter: an isolated component that patches only itself -----------------
class CounterCard extends Component {
  constructor() {
    super("scope.counter");
    this.state = { count: 0 };
  }
  bump(by) { this.setState((s) => { s.count = s.count + by; }); }
  build() {
    let c = colors();
    return card("COUNTER", new Row({
      mainAxisAlignment: "spaceBetween",
      children: [
        pill("–", c.surfaceVariant, c.textPrimary, () => this.bump(-1)),
        new Text(str(this.state.count), { size: 30.0, bold: true, color: c.textPrimary }),
        pill("+", c.primary, "#FFFFFF", () => this.bump(1)),
      ],
    }));
  }
}

// ---- greeter: a text field whose value echoes into a live greeting -----------
class GreeterCard extends Component {
  constructor() {
    super("scope.greeter");
    this.state = { name: "" };
  }
  build() {
    let c = colors();
    let name = trim(this.state.name);
    let greeting = len(name) === 0 ? "Type your name…" : ("Hello, " + name + " 👋");
    return card("GREETER", new Column({
      crossAxisAlignment: "stretch",
      children: [
        new Field({
          key: "greeter.field",
          value: this.state.name,
          hint: "Your name",
          fillColor: c.surfaceVariant,
          textColor: c.textPrimary,
          hintColor: c.textSecondary,
          radius: 10.0,
          onChanged: (p) => { this.setState((s) => { s.name = p.value; }); },
        }),
        new SizedBox({ height: 12.0 }),
        new Text(greeting, { size: 18.0, color: c.textPrimary }),
      ],
    }));
  }
}

// ---- task list: add items and toggle them done -------------------------------
class TasksCard extends Component {
  constructor() {
    super("scope.tasks");
    this.state = {
      draft: "",
      clearNonce: 0,
      items: [
        { text: "Read the Elpa README", done: true },
        { text: "Run flutter run", done: false },
        { text: "Edit assets/app/main.js", done: false },
      ],
    };
  }
  add() {
    let t = trim(this.state.draft);
    if (len(t) === 0) return;
    this.setState((s) => {
      push(s.items, { text: t, done: false });
      s.draft = "";
      s.clearNonce = s.clearNonce + 1;
    });
  }
  toggle(i, on) { this.setState((s) => { s.items[i].done = on; }); }
  build() {
    let c = colors();
    let rows = [];
    for (let i = 0; i < len(this.state.items); i++) {
      let idx = i;
      let it = this.state.items[i];
      push(rows, new Padding({
        padding: { top: 4.0, bottom: 4.0 },
        child: new Row({
          children: [
            new Switcher({ key: "task." + str(idx), value: it.done, onChanged: (p) => this.toggle(idx, p.value) }),
            new SizedBox({ width: 8.0 }),
            new Expanded({ child: new Text(it.text, {
              color: it.done ? c.textSecondary : c.textPrimary,
              italic: it.done,
            }) }),
          ],
        }),
      }));
    }
    push(rows, new SizedBox({ height: 8.0 }));
    push(rows, new Row({
      children: [
        new Expanded({ child: new Field({
          key: "tasks.draft",
          value: this.state.draft,
          hint: "New task",
          clearNonce: this.state.clearNonce,
          clearOnSubmit: true,
          fillColor: c.surfaceVariant,
          textColor: c.textPrimary,
          hintColor: c.textSecondary,
          radius: 10.0,
          onChanged: (p) => { this.state.draft = p.value; },
          onSubmitted: (p) => { this.state.draft = p.value; this.add(); },
        }) }),
        new SizedBox({ width: 10.0 }),
        pill("ADD", c.primary, "#FFFFFF", () => this.add()),
      ],
    }));
    return card("TASKS", new Column({ crossAxisAlignment: "stretch", children: rows }));
  }
}

// ---- the home page -----------------------------------------------------------
class HomePage extends Page {
  constructor() {
    super("__APP_TITLE__");
    this.counter = new CounterCard();
    this.greeter = new GreeterCard();
    this.tasks = new TasksCard();
  }
  header() {
    let c = colors();
    return new Container({
      color: c.primary,
      padding: { left: 16.0, right: 12.0, top: 48.0, bottom: 16.0 },
      child: new Row({
        mainAxisAlignment: "spaceBetween",
        children: [
          new Text("__APP_TITLE__", { size: 20.0, bold: true, color: "#FFFFFF" }),
          new Row({
            shrink: true,
            children: [
              new Icon("palette", { size: 18.0, color: "#FFFFFF" }),
              new SizedBox({ width: 6.0 }),
              new Switcher({ key: "theme.switch", value: darkMode, onChanged: (p) => toggleTheme(p.value) }),
            ],
          }),
        ],
      }),
    });
  }
  build() {
    let c = colors();
    return new Scaffold({
      backgroundColor: c.background,
      body: new Column({
        crossAxisAlignment: "stretch",
        children: [
          this.header(),
          new Expanded({ child: new ListView({
            padding: { top: 8.0, bottom: 24.0 },
            children: [this.counter, this.greeter, this.tasks],
          }) }),
        ],
      }),
    });
  }
}

// ---- theme switching ---------------------------------------------------------
function toggleTheme(wantDark) {
  darkMode = wantDark;
  app.theme = wantDark ? Theme.telegramDark() : Theme.telegramLight();
  app.render();
}

// ---- bootstrap + VM lifecycle ------------------------------------------------
app.navigator.mount(new HomePage());
app.start(() => app.navigator.build());

function onHostMessage(msg) { app.handleHostMessage(msg); }
function onFrame(dt) { app.handleFrame(dt); }
function onResize(info) { app.handleResize(info); }
