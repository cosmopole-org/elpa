// The demo Elpa application — multi-widget, multi-scope.
//
// It runs entirely on the Elpian VM and drives the Flutter UI through the
// messaging pipe. The UI is split into independent **render scopes** (nodes
// marked `boundary: true`): two counters and an animated clock. Each scope is
// updated on its own channel with `flutter.patch`, so a change to one scope
// rerenders ONLY that scope — the others (and the shell) are untouched.
//
//   • initial layout      → flutter.render (full tree, once)
//   • "Increment A" tap    → flutter.patch "counterA"   (only A rebuilds)
//   • "Increment B" tap    → flutter.patch "counterB"   (only B rebuilds)
//   • every animation tick → flutter.patch "clock"      (only the clock rebuilds)

var a = 0;
var b = 0;
var ticks = 0;

// One counter, as a self-contained render scope (boundary). Its key is the scope
// address the host patches; `rev` lets the inner Text memoize across rebuilds.
function counterScope(key, label, value, handler) {
  return {
    type: "Column",
    key: key,
    boundary: true,
    rev: value,
    props: { mainAxisAlignment: "center", crossAxisAlignment: "center", shrink: true },
    children: [
      {
        type: "Text",
        key: key + ".text",
        rev: value,
        props: { text: label + ": " + value, style: { size: 28.0, bold: true } }
      },
      { type: "SizedBox", props: { height: 8.0 } },
      {
        type: "Button",
        key: key + ".btn",
        props: { label: "Increment " + label },
        events: { onTap: handler }
      }
    ]
  };
}

// An animated render scope: it repaints every frame but, being its own scope,
// never forces the counters or the shell to rebuild.
function clockScope() {
  return {
    type: "Text",
    key: "clock",
    boundary: true,
    rev: ticks,
    props: { text: "frames rendered in the clock scope: " + ticks, style: { size: 14.0 } }
  };
}

// The full layout, composed of the scopes above plus static chrome.
function fullUi() {
  return {
    type: "Scaffold",
    key: "root",
    props: { title: "Elpa multi-scope demo" },
    children: [
      {
        type: "Center",
        props: { slot: "body" },
        children: [
          {
            type: "Column",
            key: "col",
            props: { mainAxisAlignment: "center", crossAxisAlignment: "center", shrink: true },
            children: [
              {
                type: "Text",
                key: "header",
                rev: 0,
                props: { text: "Each counter is its own render scope", style: { size: 16.0, bold: true } }
              },
              { type: "SizedBox", props: { height: 24.0 } },
              counterScope("counterA", "A", a, "incA"),
              { type: "SizedBox", props: { height: 16.0 } },
              counterScope("counterB", "B", b, "incB"),
              { type: "SizedBox", props: { height: 24.0 } },
              clockScope()
            ]
          }
        ]
      }
    ]
  };
}

function send(channel, message) {
  askHost("host.send", [channel, message]);
}

function patch(key, node) {
  send("flutter.patch", { key: key, node: node });
}

// Initial full render, then ask the shell to run the animation ticker (which
// only drives the clock scope).
send("flutter.render", fullUi());
send("flutter.tick", { on: true });

// Inbound taps from Flutter: patch just the affected scope.
function onHostMessage(msg) {
  if (msg.channel === "flutter.event") {
    var handler = msg.message.handler;
    if (handler === "incA") {
      a = a + 1;
      patch("counterA", counterScope("counterA", "A", a, "incA"));
    } else if (handler === "incB") {
      b = b + 1;
      patch("counterB", counterScope("counterB", "B", b, "incB"));
    }
  }
}

// Each animation tick repaints only the clock scope.
function onFrame(dt) {
  ticks = ticks + 1;
  patch("clock", clockScope());
}
