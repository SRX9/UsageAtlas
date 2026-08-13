import { app, autoUpdater, net, Notification, shell } from "electron";
import {
  compareVersions,
  DOWNLOAD_PAGE_URL,
  LATEST_RELEASE_URL,
  latestPublishedVersion,
  redactUpdateError,
  squirrelFeedURL
} from "./update-feed";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const FIRST_CHECK_DELAY_MS = 10_000;

export interface AutoUpdateHooks {
  capture?: (event: string) => void;
  /**
   * Called once a downloaded update only needs a restart. Squirrel.Mac never
   * installs without `quitAndInstall`, so the app has to offer the restart.
   */
  onUpdateReady?: (install: () => void) => void;
}

// Notifications are collected until dismissed so they are not garbage collected
// while visible.
const activeNotifications = new Set<Notification>();
let announcedVersion: string | null = null;

export function configureAutoUpdates(hooks: AutoUpdateHooks = {}): void {
  if (!app.isPackaged || process.env.USAGEATLAS_SMOKE_TEST === "1") return;
  if (process.platform === "darwin" || process.platform === "win32") {
    configureSquirrelUpdates(hooks);
    return;
  }
  configureReleaseNotices(hooks);
}

function configureSquirrelUpdates(hooks: AutoUpdateHooks): void {
  const feedURL = squirrelFeedURL(process.platform, process.arch, app.getVersion());
  if (!feedURL) return;
  autoUpdater.setFeedURL({ url: feedURL });

  let timer: NodeJS.Timeout | null = null;
  const stopChecking = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  autoUpdater.on("checking-for-update", () => hooks.capture?.("desktop_update_checked"));
  autoUpdater.on("update-available", () => hooks.capture?.("desktop_update_available"));
  autoUpdater.on("update-downloaded", () => {
    hooks.capture?.("desktop_update_downloaded");
    // The staged build is downloaded once; further checks would re-download it
    // until the user restarts.
    stopChecking();
    hooks.onUpdateReady?.(() => autoUpdater.quitAndInstall());
  });
  autoUpdater.on("error", (error) => {
    console.error(`Update check failed: ${redactUpdateError(error.message)}`);
  });

  const check = (): void => {
    if (!process.argv.includes("--squirrel-firstrun")) autoUpdater.checkForUpdates();
  };
  setTimeout(check, FIRST_CHECK_DELAY_MS).unref();
  timer = setInterval(check, CHECK_INTERVAL_MS);
  timer.unref();
}

/**
 * Linux ships a portable AppImage with no installer to hand a new build to, so
 * the app reports a newer release and links to the download page instead.
 */
function configureReleaseNotices(hooks: AutoUpdateHooks): void {
  const check = (): void => void checkPublishedRelease(hooks);
  setTimeout(check, FIRST_CHECK_DELAY_MS).unref();
  setInterval(check, CHECK_INTERVAL_MS).unref();
}

async function checkPublishedRelease(hooks: AutoUpdateHooks): Promise<void> {
  hooks.capture?.("desktop_update_checked");
  try {
    const response = await net.fetch(LATEST_RELEASE_URL, { cache: "no-cache" });
    if (!response.ok) return;
    const version = latestPublishedVersion(await response.json());
    if (!version || compareVersions(version, app.getVersion()) <= 0) return;
    if (announcedVersion === version) return;
    announcedVersion = version;
    hooks.capture?.("desktop_update_available");
    announceRelease(version);
  } catch (error) {
    console.error(`Update check failed: ${redactUpdateError(error instanceof Error ? error.message : "unknown")}`);
  }
}

function announceRelease(version: string): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: `UsageAtlas ${version} is available`,
    body: "Open the download page to get the latest build."
  });
  notification.once("click", () => void shell.openExternal(DOWNLOAD_PAGE_URL));
  notification.once("close", () => activeNotifications.delete(notification));
  activeNotifications.add(notification);
  notification.show();
}
