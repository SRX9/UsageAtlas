export const UPDATE_BASE_URL = "https://updates.usageatlas.com";
export const LATEST_RELEASE_URL = `${UPDATE_BASE_URL}/latest.json`;
export const DOWNLOAD_PAGE_URL = "https://usageatlas.com/#download";

/**
 * Squirrel.Mac installs whatever a 200 response points at without comparing
 * versions, so the installed version travels in the feed path and the edge
 * answers 204 when there is nothing newer. Squirrel.Windows compares the
 * versions listed in RELEASES itself, so its feed stays a bare directory.
 */
export function squirrelFeedURL(platform: string, architecture: string, version: string): string | null {
  if (platform === "darwin") return `${UPDATE_BASE_URL}/darwin/${architecture}/${encodeURIComponent(version)}`;
  if (platform === "win32") return `${UPDATE_BASE_URL}/win32/${architecture}`;
  return null;
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): { core: number[]; prerelease: string[] } => {
    const separator = value.indexOf("-");
    const core = (separator === -1 ? value : value.slice(0, separator))
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
    return { core, prerelease: separator === -1 ? [] : value.slice(separator + 1).split(".") };
  };
  const first = parse(left);
  const second = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (first.core[index] ?? 0) - (second.core[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  // A final build outranks any prerelease sharing its core version.
  if (first.prerelease.length === 0 || second.prerelease.length === 0) {
    if (first.prerelease.length === second.prerelease.length) return 0;
    return first.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(first.prerelease.length, second.prerelease.length); index += 1) {
    const a = first.prerelease[index];
    const b = second.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const numeric = /^\d+$/u.test(a) && /^\d+$/u.test(b);
    const comparison = numeric ? Number(a) - Number(b) : a.localeCompare(b);
    if (comparison !== 0) return comparison < 0 ? -1 : 1;
  }
  return 0;
}

export function isNewerVersion(candidate: string, installed: string): boolean {
  return compareVersions(candidate, installed) > 0;
}

/** Reads the published version out of the release summary served at `latest.json`. */
export function latestPublishedVersion(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const version = (payload as { version?: unknown }).version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) return null;
  return version;
}

/** Update endpoints can carry release paths; keep them out of local logs. */
export function redactUpdateError(message: string): string {
  return message.replace(/https?:\/\/[^\s]+/gu, "[update-url]").slice(0, 300);
}
