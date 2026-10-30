import { CloudAccount, type KnownProfileStatus } from "./cloud-account";
import { CATALOG, discoverProviderUsage, scanInstalledTools } from "../engine/discovery";
import { summarizeDiscovery } from "./provider-discovery";
import { ProviderCredentialStore, configureProviderCredentials } from "./provider-credentials";
import { isQuotaProvider, validateProviderCredential } from "../shared/quota-providers";
import { validateReportPlans } from "../shared/report-plans";
import type { DashboardSnapshot } from "@usageatlas/contracts";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from "electron";
import squirrelStartup from "electron-squirrel-startup";
import path from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { isLimitKey } from "../shared/capacity-model";
import { DashboardSession } from "./dashboard-session";
import type { AppMark, AppRoute, DesktopPreferences, WidgetResizeEdge } from "../shared/desktop-api";
import {
  IPC,
  isAccentTint,
  isAppearanceDensity,
  isAppearanceFont,
  isAppearanceSurface,
  isAppMark,
  isBackgroundImagePreference,
  isNumberStyle,
  isUpdateChannel,
  isUpdateRepository,
  isWidgetResizeEdge,
  sanitizeTokenAlerts
} from "../shared/desktop-api";
import { isLanguage } from "../shared/languages";
import { isUsageAlertPreferences } from "../shared/usage-alerts";
import { isGrowthEvent } from "../shared/growth-events";
import { EngineManager } from "./engine-manager";
import { PreferenceStore } from "./preferences";
import { PublicLeaderboard } from "./public-leaderboard";
import { DesktopTelemetry } from "./telemetry";
import { trayLimitLabels } from "./tray-limits";
import { resizeWidgetBounds } from "./widget-bounds";
import { configureAutoUpdates, type DesktopUpdater } from "./updates";
import { compareVersions, newerInstalledVersion, resolveUpdateSource } from "./update-feed";
import {
  createTokenAlertNotification,
  createUsageAlertNotification,
  TokenAlertEvaluator,
  UsageAlertDeliveryLog,
  UsageAlertEvaluator,
  type TriggeredTokenAlert,
  type TriggeredUsageAlert
} from "./usage-alerts";
import { UtilityEngineTransport } from "./utility-engine-transport";
import { WINDOW_ASPECT_RATIO, windowSizeForWorkArea } from "./window-sizing";
import { DESKTOP_VERSION } from "../shared/version";
import { rendererReleaseDelay, usageCheckDelay } from "./background-economy";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
]);
app.enableSandbox();
app.setName("UsageAtlas");
if (process.env.USAGEATLAS_SMOKE_TEST === "1") {
  const directory = mkdtempSync(path.join(tmpdir(), "usageatlas-smoke-"));
  app.setPath("userData", directory);
  writeFileSync(path.join(directory, "desktop-preferences.json"), JSON.stringify({
    launchAtLogin: false,
    anonymousAnalytics: false,
    providerEnabled: { codex: false, claude: false, cursor: false, opencode: false, antigravity: false, pi: false, muse: false,
      freebuff: false, warp: false, kimi: false, kilo: false, copilot: false, factory: false, amp: false, qoder: false, zai: false }
  }));
}
/**
 * The id Windows groups the window, its shortcuts and its toasts under. It is
 * deliberately not Squirrel's `com.squirrel.UsageAtlas.UsageAtlas`: the shell
 * caches the artwork of an AppUserModelID the first time it resolves one, and
 * every build installed under that id kept drawing the stock Electron atom in
 * the taskbar even with the right ICO on the executable, the shortcut and the
 * window itself. A brand id, written on the shortcut the app installs on every
 * launch, resolves to the app's own mark.
 */
const APP_USER_MODEL_ID = "com.usageatlas.desktop";

/**
 * The id Windows uses to group windows, shortcuts and toasts. A development run
 * registers its own shortcut, so it gets UsageAtlas artwork instead of Electron's.
 */
const APP_DEV_USER_MODEL_ID = "com.usageatlas.desktop.dev";
const appUserModelId = app.isPackaged ? APP_USER_MODEL_ID : APP_DEV_USER_MODEL_ID;
if (process.platform === "win32") app.setAppUserModelId(appUserModelId);

let mainWindow: BrowserWindow | null = null;
let widgetWindow: BrowserWindow | null = null;
let widgetMoveTimer: NodeJS.Timeout | null = null;
let widgetResize: { edge: WidgetResizeEdge; origin: Electron.Point; bounds: Electron.Rectangle; timer: NodeJS.Timeout } | null = null;
let widgetSnapping = false;
let registeredHotkey: string | null = null;
let tray: Tray | null = null;
let lastTraySnapshot: DashboardSnapshot | null = null;
let usageCheckTimer: NodeJS.Timeout | null = null;
let profileCheckTimer: NodeJS.Timeout | null = null;
let exportTimer: NodeJS.Timeout | null = null;
let pricingTimer: NodeJS.Timeout | null = null;
let backgroundReleaseTimer: NodeJS.Timeout | null = null;
/** The last frame of the main window, so a released window comes back where it was. */
let lastWindowBounds: Electron.Rectangle | null = null;
let onBattery = false;
let profileStatusReported = false;
let isQuitting = false;
/** Set by the login item so a sign-in launch can stay in the tray. */
const hiddenLaunch = process.argv.includes("--hidden");
let installPendingUpdate: (() => void) | null = null;
let engine: EngineManager;
let cloudAccount: CloudAccount;
const leaderboard = new PublicLeaderboard();
let providerCredentials: ProviderCredentialStore;
let preferences: PreferenceStore;
let telemetry: DesktopTelemetry;
let dashboard: DashboardSession;
let updates: DesktopUpdater;

const activeUsageNotifications = new Set<Notification>();
let usageAlertEvaluator = new UsageAlertEvaluator();
let lastBurnSample: { tokens: number; cost: number; at: number } | null = null;
let lastBurnAlertAt = 0;
const notifiedResets = new Set<string>();
const notifiedLogErrors = new Set<string>();
const tokenAlertEvaluator = new TokenAlertEvaluator();
const usageAlertDeliveryLog = new UsageAlertDeliveryLog();
/** Includes the X and Bluesky composers for sharing a recap. */
const allowedExternalHosts = new Set(["usageatlas.com", "github.com", "x.com", "bsky.app"]);
const MAX_SHARE_IMAGE_LENGTH = 16 * 1024 * 1024;
const PNG_DATA_URL = "data:image/png;base64,";
const MAX_BACKGROUND_FILE_SIZE = 25 * 1024 * 1024;
const runtimeIconDirectory = app.isPackaged
  ? path.join(process.resourcesPath, "icons")
  : path.join(app.getAppPath(), "resources", "icons");

const windowChrome = {
  light: { backgroundColor: "#f5f5f7", symbolColor: "#1d1d1f" },
  dark: { backgroundColor: "#1c1c1e", symbolColor: "#f5f5f7" }
} as const;
/** Which artwork each selectable mark ships as, under the packaged icons directory. */
const appMarkFiles: Record<AppMark, { png: string; ico: string }> = {
  datamosh: { png: "usageatlas.png", ico: "usageatlas.ico" },
  classic: { png: path.join("marks", "mark-classic.png"), ico: path.join("marks", "mark-classic.ico") },
  duotone: { png: path.join("marks", "mark-duotone.png"), ico: path.join("marks", "mark-duotone.ico") }
};

/**
 * Windows draws the window, taskbar and tray artwork from an ICO with the sizes
 * the shell asks for, so the chosen mark reaches the taskbar as well as the title
 * bar. The renderer still gets the PNG, which every platform can preview.
 */
function appMarkPath(mark: AppMark, format: "png" | "ico" = "png"): string {
  return path.join(runtimeIconDirectory, appMarkFiles[mark][format]);
}

/**
 * The file Explorer reads for the taskbar button, the toast identity and every
 * shortcut. It lives beside the `app-<version>` folders, not inside one: an
 * update deletes the previous build, which used to leave shortcuts pointing at a
 * missing ICO, and the shell then drew the stock Electron atom until the app had
 * started once. `refresh-install.ps1` refreshes this copy after an update too, so
 * even the Squirrel stub's shortcut is right before the new build launches.
 */
function stableAppMarkPath(): string {
  return app.isPackaged
    ? path.resolve(process.execPath, "..", "..", "app.ico")
    : path.join(app.getPath("userData"), "app.ico");
}

/** Copies the chosen mark to that stable path and returns it. */
function installAppMark(mark: AppMark): string {
  const target = stableAppMarkPath();
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(appMarkPath(mark, "ico"), target);
    return target;
  } catch {
    // A locked file still leaves the packaged copy usable.
    return appMarkPath(mark, "ico");
  }
}

function loadAppMark(mark: AppMark, format: "png" | "ico" = "png"): Electron.NativeImage {
  const image = nativeImage.createFromPath(appMarkPath(mark, format));
  if (image.isEmpty()) throw new Error("UsageAtlas application mark could not be loaded");
  return image;
}

function trayImage(image: Electron.NativeImage): Electron.NativeImage {
  const size = process.platform === "darwin" ? 18 : 22;
  return image.resize({ width: size, height: size, quality: "best" });
}

/**
 * The shortcut Squirrel installs for this app. Windows draws the Start Menu, the
 * taskbar pin and the toast identity from it, so its icon has to follow the picker
 * as well as the window's own icon.
 */
/**
 * Squirrel writes its shortcut inside a `UsageAtlas` folder. Updating only the
 * loose `UsageAtlas.lnk` leaves that one pointing at the build that installed the
 * app, which is why the taskbar kept the stock Electron atom after an update.
 */
function startMenuShortcutPaths(): string[] {
  const programs = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs");
  return [
    path.join(programs, "UsageAtlas", "UsageAtlas.lnk"),
    path.join(programs, "UsageAtlas.lnk")
  ];
}

/** Start Menu and an existing taskbar pin both carry the artwork Windows shows. */
function applicationShortcutPaths(): string[] {
  const shortcuts = startMenuShortcutPaths();
  const pinned = path.join(app.getPath("appData"), "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar");
  try {
    for (const entry of readdirSync(pinned)) {
      if (!entry.toLowerCase().endsWith(".lnk") || !/usage\s*atlas/iu.test(entry)) continue;
      shortcuts.push(path.join(pinned, entry));
    }
  } catch {
    // This account has never pinned the app.
  }
  return shortcuts;
}

function devShortcutPath(): string {
  return path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "UsageAtlas Dev.lnk");
}

/**
 * Windows takes the taskbar button and toast identity from a Start Menu shortcut
 * matching the process's AppUserModelID. An installed build already has one; a
 * development run creates its own, otherwise Explorer falls back to electron.exe
 * and every icon in the shell stays the stock atom. The shortcut is rewritten on
 * every launch, so a mark chosen in Settings is already right when the window
 * appears, and a restart is never needed for the shell to catch up.
 */
function applyShortcutMark(mark: AppMark): void {
  if (process.platform !== "win32" || process.env.USAGEATLAS_SMOKE_TEST === "1") return;
  const shortcuts = app.isPackaged ? applicationShortcutPaths() : [devShortcutPath()];
  const stub = path.resolve(process.execPath, "..", "..", "UsageAtlas.exe");
  const target = app.isPackaged && existsSync(stub) ? stub : process.execPath;
  const icon = installAppMark(mark);
  for (const shortcut of shortcuts) {
    try {
      // Always a fresh write: an older build's shortcut carries the Squirrel
      // AppUserModelID, and updating a shortcut in place can leave that identity
      // (with the atom Explorer cached for it) behind.
      shell.writeShortcutLink(shortcut, "create", {
        target,
        cwd: path.dirname(process.execPath),
        // A development shortcut must relaunch the same app, not an empty Electron.
        args: app.isPackaged ? undefined : app.getAppPath(),
        icon,
        iconIndex: 0,
        appUserModelId: app.isPackaged ? APP_USER_MODEL_ID : APP_DEV_USER_MODEL_ID,
        description: "UsageAtlas"
      });
    } catch {
      // A locked Start Menu still leaves the window, taskbar button and tray updated.
    }
  }
  // Explorer keeps the old icon in its cache; this asks it to re-read shortcuts.
  try {
    spawn("ie4uinit.exe", ["-show"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // Refreshing is cosmetic; the shortcut itself already carries the new icon.
  }
}

/** Swaps the window, taskbar, shortcut, dock and tray artwork without restarting. */
function applyAppMark(mark: AppMark): void {
  const image = loadAppMark(mark, process.platform === "win32" ? "ico" : "png");
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIcon(image);
    if (process.platform === "win32") {
      try {
        // The taskbar button of an AppUserModelID app follows these details, not
        // only setIcon; this is what makes the picker visible in the taskbar.
        mainWindow.setAppDetails({
          appId: appUserModelId,
          appIconPath: installAppMark(mark),
          appIconIndex: 0,
          // Relaunching this exact build keeps the icon and the version in step;
          // the Squirrel stub only forwards to it and can carry stale artwork.
          relaunchCommand: `"${process.execPath}"`,
          relaunchDisplayName: "UsageAtlas"
        });
      } catch {
        // setIcon above already changed the window artwork.
      }
    }
  }
  if (process.platform === "darwin") app.dock?.setIcon(image);
  if (tray && !tray.isDestroyed()) tray.setImage(trayImage(image));
  applyShortcutMark(mark);
}

function customBackgroundPath(): string {
  return path.join(app.getPath("userData"), "custom-background.jpg");
}

function customBackgroundUrl(): string | null {
  const imagePath = customBackgroundPath();
  if (!existsSync(imagePath)) return null;
  const image = nativeImage.createFromPath(imagePath);
  return image.isEmpty() ? null : `app://usageatlas/custom-background?v=${statSync(imagePath).mtimeMs}`;
}

function systemWindowChrome(): (typeof windowChrome)[keyof typeof windowChrome] {
  return nativeTheme.shouldUseDarkColors ? windowChrome.dark : windowChrome.light;
}

function createWindow(route: AppRoute = "day", showOnReady = true): BrowserWindow {
  const chrome = systemWindowChrome();
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width, height, minWidth, minHeight } = windowSizeForWorkArea(workArea);
  const window = new BrowserWindow({
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
    minWidth,
    minHeight,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: chrome.backgroundColor,
    // Windows draws the window and taskbar button from an ICO; handing it a PNG
    // leaves the Electron atom in place on some builds.
    icon: loadAppMark(preferences.get().appearance.mark, process.platform === "win32" ? "ico" : "png"),
    roundedCorners: true,
    // macOS keeps its traffic lights; every other platform draws its own controls
    // in the renderer's title bar, next to the window buttons the app already had.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const }
      : { titleBarStyle: "hidden" as const }),
    title: "UsageAtlas",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  window.setAspectRatio(WINDOW_ASPECT_RATIO);
  // A window released while hidden comes back where the user left it. The
  // bounds only live for this session: the OS still owns the normal restore.
  if (lastWindowBounds) window.setBounds(lastWindowBounds);
  const rememberBounds = (): void => {
    if (window.isDestroyed() || window.isMinimized() || window.isMaximized()) return;
    lastWindowBounds = window.getBounds();
  };
  window.on("resize", rememberBounds);
  window.on("move", rememberBounds);

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererURL(url)) event.preventDefault();
  });
  window.once("ready-to-show", () => {
    if (showOnReady) window.show();
    // Windows resolves the taskbar button once the window is on screen; setting
    // the icon again here covers an AUMID whose old shortcut Explorer cached.
    window.setIcon(loadAppMark(preferences.get().appearance.mark, process.platform === "win32" ? "ico" : "png"));
    if (process.platform === "win32") {
      try {
        window.setAppDetails({
          appId: appUserModelId,
          appIconPath: installAppMark(preferences.get().appearance.mark),
          appIconIndex: 0,
          relaunchCommand: `"${process.execPath}"`,
          relaunchDisplayName: "UsageAtlas"
        });
      } catch {
        // setIcon above already changed the window artwork.
      }
    }
  });
  window.on("close", (event) => {
    if (!isQuitting && preferences.get().minimizeToTray) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.on("show", () => {
    window.webContents.setFrameRate(60);
    cancelBackgroundRelease();
  });
  window.on("restore", cancelBackgroundRelease);
  // Hidden means hidden: the renderer stops compositing between now and the
  // release timer, so a tray-bound window costs almost no CPU in the meantime.
  window.on("hide", () => {
    window.webContents.setFrameRate(1);
    scheduleBackgroundRelease();
  });
  window.on("minimize", () => {
    window.webContents.setFrameRate(1);
    scheduleBackgroundRelease();
  });

  const syncWindowChrome = (): void => {
    window.setBackgroundColor(systemWindowChrome().backgroundColor);
  };
  nativeTheme.on("updated", syncWindowChrome);
  // The renderer draws the maximize glyph, so it is told when the state flips.
  const publishMaximized = (): void => {
    if (!window.isDestroyed()) window.webContents.send(IPC.windowMaximized, window.isMaximized());
  };
  window.on("maximize", publishMaximized);
  window.on("unmaximize", publishMaximized);
  window.once("closed", () => {
    nativeTheme.off("updated", syncWindowChrome);
    window.off("maximize", publishMaximized);
    window.off("unmaximize", publishMaximized);
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    url.hash = route;
    void window.loadURL(url.toString());
  } else {
    void window.loadURL(`app://usageatlas/index.html#${route}`);
  }
  return window;
}

function showWindow(route: AppRoute = "day"): void {
  cancelBackgroundRelease();
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow(route);
    mainWindow.setOpacity(preferences.get().appearance.windowOpacity);
  } else {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send(IPC.navigate, route);
  }
}

/** True while at least one window is actually on screen for the user. */
function anyWindowVisible(): boolean {
  const mainVisible = Boolean(mainWindow && !mainWindow.isDestroyed()
    && mainWindow.isVisible() && !mainWindow.isMinimized());
  const widgetVisible = Boolean(widgetWindow && !widgetWindow.isDestroyed()
    && widgetWindow.isVisible() && !widgetWindow.isMinimized());
  return mainVisible || widgetVisible;
}

function cancelBackgroundRelease(): void {
  if (!backgroundReleaseTimer) return;
  clearTimeout(backgroundReleaseTimer);
  backgroundReleaseTimer = null;
}

/**
 * Arms the release of hidden renderers. With power saving on, a window that
 * stays in the tray for half a minute gives its process back: on a typical
 * profile that is the single biggest block of memory the app holds, and none
 * of it is visible to the user. Showing the window rebuilds it at the last
 * route and size, so the only cost is a short paint.
 */
function scheduleBackgroundRelease(): void {
  cancelBackgroundRelease();
  if (isQuitting || !preferences) return;
  const delay = rendererReleaseDelay({
    windowVisible: anyWindowVisible(),
    powerSaving: preferences.get().powerSaving,
    onBattery
  });
  if (delay === null) return;
  backgroundReleaseTimer = setTimeout(() => {
    backgroundReleaseTimer = null;
    releaseBackgroundRenderers();
  }, delay);
  backgroundReleaseTimer.unref();
}

function releaseBackgroundRenderers(): void {
  if (isQuitting || anyWindowVisible()) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isMinimized() && !mainWindow.isMaximized()) lastWindowBounds = mainWindow.getBounds();
    mainWindow.destroy();
    mainWindow = null;
  }
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.destroy();
    widgetWindow = null;
  }
}

/**
 * The floating mini window. It is a second renderer over the same preload API,
 * framed by CSS rather than the OS, so it can carry the glass, the provider mark
 * and the same typography as the main window.
 */
function createWidgetWindow(showOnReady = false, focus = true): BrowserWindow {
  const saved = preferences.get().widget;
  const initial = saved.position
    ? { x: saved.position.x, y: saved.position.y, width: saved.width, height: saved.height }
    : defaultWidgetBounds(saved.width, saved.height);
  const window = new BrowserWindow({
    ...initial,
    minWidth: 180,
    minHeight: 104,
    maxWidth: 640,
    maxHeight: 400,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    // The CSS card draws its own shadow. A native shadow on a transparent
    // Windows window follows the window rectangle, which is the square edge
    // users saw around the rounded card.
    hasShadow: false,
    roundedCorners: true,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    title: "UsageAtlas mini window",
    // No `backgroundMaterial` here: acrylic paints the whole window rectangle and
    // squares off the rounded card. The renderer's CSS glass is the surface.
    ...(process.platform === "darwin" ? { vibrancy: "under-window" as const } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  window.setAlwaysOnTop(true, "floating");
  if (process.platform === "darwin") {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  window.setOpacity(saved.opacity);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererURL(url)) event.preventDefault();
  });
  window.once("ready-to-show", () => {
    if (!showOnReady) return;
    if (focus) window.show();
    else window.showInactive();
  });
  window.on("close", (event) => {
    endWidgetResize();
    if (isQuitting) return;
    event.preventDefault();
    window.hide();
  });
  window.on("closed", () => endWidgetResize());
  window.on("moved", scheduleWidgetBoundsSave);
  window.on("resized", scheduleWidgetBoundsSave);
  window.on("show", () => {
    cancelBackgroundRelease();
    updateTrayMenu();
  });
  window.on("hide", () => {
    scheduleBackgroundRelease();
    updateTrayMenu();
  });
  window.on("closed", () => {
    if (widgetWindow === window) widgetWindow = null;
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    url.hash = "widget";
    void window.loadURL(url.toString());
  } else {
    void window.loadURL("app://usageatlas/index.html#widget");
  }
  widgetWindow = window;
  return window;
}

/**
 * Windows keeps the tray and the clock at the bottom-right; the bottom-left is
 * the one corner nothing else occupies, so the card lands there by default.
 */
function defaultWidgetBounds(width: number, height: number): Electron.Rectangle {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return {
    width,
    height,
    x: Math.round(workArea.x + 24),
    y: Math.round(workArea.y + workArea.height - height - 24)
  };
}

function showWidget(focus = true): void {
  if (!preferences) return;
  cancelBackgroundRelease();
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    createWidgetWindow(true, focus);
    return;
  }
  widgetWindow.setOpacity(preferences.get().widget.opacity);
  if (widgetWindow.isMinimized()) widgetWindow.restore();
  if (focus) {
    widgetWindow.show();
    widgetWindow.focus();
  } else {
    widgetWindow.showInactive();
  }
}

function hideWidget(): void {
  endWidgetResize();
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide();
}

function toggleWidget(): void {
  if (widgetWindow?.isVisible()) hideWidget();
  else showWidget();
}

function expandWidget(): void {
  showWindow("day");
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

/**
 * Windows gives a transparent frameless window no resize border, so the card's
 * own handles drive this loop from the real cursor position. Polling the OS
 * cursor keeps the drag alive when it leaves the window.
 */
function beginWidgetResize(edge: WidgetResizeEdge): void {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  endWidgetResize();
  const origin = screen.getCursorScreenPoint();
  const bounds = widgetWindow.getBounds();
  const timer = setInterval(() => {
    if (!widgetWindow || widgetWindow.isDestroyed() || !widgetResize) {
      endWidgetResize();
      return;
    }
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    const next = resizeWidgetBounds(
      widgetResize.bounds,
      widgetResize.edge,
      point.x - widgetResize.origin.x,
      point.y - widgetResize.origin.y,
      display.workArea
    );
    widgetWindow.setBounds(next);
  }, 16);
  widgetResize = { edge, origin, bounds, timer };
}

function endWidgetResize(): void {
  if (!widgetResize) return;
  clearInterval(widgetResize.timer);
  widgetResize = null;
  if (widgetWindow && !widgetWindow.isDestroyed()) persistWidgetBounds();
}

/**
 * Squirrel leaves the previous build running. Two windows under one AppUserModelID
 * share one taskbar button, and Explorer can keep showing the old build's artwork.
 * `refresh-install.ps1` stops those processes, deletes their folders and drops the
 * shell icon cache, so an update always ends on one build with one icon.
 */
function retirePreviousBuilds(): void {
  if (process.platform !== "win32" || !app.isPackaged || process.env.USAGEATLAS_SMOKE_TEST === "1") return;
  const script = path.join(process.resourcesPath, "windows", "refresh-install.ps1");
  if (!existsSync(script)) return;
  try {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", script,
      "-InstallRoot", path.resolve(path.dirname(process.execPath), ".."),
      "-CurrentExe", process.execPath
    ], {
      windowsHide: true,
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch {
    // An older build that stays alive is not fatal; the single-instance hand-off
    // still keeps a second copy of this build from taking the window.
  }
}

function scheduleWidgetBoundsSave(): void {
  if (widgetMoveTimer) clearTimeout(widgetMoveTimer);
  widgetMoveTimer = setTimeout(() => {
    widgetMoveTimer = null;
    persistWidgetBounds();
  }, 250);
}

function persistWidgetBounds(): void {
  if (!widgetWindow || widgetWindow.isDestroyed() || !preferences) return;
  const bounds = widgetWindow.getBounds();
  const current = preferences.get().widget;
  let { x, y } = bounds;
  if (current.snapToEdges) {
    const { workArea } = screen.getDisplayMatching(bounds);
    const threshold = 18;
    if (Math.abs(x - workArea.x) <= threshold) x = workArea.x;
    if (Math.abs(x + bounds.width - (workArea.x + workArea.width)) <= threshold) {
      x = workArea.x + workArea.width - bounds.width;
    }
    if (Math.abs(y - workArea.y) <= threshold) y = workArea.y;
    if (Math.abs(y + bounds.height - (workArea.y + workArea.height)) <= threshold) {
      y = workArea.y + workArea.height - bounds.height;
    }
    if ((x !== bounds.x || y !== bounds.y) && !widgetSnapping) {
      widgetSnapping = true;
      widgetWindow.setPosition(x, y);
      setTimeout(() => { widgetSnapping = false; }, 80);
    }
  }
  preferences.update({
    widget: {
      ...current,
      width: Math.min(640, Math.max(180, bounds.width)),
      height: Math.min(400, Math.max(104, bounds.height)),
      position: { x, y }
    }
  });
}

function registerHotkey(accelerator: string): void {
  if (registeredHotkey) {
    globalShortcut.unregister(registeredHotkey);
    registeredHotkey = null;
  }
  if (!accelerator) return;
  try {
    if (globalShortcut.register(accelerator, toggleWidget)) registeredHotkey = accelerator;
  } catch {
    // An invalid accelerator is ignored; the tray item still opens the widget.
  }
}

function showTokenNotification(alert: TriggeredTokenAlert): void {
  if (!Notification.isSupported()) return;
  showNotification(createTokenAlertNotification(alert), "day");
}

function showUsageNotification(alert: TriggeredUsageAlert): void {
  if (!Notification.isSupported()) return;
  if (!usageAlertDeliveryLog.allow(alert)) return;
  showNotification(createUsageAlertNotification(alert), "limits");
}

function showNotification(content: { title: string; body: string }, route: AppRoute): void {
  const advance = preferences.get().advanced;
  const notification = new Notification({
    ...content,
    // Windows shows the registered app name above the title; the title itself
    // carries the brand too, so a toast is identifiable even without a shortcut.
    title: `UsageAtlas · ${content.title}`,
    icon: loadAppMark(preferences.get().appearance.mark),
    silent: !advance.notificationSounds
  });
  const release = (): void => {
    activeUsageNotifications.delete(notification);
  };
  notification.once("click", () => showWindow(route));
  notification.once("close", release);
  activeUsageNotifications.add(notification);
  // Windows can accept a toast and still hide it (Focus assist, per-app
  // notifications off). Mirror the alert in the window so it is never lost.
  mainWindow?.webContents.send(IPC.usageAlert, { ...content, route });
  // Do not disturb keeps the inbox complete while silencing the toast itself.
  if (!advance.dnd) notification.show();
  if (advance.notificationSounds && process.platform === "win32") shell.beep();
}

function applyAdvancedSettings(advanced: DesktopPreferences["advanced"]): Promise<void> {
  return engine.updateConfig({
    scan: {
      extraLogPaths: advanced.extraLogPaths,
      ignoredProjects: advanced.ignoredProjects
    },
    pricing: {
      promptCaching: advanced.promptCaching,
      // A flat rate is the only honest estimate for private model names; the
      // engine prices every new observation with it and a rescan reprices the
      // recent ledger, so the total on the dashboard matches the setting.
      blendedCostPerMillion: advanced.blendedCostEnabled ? advanced.blendedCostPerMillionUSD : null,
      overrides: advanced.modelCostOverrides.map((override) => ({
        model: override.model,
        input: override.input,
        output: override.output,
        cacheRead: override.cacheRead,
        cacheWrite: override.cacheWrite
      }))
    }
  }).then(() => undefined).catch(() => undefined);
}

function schedulePricingRefresh(hours: number): void {
  if (pricingTimer) clearInterval(pricingTimer);
  pricingTimer = null;
  if (hours <= 0) return;
  pricingTimer = setInterval(() => {
    void engine.refreshPricing()
      .then(() => dashboard.refresh(true))
      .catch(() => undefined);
  }, hours * 60 * 60_000);
  pricingTimer.unref();
}

function scheduleBackgroundUsageCheck(delayMs = 180_000): void {
  if (isQuitting) return;
  if (usageCheckTimer) clearTimeout(usageCheckTimer);
  usageCheckTimer = setTimeout(() => void runBackgroundUsageCheck(), delayMs);
  usageCheckTimer.unref();
}

/**
 * Alerts that need more than one snapshot: a burn rate is a delta, a reset warning
 * is a countdown, and a log failure is a source state. Each is delivered once per
 * incident, so a refresh loop cannot flood the notification centre.
 */
function evaluateDeliveryAlerts(snapshot: DashboardSnapshot): void {
  const advance = preferences.get().advanced;
  const providers = snapshot.providers.filter((provider) => provider.enabled);
  const tokens = providers.reduce((total, provider) => total + (provider.analytics?.today.totalTokens ?? 0), 0);
  const cost = providers.reduce((total, provider) => total + (provider.analytics?.today.estimatedCostUSD ?? 0), 0);
  const now = Date.now();

  if (advance.burnRateEnabled) {
    if (lastBurnSample) {
      const minutes = (now - lastBurnSample.at) / 60_000;
      if (minutes >= 0.5) {
        const tokensPerMinute = (tokens - lastBurnSample.tokens) / minutes;
        const dollarsPerMinute = (cost - lastBurnSample.cost) / minutes;
        const tooFast = tokensPerMinute >= advance.burnRateTokensPerMinute
          || dollarsPerMinute >= advance.burnRateUSDPerMinute;
        if (tooFast && now - lastBurnAlertAt > 30 * 60_000) {
          lastBurnAlertAt = now;
          showNotification({
            title: "Burn rate is high",
            body: `${compactTooltipNumber(Math.round(tokensPerMinute))} tokens/min and $${dollarsPerMinute.toFixed(2)}/min across your active tools.`
          }, "alerts");
        }
      }
    }
    lastBurnSample = { tokens, cost, at: now };
  } else {
    lastBurnSample = null;
  }

  if (advance.resetCountdownEnabled) {
    for (const provider of providers) {
      for (const window of provider.windows) {
        if (!window.resetAt) continue;
        const remaining = Date.parse(window.resetAt) - now;
        if (!Number.isFinite(remaining) || remaining <= 0 || remaining > advance.resetCountdownMinutes * 60_000) continue;
        const key = `${provider.id}:${window.kind}:${window.resetAt}`;
        if (notifiedResets.has(key)) continue;
        notifiedResets.add(key);
        showNotification({
          title: `${provider.name} resets soon`,
          body: `${window.label} quota resets in ${Math.max(1, Math.ceil(remaining / 60_000))} minutes.`
        }, "limits");
      }
    }
    if (notifiedResets.size > 500) notifiedResets.clear();
  }

  if (advance.notifyLogErrors) {
    const day = snapshot.generatedAt.slice(0, 10);
    for (const provider of providers) {
      const error = provider.analytics?.error;
      if (!error || !error.code.startsWith("analytics_")) continue;
      const key = `${provider.id}:${day}:${error.code}`;
      if (notifiedLogErrors.has(key)) continue;
      notifiedLogErrors.add(key);
      showNotification({
        title: `${provider.name} history could not be read`,
        body: error.message
      }, "diagnostics");
    }
    if (notifiedLogErrors.size > 500) notifiedLogErrors.clear();
  }
}

async function runBackgroundUsageCheck(): Promise<void> {
  let staleAfterSeconds = 180;
  try {
    const state = await dashboard.get();
    staleAfterSeconds = state.snapshot?.staleAfterSeconds ?? 180;
  } catch {
    // The next scheduled check retries without surfacing provider details in logs.
  } finally {
    scheduleBackgroundUsageCheck(usageCheckDelay({
      windowVisible: anyWindowVisible(),
      powerSaving: preferences.get().powerSaving,
      onBattery
    }, staleAfterSeconds));
  }
}

function createTray(): void {
  tray = new Tray(trayImage(loadAppMark(preferences.get().appearance.mark)));
  tray.setToolTip("UsageAtlas");
  updateTrayMenu();
  if (process.platform !== "darwin") {
    tray.on("click", () => showWindow("day"));
  }
}

function updateTrayMenu(snapshot: DashboardSnapshot | null = lastTraySnapshot): void {
  if (snapshot) lastTraySnapshot = snapshot;
  if (!tray || tray.isDestroyed()) return;

  const { advanced, limitOrder, trayLimits } = preferences.get();
  tray.setToolTip(trayTooltip(snapshot, advanced.trayMetric));
  const labels = snapshot ? trayLimitLabels(snapshot, limitOrder, trayLimits) : [];
  const limitRows: MenuItemConstructorOptions[] = snapshot
    ? labels.length > 0
      ? labels.map((label) => ({ label, enabled: false }))
      : [{ label: "No limits switched on", enabled: false }]
    : [{ label: "Loading available limits...", enabled: false }];

  const updateRows: MenuItemConstructorOptions[] = installPendingUpdate
    ? [
        { label: "Restart to install update", click: () => installPendingUpdate?.() },
        { type: "separator" }
      ]
    : [];

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Available limits", enabled: false },
    ...limitRows,
    { type: "separator" },
    ...updateRows,
    {
      label: "Mini window",
      type: "checkbox",
      checked: widgetWindow?.isVisible() ?? false,
      click: () => toggleWidget()
    },
    { label: "Open UsageAtlas", click: () => showWindow("day") },
    { label: "View all limits", click: () => showWindow("limits") },
    {
      label: "Refresh usage",
      click: () => {
        void dashboard.refresh(true);
      }
    },
    { type: "separator" },
    { label: "Settings", click: () => showWindow("settings") },
    { label: "Diagnostics", click: () => showWindow("diagnostics") },
    { type: "separator" },
    { label: "Quit", click: () => { isQuitting = true; app.quit(); } }
  ]));
}

/** A short, honest tray tooltip; `icon` keeps just the product name. */
function trayTooltip(snapshot: DashboardSnapshot | null, metric: string): string {
  if (!snapshot || metric === "icon") return "UsageAtlas";
  const providers = snapshot.providers.filter((provider) => provider.enabled);
  if (metric === "tokens") {
    const tokens = providers.reduce((total, provider) => total + (provider.analytics?.today.totalTokens ?? 0), 0);
    return `UsageAtlas — ${compactTooltipNumber(tokens)} tokens today`;
  }
  if (metric === "cost") {
    const costs = providers
      .map((provider) => provider.analytics?.today.estimatedCostUSD)
      .filter((value): value is number => value !== null && value !== undefined);
    const cost = costs.reduce((total, value) => total + value, 0);
    return `UsageAtlas — $${cost.toFixed(2)} estimated today`;
  }
  const remaining = providers.flatMap((provider) => provider.windows.map((window) => window.remainingPercent));
  return remaining.length > 0
    ? `UsageAtlas — ${Math.round(Math.min(...remaining))}% remaining`
    : "UsageAtlas — no metered limits";
}

function compactTooltipNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

interface EncryptedExport {
  format: "usageatlas-encrypted";
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
}

function exportKey(): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Encrypted exports need an available OS key store. Turn encryption off to export.");
  }
  const keyPath = path.join(app.getPath("userData"), "export-key.bin");
  if (existsSync(keyPath)) {
    return Buffer.from(safeStorage.decryptString(readFileSync(keyPath)), "base64");
  }
  const key = randomBytes(32);
  writeFileSync(keyPath, safeStorage.encryptString(key.toString("base64")), { mode: 0o600 });
  return key;
}

function encryptExport(json: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", exportKey(), iv);
  const data = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const envelope: EncryptedExport = {
    format: "usageatlas-encrypted",
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64")
  };
  return JSON.stringify(envelope, null, 2);
}

function decryptExport(text: string): string {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error("This file is not a UsageAtlas export.");
  }
  if (!envelope || typeof envelope !== "object") throw new Error("This file is not a UsageAtlas export.");
  const candidate = envelope as Partial<EncryptedExport>;
  if (candidate.format !== "usageatlas-encrypted") return text;
  if (candidate.version !== 1 || candidate.algorithm !== "aes-256-gcm"
    || typeof candidate.iv !== "string" || typeof candidate.tag !== "string" || typeof candidate.data !== "string") {
    throw new Error("This encrypted export has an unsupported format.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", exportKey(), Buffer.from(candidate.iv, "base64"));
    decipher.setAuthTag(Buffer.from(candidate.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(candidate.data, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    throw new Error("This encrypted export was made on another computer or is damaged.");
  }
}

function settingsPayload(): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "usageatlas.settings",
    exportedAt: new Date().toISOString(),
    appVersion: DESKTOP_VERSION,
    preferences: preferences.get()
  }, null, 2);
}

function applyImportedPreferences(previous: DesktopPreferences, nextPreferences: DesktopPreferences): void {
  if (previous.anonymousAnalytics !== nextPreferences.anonymousAnalytics) {
    telemetry.setEnabled(nextPreferences.anonymousAnalytics);
  }
  if (previous.appearance.mark !== nextPreferences.appearance.mark) {
    applyAppMark(nextPreferences.appearance.mark);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setOpacity(nextPreferences.appearance.windowOpacity);
  }
  if (previous.hotkey !== nextPreferences.hotkey) {
    registerHotkey(nextPreferences.hotkey);
  }
  if (nextPreferences.widget.enabled) showWidget(false);
  else hideWidget();
  if (previous.updateChannel !== nextPreferences.updateChannel || previous.updateRepository !== nextPreferences.updateRepository) {
    void updates.check().catch(() => undefined);
  }
  updateTrayMenu();
}

async function writeUsageExport(directory: string, automatic: boolean): Promise<boolean> {
  const state = await dashboard.get();
  const snapshot = state.snapshot;
  if (!snapshot) throw new Error("There is no usage to export yet.");
  const providers = snapshot.providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    enabled: provider.enabled,
    plan: provider.identity?.plan ?? null,
    windows: provider.windows,
    quotaMetrics: provider.quotaMetrics ?? [],
    today: provider.analytics?.today ?? null,
    daily: provider.analytics?.daily ?? [],
    models: provider.analytics?.models ?? []
  }));
  const payload = JSON.stringify({
    schemaVersion: 1,
    kind: "usageatlas.usage",
    exportedAt: new Date().toISOString(),
    appVersion: DESKTOP_VERSION,
    generatedAt: snapshot.generatedAt,
    automatic,
    providers
  }, null, 2);
  const advance = preferences.get().advanced;
  const fileName = `usageatlas-usage-${new Date().toISOString().slice(0, 10)}.${advance.encryptExports ? "uatlas" : "json"}`;
  const filePath = path.join(directory, fileName);
  writeFileSync(filePath, advance.encryptExports ? encryptExport(payload) : `${payload}\n`, { mode: 0o600 });
  preferences.update({ advanced: { ...advance, lastExportAt: new Date().toISOString() } });
  return true;
}

async function runScheduledExport(): Promise<void> {
  const advance = preferences.get().advanced;
  if (advance.exportSchedule === "off" || !advance.exportDirectory) return;
  const last = advance.lastExportAt ? Date.parse(advance.lastExportAt) : null;
  const now = Date.now();
  const due = advance.exportSchedule === "weekly"
    ? last === null || now - last >= 7 * 24 * 60 * 60_000
    : last === null || new Date(last).getUTCMonth() !== new Date(now).getUTCMonth()
      || new Date(last).getUTCFullYear() !== new Date(now).getUTCFullYear();
  if (!due) return;
  try {
    if (!existsSync(advance.exportDirectory)) mkdirSync(advance.exportDirectory, { recursive: true });
    await writeUsageExport(advance.exportDirectory, true);
  } catch {
    // A missing folder or an unavailable snapshot is retried on the next hourly check.
  }
}

function registerIPC(): void {
  ipcMain.handle(IPC.getProviderCredentials, event => {
    assertTrustedSender(event);
    return providerCredentials.statuses();
  });
  ipcMain.handle(IPC.setProviderCredential, async (event, id: unknown, raw: unknown) => {
    assertTrustedSender(event);
    if (!isQuotaProvider(id)) throw new Error("Unsupported provider connection.");
    const credential = validateProviderCredential(id, raw);
    const state = await dashboard.setProviderEnabled(id, credential !== null, async () => {
      providerCredentials.save(id, credential);
      await engine.updateConfig({ provider: id, credential: credential ? { ...credential } : null });
      preferences.update({ providerEnabled: { ...preferences.get().providerEnabled, [id]: credential !== null } });
    });
    if (state.error) throw new Error(state.error);
    return providerCredentials.statuses();
  });
  ipcMain.handle(IPC.getUpdateState, (event) => {
    assertTrustedSender(event);
    return updates.getState();
  });
  ipcMain.handle(IPC.checkForUpdates, (event) => {
    assertTrustedSender(event);
    return updates.check();
  });
  ipcMain.handle(IPC.rollbackUpdate, (event) => {
    assertTrustedSender(event);
    return updates.rollback();
  });
  ipcMain.handle(IPC.installUpdate, async (event) => {
    assertTrustedSender(event);
    if (updates.getState().status === "ready" && installPendingUpdate) installPendingUpdate();
    else if (updates.getState().status === "available") await shell.openExternal(updates.downloadPageURL());
    else throw new Error("No update is ready to install.");
  });
  ipcMain.handle(IPC.cloudStatus, (event) => {
    assertTrustedSender(event);
    return cloudAccount.status();
  });
  ipcMain.handle(IPC.cloudAction, async (event, action: unknown, options: unknown) => {
    assertTrustedSender(event);
    if (action === "sign-in") await cloudAccount.signIn();
    else if (action === "sign-out") await cloudAccount.signOut();
    else if (action === "save" || action === "restore") await cloudAccount.operation(action);
    else if (action === "refresh-profile") await cloudAccount.refreshProfile();
    else if (action === "automatic" && options && typeof options === "object" && "enabled" in options && typeof options.enabled === "boolean") {
      await cloudAccount.operation(action, { enabled: options.enabled });
    } else if (action === "resolve" && options && typeof options === "object" && "recordId" in options && typeof options.recordId === "string" && "choice" in options && (options.choice === "local" || options.choice === "cloud")) {
      await cloudAccount.operation(action, { recordId: options.recordId, choice: options.choice });
    } else throw new Error("Invalid cloud action.");
    return cloudAccount.status();
  });
  ipcMain.handle(IPC.checkHandle, (event, handle: unknown) => {
    assertTrustedSender(event);
    if (typeof handle !== "string") throw new Error("Invalid handle.");
    return cloudAccount.handleAvailable(handle);
  });
  ipcMain.handle(IPC.getLeaderboard, (event) => {
    assertTrustedSender(event);
    return leaderboard.glance();
  });
  // The window refuses every permission, including the web clipboard.
  ipcMain.handle(IPC.copyText, (event, text: unknown) => {
    assertTrustedSender(event);
    if (typeof text !== "string" || !text || text.length > 4096) throw new Error("Invalid text.");
    clipboard.writeText(text);
  });
  ipcMain.handle(IPC.copyImage, (event, png: unknown) => {
    assertTrustedSender(event);
    clipboard.writeImage(sharedImage(png));
  });
  ipcMain.handle(IPC.saveImage, async (event, png: unknown, fileName: unknown) => {
    assertTrustedSender(event);
    const image = sharedImage(png);
    if (typeof fileName !== "string" || !/^[a-z0-9-]{1,80}\.png$/u.test(fileName)) throw new Error("Invalid file name.");
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.SaveDialogOptions = {
      title: "Save image",
      defaultPath: path.join(app.getPath("downloads"), fileName),
      filters: [{ name: "PNG image", extensions: ["png"] }]
    };
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return false;
    writeFileSync(result.filePath, image.toPNG());
    return true;
  });
  ipcMain.handle(IPC.trackGrowthEvent, (event, name: unknown, properties: unknown) => {
    assertTrustedSender(event);
    if (!isGrowthEvent(name, properties)) throw new Error("Invalid analytics event.");
    telemetry.capture(name, properties as Record<string, string>);
  });
  ipcMain.handle(IPC.snapshot, (event) => {
    assertTrustedSender(event);
    return dashboard.get();
  });
  ipcMain.handle(IPC.refreshAll, (event) => {
    assertTrustedSender(event);
    return dashboard.refresh(true);
  });
  ipcMain.handle(IPC.setProviderEnabled, async (event, providerID: unknown, enabled: unknown) => {
    assertTrustedSender(event);
    if (typeof providerID !== "string" || !/^[a-z0-9-]{1,64}$/u.test(providerID)) {
      throw new Error("Invalid provider identifier");
    }
    if (typeof enabled !== "boolean") throw new Error("Invalid provider state");
    const current = preferences.get().providerEnabled;
    preferences.update({ providerEnabled: { ...current, [providerID]: enabled } });
    return dashboard.setProviderEnabled(providerID, enabled);
  });
  ipcMain.handle(IPC.discoverProvider, async (event, name: unknown) => {
    assertTrustedSender(event);
    if (typeof name !== "string") throw new Error("Enter a provider name to look for.");
    const provider = name.trim();
    if (!provider) throw new Error("Enter a provider name to look for.");
    if (provider.length > 64) throw new Error("Use a provider name of 64 characters or fewer.");
    const result = await discoverProviderUsage(provider, new Date(), {
      // One saved route per provider next to the other app data. A read-only
      // folder only costs a re-scan on the next look.
      cacheDirectory: path.join(app.getPath("userData"), "discovery")
    });
    return summarizeDiscovery(result);
  });
  ipcMain.handle(IPC.discoverableProviders, (event) => {
    assertTrustedSender(event);
    return CATALOG.map((entry) => entry.name);
  });
  ipcMain.handle(IPC.scanInstalledProviders, async (event) => {
    assertTrustedSender(event);
    // Folders only: no file contents, no network. A hit still has to be probed.
    return (await scanInstalledTools()).map(({ name, folder, kind }) => ({ name, folder, kind }));
  });
  ipcMain.handle(IPC.providerDirectory, async (event) => {
    assertTrustedSender(event);
    // The directory is passive: it lists what exists and what the app can read.
    // Nothing is enabled here — turning a tool on stays a deliberate click.
    const installed = await scanInstalledTools();
    const folderByName = new Map(installed.map((tool) => [tool.name, tool.folder]));
    const enabled = preferences.get().providerEnabled;
    return CATALOG.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      adapter: entry.adapter ?? null,
      tracked: entry.adapter ? enabled[entry.adapter] !== false : false,
      installedFolder: folderByName.get(entry.name) ?? null
    }));
  });
  ipcMain.handle(IPC.setReportPlans, async (event, value: unknown) => {
    assertTrustedSender(event);
    const next = preferences.update({ reportPlans: validateReportPlans(value) });
    await engine.setReportPlans(next.reportPlans);
    return next;
  });
  ipcMain.handle(IPC.minimizeWindow, (event) => {
    assertTrustedSender(event);
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle(IPC.toggleMaximizeWindow, (event) => {
    assertTrustedSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });
  ipcMain.handle(IPC.closeWindow, (event) => {
    assertTrustedSender(event);
    // Goes through the window's own close handler, so minimize-to-tray still applies.
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle(IPC.getWindowState, (event) => {
    assertTrustedSender(event);
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });
  ipcMain.handle(IPC.getPreferences, (event) => {
    assertTrustedSender(event);
    return preferences.get();
  });
  ipcMain.handle(IPC.updatePreferences, (event, patch: unknown) => {
    assertTrustedSender(event);
    if (!isPreferencePatch(patch)) throw new Error("Invalid preferences update");
    const previous = preferences.get();
    // Claim the accelerator before saving it, so a shortcut already owned by
    // another app is reported instead of silently stored.
    if (typeof patch.hotkey === "string" && patch.hotkey !== previous.hotkey) {
      registerHotkey(patch.hotkey);
      if (registeredHotkey !== patch.hotkey) {
        registerHotkey(previous.hotkey);
        throw new Error("That keyboard shortcut is already in use.");
      }
    }
    const nextPreferences = preferences.update(patch);
    if (previous.powerSaving !== nextPreferences.powerSaving) {
      if (nextPreferences.powerSaving) scheduleBackgroundRelease();
      else cancelBackgroundRelease();
    }
    if (previous.anonymousAnalytics !== nextPreferences.anonymousAnalytics) {
      telemetry.setEnabled(nextPreferences.anonymousAnalytics);
    }
    // A different publisher, or a different repository on the custom channel, is
    // checked against the new feed right away.
    if (previous.updateChannel !== nextPreferences.updateChannel || previous.updateRepository !== nextPreferences.updateRepository) {
      void updates.check().catch(() => undefined);
    }
    if (previous.appearance.mark !== nextPreferences.appearance.mark) {
      applyAppMark(nextPreferences.appearance.mark);
    }
    if (previous.appearance.windowOpacity !== nextPreferences.appearance.windowOpacity && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setOpacity(nextPreferences.appearance.windowOpacity);
    }
    if (previous.widget.opacity !== nextPreferences.widget.opacity && widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.setOpacity(nextPreferences.widget.opacity);
    }
    if (previous.widget.enabled !== nextPreferences.widget.enabled) {
      if (nextPreferences.widget.enabled) showWidget(false);
      else hideWidget();
    }
    if (JSON.stringify(previous.advanced) !== JSON.stringify(nextPreferences.advanced)) {
      // Pricing and scan roots only take effect on the next collection. Waiting
      // for the config write and then refreshing makes the new estimate visible
      // immediately instead of after the next scheduled scan.
      void applyAdvancedSettings(nextPreferences.advanced).then(() => dashboard.refresh(true));
    }
    if (previous.pricingSyncHours !== nextPreferences.pricingSyncHours) {
      schedulePricingRefresh(nextPreferences.pricingSyncHours);
    }
    if (JSON.stringify(previous.reportPlans) !== JSON.stringify(nextPreferences.reportPlans)) {
      void engine.setReportPlans(nextPreferences.reportPlans).catch(() => undefined);
    }
    if (nextPreferences.advanced.retentionDays > 0
      && previous.advanced.retentionDays !== nextPreferences.advanced.retentionDays) {
      void engine.updateConfig({ maintenance: { pruneDays: nextPreferences.advanced.retentionDays } }).catch(() => undefined);
    }
    updateTrayMenu();
    return nextPreferences;
  });
  ipcMain.handle(IPC.showWidget, (event) => {
    assertTrustedSender(event);
    showWidget();
  });
  ipcMain.handle(IPC.hideWidget, (event) => {
    assertTrustedSender(event);
    hideWidget();
  });
  ipcMain.handle(IPC.toggleWidget, (event) => {
    assertTrustedSender(event);
    toggleWidget();
  });
  ipcMain.handle(IPC.expandWidget, (event) => {
    assertTrustedSender(event);
    expandWidget();
  });
  ipcMain.handle(IPC.beginWidgetResize, (event, edge: WidgetResizeEdge) => {
    assertTrustedSender(event);
    if (!isWidgetResizeEdge(edge)) return;
    beginWidgetResize(edge);
  });
  ipcMain.handle(IPC.endWidgetResize, (event) => {
    assertTrustedSender(event);
    endWidgetResize();
  });
  ipcMain.handle(IPC.restartApp, (event) => {
    assertTrustedSender(event);
    isQuitting = true;
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle(IPC.chooseFolder, async (event) => {
    assertTrustedSender(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "Choose a folder",
      properties: ["openDirectory"]
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle(IPC.chooseExportDirectory, async (event) => {
    assertTrustedSender(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "Choose where automatic exports are written",
      properties: ["openDirectory", "createDirectory"]
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const directory = result.filePaths[0];
    const advance = preferences.get().advanced;
    preferences.update({ advanced: { ...advance, exportDirectory: directory } });
    return directory;
  });
  ipcMain.handle(IPC.exportSettings, async (event) => {
    assertTrustedSender(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const encrypted = preferences.get().advanced.encryptExports;
    const options: Electron.SaveDialogOptions = {
      title: "Export UsageAtlas settings",
      defaultPath: path.join(app.getPath("documents"), `usageatlas-settings-${new Date().toISOString().slice(0, 10)}.${encrypted ? "uatlas" : "json"}`),
      filters: encrypted
        ? [{ name: "Encrypted UsageAtlas export", extensions: ["uatlas"] }]
        : [{ name: "JSON", extensions: ["json"] }]
    };
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return false;
    const payload = settingsPayload();
    writeFileSync(result.filePath, encrypted ? encryptExport(payload) : `${payload}\n`, { mode: 0o600 });
    return true;
  });
  ipcMain.handle(IPC.importSettings, async (event) => {
    assertTrustedSender(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "Import UsageAtlas settings",
      properties: ["openFile"],
      filters: [{ name: "UsageAtlas export", extensions: ["json", "uatlas"] }]
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const text = readFileSync(result.filePaths[0], "utf8");
    const decoded = decryptExport(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw new Error("This settings file is not valid JSON.");
    }
    if (!parsed || typeof parsed !== "object") throw new Error("This settings file has no preferences.");
    const candidate = (parsed as { preferences?: unknown }).preferences ?? parsed;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("This settings file has no preferences.");
    }
    const { providerEnabled: _providers, customBackgroundName: _background, ...patch } = candidate as Record<string, unknown>;
    void _providers;
    void _background;
    if (!isPreferencePatch(patch)) throw new Error("This settings file uses an unsupported format.");
    const previous = preferences.get();
    const nextPreferences = preferences.update(patch);
    applyImportedPreferences(previous, nextPreferences);
    return nextPreferences;
  });
  ipcMain.handle(IPC.exportUsageNow, async (event) => {
    assertTrustedSender(event);
    let directory = preferences.get().advanced.exportDirectory;
    if (!directory) {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.OpenDialogOptions = {
        title: "Choose where to write the usage export",
        properties: ["openDirectory", "createDirectory"]
      };
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) return false;
      directory = result.filePaths[0];
      const advance = preferences.get().advanced;
      preferences.update({ advanced: { ...advance, exportDirectory: directory } });
    }
    return writeUsageExport(directory, false);
  });
  ipcMain.handle(IPC.getAppMarks, (event) => {
    assertTrustedSender(event);
    return Object.fromEntries(Object.keys(appMarkFiles).map(mark => [mark, loadAppMark(mark as AppMark).toDataURL()])) as Record<AppMark, string>;
  });
  ipcMain.handle(IPC.sendTestAlert, (event, tokens: unknown, providerName: unknown) => {
    assertTrustedSender(event);
    const safeTokens = typeof tokens === "number" && Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)) : 12_400;
    const safeName = typeof providerName === "string" && providerName.trim().length > 0 && providerName.length <= 80
      ? providerName.trim() : "a source";
    if (!Notification.isSupported()) return false;
    showNotification(createTokenAlertNotification({ providerID: "test", providerName: safeName, tokens: safeTokens }), "alerts");
    return true;
  });
  ipcMain.handle(IPC.getCustomBackground, (event) => {
    assertTrustedSender(event);
    return customBackgroundUrl();
  });
  ipcMain.handle(IPC.chooseCustomBackground, async (event) => {
    assertTrustedSender(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "Choose a background image",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }]
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;

    const sourcePath = result.filePaths[0];
    if (statSync(sourcePath).size > MAX_BACKGROUND_FILE_SIZE) {
      throw new Error("Choose an image smaller than 25 MB.");
    }
    const image = nativeImage.createFromPath(sourcePath);
    if (image.isEmpty()) throw new Error("The selected file is not a supported image.");

    const encodedImage = image.toJPEG(90);
    writeFileSync(customBackgroundPath(), encodedImage, { mode: 0o600 });
    const nextPreferences = preferences.update({
      backgroundImage: "custom",
      customBackgroundName: path.basename(sourcePath)
    });
    const imageUrl = customBackgroundUrl();
    if (!imageUrl) throw new Error("The background image could not be saved.");
    return { preferences: nextPreferences, imageUrl };
  });
  ipcMain.handle(IPC.getDiagnostics, (event) => {
    assertTrustedSender(event);
    return engine.getDiagnostics();
  });
  ipcMain.handle(IPC.openExternal, (event, url: unknown) => {
    assertTrustedSender(event);
    if (typeof url !== "string" || !isAllowedExternal(url)) return false;
    return shell.openExternal(url).then(() => true);
  });
}

/** Reports the share of installs with a public profile once per launch, and each publish seen. */
function reportProfile(accountId: string, profile: KnownProfileStatus): void {
  const previous = preferences.recordProfileState(accountId, profile.state);
  if (!profileStatusReported) {
    profileStatusReported = true;
    telemetry.capture("profile_status_checked", { state: profile.state });
  }
  if (profile.state === "public" && previous !== null && previous !== "public")
    telemetry.capture("profile_published", { previous_state: previous });
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (!frame || frame !== frame.top || !isTrustedRendererURL(frame.url)) {
    throw new Error("Untrusted IPC sender");
  }
}

function isTrustedRendererURL(value: string): boolean {
  try {
    const candidate = new URL(value);
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      return candidate.origin === new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin;
    }
    return candidate.protocol === "app:" && candidate.hostname === "usageatlas";
  } catch {
    return false;
  }
}

/** A PNG the renderer drew, decoded and re-encoded before it reaches the clipboard or disk. */
function sharedImage(value: unknown): Electron.NativeImage {
  if (typeof value !== "string" || !value.startsWith(PNG_DATA_URL) || value.length > MAX_SHARE_IMAGE_LENGTH) throw new Error("Invalid image.");
  const image = nativeImage.createFromBuffer(Buffer.from(value.slice(PNG_DATA_URL.length), "base64"));
  if (image.isEmpty()) throw new Error("Invalid image.");
  return image;
}

function isAllowedExternal(value: string): boolean {
  try {
    const candidate = new URL(value);
    return candidate.protocol === "https:" && allowedExternalHosts.has(candidate.hostname);
  } catch {
    return false;
  }
}

function isPreferencePatch(value: unknown): value is Partial<DesktopPreferences> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const patch = value as Record<string, unknown>;
  if (Object.keys(patch).some((key) => !["launchAtLogin", "minimizeToTray", "anonymousAnalytics", "backgroundImage", "usageAlerts", "tokenAlerts", "appearance", "language", "limitOrder", "trayLimits", "updateChannel", "updateRepository", "startMinimized", "hotkey", "pricingSyncHours", "powerSaving", "widget", "advanced"].includes(key))) {
    return false;
  }
  return (patch.launchAtLogin === undefined || typeof patch.launchAtLogin === "boolean")
    && (patch.language === undefined || isLanguage(patch.language))
    && (patch.appearance === undefined || isAppearancePatch(patch.appearance))
    && (patch.tokenAlerts === undefined || isTokenAlertPatch(patch.tokenAlerts))
    && (patch.minimizeToTray === undefined || typeof patch.minimizeToTray === "boolean")
    && (patch.anonymousAnalytics === undefined || typeof patch.anonymousAnalytics === "boolean")
    && (patch.startMinimized === undefined || typeof patch.startMinimized === "boolean")
    && (patch.powerSaving === undefined || typeof patch.powerSaving === "boolean")
    && (patch.hotkey === undefined || (typeof patch.hotkey === "string" && patch.hotkey.trim().length > 0 && patch.hotkey.length <= 128))
    && (patch.pricingSyncHours === undefined || (typeof patch.pricingSyncHours === "number" && Number.isInteger(patch.pricingSyncHours) && patch.pricingSyncHours >= 0 && patch.pricingSyncHours <= 168))
    && (patch.widget === undefined || (Boolean(patch.widget) && typeof patch.widget === "object" && !Array.isArray(patch.widget)))
    && (patch.advanced === undefined || (Boolean(patch.advanced) && typeof patch.advanced === "object" && !Array.isArray(patch.advanced)))
    && (patch.backgroundImage === undefined || isBackgroundImagePreference(patch.backgroundImage))
    && (patch.limitOrder === undefined || (
      Array.isArray(patch.limitOrder)
      && patch.limitOrder.length <= 128
      && patch.limitOrder.every(isLimitKey)
    ))
    && (patch.trayLimits === undefined || isTrayLimitPatch(patch.trayLimits))
    && (patch.updateChannel === undefined || isUpdateChannel(patch.updateChannel))
    && (patch.updateRepository === undefined || isUpdateRepository(patch.updateRepository))
    && (patch.usageAlerts === undefined || isUsageAlertPreferences(patch.usageAlerts));
}

function isAppearancePatch(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const patch = value as Record<string, unknown>;
  if (Object.keys(patch).some((key) => !["font", "fontScale", "textColor", "mark", "numberStyle", "accent", "surface", "animate", "density", "windowOpacity", "blur", "providerColors"].includes(key))) return false;
  return (patch.font === undefined || isAppearanceFont(patch.font))
    && (patch.mark === undefined || isAppMark(patch.mark))
    && (patch.numberStyle === undefined || isNumberStyle(patch.numberStyle))
    && (patch.accent === undefined || isAccentTint(patch.accent))
    && (patch.surface === undefined || isAppearanceSurface(patch.surface))
    && (patch.density === undefined || isAppearanceDensity(patch.density))
    && (patch.animate === undefined || typeof patch.animate === "boolean")
    && (patch.fontScale === undefined || (
      typeof patch.fontScale === "number"
      && Number.isFinite(patch.fontScale)
      && patch.fontScale >= 0.85
      && patch.fontScale <= 1.3
    ))
    && (patch.windowOpacity === undefined || (typeof patch.windowOpacity === "number" && patch.windowOpacity >= 0.7 && patch.windowOpacity <= 1))
    && (patch.blur === undefined || (typeof patch.blur === "number" && Number.isInteger(patch.blur) && patch.blur >= 0 && patch.blur <= 32))
    && (patch.providerColors === undefined || (Boolean(patch.providerColors) && typeof patch.providerColors === "object" && !Array.isArray(patch.providerColors)))
    && (patch.textColor === undefined || patch.textColor === null
      || (typeof patch.textColor === "string" && /^#[0-9a-f]{6}$/iu.test(patch.textColor)));
}

function isTokenAlertPatch(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const patch = value as Record<string, unknown>;
  if (Object.keys(patch).some((key) => !["enabled", "thresholdTokens"].includes(key))) return false;
  const sanitized = sanitizeTokenAlerts(patch);
  return (patch.enabled === undefined || typeof patch.enabled === "boolean")
    && (patch.thresholdTokens === undefined || (
      typeof patch.thresholdTokens === "number"
      && Number.isSafeInteger(patch.thresholdTokens)
      && patch.thresholdTokens >= 1_000
      && patch.thresholdTokens <= 1_000_000_000
      && sanitized.thresholdTokens === patch.thresholdTokens
    ));
}

function isTrayLimitPatch(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 128
    && entries.every(([key, shown]) => isLimitKey(key) && typeof shown === "boolean");
}

async function registerApplicationProtocol(): Promise<void> {
  const rendererRoot = path.resolve(__dirname, "../renderer", MAIN_WINDOW_VITE_NAME);
  protocol.handle("app", (request) => {
    const parsed = new URL(request.url);
    if (parsed.hostname !== "usageatlas") return new Response("Not found", { status: 404 });
    if (parsed.pathname === "/custom-background") {
      const imagePath = customBackgroundPath();
      return existsSync(imagePath)
        ? net.fetch(pathToFileURL(imagePath).toString())
        : new Response("Not found", { status: 404 });
    }
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) return new Response("Not found", { status: 404 });
    const relativePath = decodeURIComponent(parsed.pathname).replace(/^\/+/, "") || "index.html";
    const requestedPath = path.resolve(rendererRoot, relativePath);
    if (requestedPath !== rendererRoot && !requestedPath.startsWith(`${rendererRoot}${path.sep}`)) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(requestedPath).toString());
  });
}

/*
 * One copy of the app per computer. Squirrel leaves the previous version running
 * after an update, and several builds sharing this profile fight over the history
 * database and keep the old build's taskbar icon in front of the new one.
 */
/**
 * A newer build that cannot take the lock asks the running copy to step aside.
 * Without this hand-off, Squirrel's update installs a new `app-*` folder while
 * the previous version keeps the window, the database and the old taskbar icon.
 */
const hasSingleInstanceLock = squirrelStartup || app.requestSingleInstanceLock({
  takeoverVersion: app.getVersion()
});
app.on("second-instance", (_event, _argv, _workingDirectory, additionalData) => {
  const takeoverVersion = (additionalData as { takeoverVersion?: string } | undefined)?.takeoverVersion;
  if (takeoverVersion && compareVersions(takeoverVersion, app.getVersion()) > 0) {
    const newer = newerInstalledVersion(process.execPath, app.getVersion());
    const build = newer
      ? path.resolve(path.dirname(process.execPath), "..", `app-${newer}`, "UsageAtlas.exe")
      : null;
    if (build && existsSync(build)) {
      // Relaunch after this process releases the lock, not before: two copies
      // starting at once would only repeat the same hand-off.
      isQuitting = true;
      app.relaunch({ execPath: build, args: [] });
      app.quit();
      return;
    }
  }
  // The window may have been released while the app sat in the tray; launching
  // the shortcut again should bring it back rather than do nothing.
  if (!mainWindow || mainWindow.isDestroyed()) {
    showWindow("day");
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

if (squirrelStartup || !hasSingleInstanceLock) {
  app.quit();
} else void app.whenReady().then(async () => {
  // Launching an older executable directly (a stale desktop shortcut, Explorer's
  // recent list) still lands on the newest installed build. The stub would do
  // this by itself; this covers the paths around it.
  const installedAhead = process.platform === "win32" && app.isPackaged
    ? newerInstalledVersion(process.execPath, app.getVersion())
    : null;
  if (installedAhead) {
    const build = path.resolve(path.dirname(process.execPath), "..", `app-${installedAhead}`, "UsageAtlas.exe");
    if (existsSync(build)) {
      app.relaunch({ execPath: build, args: [] });
      app.exit(0);
      return;
    }
  }
  if (process.platform === "darwin") app.dock?.setIcon(loadAppMark("datamosh"));
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  await registerApplicationProtocol();
  retirePreviousBuilds();
  preferences = new PreferenceStore();
  providerCredentials = new ProviderCredentialStore(path.join(app.getPath("userData"), "provider-credentials"));
  telemetry = new DesktopTelemetry(preferences);
  engine = new EngineManager(
    () => new UtilityEngineTransport(
      path.join(__dirname, "engine-entry.js"),
      path.join(app.getPath("userData"), "history.sqlite")
    )
  );
  engine.onStatus((status) => mainWindow?.webContents.send(IPC.engineStatus, status));
  dashboard = new DashboardSession(engine, state => {
    if (isQuitting) return;
    lastTraySnapshot = state.snapshot;
    if (!state.snapshot) usageAlertEvaluator = new UsageAlertEvaluator();
    updateTrayMenu(state.snapshot);
    mainWindow?.webContents.send(IPC.snapshotUpdated, state);
  }, snapshot => {
    const alerts = usageAlertEvaluator.evaluate(snapshot, preferences.get().usageAlerts);
    for (const alert of alerts) showUsageNotification(alert);
    for (const alert of tokenAlertEvaluator.evaluate(snapshot, preferences.get().tokenAlerts)) showTokenNotification(alert);
    evaluateDeliveryAlerts(snapshot);
  });
  engine.onProgress(progress => dashboard.progress(progress));
  engine.onImportProgress(message => dashboard.importProgress(message.accountId, message.progress));
  cloudAccount = new CloudAccount(engine, (accountId, configure, reconnect) =>
    dashboard.configure(accountId, configure, reconnect), reportProfile);
  engine.onHistoryChanged(() => dashboard.historyChanged());
  await cloudAccount.initialize().catch(() => undefined);
  await configureProviderCredentials(providerCredentials, engine);
  engine.onStatus(status => {
    if (status === "ready") void configureProviderCredentials(providerCredentials, engine)      .then(() => engine.applyProviderPreferences(preferences.get().providerEnabled))
      .then(() => engine.setReportPlans(preferences.get().reportPlans))
      .then(() => cloudAccount.reconnect()).catch(() => undefined);
  });
  await engine.applyProviderPreferences(preferences.get().providerEnabled);
  await engine.setReportPlans(preferences.get().reportPlans);
  await applyAdvancedSettings(preferences.get().advanced);
  schedulePricingRefresh(preferences.get().pricingSyncHours);
  dashboard.activate();
  registerIPC();
  createTray();
  // Write the shell shortcut before the first window exists: Windows resolves a
  // taskbar button's identity when it is created, so doing this afterwards would
  // leave the first launch of a new build on the previous icon.
  applyAppMark(preferences.get().appearance.mark);
  const startHidden = hiddenLaunch && preferences.get().startMinimized;
  mainWindow = createWindow("day", !startHidden);
  mainWindow.setOpacity(preferences.get().appearance.windowOpacity);
  applyAppMark(preferences.get().appearance.mark);
  registerHotkey(preferences.get().hotkey);
  if (preferences.get().widget.enabled) showWidget(!startHidden);
  telemetry.capture("desktop_app_opened");
  if (cloudAccount.profileStatus().state === "signed-out") {
    profileStatusReported = true;
    telemetry.capture("profile_status_checked", { state: "signed-out" });
  }
  void cloudAccount.refreshProfile();
  // A profile published on the website shows up here within ten minutes.
  profileCheckTimer = setInterval(() => void cloudAccount.refreshProfile(), 10 * 60_000);
  profileCheckTimer.unref();
  updates = configureAutoUpdates({
    capture: (event) => telemetry.capture(event),
    // Read per check, so switching publisher takes effect on the next one.
    source: () => resolveUpdateSource(preferences.get().updateChannel, preferences.get().updateRepository),
    onStateChange: (state) => {
      if (state.status === "error") {
        if (installPendingUpdate) isQuitting = false;
        installPendingUpdate = null;
        updateTrayMenu();
      }
      mainWindow?.webContents.send(IPC.updateStateChanged, state);
    },
    onUpdateReady: (install) => {
      // The close handler keeps the window alive when minimize-to-tray is on,
      // which would stall the Squirrel restart.
      installPendingUpdate = () => {
        if (isQuitting) return;
        isQuitting = true;
        try { install(); } catch (error) { isQuitting = false; throw error; }
      };
      updateTrayMenu();
    }
  });
  // A hidden app costs what it collects, not what it renders. Battery and tray
  // state adjust both the release timer and the refresh cadence.
  onBattery = powerMonitor.isOnBatteryPower();
  powerMonitor.on("on-battery", () => { onBattery = true; scheduleBackgroundRelease(); });
  powerMonitor.on("on-ac", () => { onBattery = false; scheduleBackgroundRelease(); });
  scheduleBackgroundRelease();
  scheduleBackgroundUsageCheck();
  setTimeout(() => void runScheduledExport(), 45_000).unref();
  exportTimer = setInterval(() => void runScheduledExport(), 60 * 60_000);
  exportTimer.unref();
  if (process.env.USAGEATLAS_SMOKE_TEST === "1") void runPackagedSmokeTest(mainWindow);
  app.on("activate", () => showWindow());
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("before-quit", () => {
  isQuitting = true;
  cancelBackgroundRelease();
  if (usageCheckTimer) clearTimeout(usageCheckTimer);
  usageCheckTimer = null;
  if (profileCheckTimer) clearInterval(profileCheckTimer);
  profileCheckTimer = null;
  if (exportTimer) clearInterval(exportTimer);
  exportTimer = null;
  if (pricingTimer) clearInterval(pricingTimer);
  pricingTimer = null;
  cloudAccount?.close();
  dashboard?.close();
  void engine?.shutdown();
  void telemetry?.shutdown();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !preferences?.get().minimizeToTray) app.quit();
});

async function runPackagedSmokeTest(window: BrowserWindow): Promise<void> {
  try {
    if (!app.isPackaged) throw new Error("Packaged smoke mode requires a packaged application");
    await waitForRenderer(window);
    const rendererReady = await window.webContents.executeJavaScript(`(async () => {
      if (!window.usageAtlas) return false;
      for (let attempt = 0; attempt < 100 && !document.querySelector("#root")?.childElementCount; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!document.querySelector("#root")?.childElementCount) return false;
      const state = await window.usageAtlas.getSnapshot();
      const preferences = await window.usageAtlas.getPreferences();
      return Number.isInteger(state.revision) && preferences.anonymousAnalytics === false;
    })()`);
    if (!rendererReady) throw new Error("Renderer or preload API did not initialize");
    await engine.getSnapshot();
    await engine.shutdown();
    tray?.destroy();
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Packaged smoke test failed");
    tray?.destroy();
    if (!window.isDestroyed()) window.destroy();
    app.exit(1);
  }
}

async function waitForRenderer(window: BrowserWindow): Promise<void> {
  if (window.webContents.getURL() && !window.webContents.isLoadingMainFrame()) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Renderer smoke test timed out"));
    }, 15_000);
    timeout.unref();
    const cleanup = (): void => {
      clearTimeout(timeout);
      window.webContents.off("did-finish-load", handleLoaded);
      window.webContents.off("did-fail-load", handleFailed);
    };
    const handleLoaded = (): void => {
      cleanup();
      resolve();
    };
    const handleFailed = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean
    ): void => {
      if (!isMainFrame) return;
      cleanup();
      reject(new Error(`Renderer failed to load ${validatedURL}: ${errorCode} ${errorDescription}`));
    };
    window.webContents.once("did-finish-load", handleLoaded);
    window.webContents.on("did-fail-load", handleFailed);
  });
}
