// Ambient declarations for the Elpa Flutter widget SDK.
//
// The SDK is vendored as plain VM-subset JavaScript under `assets/app/sdk/` and
// concatenated ahead of your app by the Dart loader (see lib/main.dart). Its
// classes/functions are therefore *global* at runtime — these `declare`s give
// your editor the types and emit nothing. Write idiomatic TypeScript: the Elpa
// CLI's shim turns template literals, `arr.push`, `s.trim()`, `a.length`, … into
// the VM's stdlib globals.

export {};

declare global {
    interface ChangePayload {
        value: any;
    }

    // Declarative widgets (constructors take a loosely-typed options object).
    class Container {
        constructor(opts: any);
    }
    class Column {
        constructor(opts: any);
    }
    class Row {
        constructor(opts: any);
    }
    class Text {
        constructor(text: string, opts?: any);
    }
    class SizedBox {
        constructor(opts: any);
    }
    class Padding {
        constructor(opts: any);
    }
    class Expanded {
        constructor(opts: any);
    }
    class Tappable {
        constructor(opts: any);
    }
    class Field {
        constructor(opts: any);
    }
    class Switcher {
        constructor(opts: any);
    }
    class Icon {
        constructor(name: string, opts?: any);
    }
    class ListView {
        constructor(opts: any);
    }
    class Scaffold {
        constructor(opts: any);
    }

    // A 3D surface widget linking Elpa's wgpu pipeline to Flutter (wgpu-flutter).
    class Native3DView {
        constructor(opts: any);
    }

    // Reactive base classes.
    class Component {
        constructor(scope: string);
        state: any;
        setState(mutate: (s: any) => void): void;
        build(): any;
    }
    class Page {
        constructor(title: string);
        build(): any;
    }

    // The application object + theming.
    interface Navigator {
        mount(page: Page): void;
        build(): any;
    }
    class App {
        theme: any;
        navigator: Navigator;
        render(): void;
        start(build: () => any): void;
    }
    class Theme {
        static telegramDark(): any;
        static telegramLight(): any;
    }
}
