import type { WidgetResizeEdge } from "../shared/desktop-api";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Below this the exact token figure would not fit any more. */
export const WIDGET_MIN_SIZE = { width: 180, height: 104 } as const;
export const WIDGET_MAX_SIZE = { width: 640, height: 400 } as const;

/**
 * Grows or shrinks a rectangle from one of its sides, keeping the opposite edge
 * still. The size stays within the window limits; the position then stays inside
 * the display's work area, so a drag can never park the card off-screen.
 */
export function resizeWidgetBounds(
  bounds: Bounds,
  edge: WidgetResizeEdge,
  dx: number,
  dy: number,
  workArea: Bounds
): Bounds {
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  const width = clamp(
    bounds.width + (edge.includes("e") ? dx : 0) - (edge.includes("w") ? dx : 0),
    WIDGET_MIN_SIZE.width,
    Math.min(WIDGET_MAX_SIZE.width, workArea.width)
  );
  const height = clamp(
    bounds.height + (edge.includes("s") ? dy : 0) - (edge.includes("n") ? dy : 0),
    WIDGET_MIN_SIZE.height,
    Math.min(WIDGET_MAX_SIZE.height, workArea.height)
  );
  return {
    x: clamp(edge.includes("w") ? right - width : bounds.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(edge.includes("n") ? bottom - height : bounds.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(max, value)));
}
