import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADVANCED_PREFERENCES,
  DEFAULT_BACKGROUND_IMAGE,
  sanitizeAdvancedPreferences,
  isBackgroundImagePreference,
  rollForwardBackgroundDefault,
  sanitizeBackgroundImage,
  sanitizeUpdateChannel,
  sanitizeUpdateRepository
} from "./desktop-api";

describe("update source preference", () => {
  it("accepts the three publishers and rejects anything else", () => {
    expect(sanitizeUpdateChannel("fork")).toBe("fork");
    expect(sanitizeUpdateChannel("upstream")).toBe("upstream");
    expect(sanitizeUpdateChannel("custom")).toBe("custom");
    expect(sanitizeUpdateChannel("nightly")).toBe("fork");
    expect(sanitizeUpdateChannel(null)).toBe("fork");
  });

  it("keeps a repository name and clears anything that is not one", () => {
    expect(sanitizeUpdateRepository("  arthur/UsageAtlas-Builds ")).toBe("arthur/UsageAtlas-Builds");
    expect(sanitizeUpdateRepository("UsageAtlas-Builds")).toBe("");
    expect(sanitizeUpdateRepository("arthur/UsageAtlas-Builds/tree/main")).toBe("");
    expect(sanitizeUpdateRepository("https://github.com/arthur/UsageAtlas-Builds")).toBe("");
    expect(sanitizeUpdateRepository(7)).toBe("");
  });
});

describe("blended cost preference", () => {
  it("defaults to a realistic $0.54 per million tokens", () => {
    expect(DEFAULT_ADVANCED_PREFERENCES.blendedCostEnabled).toBe(true);
    expect(DEFAULT_ADVANCED_PREFERENCES.blendedCostPerMillionUSD).toBe(0.54);
    expect(sanitizeAdvancedPreferences({}).blendedCostPerMillionUSD).toBe(0.54);
  });

  it("keeps a saved rate and rejects values outside the supported range", () => {
    expect(sanitizeAdvancedPreferences({ blendedCostPerMillionUSD: 1.25, blendedCostEnabled: false })).toMatchObject({
      blendedCostPerMillionUSD: 1.25,
      blendedCostEnabled: false
    });
    expect(sanitizeAdvancedPreferences({ blendedCostPerMillionUSD: -4 }).blendedCostPerMillionUSD).toBe(0.01);
    expect(sanitizeAdvancedPreferences({ blendedCostPerMillionUSD: 99_999 }).blendedCostPerMillionUSD).toBe(1_000);
  });
});

describe("background image preference", () => {
  it("defaults to the Mist wallpaper", () => {
    expect(DEFAULT_BACKGROUND_IMAGE).toBe("mist");
  });

  it("accepts built-in wallpapers and a custom image", () => {
    expect(isBackgroundImagePreference("mist")).toBe(true);
    expect(isBackgroundImagePreference("valley")).toBe(true);
    expect(isBackgroundImagePreference("anime-calm")).toBe(true);
    expect(isBackgroundImagePreference("monterey")).toBe(true);
    expect(isBackgroundImagePreference("big-sur")).toBe(true);
    expect(isBackgroundImagePreference("custom")).toBe(true);
    expect(isBackgroundImagePreference("arches")).toBe(false);
    expect(isBackgroundImagePreference("default")).toBe(false);
  });

  it("maps the legacy default value onto Mist", () => {
    expect(sanitizeBackgroundImage("default")).toBe("mist");
    expect(sanitizeBackgroundImage("arches")).toBe("mist");
    expect(sanitizeBackgroundImage("custom")).toBe("custom");
    expect(sanitizeBackgroundImage("valley")).toBe("valley");
  });

  it("moves existing installs onto Mist once, leaving a custom upload alone", () => {
    expect(rollForwardBackgroundDefault("valley", undefined)).toEqual({
      backgroundImage: "mist",
      appliedGeneration: "mist",
      changed: true
    });
    expect(rollForwardBackgroundDefault("anime-calm", "valley")).toEqual({
      backgroundImage: "mist",
      appliedGeneration: "mist",
      changed: true
    });
    expect(rollForwardBackgroundDefault("custom", undefined)).toEqual({
      backgroundImage: "custom",
      appliedGeneration: "mist",
      changed: true
    });
    expect(rollForwardBackgroundDefault("valley", "mist")).toEqual({
      backgroundImage: "valley",
      appliedGeneration: "mist",
      changed: false
    });
  });
});
