import type { DashboardSnapshot } from "@usageatlas/contracts";

export type AppRoute = "day" | "trends" | "insights" | "limits" | "alerts" | "settings" | "diagnostics";
export type EngineStatus = "starting" | "ready" | "degraded" | "stopped";

export interface DesktopUpdateState {
  status: "idle" | "checking" | "current" | "downloading" | "ready" | "available" | "error" | "unavailable";
  currentVersion: string;
  availableVersion: string | null;
  error: string | null;
}

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

export interface LocalImportProgress {
  completed: number;
  total: number;
  error: string | null;
}

export interface DashboardState {
  localImport?: LocalImportProgress | null;
  revision: number;
  snapshot: DashboardSnapshot | null;
  refreshing: boolean;
  progress: RefreshProgress | null;
  error: string | null;
}

export interface UsageAtlasDesktopAPI {
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<void>;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
  getCloudStatus(): Promise<CloudStatus>;
  cloudAction(action: CloudAction, options?: CloudActionOptions): Promise<CloudStatus>;
  getCustomBackground(): Promise<string | null>;
  chooseCustomBackground(): Promise<BackgroundImageSelection | null>;
  getSnapshot(): Promise<DashboardState>;
  refreshAll(): Promise<DashboardState>;
  setProviderEnabled(providerID: string, enabled: boolean): Promise<DashboardState>;
  getPreferences(): Promise<DesktopPreferences>;
  updatePreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>;
  getDiagnostics(): Promise<EngineDiagnostics>;
  openExternal(url: string): Promise<boolean>;
  onEngineStatus(listener: (status: EngineStatus) => void): () => void;
  onNavigate(listener: (route: AppRoute) => void): () => void;
  onSnapshot(listener: (state: DashboardState) => void): () => void;
}

export const IPC = {
  getUpdateState: "updates:get",
  checkForUpdates: "updates:check",
  installUpdate: "updates:install",
  updateStateChanged: "updates:changed",
  cloudStatus: "cloud:status",
  cloudAction: "cloud:action",
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
  openExternal: "shell:open-external"
} as const;

export interface CloudProgress {
  operation: "save" | "restore";
  phase: "reading" | "saving";
  completed: number;
  total: number | null;
}

export interface UsageCloudState {
  accountId: string | null;
  automatic: boolean;
  pending: number;
  busy: boolean;
  progress: CloudProgress | null;
  lastCompleted: "save" | "restore" | null;
  error: string | null;
  conflicts: { recordId: string; provider: string; day: string | null; localTokens: number | null; cloudTokens: number | null }[];
}
export interface CloudStatus extends UsageCloudState {
  account: { id: string; email: string } | null;
  loginCode: string | null;
}
export type CloudAction = "sign-in" | "sign-out" | "save" | "restore" | "automatic" | "resolve";
export interface CloudActionOptions { enabled?: boolean; recordId?: string; choice?: "local" | "cloud" }
