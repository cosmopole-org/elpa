// The demo Elpa application.
//
// It runs entirely on the Elpian VM and drives the Flutter UI through the
// messaging pipe: it streams a widget-tree description on the `flutter.render`
// channel and receives user events on `flutter.event`. No Dart code knows what
// this app does — the UI is data, authored here.
//
// Caching is demonstrated via `rev`: the count Text bumps its `rev` every render
// so it rebuilds, while the button Row keeps `rev: 0` so Flutter reuses the
// previously-built buttons untouched.

var count = 0;

function ui() {
  return {
    type: "Scaffold",
    key: "root",
    props: { title: "Elpa + Rust + Flutter" },
    children: [
      {
        type: "Center",
        props: { slot: "body" },
        children: [
          {
            type: "Column",
            key: "col",
            props: { mainAxisAlignment: "center", crossAxisAlignment: "center" },
            children: [
              {
                type: "Text",
                key: "count",
                rev: count,
                props: { text: "Count: " + count, style: { size: 32.0, bold: true } }
              },
              { type: "SizedBox", props: { height: 24.0 } },
              {
                type: "Row",
                key: "buttons",
                rev: 0,
                props: { mainAxisAlignment: "center", shrink: true },
                children: [
                  { type: "Button", key: "dec", props: { label: " - " }, events: { onTap: "dec" } },
                  { type: "SizedBox", props: { width: 16.0 } },
                  { type: "Button", key: "inc", props: { label: " + " }, events: { onTap: "inc" } }
                ]
              }
            ]
          }
        ]
      }
    ]
  };
}

function render() {
  askHost("host.send", ["flutter.render", ui()]);
}

// First frame.
render();

// Inbound events from Flutter (taps) arrive here.
function onHostMessage(msg) {
  if (msg.channel === "flutter.event") {
    var handler = msg.message.handler;
    if (handler === "inc") { count = count + 1; render(); }
    else if (handler === "dec") { count = count - 1; render(); }
  }
}
