import { app, autoUpdater, net } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import type { DesktopUpdateState } from "../shared/desktop-api";
import {
  compareVersions,
  downloadPageURL,
  latestPublishedVersion,
  newerInstalledVersion,
  previousInstalledVersion,
  redactUpdateError,
  resolveUpdateSource,
  squirrelFeedURL,
  updateCheckURL,
  type UpdateSource
} from "./update-feed";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const FIRST_CHECK_DELAY_MS = 10_000;

export interface AutoUpdateHooks {
  capture?: (event: string) => void;
  /** Read on every check, so switching publisher takes effect without a restart. */
  source?: () => UpdateSource;
  onStateChange?: (state: DesktopUpdateState) => void;
  onUpdateReady?: (install: () => void) => void;
}

export interface DesktopUpdater {
  getState(): DesktopUpdateState;
  check(): Promise<DesktopUpdateState>;
  /** Relaunches the newest build applied before this one. */
  rollback(): boolean;
  /** Where a version this build cannot install in place is downloaded from. */
  downloadPageURL(): string;
}

export function configureAutoUpdates(hooks: AutoUpdateHooks = {}): DesktopUpdater {
  const enabled = app.isPackaged && process.env.USAGEATLAS_SMOKE_TEST !== "1";
  const currentVersion = app.getVersion();
  const source = (): UpdateSource => hooks.source?.() ?? resolveUpdateSource("upstream");
  const firstRunUntil = process.argv.includes("--squirrel-firstrun") ? Date.now() + FIRST_CHECK_DELAY_MS : 0;
  // A build installed while an older window stayed open is already on disk. Say
  // so instead of letting Squirrel answer "up to date" for the newer package.
  const installedAhead = newerInstalledVersion(process.execPath, currentVersion);
  let previousVersion = previousInstalledVersion(process.execPath, currentVersion);
  let state: DesktopUpdateState = {
    status: enabled ? (installedAhead ? "ready" : "idle") : "unavailable",
    currentVersion,
    availableVersion: installedAhead,
    previousVersion,
    error: null
  };

  /**
   * Squirrel's stub at the install root opens the newest applied release; the
   * running `app-<older>` executable would only ever relaunch itself.
   */
  function restartIntoInstalledBuild(): void {
    const stub = path.resolve(process.execPath, "..", "..", "UsageAtlas.exe");
    if (process.platform === "win32" && existsSync(stub)) app.relaunch({ execPath: stub });
    else app.relaunch();
    app.exit(0);
  }
  function rollback(): boolean {
    if (!enabled) return false;
    previousVersion = previousInstalledVersion(process.execPath, currentVersion);
    if (!previousVersion) return false;
    const build = path.resolve(path.dirname(process.execPath), "..", `app-${previousVersion}`, "UsageAtlas.exe");
    if (process.platform === "win32" && existsSync(build)) app.relaunch({ execPath: build });
    else app.relaunch();
    app.exit(0);
    return true;
  }
  let initialTimer: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;

  function publish(patch: Partial<DesktopUpdateState>): void {
    state = { ...state, error: null, ...patch };
    hooks.onStateChange?.(state);
  }

  function stopChecking(): void {
    clearTimeout(initialTimer);
    clearInterval(timer);
  }

  function failed(error: unknown): void {
    console.error(`Update check failed: ${redactUpdateError(error instanceof Error ? error.message : "unknown")}`);
    publish({ status: "error", error: "Unable to update. Check your connection and try again." });
  }

  async function check(): Promise<DesktopUpdateState> {
    // A second Squirrel check would download the same update again.
    if (!enabled || state.status === "checking" || state.status === "downloading" || state.status === "ready") return state;
    if (Date.now() < firstRunUntil) {
      publish({ status: "error", error: "Finishing installation. Try checking again in a few seconds." });
      return state;
    }
    const pending = newerInstalledVersion(process.execPath, currentVersion);
    if (pending) {
      hooks.onUpdateReady?.(restartIntoInstalledBuild);
      publish({ status: "ready", availableVersion: pending });
      return state;
    }
    publish({ status: "checking", availableVersion: null });
    hooks.capture?.("desktop_update_checked");
    try {
      const feedURL = squirrelFeedURL(process.platform, process.arch, currentVersion, source());
      if (feedURL) {
        autoUpdater.setFeedURL({ url: feedURL });
        autoUpdater.checkForUpdates();
      } else {
        // Platforms without a Squirrel feed (Linux packages, macOS off the mirror)
        // are downloaded manually; the available state carries the version.
        const response = await net.fetch(updateCheckURL(source()), {
          cache: "no-cache",
          headers: { accept: "application/vnd.github+json", "user-agent": "UsageAtlas-Desktop" },
          signal: AbortSignal.timeout(30_000)
        });
        if (!response.ok) throw new Error(`Release check returned ${response.status}`);
        const version = latestPublishedVersion(await response.json());
        if (!version) throw new Error("The release feed did not contain a valid version");
        const available = compareVersions(version, currentVersion) > 0;
        publish({ status: available ? "available" : "current", availableVersion: available ? version : null });
        if (available) hooks.capture?.("desktop_update_available");
      }
    } catch (error) {
      failed(error);
    }
    return state;
  }

  if (enabled) {
    if (installedAhead) hooks.onUpdateReady?.(restartIntoInstalledBuild);
    if (squirrelFeedURL(process.platform, process.arch, currentVersion, source())) {
      autoUpdater.on("update-available", () => {
        hooks.capture?.("desktop_update_available");
        publish({ status: "downloading" });
      });
      autoUpdater.on("update-not-available", () => publish({ status: "current", availableVersion: null }));
      autoUpdater.on("update-downloaded", (_event, _notes, releaseName) => {
        hooks.capture?.("desktop_update_downloaded");
        stopChecking();
        hooks.onUpdateReady?.(() => autoUpdater.quitAndInstall());
        publish({ status: "ready", availableVersion: releaseName || null });
      });
      autoUpdater.on("error", failed);
    }
    initialTimer = setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
    initialTimer.unref();
    timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
    timer.unref();
    app.once("before-quit", stopChecking);
  }
  /**
   * A saved "current" can go stale: Squirrel may unpack a newer build while this
   * window keeps running. Re-read the install root on every read so the badge
   * says "restart", not "latest", the moment a newer folder exists.
   */
  function getState(): DesktopUpdateState {
    if (!enabled || state.status === "checking" || state.status === "downloading" || state.status === "ready") {
      return state;
    }
    const pending = newerInstalledVersion(process.execPath, currentVersion);
    if (!pending) return state;
    hooks.onUpdateReady?.(restartIntoInstalledBuild);
    state = { ...state, status: "ready", availableVersion: pending, error: null };
    hooks.onStateChange?.(state);
    return state;
  }

  return { getState, check, rollback, downloadPageURL: () => downloadPageURL(source()) };
}
