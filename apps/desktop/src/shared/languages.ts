/**
 * Interface languages. `system` follows the operating system; every other value
 * is a fixed choice. Translations live in the renderer, but the preference is
 * shared so the main process can validate and store it.
 */
export const LANGUAGES = ["system", "en", "fr", "es", "zh", "hi"] as const;
export type Language = (typeof LANGUAGES)[number];
export type ResolvedLanguage = Exclude<Language, "system">;

export const DEFAULT_LANGUAGE: Language = "system";

export const LANGUAGE_LABELS: Record<Language, string> = {
  system: "System",
  en: "English",
  fr: "Français",
  es: "Español",
  zh: "中文",
  hi: "हिन्दी"
};

const languageSet = new Set<string>(LANGUAGES);

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && languageSet.has(value);
}

export function sanitizeLanguage(value: unknown): Language {
  return isLanguage(value) ? value : DEFAULT_LANGUAGE;
}

/**
 * Turns the saved preference into the catalog to show. A system locale such as
 * `fr-CA`, `zh-Hans` or `hi-IN` resolves to its base language; anything we do not
 * translate falls back to English rather than to an empty interface.
 */
export function resolveLanguage(preference: Language, systemLocale: string | null | undefined): ResolvedLanguage {
  const candidate = preference === "system" ? baseLanguage(systemLocale) : preference;
  return candidate === "fr" || candidate === "es" || candidate === "zh" || candidate === "hi" ? candidate : "en";
}

function baseLanguage(locale: string | null | undefined): string | null {
  if (!locale) return null;
  return locale.trim().toLowerCase().split(/[-_]/u)[0] || null;
}
