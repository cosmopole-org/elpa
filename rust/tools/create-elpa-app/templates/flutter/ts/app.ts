// The shared application object, theme state, and theme switching.

export const app = new App();

export let darkMode = true;

/// The current theme's colour roles.
export function colors(): any {
    return app.theme.colors;
}

/// Flip dark/light and re-render the whole tree.
export function toggleTheme(wantDark: boolean): void {
    darkMode = wantDark;
    app.theme = wantDark ? Theme.telegramDark() : Theme.telegramLight();
    app.render();
}
