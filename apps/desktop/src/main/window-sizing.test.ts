import { describe, expect, it } from "vitest";
import { WINDOW_ASPECT_RATIO, windowSizeForWorkArea } from "./window-sizing";

describe("windowSizeForWorkArea", () => {
  it("uses a 1280 by 720 default on displays where it fits", () => {
    expect(windowSizeForWorkArea({ width: 1920, height: 1040 })).toEqual({
      width: 1280,
      height: 720,
      minWidth: 960,
      minHeight: 540
    });
  });

  it("scales down in whole 16 by 9 units to fit the work area", () => {
    const size = windowSizeForWorkArea({ width: 1280, height: 680 });

    expect(size).toEqual({ width: 1200, height: 675, minWidth: 960, minHeight: 540 });
    expect(size.width / size.height).toBe(WINDOW_ASPECT_RATIO);
  });

  it("keeps its minimum size on-screen for unusually small work areas", () => {
    const size = windowSizeForWorkArea({ width: 800, height: 500 });

    expect(size).toEqual({ width: 800, height: 450, minWidth: 800, minHeight: 450 });
    expect(size.width).toBeLessThanOrEqual(800);
    expect(size.height).toBeLessThanOrEqual(500);
  });
});
