import type { DashboardSnapshot } from "@usageatlas/contracts";

export type AppRoute = "day" | "trends" | "insights" | "limits" | "alerts" | "settings" | "diagnostics";
export type EngineStatus = "starting" | "ready" | "degraded" | "stopped";

export interface UsageAlertRule {
  enabled: boolean;
  thresholdPercent: number;
}

export type UsageAlertPreferences = Record<string, Record<string, UsageAlertRule>>;
export type BackgroundImagePreference = 'default' | 'custom';

export interface DesktopPreferences {
  backgroundImage: BackgroundImagePreference;
  customBackgroundName: string | null;
  launchAtLogin: boolean;
  minimizeToTray: boolean;
  anonymousAnalytics: boolean;
  providerEnabled: Record<string, boolean>;
  limitProviderOrder: string[];
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
  openExternal: "shell:open-external"
} as const;
