import type { DashboardSnapshot } from "@usageatlas/contracts";

export type AppRoute = "day" | "trends" | "insights" | "limits" | "alerts" | "settings" | "diagnostics";
export type EngineStatus = "starting" | "ready" | "degraded" | "stopped";

export interface UsageAlertRule {
  enabled: boolean;
  thresholdPercent: number;
}

export type UsageAlertPreferences = Record<string, Record<string, UsageAlertRule>>;
export const BUILT_IN_BACKGROUND_IDS = ["mist", "valley", "anime-calm", "monterey", "big-sur"] as const;
export type BuiltInBackgroundId = (typeof BUILT_IN_BACKGROUND_IDS)[number];
export type BackgroundImagePreference = BuiltInBackgroundId | "custom";
export const DEFAULT_BACKGROUND_IMAGE: BuiltInBackgroundId = "mist";
export const BACKGROUND_DEFAULT_GENERATION = DEFAULT_BACKGROUND_IMAGE;

const builtInBackgroundIdSet = new Set<string>(BUILT_IN_BACKGROUND_IDS);

export function isBackgroundImagePreference(value: unknown): value is BackgroundImagePreference {
  return value === "custom" || (typeof value === "string" && builtInBackgroundIdSet.has(value));
}

export function sanitizeBackgroundImage(value: unknown): BackgroundImagePreference {
  return isBackgroundImagePreference(value) ? value : DEFAULT_BACKGROUND_IMAGE;
}

/** Move existing installs onto a new product default once, without replacing a custom upload. */
export function rollForwardBackgroundDefault(
  backgroundImage: BackgroundImagePreference,
  appliedGeneration: unknown
): { backgroundImage: BackgroundImagePreference; appliedGeneration: string; changed: boolean } {
  if (appliedGeneration === BACKGROUND_DEFAULT_GENERATION) {
    return { backgroundImage, appliedGeneration: BACKGROUND_DEFAULT_GENERATION, changed: false };
  }

  return {
    backgroundImage: backgroundImage === "custom" ? "custom" : DEFAULT_BACKGROUND_IMAGE,
    appliedGeneration: BACKGROUND_DEFAULT_GENERATION,
    changed: true
  };
}

export interface DesktopPreferences {
  backgroundImage: BackgroundImagePreference;
  customBackgroundName: string | null;
  launchAtLogin: boolean;
  minimizeToTray: boolean;
  anonymousAnalytics: boolean;
  providerEnabled: Record<string, boolean>;
  /** Ranked `provider:window` limit keys, most important first. */
  limitOrder: string[];
  /** Limit keys switched off for the tray menu. Missing keys stay in the menu. */
  trayLimits: Record<string, boolean>;
  usageAlerts: UsageAlertPreferences;
}

export interface BackgroundImageSelection {
  preferences: DesktopPreferences;
  imageUrl: string;
}

export interface EngineDiagnostics {
  status: EngineStatus;
  restartCount: number;
  messages: string[];
}

export interface RefreshProgress {
  completed: number;
  total: number;
  providerID: string | null;
  providerName: string | null;
  status: "started" | "completed";
}

export interface UsageAtlasDesktopAPI {
  getCustomBackground(): Promise<string | null>;
  chooseCustomBackground(): Promise<BackgroundImageSelection | null>;
  getSnapshot(): Promise<DashboardSnapshot>;
  refreshAll(): Promise<DashboardSnapshot>;
  setProviderEnabled(providerID: string, enabled: boolean): Promise<DashboardSnapshot>;
  getPreferences(): Promise<DesktopPreferences>;
  updatePreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>;
  getDiagnostics(): Promise<EngineDiagnostics>;
  openExternal(url: string): Promise<boolean>;
  onEngineStatus(listener: (status: EngineStatus) => void): () => void;
  onNavigate(listener: (route: AppRoute) => void): () => void;
  onSnapshot(listener: (snapshot: DashboardSnapshot) => void): () => void;
  onRefreshProgress(listener: (progress: RefreshProgress) => void): () => void;
}

export const IPC = {
  getCustomBackground: 'background:get-custom',
  chooseCustomBackground: 'background:choose-custom',
  snapshot: "dashboard:snapshot",
  refreshAll: "dashboard:refresh-all",
  setProviderEnabled: "dashboard:set-provider-enabled",
  getPreferences: "preferences:get",
  updatePreferences: "preferences:update",
  getDiagnostics: "engine:diagnostics",
  engineStatus: "engine:status",
  navigate: "shell:navigate",
  snapshotUpdated: "dashboard:updated",
  refreshProgress: "dashboard:refresh-progress",
  openExternal: "shell:open-external"
} as const;
