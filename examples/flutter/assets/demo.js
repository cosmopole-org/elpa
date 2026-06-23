// Elpa Flutter — demo app (step 5: a Material app).
//
// A faithful little Flutter app: MaterialApp provides a Theme (an
// InheritedWidget), Scaffold lays out an AppBar over a body, a StatefulWidget
// holds the counter, ElevatedButton taps fire setState, an Icon and a
// CustomPaint (dart:ui) round out the catalog. The whole loop — build → element
// reconcile → render layout → dart:ui paint → GPU submit — runs on the Elpa VM.

class Sparkline extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "Sparkline"; }
    build(context) {
        let color = this.p.color;
        return CustomPaint({
            height: 70.0,
            painter: (canvas, sz) => {
                let pts = [0.2, 0.5, 0.35, 0.7, 0.55, 0.9, 0.65, 1.0];
                let path0 = path();
                let n = len(pts);
                let i = 0;
                while (i < n) {
                    let x = sz.width * (num(i) / (n - 1.0));
                    let y = sz.height * (1.0 - pts[i]) * 0.9 + 4.0;
                    if (i == 0) { path0.moveTo(x, y); } else { path0.lineTo(x, y); }
                    i = i + 1;
                }
                canvas.drawPath(path0, paintStroke(color, 3.0));
            },
        });
    }
}

class HomePage extends StatefulWidget {
    constructor(p) { super(p); }
    typeName() { return "HomePage"; }
    createState() { return new HomeState(); }
}
class HomeState extends State {
    initState() { this.count = 0; }
    build(context) {
        let self = this;
        let theme = themeOf(context);
        let label = concat("You tapped  ", str(this.count));
        return Scaffold({
            appBar: AppBar({ title: "Flutter on Elpa" }),
            body: Center({
                child: SizedBox({
                    width: 380.0,
                    child: Column({
                        mainAxisSize: "min", crossAxisAlignment: "stretch",
                        children: [
                            Container({
                                margin: edgeAll(16.0), padding: edgeAll(18.0),
                                decoration: {
                                    gradient: linearGradient(offset(-1.0, -1.0), offset(1.0, 1.0), [Colors.deepPurple, Colors.indigo], 0),
                                    borderRadius: 20.0,
                                    boxShadow: [{ color: withOpacity(Colors.black, 0.3), blur: 18.0, dy: 8.0 }],
                                },
                                child: Column({
                                    mainAxisSize: "min", crossAxisAlignment: "start",
                                    children: [
                                        Row({
                                            children: [
                                                new IconWidget({ icon: "favorite", size: 22.0, color: Colors.white }),
                                                SizedBox({ width: 8.0 }),
                                                Text("Material 3", { fontSize: 18.0, color: Colors.white }),
                                            ],
                                        }),
                                        SizedBox({ height: 10.0 }),
                                        Text("A faithful, layered port of Flutter.", { fontSize: 13.0, color: withOpacity(Colors.white, 0.92) }),
                                        SizedBox({ height: 12.0 }),
                                        new Sparkline({ color: Colors.amber }),
                                    ],
                                }),
                            }),
                            SizedBox({ height: 8.0 }),
                            Text(label, { fontSize: 20.0, color: theme.onSurface, textAlign: "center" }),
                            SizedBox({ height: 14.0 }),
                            Center({
                                child: ElevatedButton({
                                    label: "TAP ME",
                                    onPressed: () => { self.setState(() => { self.count = self.count + 1; }); },
                                }),
                            }),
                        ],
                    }),
                }),
            }),
        });
    }
}

runApp(MaterialApp({ theme: darkTheme(), home: new HomePage({}) }));
