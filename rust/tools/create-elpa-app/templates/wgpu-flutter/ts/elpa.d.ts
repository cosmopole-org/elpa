// Ambient declarations for the Elpa Flutter widget SDK + the wgpu 3D surface.
//
// The SDK is vendored as VM-subset JavaScript under `assets/app/sdk/` and linked
// ahead of your app by the Dart loader, so these symbols are global at runtime —
// the `declare`s are editor types only. Write idiomatic TypeScript; the CLI's
// shim lowers it to the VM subset.

export {};

declare global {
    interface ChangePayload {
        value: any;
    }
    const NIL: any; // the SDK's null sentinel (e.g. `setState(NIL)` to just repaint)

    // 2D widgets.
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
    class Expanded {
        constructor(opts: any);
    }
    class Tappable {
        constructor(opts: any);
    }
    class ListView {
        constructor(opts: any);
    }
    class Scaffold {
        constructor(opts: any);
    }
    class ClipRRect {
        constructor(opts: any);
    }
    /// The zero-copy surface that composites Elpa's wgpu output inline in Flutter.
    class Native3DView {
        constructor(opts: any);
    }

    // Reactive base classes + app.
    class Component {
        constructor(scope: string);
        state: any;
        setState(mutate: any): void;
        build(): any;
    }
    class Page {
        constructor(title: string);
        build(): any;
    }
    interface Navigator {
        mount(page: Page): void;
        build(): any;
    }
    interface FrameBuilder {
        surfacePass(clear: any, commands: any[]): FrameBuilder;
        submit(): void;
    }
    interface Gpu {
        define(def: any): void;
        frame(): FrameBuilder;
    }
    class App {
        theme: any;
        navigator: Navigator;
        gpu: Gpu;
        render(): void;
        start(build: () => any): void;
        handleHostMessage(msg: any): void;
        handleFrame(dt: number): void;
        handleResize(info: any): void;
    }
    class Theme {
        static telegramDark(): any;
        static telegramLight(): any;
    }
    class Color {
        static rgba(r: number, g: number, b: number, a: number): any;
    }
}
