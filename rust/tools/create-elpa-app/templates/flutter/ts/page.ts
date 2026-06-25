// The home page: a themed header with a dark/light switch over a scrolling list
// of the three cards.

import { colors, darkMode, toggleTheme } from "./app";
import { CounterCard, GreeterCard, TasksCard } from "./cards";

const APP_TITLE = "__APP_TITLE__";

export class HomePage extends Page {
    counter: CounterCard;
    greeter: GreeterCard;
    tasks: TasksCard;

    constructor() {
        super(APP_TITLE);
        this.counter = new CounterCard();
        this.greeter = new GreeterCard();
        this.tasks = new TasksCard();
    }

    header(): any {
        const c = colors();
        return new Container({
            color: c.primary,
            padding: { left: 16.0, right: 12.0, top: 48.0, bottom: 16.0 },
            child: new Row({
                mainAxisAlignment: "spaceBetween",
                children: [
                    new Text(APP_TITLE, { size: 20.0, bold: true, color: "#FFFFFF" }),
                    new Row({
                        shrink: true,
                        children: [
                            new Icon("palette", { size: 18.0, color: "#FFFFFF" }),
                            new SizedBox({ width: 6.0 }),
                            new Switcher({ key: "theme.switch", value: darkMode, onChanged: (p: ChangePayload) => toggleTheme(p.value) }),
                        ],
                    }),
                ],
            }),
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
                        child: new ListView({ padding: { top: 8.0, bottom: 24.0 }, children: [this.counter, this.greeter, this.tasks] }),
                    }),
                ],
            }),
        });
    }
}
