// Elpa Flutter — demo app (step 3: the widgets layer).
//
// A real widget tree, mounted with `runApp`. The widgets inflate into an element
// tree that builds the render tree from step 2; StatelessWidget composition
// (Container), MultiChild reconciliation (Row/Column), ParentData widgets
// (Expanded) and a leaf (Text) all run through the faithful element machinery.

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
                    Text(this.p.title, { fontSize: 20.0, color: Colors.white }),
                    SizedBox({ height: 8.0 }),
                    Text(this.p.body, { fontSize: 13.0, color: withOpacity(Colors.white, 0.9) }),
                ],
            }),
        });
    }
}

class App extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "App"; }
    build(context) {
        return Container({
            color: colorRGBO(20, 22, 30, 1.0),
            child: Center({
                child: SizedBox({
                    width: 360.0,
                    child: Column({
                        mainAxisSize: "min", crossAxisAlignment: "stretch",
                        children: [
                            Text("FLUTTER ON ELPA", { fontSize: 26.0, color: Colors.white, textAlign: "center" }),
                            SizedBox({ height: 18.0 }),
                            new FeatureCard({ title: "WIDGETS", body: "Immutable config inflates an element tree.", colors: [Colors.deepPurple, Colors.indigo] }),
                            SizedBox({ height: 12.0 }),
                            new FeatureCard({ title: "RENDERING", body: "Constraints down, sizes up, parent positions.", colors: [Colors.teal, Colors.blue] }),
                            SizedBox({ height: 16.0 }),
                            Row({
                                children: [
                                    Expanded({ flex: 2.0, child: Container({ height: 40.0, color: withOpacity(Colors.white, 0.18), borderRadius: 8.0 }) }),
                                    SizedBox({ width: 10.0 }),
                                    Expanded({ flex: 1.0, child: Container({ height: 40.0, color: withOpacity(Colors.white, 0.34), borderRadius: 8.0 }) }),
                                ],
                            }),
                        ],
                    }),
                }),
            }),
        });
    }
}

runApp(new App({}));
