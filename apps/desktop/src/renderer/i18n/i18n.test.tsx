import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { catalogs, I18nProvider, useI18n } from ".";
import { en } from "./en";

function Probe(): React.JSX.Element {
  const { language, t } = useI18n();
  return <span>{`${language}|${t("alerts.daily.message", { tokens: "128,400", provider: "Freebuff" })}`}</span>;
}

describe("translations", () => {
  it("provides every English key in every language, without blanks", () => {
    for (const [language, catalog] of Object.entries(catalogs)) {
      for (const key of Object.keys(en) as (keyof typeof en)[]) {
        expect(catalog[key], `${language} is missing ${key}`).toBeTruthy();
      }
    }
  });

  it("interpolates the token alert sentence", () => {
    expect(renderToStaticMarkup(
      <I18nProvider language="fr" systemLocale="en-US"><Probe /></I18nProvider>
    )).toContain("fr|Tu as utilisé 128,400 tokens sur Freebuff aujourd&#x27;hui.");
  });

  it("follows the system locale and falls back to English", () => {
    expect(renderToStaticMarkup(
      <I18nProvider language="system" systemLocale="es-MX"><Probe /></I18nProvider>
    )).toContain("es|Has usado");
    expect(renderToStaticMarkup(
      <I18nProvider language="system" systemLocale="de-DE"><Probe /></I18nProvider>
    )).toContain("en|You used");
  });

  it("leaves an unknown placeholder visible", () => {
    expect(renderToStaticMarkup(
      <I18nProvider language="en" systemLocale="en"><Probe /></I18nProvider>
    )).toContain("You used 128,400 tokens on Freebuff today.");
  });
});
