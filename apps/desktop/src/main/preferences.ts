import { app } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sanitizeLimitOrder, sanitizeTrayLimits } from "../shared/capacity-model";
import type { DesktopPreferences } from "../shared/desktop-api";
import { cloneUsageAlertPreferences, sanitizeUsageAlertPreferences } from "../shared/usage-alerts";

interface StoredPreferences extends DesktopPreferences {
  analyticsInstallationId: string;
}

function defaultPreferences(): StoredPreferences {
  return {
    backgroundImage: 'default',
    customBackgroundName: null,
    launchAtLogin: false,
    minimizeToTray: true,
    providerEnabled: {},
    limitOrder: [],
    trayLimits: {},
    usageAlerts: {},
    anonymousAnalytics: true,
    analyticsInstallationId: randomUUID()
  };
}

export class PreferenceStore {
  private values: StoredPreferences;
  private readonly filePath: string;

  constructor() {
    this.filePath = path.join(app.getPath("userData"), "desktop-preferences.json");
    this.values = this.load();
    this.applyLoginItemSetting(this.values.launchAtLogin);
  }

  get(): DesktopPreferences {
    return {
      backgroundImage: this.values.backgroundImage,
      customBackgroundName: this.values.customBackgroundName,
      launchAtLogin: this.values.launchAtLogin,
      minimizeToTray: this.values.minimizeToTray,
      anonymousAnalytics: this.values.anonymousAnalytics,
      providerEnabled: { ...this.values.providerEnabled },
      limitOrder: [...this.values.limitOrder],
      trayLimits: { ...this.values.trayLimits },
      usageAlerts: cloneUsageAlertPreferences(this.values.usageAlerts)
    };
  }

  getAnalyticsInstallationId(): string {
    return this.values.analyticsInstallationId;
  }

  update(patch: Partial<DesktopPreferences>): DesktopPreferences {
    const next = { ...this.values };
    if (patch.backgroundImage === 'default' || patch.backgroundImage === 'custom') {
      next.backgroundImage = patch.backgroundImage;
    }
    if (patch.customBackgroundName === null || typeof patch.customBackgroundName === 'string') {
      next.customBackgroundName = patch.customBackgroundName;
    }
    if (typeof patch.launchAtLogin === "boolean") next.launchAtLogin = patch.launchAtLogin;
    if (typeof patch.minimizeToTray === "boolean") next.minimizeToTray = patch.minimizeToTray;
    if (typeof patch.anonymousAnalytics === "boolean") next.anonymousAnalytics = patch.anonymousAnalytics;
    if (patch.providerEnabled && typeof patch.providerEnabled === "object") {
      next.providerEnabled = Object.fromEntries(Object.entries(patch.providerEnabled).filter(
        ([providerID, enabled]) => /^[a-z0-9-]{1,64}$/u.test(providerID) && typeof enabled === "boolean"
      ));
    }
    if (Array.isArray(patch.limitOrder)) {
      next.limitOrder = sanitizeLimitOrder(patch.limitOrder);
    }
    if (patch.trayLimits && typeof patch.trayLimits === "object") {
      next.trayLimits = sanitizeTrayLimits(patch.trayLimits);
    }
    if (patch.usageAlerts && typeof patch.usageAlerts === "object") {
      next.usageAlerts = sanitizeUsageAlertPreferences(patch.usageAlerts);
    }
    this.values = next;
    this.persist();
    this.applyLoginItemSetting(next.launchAtLogin);
    return this.get();
  }

  private persist(): void {
    writeFileSync(this.filePath, `${JSON.stringify(this.values, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private load(): StoredPreferences {
    const defaults = defaultPreferences();
    if (!existsSync(this.filePath)) return defaults;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoredPreferences>;
      const providerEnabled = parsed.providerEnabled && typeof parsed.providerEnabled === "object"
        ? Object.fromEntries(Object.entries(parsed.providerEnabled).filter(([providerID, enabled]) => (
            /^[a-z0-9-]{1,64}$/u.test(providerID) && typeof enabled === "boolean"
          )))
        : {};
      return {
        backgroundImage: parsed.backgroundImage === 'custom' ? 'custom' : 'default',
        customBackgroundName: typeof parsed.customBackgroundName === 'string' ? parsed.customBackgroundName : null,
        launchAtLogin: typeof parsed.launchAtLogin === "boolean" ? parsed.launchAtLogin : defaults.launchAtLogin,
        minimizeToTray: typeof parsed.minimizeToTray === "boolean" ? parsed.minimizeToTray : defaults.minimizeToTray,
        // Installs from before the toggle moved to Settings stored `null` for "not asked yet".
        anonymousAnalytics: typeof parsed.anonymousAnalytics === "boolean"
          ? parsed.anonymousAnalytics : defaults.anonymousAnalytics,
        analyticsInstallationId: typeof parsed.analyticsInstallationId === "string"
          && /^[0-9a-f-]{36}$/iu.test(parsed.analyticsInstallationId)
          ? parsed.analyticsInstallationId : defaults.analyticsInstallationId,
        providerEnabled,
        limitOrder: sanitizeLimitOrder(parsed.limitOrder),
        trayLimits: sanitizeTrayLimits(parsed.trayLimits),
        usageAlerts: sanitizeUsageAlertPreferences(parsed.usageAlerts)
      };
    } catch {
      return defaults;
    }
  }

  private applyLoginItemSetting(openAtLogin: boolean): void {
    if (process.platform === "win32" && app.isPackaged) {
      const executableName = path.basename(process.execPath);
      const squirrelStub = path.resolve(path.dirname(process.execPath), "..", executableName);
      app.setLoginItemSettings({ openAtLogin, path: squirrelStub });
      return;
    }
    app.setLoginItemSettings({ openAtLogin });
  }
}
