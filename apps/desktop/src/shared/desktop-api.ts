import type { DashboardSnapshot } from "@usageatlas/contracts";
import type { GrowthEvent, GrowthEventProperties } from "./growth-events";
import type { ProviderCredential, ProviderCredentialStatus, QuotaProviderId } from "./quota-providers";

export type AppRoute = "day" | "trends" | "insights" | "limits" | "alerts" | "profile" | "settings" | "diagnostics";
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
  /** Lets the renderer leave room for the native window controls. */
  platform: NodeJS.Platform;
  getProviderCredentials(): Promise<Record<string, ProviderCredentialStatus>>;
  setProviderCredential(provider: QuotaProviderId, credential: ProviderCredential | null): Promise<Record<string, ProviderCredentialStatus>>;
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<void>;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
  getCloudStatus(): Promise<CloudStatus>;
  cloudAction(action: CloudAction, options?: CloudActionOptions): Promise<CloudStatus>;
  checkHandle(handle: string): Promise<boolean>;
  getLeaderboard(): Promise<LeaderboardGlance>;
  copyText(text: string): Promise<void>;
  /** A PNG data URL. */
  copyImage(png: string): Promise<void>;
  /** Asks where to save the PNG; false when the user cancels. */
  saveImage(png: string, fileName: string): Promise<boolean>;
  trackGrowthEvent<E extends GrowthEvent>(event: E, properties: GrowthEventProperties<E>): Promise<void>;
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
  getProviderCredentials: "providers:credentials-status",
  setProviderCredential: "providers:set-credential",
  getUpdateState: "updates:get",
  checkForUpdates: "updates:check",
  installUpdate: "updates:install",
  updateStateChanged: "updates:changed",
  cloudStatus: "cloud:status",
  cloudAction: "cloud:action",
  checkHandle: "profile:check-handle",
  getLeaderboard: "profile:leaderboard",
  copyText: "clipboard:write-text",
  copyImage: "clipboard:write-image",
  saveImage: "image:save",
  trackGrowthEvent: "telemetry:growth-event",
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
/**
 * What the signed-in account has published on usageatlas.com. `unknown` until a
 * check succeeds, so a failed check never reads as "no profile".
 */
export type CloudProfileStatus =
  | { state: "signed-out" }
  | { state: "unknown" }
  | { state: "missing" }
  | { state: "private" | "public"; handle: string };
/**
 * The public 30-day token leaderboard on usageatlas.com, trimmed to what the profile
 * page and prompt show. Fetched without an account.
 */
export interface LeaderboardGlance {
  /** Every public profile, with or without recent usage. */
  profiles: number;
  /** Profiles with tokens in the last 30 days. `entries` holds the top of them. */
  ranked: number;
  /** Highest first. Equal token totals share a rank. */
  entries: { handle: string; rank: number; tokens: number }[];
  /** A few top profiles to show as faces. `avatar` is a data URL, or null for initials. */
  faces: { handle: string; name: string; avatar: string | null }[];
}
export interface CloudStatus extends UsageCloudState {
  account: { id: string; email: string } | null;
  loginCode: string | null;
  profile: CloudProfileStatus;
}
export type CloudAction = "sign-in" | "sign-out" | "save" | "restore" | "automatic" | "resolve" | "refresh-profile";
export interface CloudActionOptions { enabled?: boolean; recordId?: string; choice?: "local" | "cloud" }
