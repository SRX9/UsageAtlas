import type { DashboardSnapshot } from "@usageatlas/contracts";
import { existsSync, statSync, writeFileSync } from "node:fs";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  protocol,
  screen,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from "electron";
import squirrelStartup from "electron-squirrel-startup";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isLimitKey } from "../shared/capacity-model";
import type { AppRoute, DesktopPreferences } from "../shared/desktop-api";
import { IPC } from "../shared/desktop-api";
import { isUsageAlertPreferences } from "../shared/usage-alerts";
import { EngineManager } from "./engine-manager";
import { PreferenceStore } from "./preferences";
import { DesktopTelemetry } from "./telemetry";
import { trayLimitLabels } from "./tray-limits";
import { configureAutoUpdates } from "./updates";
import {
  createUsageAlertNotification,
  UsageAlertDeliveryLog,
  UsageAlertEvaluator,
  type TriggeredUsageAlert
} from "./usage-alerts";
import { UtilityEngineTransport } from "./utility-engine-transport";
import { WINDOW_ASPECT_RATIO, windowSizeForWorkArea } from "./window-sizing";

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
if (process.platform === "win32") {
  app.setAppUserModelId(app.isPackaged
    ? "com.squirrel.UsageAtlas.UsageAtlas"
    : "com.usageatlas.desktop.dev");
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let lastTraySnapshot: DashboardSnapshot | null = null;
let usageCheckTimer: NodeJS.Timeout | null = null;
let isQuitting = false;
let installPendingUpdate: (() => void) | null = null;
let engine: EngineManager;
let preferences: PreferenceStore;
let telemetry: DesktopTelemetry;

const activeUsageNotifications = new Set<Notification>();
const usageAlertEvaluator = new UsageAlertEvaluator();
const usageAlertDeliveryLog = new UsageAlertDeliveryLog();
const allowedExternalHosts = new Set(["usageatlas.com", "github.com"]);
const MAX_BACKGROUND_FILE_SIZE = 25 * 1024 * 1024;
const runtimeIconDirectory = app.isPackaged
  ? path.join(process.resourcesPath, "icons")
  : path.join(app.getAppPath(), "resources", "icons");

const windowChrome = {
  light: { backgroundColor: "#f5f5f7", symbolColor: "#1d1d1f" },
  dark: { backgroundColor: "#1c1c1e", symbolColor: "#f5f5f7" }
} as const;
function runtimeIconPath(filename: "usageatlas.ico" | "usageatlas.png"): string {
  return path.join(runtimeIconDirectory, filename);
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

function loadRuntimeLogo(): Electron.NativeImage {
  const image = nativeImage.createFromPath(runtimeIconPath("usageatlas.png"));
  if (image.isEmpty()) throw new Error("UsageAtlas application icon could not be loaded");
  return image;
}

function loadWindowsIcon(): Electron.NativeImage {
  const image = nativeImage.createFromPath(runtimeIconPath("usageatlas.ico"));
  if (image.isEmpty()) throw new Error("UsageAtlas Windows icon could not be loaded");
  return image;
}

function systemWindowChrome(): (typeof windowChrome)[keyof typeof windowChrome] {
  return nativeTheme.shouldUseDarkColors ? windowChrome.dark : windowChrome.light;
}

function createWindow(route: AppRoute = "day"): BrowserWindow {
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
    icon: process.platform === "win32" ? loadWindowsIcon() : loadRuntimeLogo(),
    roundedCorners: true,
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const }
      : {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: { color: chrome.backgroundColor, symbolColor: chrome.symbolColor, height: 40 }
        }),
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

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererURL(url)) event.preventDefault();
  });
  window.once("ready-to-show", () => {
    window.show();
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

  const syncWindowChrome = (): void => {
    const next = systemWindowChrome();
    window.setBackgroundColor(next.backgroundColor);
    if (process.platform !== "darwin") {
      window.setTitleBarOverlay({ color: next.backgroundColor, symbolColor: next.symbolColor, height: 40 });
    }
  };
  nativeTheme.on("updated", syncWindowChrome);
  window.once("closed", () => {
    nativeTheme.off("updated", syncWindowChrome);
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
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow(route);
  } else {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send(IPC.navigate, route);
  }
}

async function getSnapshotWithUsageAlerts(force = false): Promise<DashboardSnapshot> {
  const snapshot = force ? await engine.refreshAll() : await engine.getSnapshot();
  updateTrayMenu(snapshot);
  const alerts = usageAlertEvaluator.evaluate(snapshot, preferences.get().usageAlerts);
  for (const alert of alerts) showUsageNotification(alert);
  return snapshot;
}

function showUsageNotification(alert: TriggeredUsageAlert): void {
  if (!Notification.isSupported()) return;
  if (!usageAlertDeliveryLog.allow(alert)) return;
  const content = createUsageAlertNotification(alert);
  const notification = new Notification({
    ...content,
    icon: runtimeIconPath("usageatlas.png")
  });
  const release = (): void => {
    activeUsageNotifications.delete(notification);
  };
  notification.once("click", () => showWindow("limits"));
  notification.once("close", release);
  activeUsageNotifications.add(notification);
  notification.show();
}

function scheduleBackgroundUsageCheck(delayMs = 180_000): void {
  if (isQuitting) return;
  if (usageCheckTimer) clearTimeout(usageCheckTimer);
  usageCheckTimer = setTimeout(() => void runBackgroundUsageCheck(), delayMs);
  usageCheckTimer.unref();
}

async function runBackgroundUsageCheck(): Promise<void> {
  let nextDelayMs = 60_000;
  try {
    const snapshot = await getSnapshotWithUsageAlerts();
    mainWindow?.webContents.send(IPC.snapshotUpdated, snapshot);
    nextDelayMs = Math.max(30, Math.min(snapshot.staleAfterSeconds, 300)) * 1_000;
  } catch {
    // The next scheduled check retries without surfacing provider details in logs.
  } finally {
    scheduleBackgroundUsageCheck(nextDelayMs);
  }
}

function createTray(): void {
  const image = process.platform === "win32"
    ? loadWindowsIcon()
    : loadRuntimeLogo().resize({
        width: process.platform === "darwin" ? 18 : 22,
        height: process.platform === "darwin" ? 18 : 22,
        quality: "best"
      });
  tray = new Tray(image);
  tray.setToolTip("UsageAtlas");
  updateTrayMenu();
  if (process.platform !== "darwin") {
    tray.on("click", () => showWindow("day"));
  }
}

function updateTrayMenu(snapshot: DashboardSnapshot | null = lastTraySnapshot): void {
  if (snapshot) lastTraySnapshot = snapshot;
  if (!tray || tray.isDestroyed()) return;

  const { limitOrder, trayLimits } = preferences.get();
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
    { label: "Open UsageAtlas", click: () => showWindow("day") },
    { label: "View all limits", click: () => showWindow("limits") },
    {
      label: "Refresh usage",
      click: () => {
        void getSnapshotWithUsageAlerts(true).then((snapshot) => {
          mainWindow?.webContents.send(IPC.snapshotUpdated, snapshot);
        });
      }
    },
    { type: "separator" },
    { label: "Settings", click: () => showWindow("settings") },
    { label: "Diagnostics", click: () => showWindow("diagnostics") },
    { type: "separator" },
    { label: "Quit", click: () => { isQuitting = true; app.quit(); } }
  ]));
}

function registerIPC(): void {
  ipcMain.handle(IPC.snapshot, (event) => {
    assertTrustedSender(event);
    return getSnapshotWithUsageAlerts();
  });
  ipcMain.handle(IPC.refreshAll, (event) => {
    assertTrustedSender(event);
    return getSnapshotWithUsageAlerts(true);
  });
  ipcMain.handle(IPC.setProviderEnabled, async (event, providerID: unknown, enabled: unknown) => {
    assertTrustedSender(event);
    if (typeof providerID !== "string" || !/^[a-z0-9-]{1,64}$/u.test(providerID)) {
      throw new Error("Invalid provider identifier");
    }
    if (typeof enabled !== "boolean") throw new Error("Invalid provider state");
    const current = preferences.get().providerEnabled;
    preferences.update({ providerEnabled: { ...current, [providerID]: enabled } });
    const snapshot = await engine.setProviderEnabled(providerID, enabled);
    updateTrayMenu(snapshot);
    const alerts = usageAlertEvaluator.evaluate(snapshot, preferences.get().usageAlerts);
    for (const alert of alerts) showUsageNotification(alert);
    return snapshot;
  });
  ipcMain.handle(IPC.getPreferences, (event) => {
    assertTrustedSender(event);
    return preferences.get();
  });
  ipcMain.handle(IPC.updatePreferences, (event, patch: unknown) => {
    assertTrustedSender(event);
    if (!isPreferencePatch(patch)) throw new Error("Invalid preferences update");
    const nextPreferences = preferences.update(patch);
    updateTrayMenu();
    return nextPreferences;
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
  if (Object.keys(patch).some((key) => !["launchAtLogin", "minimizeToTray", "anonymousAnalytics", "backgroundImage", "usageAlerts", "limitOrder", "trayLimits"].includes(key))) {
    return false;
  }
  return (patch.launchAtLogin === undefined || typeof patch.launchAtLogin === "boolean")
    && (patch.minimizeToTray === undefined || typeof patch.minimizeToTray === "boolean")
    && (patch.anonymousAnalytics === undefined || typeof patch.anonymousAnalytics === "boolean")
    && (patch.backgroundImage === undefined || patch.backgroundImage === "default" || patch.backgroundImage === "custom")
    && (patch.limitOrder === undefined || (
      Array.isArray(patch.limitOrder)
      && patch.limitOrder.length <= 128
      && patch.limitOrder.every(isLimitKey)
    ))
    && (patch.trayLimits === undefined || isTrayLimitPatch(patch.trayLimits))
    && (patch.usageAlerts === undefined || isUsageAlertPreferences(patch.usageAlerts));
}

function isTrayLimitPatch(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 128
    && entries.every(([key, shown]) => isLimitKey(key) && typeof shown === "boolean");
}

/**
 * A downloaded update is staged but not live: Squirrel.Mac only installs on
 * `quitAndInstall`, and a restart is what swaps the running Windows build.
 */
async function promptToInstallUpdate(): Promise<void> {
  const install = installPendingUpdate;
  if (!install || process.env.USAGEATLAS_SMOKE_TEST === "1") return;
  const options: Electron.MessageBoxOptions = {
    type: "question",
    title: "Update ready",
    message: "A new version of UsageAtlas is ready to install.",
    detail: "Restarting takes a moment. You can also restart later from the tray menu.",
    buttons: ["Restart now", "Later"],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  };
  const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const result = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options);
  if (result.response === 0) install();
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

if (squirrelStartup) {
  app.quit();
} else void app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock?.setIcon(loadRuntimeLogo());
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  await registerApplicationProtocol();
  preferences = new PreferenceStore();
  telemetry = new DesktopTelemetry(preferences);
  engine = new EngineManager(
    () => new UtilityEngineTransport(path.join(__dirname, "engine-entry.js"))
  );
  engine.onStatus((status) => mainWindow?.webContents.send(IPC.engineStatus, status));
  await engine.applyProviderPreferences(preferences.get().providerEnabled);
  registerIPC();
  createTray();
  mainWindow = createWindow();
  telemetry.capture("desktop_app_opened");
  configureAutoUpdates({
    capture: (event) => telemetry.capture(event),
    onUpdateReady: (install) => {
      // The close handler keeps the window alive when minimize-to-tray is on,
      // which would stall the Squirrel restart.
      installPendingUpdate = () => {
        isQuitting = true;
        install();
      };
      updateTrayMenu();
      void promptToInstallUpdate();
    }
  });
  scheduleBackgroundUsageCheck();
  if (process.env.USAGEATLAS_SMOKE_TEST === "1") void runPackagedSmokeTest(mainWindow);
  app.on("activate", () => showWindow());
});

app.on("before-quit", () => {
  isQuitting = true;
  if (usageCheckTimer) clearTimeout(usageCheckTimer);
  usageCheckTimer = null;
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
