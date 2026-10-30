import { app } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sanitizeLimitOrder, sanitizeTrayLimits } from "../shared/capacity-model";
import {
  BACKGROUND_DEFAULT_GENERATION,
  DEFAULT_ADVANCED_PREFERENCES,
  DEFAULT_APPEARANCE,
  DEFAULT_BACKGROUND_IMAGE,
  DEFAULT_UPDATE_CHANNEL,
  DEFAULT_WIDGET_PREFERENCES,
  isBackgroundImagePreference,
  rollForwardBackgroundDefault,
  DEFAULT_TOKEN_ALERTS,
  sanitizeAdvancedPreferences,
  sanitizeAppearance,
  sanitizeBackgroundImage,
  sanitizeTokenAlerts,
  sanitizeUpdateChannel,
  sanitizeUpdateRepository,
  sanitizeWidgetPreferences,
  type DesktopPreferences
} from "../shared/desktop-api";
import { DEFAULT_LANGUAGE, sanitizeLanguage } from "../shared/languages";
import { planFromLegacyAliases, validateReportPlans } from "../shared/report-plans";
import { cloneUsageAlertPreferences, sanitizeUsageAlertPreferences } from "../shared/usage-alerts";

type ProfileState = "missing" | "private" | "public";

interface StoredPreferences extends DesktopPreferences {
  analyticsInstallationId: string;
  backgroundDefaultGeneration: string;
  /** The last profile state seen for the signed-in account, to notice it being published. */
  lastProfile: { accountId: string; state: ProfileState } | null;
}

function defaultPreferences(): StoredPreferences {
  return {
    language: DEFAULT_LANGUAGE,
    appearance: { ...DEFAULT_APPEARANCE },
    backgroundImage: DEFAULT_BACKGROUND_IMAGE,
    updateChannel: DEFAULT_UPDATE_CHANNEL,
    updateRepository: "",
    customBackgroundName: null,
    launchAtLogin: true,
    minimizeToTray: true,
    providerEnabled: {},
    limitOrder: [],
    trayLimits: {},
    usageAlerts: {},
    tokenAlerts: { ...DEFAULT_TOKEN_ALERTS },
    reportPlans: [],
    startMinimized: false,
    hotkey: "CommandOrControl+Shift+U",
    pricingSyncHours: 24,
    powerSaving: true,
    widget: { ...DEFAULT_WIDGET_PREFERENCES },
    advanced: { ...DEFAULT_ADVANCED_PREFERENCES },
    anonymousAnalytics: true,
    analyticsInstallationId: randomUUID(),
    backgroundDefaultGeneration: BACKGROUND_DEFAULT_GENERATION,
    lastProfile: null
  };
}

export class PreferenceStore {
  private values: StoredPreferences;
  private readonly filePath: string;

  constructor() {
    this.filePath = path.join(app.getPath("userData"), "desktop-preferences.json");
    const loaded = this.readStored();
    this.values = loaded.values;
    if (loaded.persist) this.persist();
    this.applyLoginItemSetting(this.values.launchAtLogin, this.values.startMinimized);
  }

  get(): DesktopPreferences {
    return {
      language: this.values.language,
      appearance: { ...this.values.appearance },
      backgroundImage: this.values.backgroundImage,
      updateChannel: this.values.updateChannel,
      updateRepository: this.values.updateRepository,
      customBackgroundName: this.values.customBackgroundName,
      launchAtLogin: this.values.launchAtLogin,
      minimizeToTray: this.values.minimizeToTray,
      anonymousAnalytics: this.values.anonymousAnalytics,
      providerEnabled: { ...this.values.providerEnabled },
      limitOrder: [...this.values.limitOrder],
      trayLimits: { ...this.values.trayLimits },
      usageAlerts: cloneUsageAlertPreferences(this.values.usageAlerts),
      tokenAlerts: { ...this.values.tokenAlerts },
      reportPlans: this.values.reportPlans.map(plan => ({
        source: plan.source,
        targets: plan.targets.map(target => ({ ...target }))
      })),
      startMinimized: this.values.startMinimized,
      hotkey: this.values.hotkey,
      pricingSyncHours: this.values.pricingSyncHours,
      powerSaving: this.values.powerSaving,
      widget: { ...this.values.widget, position: this.values.widget.position ? { ...this.values.widget.position } : null },
      advanced: {
        ...this.values.advanced,
        modelCostOverrides: this.values.advanced.modelCostOverrides.map((override) => ({ ...override })),
        extraLogPaths: [...this.values.advanced.extraLogPaths],
        ignoredProjects: [...this.values.advanced.ignoredProjects]
      }
    };
  }

  getAnalyticsInstallationId(): string {
    return this.values.analyticsInstallationId;
  }

  /** Saves the account's current profile state and returns the one it replaces, if known. */
  recordProfileState(accountId: string, state: ProfileState): ProfileState | null {
    const previous = this.values.lastProfile?.accountId === accountId ? this.values.lastProfile.state : null;
    if (previous !== state) {
      this.values = { ...this.values, lastProfile: { accountId, state } };
      this.persist();
    }
    return previous;
  }

  update(patch: Partial<DesktopPreferences>): DesktopPreferences {
    const next = { ...this.values };
    if (patch.language !== undefined) next.language = sanitizeLanguage(patch.language);
    if (patch.appearance !== undefined) next.appearance = sanitizeAppearance(patch.appearance);
    if (isBackgroundImagePreference(patch.backgroundImage)) {
      next.backgroundImage = patch.backgroundImage;
    }
    if (patch.customBackgroundName === null || typeof patch.customBackgroundName === 'string') {
      next.customBackgroundName = patch.customBackgroundName;
    }
    if (typeof patch.launchAtLogin === "boolean") next.launchAtLogin = patch.launchAtLogin;
    if (typeof patch.minimizeToTray === "boolean") next.minimizeToTray = patch.minimizeToTray;
    if (typeof patch.anonymousAnalytics === "boolean") next.anonymousAnalytics = patch.anonymousAnalytics;
    if (patch.updateChannel !== undefined) next.updateChannel = sanitizeUpdateChannel(patch.updateChannel);
    if (patch.updateRepository !== undefined) next.updateRepository = sanitizeUpdateRepository(patch.updateRepository);
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
    if (patch.tokenAlerts && typeof patch.tokenAlerts === "object") {
      next.tokenAlerts = sanitizeTokenAlerts(patch.tokenAlerts);
    }
    if (Array.isArray(patch.reportPlans)) {
      next.reportPlans = validateReportPlans(patch.reportPlans);
    }
    if (typeof patch.startMinimized === "boolean") next.startMinimized = patch.startMinimized;
    if (typeof patch.hotkey === "string") next.hotkey = patch.hotkey.trim().slice(0, 128) || next.hotkey;
    if (typeof patch.pricingSyncHours === "number") {
      next.pricingSyncHours = Math.min(168, Math.max(0, Math.round(patch.pricingSyncHours)));
    }
    if (typeof patch.powerSaving === "boolean") next.powerSaving = patch.powerSaving;
    if (patch.widget && typeof patch.widget === "object") next.widget = sanitizeWidgetPreferences(patch.widget);
    if (patch.advanced && typeof patch.advanced === "object") next.advanced = sanitizeAdvancedPreferences(patch.advanced);
    this.values = next;
    this.persist();
    this.applyLoginItemSetting(next.launchAtLogin, next.startMinimized);
    return this.get();
  }

  private persist(): void {
    writeFileSync(this.filePath, `${JSON.stringify(this.values, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private readStored(): { values: StoredPreferences; persist: boolean } {
    const defaults = defaultPreferences();
    if (!existsSync(this.filePath)) return { values: defaults, persist: false };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoredPreferences>;
      const providerEnabled = parsed.providerEnabled && typeof parsed.providerEnabled === "object"
        ? Object.fromEntries(Object.entries(parsed.providerEnabled).filter(([providerID, enabled]) => (
            /^[a-z0-9-]{1,64}$/u.test(providerID) && typeof enabled === "boolean"
          )))
        : {};
      const rolled = rollForwardBackgroundDefault(
        sanitizeBackgroundImage(parsed.backgroundImage),
        parsed.backgroundDefaultGeneration
      );
      return {
        values: {
          language: sanitizeLanguage(parsed.language),
          appearance: sanitizeAppearance(parsed.appearance),
          backgroundImage: rolled.backgroundImage,
          updateChannel: sanitizeUpdateChannel(parsed.updateChannel),
          updateRepository: sanitizeUpdateRepository(parsed.updateRepository),
          customBackgroundName: typeof parsed.customBackgroundName === "string" ? parsed.customBackgroundName : null,
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
          usageAlerts: sanitizeUsageAlertPreferences(parsed.usageAlerts),
          tokenAlerts: sanitizeTokenAlerts(parsed.tokenAlerts),
          // Single-target rules from earlier builds become one-target plans.
          reportPlans: validateReportPlans(parsed.reportPlans ?? []).length
            ? validateReportPlans(parsed.reportPlans)
            : planFromLegacyAliases((parsed as { reportAliases?: unknown }).reportAliases),
          startMinimized: typeof parsed.startMinimized === "boolean" ? parsed.startMinimized : defaults.startMinimized,
          hotkey: typeof parsed.hotkey === "string" && parsed.hotkey.trim().length > 0
            ? parsed.hotkey.trim().slice(0, 128) : defaults.hotkey,
          pricingSyncHours: typeof parsed.pricingSyncHours === "number" && Number.isFinite(parsed.pricingSyncHours)
            ? Math.min(168, Math.max(0, Math.round(parsed.pricingSyncHours))) : defaults.pricingSyncHours,
          powerSaving: typeof parsed.powerSaving === "boolean" ? parsed.powerSaving : defaults.powerSaving,
          widget: sanitizeWidgetPreferences(parsed.widget),
          advanced: sanitizeAdvancedPreferences(parsed.advanced),
          backgroundDefaultGeneration: rolled.appliedGeneration,
          lastProfile: isLastProfile(parsed.lastProfile) ? parsed.lastProfile : null
        },
        persist: rolled.changed
      };
    } catch {
      return { values: defaults, persist: false };
    }
  }

  private applyLoginItemSetting(openAtLogin: boolean, startMinimized: boolean): void {
    // Development runs would register the bare Electron executable at login.
    if (!app.isPackaged || process.env.USAGEATLAS_SMOKE_TEST === "1") return;
    const args = startMinimized ? ["--hidden"] : [];
    if (process.platform === "win32") {
      const executableName = path.basename(process.execPath);
      const squirrelStub = path.resolve(path.dirname(process.execPath), "..", executableName);
      app.setLoginItemSettings({ openAtLogin, path: squirrelStub, args });
      return;
    }
    app.setLoginItemSettings({ openAtLogin, args });
  }
}

function isLastProfile(value: unknown): value is StoredPreferences["lastProfile"] & object {
  return Boolean(value) && typeof value === "object"
    && typeof (value as { accountId?: unknown }).accountId === "string"
    && ["missing", "private", "public"].includes((value as { state?: unknown }).state as string);
}
