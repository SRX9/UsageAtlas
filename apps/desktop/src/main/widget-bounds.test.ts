import { describe, expect, it } from "vitest";
import { resizeWidgetBounds } from "./widget-bounds";

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
const card = { x: 1200, y: 700, width: 320, height: 180 };

describe("resizeWidgetBounds", () => {
  it("grows from the bottom-right and leaves the top-left corner alone", () => {
    expect(resizeWidgetBounds(card, "se", 60, 40, workArea)).toEqual({
      x: 1200, y: 700, width: 380, height: 220
    });
  });

  it("moves the top-left corner when dragging the left or top edge", () => {
    expect(resizeWidgetBounds(card, "nw", -40, -30, workArea)).toEqual({
      x: 1160, y: 670, width: 360, height: 210
    });
  });

  it("never goes below the size that still shows a number", () => {
    expect(resizeWidgetBounds(card, "se", -900, -900, workArea)).toEqual({
      x: 1200, y: 700, width: 180, height: 104
    });
    const shrunk = resizeWidgetBounds(card, "nw", 900, 900, workArea);
    expect(shrunk.width).toBe(180);
    expect(shrunk.height).toBe(104);
    // The bottom-right corner is the anchor, so it does not move.
    expect(shrunk.x + shrunk.width).toBe(card.x + card.width);
    expect(shrunk.y + shrunk.height).toBe(card.y + card.height);
  });

  it("caps the card at its largest size", () => {
    // The card is already near the bottom edge, so the taller size pulls it up
    // to stay inside the work area instead of growing past the taskbar.
    expect(resizeWidgetBounds(card, "se", 4000, 4000, workArea)).toEqual({
      x: 1200, y: 640, width: 640, height: 400
    });
  });

  it("keeps the card inside the display when a drag pushes it out", () => {
    const pinned = resizeWidgetBounds({ x: 1840, y: 980, width: 200, height: 150 }, "se", 300, 300, workArea);
    expect(pinned.x + pinned.width).toBeLessThanOrEqual(workArea.width);
    expect(pinned.y + pinned.height).toBeLessThanOrEqual(workArea.height);
  });
});
