// The three isolated, self-patching components: a counter, a live greeter, and a
// task list. Each extends `Component` with its own repaint scope.

import { colors } from "./app";
import { card, pill } from "./ui";

interface Task {
    text: string;
    done: boolean;
}

export class CounterCard extends Component {
    constructor() {
        super("scope.counter");
        this.state = { count: 0 };
    }
    bump(by: number): void {
        this.setState((s) => {
            s.count = s.count + by;
        });
    }
    build(): any {
        const c = colors();
        return card(
            "COUNTER",
            new Row({
                mainAxisAlignment: "spaceBetween",
                children: [
                    pill("–", c.surfaceVariant, c.textPrimary, () => this.bump(-1)),
                    new Text(`${this.state.count}`, { size: 30.0, bold: true, color: c.textPrimary }),
                    pill("+", c.primary, "#FFFFFF", () => this.bump(1)),
                ],
            }),
        );
    }
}

export class GreeterCard extends Component {
    constructor() {
        super("scope.greeter");
        this.state = { name: "" };
    }
    build(): any {
        const c = colors();
        const name = this.state.name.trim();
        const greeting = name.length === 0 ? "Type your name…" : `Hello, ${name} 👋`;
        return card(
            "GREETER",
            new Column({
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
                        onChanged: (p: ChangePayload) => {
                            this.setState((s) => {
                                s.name = p.value;
                            });
                        },
                    }),
                    new SizedBox({ height: 12.0 }),
                    new Text(greeting, { size: 18.0, color: c.textPrimary }),
                ],
            }),
        );
    }
}

export class TasksCard extends Component {
    constructor() {
        super("scope.tasks");
        this.state = {
            draft: "",
            clearNonce: 0,
            items: [
                { text: "Read the Elpa README", done: true },
                { text: "Run flutter run", done: false },
                { text: "Edit assets/app/ts", done: false },
            ],
        };
    }
    add(): void {
        const t = this.state.draft.trim();
        if (t.length === 0) {
            return;
        }
        this.setState((s) => {
            s.items.push({ text: t, done: false });
            s.draft = "";
            s.clearNonce = s.clearNonce + 1;
        });
    }
    toggle(i: number, on: boolean): void {
        this.setState((s) => {
            s.items[i].done = on;
        });
    }
    build(): any {
        const c = colors();
        const items: Task[] = this.state.items;
        const rows: any[] = items.map((it, i) => {
            return new Padding({
                padding: { top: 4.0, bottom: 4.0 },
                child: new Row({
                    children: [
                        new Switcher({ key: `task.${i}`, value: it.done, onChanged: (p: ChangePayload) => this.toggle(i, p.value) }),
                        new SizedBox({ width: 8.0 }),
                        new Expanded({ child: new Text(it.text, { color: it.done ? c.textSecondary : c.textPrimary, italic: it.done }) }),
                    ],
                }),
            });
        });
        rows.push(new SizedBox({ height: 8.0 }));
        rows.push(
            new Row({
                children: [
                    new Expanded({
                        child: new Field({
                            key: "tasks.draft",
                            value: this.state.draft,
                            hint: "New task",
                            clearNonce: this.state.clearNonce,
                            clearOnSubmit: true,
                            fillColor: c.surfaceVariant,
                            textColor: c.textPrimary,
                            hintColor: c.textSecondary,
                            radius: 10.0,
                            onChanged: (p: ChangePayload) => {
                                this.state.draft = p.value;
                            },
                            onSubmitted: (p: ChangePayload) => {
                                this.state.draft = p.value;
                                this.add();
                            },
                        }),
                    }),
                    new SizedBox({ width: 10.0 }),
                    pill("ADD", c.primary, "#FFFFFF", () => this.add()),
                ],
            }),
        );
        return card("TASKS", new Column({ crossAxisAlignment: "stretch", children: rows }));
    }
}
