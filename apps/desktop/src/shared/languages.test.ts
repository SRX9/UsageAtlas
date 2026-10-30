import { describe, expect, it } from "vitest";
import { resolveLanguage, sanitizeLanguage } from "./languages";

describe("language preference", () => {
  it("keeps a supported fixed choice", () => {
    expect(resolveLanguage("fr", "en-US")).toBe("fr");
    expect(resolveLanguage("zh", "fr-FR")).toBe("zh");
    expect(resolveLanguage("hi", null)).toBe("hi");
  });

  it("follows the system locale, including regional variants", () => {
    expect(resolveLanguage("system", "fr-CA")).toBe("fr");
    expect(resolveLanguage("system", "es-419")).toBe("es");
    expect(resolveLanguage("system", "zh-Hans-CN")).toBe("zh");
    expect(resolveLanguage("system", "hi-IN")).toBe("hi");
  });

  it("falls back to English instead of an empty interface", () => {
    expect(resolveLanguage("system", "de-DE")).toBe("en");
    expect(resolveLanguage("system", null)).toBe("en");
    expect(resolveLanguage("system", "")).toBe("en");
  });

  it("rejects an unknown stored value", () => {
    expect(sanitizeLanguage("klingon")).toBe("system");
    expect(sanitizeLanguage(undefined)).toBe("system");
    expect(sanitizeLanguage("es")).toBe("es");
  });
});
