// The 3D controls card: pause/resume the spin and reset the view. An isolated
// component that repaints only itself.

import { colors } from "./app";
import { card, pill } from "./ui";
import { sceneCtl } from "./scene";

export class ControlsCard extends Component {
    constructor() {
        super("scope.controls");
    }
    build(): any {
        const c = colors();
        return card(
            "3D CONTROLS",
            new Row({
                mainAxisAlignment: "spaceBetween",
                children: [
                    pill(sceneCtl.spinning ? "PAUSE" : "RESUME", c.primary, "#FFFFFF", () => {
                        sceneCtl.spinning = !sceneCtl.spinning;
                        this.setState(NIL);
                    }),
                    pill("RESET VIEW", c.surfaceVariant, c.textPrimary, () => {
                        sceneCtl.angle = 0.0;
                        this.setState(NIL);
                    }),
                ],
            }),
        );
    }
}
