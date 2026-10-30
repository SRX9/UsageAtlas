import { createContext, useContext, useMemo } from "react";
import { resolveLanguage, type Language, type ResolvedLanguage } from "../../shared/languages";
import { en, type MessageKey, type Messages } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { hi } from "./hi";
import { zh } from "./zh";

const catalogs: Record<ResolvedLanguage, Messages> = { en, fr, es, zh, hi };

export interface Translation {
  language: ResolvedLanguage;
  /** Looks up a message and fills `{placeholders}`. */
  t(key: MessageKey, values?: Record<string, string | number>): string;
}

const fallback: Translation = {
  language: "en",
  t: (key, values) => interpolate(en[key], values)
};

const TranslationContext = createContext<Translation>(fallback);

export function I18nProvider({
  language,
  systemLocale,
  children
}: {
  language: Language;
  systemLocale?: string | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const resolved = resolveLanguage(
    language,
    systemLocale === undefined && typeof navigator !== "undefined" ? navigator.language : systemLocale ?? null
  );
  const value = useMemo<Translation>(() => ({
    language: resolved,
    t: (key, values) => interpolate(catalogs[resolved][key], values)
  }), [resolved]);
  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

export function useI18n(): Translation {
  return useContext(TranslationContext);
}

/** Missing placeholders stay visible rather than printing `undefined`. */
function interpolate(message: string, values?: Record<string, string | number>): string {
  if (!values) return message;
  return message.replace(/\{([a-zA-Z]+)\}/gu, (match, name: string) => (
    values[name] === undefined ? match : String(values[name])
  ));
}

export { catalogs };
export type { MessageKey };
