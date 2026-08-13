export const WINDOW_ASPECT_RATIO = 16 / 9;

const DEFAULT_SIZE = { width: 1280, height: 720 } as const;
const MINIMUM_SIZE = { width: 960, height: 540 } as const;

export interface WindowSize {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
}

export function windowSizeForWorkArea(workArea: { width: number; height: number }): WindowSize {
  const defaultUnit = DEFAULT_SIZE.width / 16;
  const minimumUnit = MINIMUM_SIZE.width / 16;
  const availableUnit = Math.max(1, Math.floor(Math.min(workArea.width / 16, workArea.height / 9)));
  const windowUnit = Math.min(defaultUnit, availableUnit);
  const constrainedMinimumUnit = Math.min(minimumUnit, windowUnit);

  return {
    width: windowUnit * 16,
    height: windowUnit * 9,
    minWidth: constrainedMinimumUnit * 16,
    minHeight: constrainedMinimumUnit * 9
  };
}
