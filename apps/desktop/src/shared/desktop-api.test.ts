import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKGROUND_IMAGE,
  isBackgroundImagePreference,
  rollForwardBackgroundDefault,
  sanitizeBackgroundImage
} from "./desktop-api";

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
