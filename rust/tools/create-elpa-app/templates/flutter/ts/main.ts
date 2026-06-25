// __APP_TITLE__ — Elpa + Flutter entry point.
//
// A rich 2D UI authored entirely in TypeScript on the Elpian VM and streamed to
// real Flutter widgets over the message pipe. Mounts the home page and starts the
// VM render loop.

import { app } from "./app";
import { HomePage } from "./page";

app.navigator.mount(new HomePage());
app.start(() => app.navigator.build());
