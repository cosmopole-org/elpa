// The home page: a fixed-height card hosting the native wgpu surface
// (Native3DView), the 3D controls, and an about card.

import { colors } from "./app";
import { card } from "./ui";
import { ControlsCard } from "./cards";

const APP_TITLE = "__APP_TITLE__";

export class HomePage extends Page {
    controls: ControlsCard;

    constructor() {
        super(APP_TITLE);
        this.controls = new ControlsCard();
    }

    header(): any {
        const c = colors();
        return new Container({
            color: c.primary,
            padding: { left: 16.0, right: 16.0, top: 48.0, bottom: 16.0 },
            child: new Text(APP_TITLE, { size: 20.0, bold: true, color: "#FFFFFF" }),
        });
    }

    // A fixed-height region hosting the native wgpu surface (live with the `gpu`
    // feature build; a reserved placeholder otherwise).
    sceneCard(): any {
        return new Container({
            height: 240.0,
            radius: 14.0,
            color: "#0E1621",
            margin: { left: 16.0, right: 16.0, top: 8.0, bottom: 8.0 },
            child: new ClipRRect({ radius: 14.0, child: new Native3DView({ key: "scene.native", height: 240.0 }) }),
        });
    }

    build(): any {
        const c = colors();
        return new Scaffold({
            backgroundColor: c.background,
            body: new Column({
                crossAxisAlignment: "stretch",
                children: [
                    this.header(),
                    new Expanded({
                        child: new ListView({
                            padding: { top: 8.0, bottom: 24.0 },
                            children: [
                                this.sceneCard(),
                                this.controls,
                                card(
                                    "ABOUT",
                                    new Text(
                                        "The card above hosts a 3D scene rendered by Elpa's wgpu pipeline and composited inline by Flutter. The rest of the UI is a Flutter widget tree streamed from the Elpian VM.",
                                        { color: c.textSecondary },
                                    ),
                                ),
                            ],
                        }),
                    }),
                ],
            }),
        });
    }
}
