import type {
  AccentTint,
  AppMark,
  AppearanceFont,
  AppearancePreferences,
  AppearanceTheme
} from "../shared/desktop-api";
import { setNumberStyle } from "./number-format";

export interface FontOption {
  id: AppearanceFont;
  label: string;
}

/**
 * The typography offered in Settings → Appearance. Every family is a bundled
 * variable font, so a choice looks the same on a machine that has never seen it.
 */
export const FONT_OPTIONS: FontOption[] = [
  { id: "system", label: "System" },
  { id: "inter", label: "Inter" },
  { id: "manrope", label: "Manrope" },
  { id: "figtree", label: "Figtree" },
  { id: "jakarta", label: "Jakarta" },
  { id: "geist", label: "Geist" },
  { id: "outfit", label: "Outfit" },
  { id: "sora", label: "Sora" },
  { id: "newsreader", label: "Newsreader" },
  { id: "fraunces", label: "Fraunces" }
];

export const THEME_OPTIONS: { id: AppearanceTheme; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" }
];

/** CSS stacks for the preview tiles, matching the selectors in globals.css. */
export const FONT_STACKS: Record<AppearanceFont, string> = {
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  inter: "'Inter Variable', Inter, sans-serif",
  manrope: "'Manrope Variable', Manrope, sans-serif",
  figtree: "'Figtree Variable', Figtree, sans-serif",
  jakarta: "'Plus Jakarta Sans Variable', 'Plus Jakarta Sans', sans-serif",
  geist: "'Geist Variable', Geist, sans-serif",
  outfit: "'Outfit Variable', Outfit, sans-serif",
  sora: "'Sora Variable', Sora, sans-serif",
  newsreader: "'Newsreader Variable', Newsreader, Georgia, serif",
  fraunces: "'Fraunces Variable', Fraunces, Georgia, serif"
};

const systemDark = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : null;
let activeTheme: AppearanceTheme = "system";

/**
 * Pins the palette to the chosen theme. HeroUI reads its own `dark` / `light`
 * classes, so they are switched here too instead of relying on the stylesheet's
 * OS media query alone. `system` keeps following the OS while it is selected.
 */
export function applyTheme(theme: AppearanceTheme): void {
  activeTheme = theme;
  if (typeof document === "undefined") return;
  const dark = theme === "dark" || (theme === "system" && Boolean(systemDark?.matches));
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.classList.toggle("glass-dark", dark);
  root.classList.toggle("light", !dark);
  root.classList.toggle("glass-light", !dark);
  root.dataset.atlasTheme = dark ? "dark" : "light";
  root.style.colorScheme = dark ? "dark" : "light";
}

if (systemDark) {
  systemDark.addEventListener("change", () => {
    if (activeTheme === "system") applyTheme("system");
  });
}

export const MARK_OPTIONS: { id: AppMark; label: string }[] = [
  { id: "datamosh", label: "Datamosh" },
  { id: "classic", label: "Classic" },
  { id: "duotone", label: "Duotone" }
];

export type InkSwatchId = "theme" | "graphite" | "cobalt" | "plum" | "forest" | "ember";

/** Ink swatches. The first one clears the override and follows the theme. */
export const INK_SWATCHES: { id: InkSwatchId; value: string | null }[] = [
  { id: "theme", value: null },
  { id: "graphite", value: "#1d1d1f" },
  { id: "cobalt", value: "#0b3d91" },
  { id: "plum", value: "#5b2a86" },
  { id: "forest", value: "#0f5b45" },
  { id: "ember", value: "#8a3b12" }
];

/**
 * Accent tints. `system` keeps the theme's own accent (near-black in light mode,
 * white in dark mode); the rest override it for buttons, focus rings and links.
 * Every tint is dark enough to keep white label text legible.
 */
export const ACCENT_TINT_VALUES: Record<AccentTint, { accent: string; hover: string } | null> = {
  system: null,
  ink: { accent: "#1d1d1f", hover: "#3a3a3c" },
  cobalt: { accent: "#0b5fd8", hover: "#0a51ba" },
  violet: { accent: "#6b3fd4", hover: "#5b34b8" },
  rose: { accent: "#c02c5c", hover: "#a82550" },
  forest: { accent: "#146b4a", hover: "#11573c" },
  amber: { accent: "#9a5b06", hover: "#824c05" }
};

/**
 * Applies typography, type scale, ink colour, accent, surfaces and motion to the
 * document. Kept out of the component so the same function serves the first
 * render and every change.
 */
export function applyAppearance(appearance: AppearancePreferences): void {
  applyTheme(appearance.theme);
  const root = document.documentElement;
  root.dataset.appearanceFont = appearance.font;
  root.dataset.appearanceSurface = appearance.surface;
  root.dataset.appearanceMotion = appearance.animate ? "on" : "off";
  root.dataset.appearanceDensity = appearance.density;
  root.style.setProperty("--atlas-font-scale", String(appearance.fontScale));
  root.style.setProperty("--atlas-glass-blur", `${appearance.blur}px`);
  root.style.setProperty("--atlas-overlay-blur", `${Math.min(40, appearance.blur + 6)}px`);

  // Provider tints are per-key custom properties so a logo, a row or a chart mark
  // can read one without threading preferences through every component.
  for (const property of Array.from(root.style)) {
    if (property.startsWith("--atlas-provider-")) root.style.removeProperty(property);
  }
  for (const [providerID, color] of Object.entries(appearance.providerColors)) {
    root.style.setProperty(`--atlas-provider-${providerID}`, color);
  }
  if (appearance.textColor) root.style.setProperty("--foreground", appearance.textColor);
  else root.style.removeProperty("--foreground");

  const tint = ACCENT_TINT_VALUES[appearance.accent];
  if (tint) {
    root.style.setProperty("--accent", tint.accent);
    root.style.setProperty("--accent-hover", tint.hover);
    root.style.setProperty("--accent-foreground", "#ffffff");
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-hover");
    root.style.removeProperty("--accent-foreground");
  }

  setNumberStyle(appearance.numberStyle);
}
