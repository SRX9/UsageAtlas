import { describe, expect, it } from "vitest";
import { fromApp } from "./website-links";

describe("fromApp", () => {
  it("adds the campaign before the fragment", () => {
    expect(fromApp("https://usageatlas.com/#download", "update"))
      .toBe("https://usageatlas.com/?utm_source=desktop_app&utm_medium=app&utm_campaign=update#download");
  });

  it("keeps existing query parameters", () => {
    expect(fromApp("https://usageatlas.com/leaderboard?board=streak", "profile"))
      .toBe("https://usageatlas.com/leaderboard?board=streak&utm_source=desktop_app&utm_medium=app&utm_campaign=profile");
  });
});
