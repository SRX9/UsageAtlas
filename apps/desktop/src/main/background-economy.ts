/**
 * What the app does with itself when nobody is looking at it.
 *
 * A hidden Electron window keeps a whole renderer process alive: its JavaScript
 * heap, its compositor and every decoded image. On this app that is the largest
 * block of memory by far, and none of it is needed while the window sits in the
 * tray. The rules live here, away from Electron, so the thresholds are testable.
 */

/** How long a window stays hidden before its renderer is dropped. */
export const RENDERER_RELEASE_DELAY_MS = 30_000;

/** A visible window checks usage at the cadence the dashboard advertises. */
const VISIBLE_MIN_SECONDS = 30;
const VISIBLE_MAX_SECONDS = 300;

/** Hidden on wall power still refreshes, just far less often. */
const HIDDEN_SECONDS = 15 * 60;
/** Every extra wake-up on battery costs the same budget as a lit screen. */
const BATTERY_SECONDS = 30 * 60;

export interface BackgroundState {
  /** At least one window is on screen, restored and not minimized. */
  windowVisible: boolean;
  /** The app is sitting in the tray. */
  powerSaving: boolean;
  /** The machine is drawing from its battery. */
  onBattery: boolean;
}

/**
 * `null` means keep the renderer: either the user is looking, or they turned
 * the power-saving behaviour off. Otherwise this is the delay before the hidden
 * window is destroyed and its process returns to the OS.
 */
export function rendererReleaseDelay(state: BackgroundState): number | null {
  if (state.windowVisible || !state.powerSaving) return null;
  return RENDERER_RELEASE_DELAY_MS;
}

/**
 * Delay between background usage checks. A visible window follows the engine's
 * own staleness so the dashboard never reads as stale; a hidden one trades
 * freshness for silence, and a laptop trades more of it.
 */
export function usageCheckDelay(state: BackgroundState, staleAfterSeconds: number): number {
  if (!state.windowVisible) {
    return (state.onBattery ? BATTERY_SECONDS : HIDDEN_SECONDS) * 1_000;
  }
  const clamped = Math.max(VISIBLE_MIN_SECONDS, Math.min(staleAfterSeconds, VISIBLE_MAX_SECONDS));
  return clamped * 1_000;
}
