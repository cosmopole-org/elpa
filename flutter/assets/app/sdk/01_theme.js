// =============================================================================
// Elpa SDK — Theme
// -----------------------------------------------------------------------------
// Design tokens (colours, spacing, radii, typography) for a Telegram-style
// surface. Colours are `#RRGGBB` / `#AARRGGBB` strings — the form the Flutter DSL
// colour parser understands — so the whole UI is themed from one object.
// =============================================================================

/// A coherent set of colour, spacing and type tokens. Build one with a factory
/// (`Theme.telegramDark()` / `Theme.telegramLight()`).
class Theme {
  constructor(palette) {
    this.colors = palette;
    this.space = { xs: 4.0, sm: 8.0, md: 12.0, lg: 16.0, xl: 24.0 };
    this.radius = { sm: 8.0, md: 14.0, lg: 18.0, pill: 999.0 };
    this.font = {
      title: 18.0,
      subtitle: 15.0,
      body: 16.0,
      caption: 13.0,
      tiny: 11.0,
    };
  }

  static telegramDark() {
    return new Theme({
      background: "#0E1621",
      surface: "#17212B",
      surfaceVariant: "#1D2733",
      appBar: "#17212B",
      primary: "#2AABEE",
      primaryDeep: "#229ED9",
      onPrimary: "#FFFFFF",
      bubbleOut: "#2B5278",
      bubbleOutText: "#FFFFFF",
      bubbleIn: "#182533",
      bubbleInText: "#FFFFFF",
      textPrimary: "#FFFFFF",
      textSecondary: "#7D8E9B",
      textMuted: "#5E6E7A",
      divider: "#101921",
      inputBg: "#242F3D",
      online: "#4DCB5D",
      unreadBadge: "#3C8DD9",
      accent: "#64B5EF",
      ripple: "#22324A",
      check: "#5EC587",
    });
  }

  static telegramLight() {
    return new Theme({
      background: "#FFFFFF",
      surface: "#FFFFFF",
      surfaceVariant: "#F1F1F1",
      appBar: "#527DA3",
      primary: "#3390EC",
      primaryDeep: "#2B7DD6",
      onPrimary: "#FFFFFF",
      bubbleOut: "#EFFDDE",
      bubbleOutText: "#000000",
      bubbleIn: "#FFFFFF",
      bubbleInText: "#000000",
      textPrimary: "#000000",
      textSecondary: "#707991",
      textMuted: "#A0A6B0",
      divider: "#E6ECF0",
      inputBg: "#F1F3F5",
      online: "#4DCB5D",
      unreadBadge: "#4FAE4E",
      accent: "#3390EC",
      ripple: "#E9F3FB",
      check: "#4FAE4E",
    });
  }

  /// Pick a stable accent colour for an avatar from a small Telegram-like palette,
  /// keyed by a seed (e.g. a name) so the same peer always gets the same colour.
  avatarColor(seed) {
    let palette = [
      "#E17076", "#7BC862", "#65AADD", "#A695E7",
      "#EE7AAE", "#6EC9CB", "#FAA774", "#5CAAE0",
    ];
    let h = 0;
    for (let i = 0; i < len(seed); i++) {
      h = (h + ord(charAt(seed, i))) % len(palette);
    }
    return palette[h];
  }
}
