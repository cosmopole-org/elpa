// Elpa Flutter — demo app (step 4: gestures + setState).
//
// A real interactive Flutter app: a StatefulWidget holds a counter, a
// GestureDetector tap fires `setState`, which marks the element dirty; the
// BuildOwner rebuilds just that subtree, the reconciler reuses the render
// objects, layout/paint re-run, and the new frame is submitted — the whole
// Flutter loop (build → element → render → layout → paint), driven by a tap.

class FeatureCard extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "FeatureCard"; }
    build(context) {
        return Container({
            padding: edgeAll(16.0),
            decoration: {
                gradient: linearGradient(offset(-1.0, -1.0), offset(1.0, 1.0), this.p.colors, 0),
                borderRadius: 18.0,
                boxShadow: [{ color: withOpacity(Colors.black, 0.28), blur: 16.0, dy: 6.0 }],
            },
            child: Column({
                mainAxisSize: "min", crossAxisAlignment: "start",
                children: [
                    Text(this.p.title, { fontSize: 18.0, color: Colors.white }),
                    SizedBox({ height: 6.0 }),
                    Text(this.p.body, { fontSize: 12.0, color: withOpacity(Colors.white, 0.9) }),
                ],
            }),
        });
    }
}

class CounterApp extends StatefulWidget {
    constructor(p) { super(p); }
    typeName() { return "CounterApp"; }
    createState() { return new CounterState(); }
}
class CounterState extends State {
    initState() { this.count = 0; }
    build(context) {
        let self = this;
        let label = concat("TAPS  ", str(this.count));
        return Container({
            color: colorRGBO(18, 20, 28, 1.0),
            child: Center({
                child: SizedBox({
                    width: 360.0,
                    child: Column({
                        mainAxisSize: "min", crossAxisAlignment: "stretch",
                        children: [
                            Text("FLUTTER ON ELPA", { fontSize: 24.0, color: Colors.white, textAlign: "center" }),
                            SizedBox({ height: 16.0 }),
                            new FeatureCard({ title: "WIDGETS", body: "Immutable config, reconciled elements.", colors: [Colors.deepPurple, Colors.indigo] }),
                            SizedBox({ height: 12.0 }),
                            new FeatureCard({ title: "RENDERING", body: "Constraints down, sizes up.", colors: [Colors.teal, Colors.blue] }),
                            SizedBox({ height: 20.0 }),
                            Text(label, { fontSize: 22.0, color: Colors.amber, textAlign: "center" }),
                            SizedBox({ height: 12.0 }),
                            GestureDetector({
                                onTap: () => { self.setState(() => { self.count = self.count + 1; }); },
                                child: Container({
                                    padding: edgeSymmetric(20.0, 14.0),
                                    color: Colors.deepPurple, borderRadius: 14.0,
                                    child: Text("TAP ME", { fontSize: 16.0, color: Colors.white, textAlign: "center" }),
                                }),
                            }),
                        ],
                    }),
                }),
            }),
        });
    }
}

runApp(new CounterApp({}));
