// __APP_TITLE__ — Elpa + Flutter entry point with a 3D Native3DView.
//
// Mounts the home page, starts the VM render loop, and wires the host lifecycle
// hooks: each frame drives the 2D timers/animations and renders the 3D scene into
// the native surface.

import { app } from "./app";
import { HomePage } from "./page";
import { sceneCtl } from "./scene";

app.navigator.mount(new HomePage());
app.start(() => app.navigator.build());

// ---- host lifecycle hooks (called by the native host) ------------------------
export function onHostMessage(msg: any): void {
    app.handleHostMessage(msg);
}
export function onFrame(dt: number): void {
    app.handleFrame(dt); // drive 2D timers/animations
    sceneCtl.render(dt); // render the 3D scene into the native surface
}
export function onResize(info: any): void {
    app.handleResize(info);
}
