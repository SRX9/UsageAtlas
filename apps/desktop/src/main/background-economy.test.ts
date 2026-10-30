import { describe, expect, it } from "vitest";
import { rendererReleaseDelay, usageCheckDelay } from "./background-economy";

const visible = { windowVisible: true, powerSaving: true, onBattery: false };
const hidden = { windowVisible: false, powerSaving: true, onBattery: false };

describe("rendererReleaseDelay", () => {
  it("keeps a visible window's renderer", () => {
    expect(rendererReleaseDelay(visible)).toBeNull();
  });

  it("releases a hidden renderer after the settle delay", () => {
    expect(rendererReleaseDelay(hidden)).toBe(30_000);
  });

  it("never releases when the user turned power saving off", () => {
    expect(rendererReleaseDelay({ ...hidden, powerSaving: false })).toBeNull();
  });
});

describe("usageCheckDelay", () => {
  it("follows the engine while the window is open", () => {
    expect(usageCheckDelay(visible, 180)).toBe(180_000);
  });

  it("clamps a stale-after the engine reports outside the useful range", () => {
    expect(usageCheckDelay(visible, 5)).toBe(30_000);
    expect(usageCheckDelay(visible, 9_000)).toBe(300_000);
  });

  it("checks rarely while hidden on wall power", () => {
    expect(usageCheckDelay(hidden, 180)).toBe(15 * 60_000);
  });

  it("checks least often on battery", () => {
    expect(usageCheckDelay({ ...hidden, onBattery: true }, 180)).toBe(30 * 60_000);
  });
});
