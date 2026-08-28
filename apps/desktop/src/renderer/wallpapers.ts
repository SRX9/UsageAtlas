import type { BackgroundImagePreference, BuiltInBackgroundId } from "../shared/desktop-api";
import { BUILT_IN_BACKGROUND_IDS, DEFAULT_BACKGROUND_IMAGE } from "../shared/desktop-api";

export interface BuiltInWallpaper {
  id: BuiltInBackgroundId;
  label: string;
}

const wallpaperLabels: Record<BuiltInBackgroundId, string> = {
  mist: "Mist",
  valley: "Valley",
  "anime-calm": "Night",
  monterey: "Monterey",
  "big-sur": "Big Sur"
};

export const BUILT_IN_WALLPAPERS: BuiltInWallpaper[] = BUILT_IN_BACKGROUND_IDS.map((id) => ({
  id,
  label: wallpaperLabels[id]
}));

export function applyWallpaper(
  preference: BackgroundImagePreference | null | undefined,
  customUrl: string | null
): void {
  if (preference === "custom" && customUrl) {
    document.body.dataset.wallpaper = "custom";
    document.body.style.setProperty("--atlas-wallpaper-image", `url("${customUrl}")`);
    return;
  }

  const wallpaper = preference && preference !== "custom" ? preference : DEFAULT_BACKGROUND_IMAGE;
  document.body.dataset.wallpaper = wallpaper;
  document.body.style.removeProperty("--atlas-wallpaper-image");
}
