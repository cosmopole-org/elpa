// Small reusable widget helpers shared across the cards.

import { colors } from "./app";

/// A titled "card" container.
export function card(title: string, body: any): any {
    const c = colors();
    return new Container({
        color: c.surface,
        radius: 14.0,
        padding: 16.0,
        margin: { left: 16.0, right: 16.0, top: 8.0, bottom: 8.0 },
        child: new Column({
            crossAxisAlignment: "stretch",
            children: [new Text(title, { size: 13.0, bold: true, color: c.textSecondary }), new SizedBox({ height: 12.0 }), body],
        }),
    });
}

/// A pill-shaped tappable button.
export function pill(label: string, bg: any, fg: any, onTap: () => void): any {
    return new Tappable({
        onTap,
        child: new Container({
            color: bg,
            radius: 10.0,
            padding: { left: 16.0, right: 16.0, top: 10.0, bottom: 10.0 },
            alignment: "center",
            child: new Text(label, { bold: true, color: fg }),
        }),
    });
}
