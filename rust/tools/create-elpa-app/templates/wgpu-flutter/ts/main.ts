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

// Keep the host frame pump running so the 3D scene renders every vsync. The
// Flutter shell only ticks `onFrame` while the app has work scheduled, so a
// permanent zero-cost interval latches the ticker on (PAUSE stops the cube's
// rotation inside `render`, not the frame loop). Without this `onFrame` is
// never called and the scene never renders.
app.scheduler.setInterval(() => {}, 16);

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
