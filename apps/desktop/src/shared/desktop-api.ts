import type { DashboardSnapshot } from "@usageatlas/contracts";
import type { GrowthEvent, GrowthEventProperties } from "./growth-events";
import type { ProviderCredential, ProviderCredentialStatus, QuotaProviderId } from "./quota-providers";
import type { ReportPlan } from "./report-plans";
import type { Language } from "./languages";

export type AppRoute = "day" | "trends" | "insights" | "limits" | "alerts" | "profile" | "attribution" | "settings" | "diagnostics";
export type EngineStatus = "starting" | "ready" | "degraded" | "stopped";

export interface DesktopUpdateState {
  status: "idle" | "checking" | "current" | "downloading" | "ready" | "available" | "error" | "unavailable";
  currentVersion: string;
  availableVersion: string | null;
  /** Newest build applied before this one, offered as a one-click rollback. */
  previousVersion: string | null;
  error: string | null;
}

export interface UsageAlertRule {
  enabled: boolean;
  thresholdPercent: number;
}

export type UsageAlertPreferences = Record<string, Record<string, UsageAlertRule>>;

/**
 * The typography choices offered in Settings → Appearance. Every family ships as a
 * bundled variable font, so a choice never depends on what the machine has installed.
 */
export const APPEARANCE_FONTS = [
  "system", "inter", "manrope", "figtree", "jakarta", "geist", "outfit", "sora", "newsreader", "fraunces"
] as const;
export type AppearanceFont = (typeof APPEARANCE_FONTS)[number];

/** `system` follows the OS, the other two pin the palette regardless of it. */
export const APPEARANCE_THEMES = ["system", "light", "dark"] as const;
export type AppearanceTheme = (typeof APPEARANCE_THEMES)[number];

/** Application marks the title bar and the window icon can use. */
export const APP_MARKS = ["datamosh", "classic", "duotone"] as const;
export type AppMark = (typeof APP_MARKS)[number];

/**
 * A daily token alert: once a source passes the threshold, the app says exactly
 * how many tokens it used. Unlike capacity rules it needs no provider quota
 * window, so it works for every local history reader.
 */
export interface TokenAlertPreferences {
  enabled: boolean;
  thresholdTokens: number;
}

export const DEFAULT_TOKEN_ALERTS: TokenAlertPreferences = {
  enabled: true,
  thresholdTokens: 100_000
};

export function sanitizeTokenAlerts(value: unknown): TokenAlertPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_TOKEN_ALERTS };
  const record = value as Record<string, unknown>;
  const threshold = typeof record.thresholdTokens === "number" && Number.isFinite(record.thresholdTokens)
    ? Math.min(1_000_000_000, Math.max(1_000, Math.round(record.thresholdTokens)))
    : DEFAULT_TOKEN_ALERTS.thresholdTokens;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_TOKEN_ALERTS.enabled,
    thresholdTokens: threshold
  };
}

/**
 * How big figures are spelled in the interface. `exact` prints every digit
 * (`1,284,930`); `compact` shortens them to a unit (`1.3M`), which is the only
 * honest choice for dense chart axes.
 */
export const NUMBER_STYLES = ["exact", "compact"] as const;
export type NumberStyle = (typeof NUMBER_STYLES)[number];

/** Accent tints offered in Settings → Appearance. `system` keeps the theme's own. */
export const ACCENT_TINTS = ["system", "ink", "cobalt", "violet", "rose", "forest", "amber"] as const;
export type AccentTint = (typeof ACCENT_TINTS)[number];

/** Glass keeps the translucent material; solid paints every card with the surface. */
export const APPEARANCE_SURFACES = ["glass", "solid"] as const;
export type AppearanceSurface = (typeof APPEARANCE_SURFACES)[number];

/** Airy Apple-like spacing, or a dense layout for small screens. */
export const APPEARANCE_DENSITIES = ["comfortable", "compact"] as const;
export type AppearanceDensity = (typeof APPEARANCE_DENSITIES)[number];

export interface AppearancePreferences {
  /** Palette: the OS appearance, or a fixed light/dark theme. */
  theme: AppearanceTheme;
  font: AppearanceFont;
  /** Root type scale, 0.85–1.3. */
  fontScale: number;
  /** A `#rrggbb` ink colour, or null for the theme's own text colour. */
  textColor: string | null;
  mark: AppMark;
  numberStyle: NumberStyle;
  accent: AccentTint;
  surface: AppearanceSurface;
  /** Page slides, rail highlight and hover motion. */
  animate: boolean;
  /** Compact tightens paddings and row heights without changing the type scale. */
  density: AppearanceDensity;
  /** Whole-window opacity, 0.7–1. */
  windowOpacity: number;
  /** Strength of the card blur, in pixels. */
  blur: number;
  /** Per-provider `#rrggbb` tints used by logos, chart marks and rows. */
  providerColors: Record<string, string>;
}

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  theme: "system",
  font: "system",
  fontScale: 1,
  textColor: null,
  mark: "datamosh",
  // Full figures by default: a token count is a measurement, not a headline.
  numberStyle: "exact",
  accent: "system",
  surface: "glass",
  animate: true,
  density: "comfortable",
  windowOpacity: 1,
  blur: 18,
  providerColors: {}
};
const appearanceFontSet = new Set<string>(APPEARANCE_FONTS);
const appearanceThemeSet = new Set<string>(APPEARANCE_THEMES);
const appMarkSet = new Set<string>(APP_MARKS);
const numberStyleSet = new Set<string>(NUMBER_STYLES);
const accentTintSet = new Set<string>(ACCENT_TINTS);
const appearanceSurfaceSet = new Set<string>(APPEARANCE_SURFACES);
const appearanceDensitySet = new Set<string>(APPEARANCE_DENSITIES);
const PROVIDER_COLOR_KEY = /^[a-z0-9-]{1,64}$/u;
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

export function isAppearanceDensity(value: unknown): value is AppearanceDensity {
  return typeof value === "string" && appearanceDensitySet.has(value);
}

export function sanitizeProviderColors(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([providerID, color]) => PROVIDER_COLOR_KEY.test(providerID)
      && typeof color === "string" && HEX_COLOR.test(color))
    .map(([providerID, color]) => [providerID, (color as string).toLowerCase()])
    .slice(0, 64));
}

export function isAppearanceFont(value: unknown): value is AppearanceFont {
  return typeof value === "string" && appearanceFontSet.has(value);
}

export function isAppearanceTheme(value: unknown): value is AppearanceTheme {
  return typeof value === "string" && appearanceThemeSet.has(value);
}

export function isAppMark(value: unknown): value is AppMark {
  return typeof value === "string" && appMarkSet.has(value);
}

const WIDGET_RESIZE_EDGES = new Set<string>(["n", "s", "e", "w", "ne", "nw", "se", "sw"]);

export function isWidgetResizeEdge(value: unknown): value is WidgetResizeEdge {
  return typeof value === "string" && WIDGET_RESIZE_EDGES.has(value);
}

export function isNumberStyle(value: unknown): value is NumberStyle {
  return typeof value === "string" && numberStyleSet.has(value);
}

export function isAccentTint(value: unknown): value is AccentTint {
  return typeof value === "string" && accentTintSet.has(value);
}

export function isAppearanceSurface(value: unknown): value is AppearanceSurface {
  return typeof value === "string" && appearanceSurfaceSet.has(value);
}

export function sanitizeAppearance(value: unknown): AppearancePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_APPEARANCE };
  const record = value as Record<string, unknown>;
  const scale = typeof record.fontScale === "number" && Number.isFinite(record.fontScale)
    ? Math.min(1.3, Math.max(0.85, Math.round(record.fontScale * 100) / 100))
    : DEFAULT_APPEARANCE.fontScale;
  const textColor = typeof record.textColor === "string" && HEX_COLOR.test(record.textColor)
    ? record.textColor.toLowerCase()
    : null;
  const windowOpacity = typeof record.windowOpacity === "number" && Number.isFinite(record.windowOpacity)
    ? Math.min(1, Math.max(0.7, Math.round(record.windowOpacity * 100) / 100))
    : DEFAULT_APPEARANCE.windowOpacity;
  const blur = typeof record.blur === "number" && Number.isFinite(record.blur)
    ? Math.min(32, Math.max(0, Math.round(record.blur)))
    : DEFAULT_APPEARANCE.blur;
  return {
    theme: isAppearanceTheme(record.theme) ? record.theme : DEFAULT_APPEARANCE.theme,
    font: isAppearanceFont(record.font) ? record.font : DEFAULT_APPEARANCE.font,
    fontScale: scale,
    textColor,
    mark: isAppMark(record.mark) ? record.mark : DEFAULT_APPEARANCE.mark,
    numberStyle: isNumberStyle(record.numberStyle) ? record.numberStyle : DEFAULT_APPEARANCE.numberStyle,
    accent: isAccentTint(record.accent) ? record.accent : DEFAULT_APPEARANCE.accent,
    surface: isAppearanceSurface(record.surface) ? record.surface : DEFAULT_APPEARANCE.surface,
    animate: typeof record.animate === "boolean" ? record.animate : DEFAULT_APPEARANCE.animate,
    density: isAppearanceDensity(record.density) ? record.density : DEFAULT_APPEARANCE.density,
    windowOpacity,
    blur,
    providerColors: sanitizeProviderColors(record.providerColors)
  };
}

/**
 * The floating mini window. It stays above other windows, remembers where it was
 * dropped, and snaps to the work-area edges when it gets close.
 */
export interface WidgetPosition {
  x: number;
  y: number;
}

/** How much the mini window shows: one figure, the card, or the full panel. */
export const WIDGET_STYLES = ["minimal", "balanced", "detailed"] as const;
export type WidgetStyle = (typeof WIDGET_STYLES)[number];

export function isWidgetStyle(value: unknown): value is WidgetStyle {
  return typeof value === "string" && (WIDGET_STYLES as readonly string[]).includes(value);
}

export interface WidgetPreferences {
  /** Opens the mini window on launch and keeps it available from the tray. */
  enabled: boolean;
  /** From the bare token figure to quotas, burn rate and cost. */
  style: WidgetStyle;
  /** Hide after this many idle seconds; 0 keeps it on screen. */
  autoHideSeconds: number;
  /** Window opacity, 0.7–1. */
  opacity: number;
  snapToEdges: boolean;
  width: number;
  height: number;
  /** Last position, already clamped to a visible display. */
  position: WidgetPosition | null;
}

export const DEFAULT_WIDGET_PREFERENCES: WidgetPreferences = {
  enabled: false,
  style: "balanced",
  autoHideSeconds: 0,
  opacity: 0.94,
  snapToEdges: true,
  width: 300,
  height: 150,
  position: null
};

export function sanitizeWidgetPreferences(value: unknown): WidgetPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_WIDGET_PREFERENCES };
  const record = value as Record<string, unknown>;
  const autoHide = typeof record.autoHideSeconds === "number" && Number.isFinite(record.autoHideSeconds)
    ? Math.min(600, Math.max(0, Math.round(record.autoHideSeconds)))
    : DEFAULT_WIDGET_PREFERENCES.autoHideSeconds;
  const opacity = typeof record.opacity === "number" && Number.isFinite(record.opacity)
    ? Math.min(1, Math.max(0.7, Math.round(record.opacity * 100) / 100))
    : DEFAULT_WIDGET_PREFERENCES.opacity;
  const position = record.position && typeof record.position === "object" && !Array.isArray(record.position)
    ? record.position as Record<string, unknown>
    : null;
  const x = position?.x;
  const y = position?.y;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_WIDGET_PREFERENCES.enabled,
    style: isWidgetStyle(record.style) ? record.style : DEFAULT_WIDGET_PREFERENCES.style,
    autoHideSeconds: autoHide,
    opacity,
    snapToEdges: typeof record.snapToEdges === "boolean" ? record.snapToEdges : DEFAULT_WIDGET_PREFERENCES.snapToEdges,
    width: Math.min(640, Math.max(180, Math.round(boundedNumber(record.width, DEFAULT_WIDGET_PREFERENCES.width, 180, 640, true)))),
    height: Math.min(400, Math.max(104, Math.round(boundedNumber(record.height, DEFAULT_WIDGET_PREFERENCES.height, 104, 400, true)))),
    position: typeof x === "number" && Number.isSafeInteger(x) && Math.abs(x) <= 100_000
      && typeof y === "number" && Number.isSafeInteger(y) && Math.abs(y) <= 100_000
      ? { x, y }
      : null
  };
}

/** What the tray tooltip shows besides the app name. */
export const TRAY_METRICS = ["icon", "tokens", "cost", "remaining"] as const;
export type TrayMetric = (typeof TRAY_METRICS)[number];

/** Display currencies; every amount is stored in USD and converted on render. */
export const CURRENCY_CODES = ["USD", "EUR", "GBP", "CAD", "JPY", "CHF"] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

/** Automatic settings/data export cadence. */
export const EXPORT_SCHEDULES = ["off", "weekly", "monthly"] as const;
export type ExportSchedule = (typeof EXPORT_SCHEDULES)[number];

/** Keep history forever (0) or trim records older than the chosen window. */
export const RETENTION_CHOICES = [0, 30, 90, 365] as const;
export type RetentionDays = (typeof RETENTION_CHOICES)[number];

/** A rate entered in Settings, in USD per million tokens. */
export interface ModelCostOverride {
  model: string;
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

/**
 * Settings that shape collection, pricing and alerts. Kept in one object so a
 * change is validated and saved atomically instead of field by field.
 */
export interface AdvancedPreferences {
  trayMetric: TrayMetric;
  /** Soft monthly budget used by the mini window gauge; 0 turns the gauge off. */
  monthlyBudgetUSD: number;
  currency: CurrencyCode;
  /** Display-currency units per USD, fixed by the user so figures never jump. */
  currencyRate: number;
  /** Added to displayed estimates, 0–100. */
  taxPercent: number;
  /**
   * Replaces per-model catalog rates with one blended rate. Provider logs often
   * name a private model whose public price is far below the invoice, so the
   * catalog total understates a real bill by an order of magnitude.
   */
  blendedCostEnabled: boolean;
  /** USD per million tokens while `blendedCostEnabled` is on. */
  blendedCostPerMillionUSD: number;
  /** When off, cached input is charged at the full input rate. */
  promptCaching: boolean;
  modelCostOverrides: ModelCostOverride[];
  /** Extra folders of session logs, including WSL/network mounts. */
  extraLogPaths: string[];
  /** Case-insensitive path fragments whose events are excluded from totals. */
  ignoredProjects: string[];
  /** Hide sessions idle longer than this from the session list; 0 keeps all. */
  staleSessionMinutes: number;
  burnRateEnabled: boolean;
  burnRateTokensPerMinute: number;
  burnRateUSDPerMinute: number;
  resetCountdownEnabled: boolean;
  resetCountdownMinutes: number;
  /** Silences toast windows; the in-app inbox still receives every alert. */
  dnd: boolean;
  notifyLogErrors: boolean;
  notificationSounds: boolean;
  /** Replaces project paths and names in the interface and exports with labels. */
  redactProjects: boolean;
  retentionDays: number;
  exportSchedule: ExportSchedule;
  exportDirectory: string | null;
  /** Encrypts settings backups and scheduled exports with an OS-protected key. */
  encryptExports: boolean;
  /** Last automatic export, used to avoid writing the same period twice. */
  lastExportAt: string | null;
}

export const DEFAULT_ADVANCED_PREFERENCES: AdvancedPreferences = {
  trayMetric: "remaining",
  monthlyBudgetUSD: 0,
  currency: "USD",
  currencyRate: 1,
  taxPercent: 0,
  blendedCostEnabled: true,
  // The published leaderboard sits near $0.54 per million tokens; use that as
  // the default so a fresh install does not report a tenfold-low estimate.
  blendedCostPerMillionUSD: 0.54,
  promptCaching: true,
  modelCostOverrides: [],
  extraLogPaths: [],
  ignoredProjects: [],
  staleSessionMinutes: 0,
  burnRateEnabled: false,
  burnRateTokensPerMinute: 100_000,
  burnRateUSDPerMinute: 5,
  resetCountdownEnabled: true,
  resetCountdownMinutes: 15,
  dnd: false,
  notifyLogErrors: true,
  notificationSounds: false,
  redactProjects: false,
  retentionDays: 0,
  exportSchedule: "off",
  exportDirectory: null,
  encryptExports: false,
  lastExportAt: null
};

const trayMetricSet = new Set<string>(TRAY_METRICS);
const currencyCodeSet = new Set<string>(CURRENCY_CODES);
const exportScheduleSet = new Set<string>(EXPORT_SCHEDULES);
const retentionDaySet = new Set<number>(RETENTION_CHOICES);

function boundedNumber(value: unknown, fallback: number, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const bounded = Math.min(max, Math.max(min, value));
  return integer ? Math.round(bounded) : Math.round(bounded * 100) / 100;
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= maxLength))]
    .slice(0, maxItems);
}

export function sanitizeModelCostOverrides(value: unknown): ModelCostOverride[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.model !== "string") return [];
    const model = record.model.trim().slice(0, 256);
    const key = model.toLowerCase();
    if (!model || seen.has(key)) return [];
    seen.add(key);
    return [{
      model,
      input: boundedNumber(record.input, 0, 0, 100_000),
      output: boundedNumber(record.output, 0, 0, 100_000),
      cacheRead: record.cacheRead === null ? null : boundedNumber(record.cacheRead, 0, 0, 100_000),
      cacheWrite: record.cacheWrite === null ? null : boundedNumber(record.cacheWrite, 0, 0, 100_000)
    }];
  }).slice(0, 50);
}

export function sanitizeAdvancedPreferences(value: unknown): AdvancedPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_ADVANCED_PREFERENCES };
  const record = value as Record<string, unknown>;
  const retention = typeof record.retentionDays === "number" && retentionDaySet.has(record.retentionDays)
    ? record.retentionDays
    : DEFAULT_ADVANCED_PREFERENCES.retentionDays;
  return {
    trayMetric: typeof record.trayMetric === "string" && trayMetricSet.has(record.trayMetric)
      ? record.trayMetric as TrayMetric : DEFAULT_ADVANCED_PREFERENCES.trayMetric,
    monthlyBudgetUSD: boundedNumber(record.monthlyBudgetUSD, DEFAULT_ADVANCED_PREFERENCES.monthlyBudgetUSD, 0, 1_000_000),
    currency: typeof record.currency === "string" && currencyCodeSet.has(record.currency)
      ? record.currency as CurrencyCode : DEFAULT_ADVANCED_PREFERENCES.currency,
    currencyRate: boundedNumber(record.currencyRate, DEFAULT_ADVANCED_PREFERENCES.currencyRate, 0.01, 10_000),
    taxPercent: boundedNumber(record.taxPercent, DEFAULT_ADVANCED_PREFERENCES.taxPercent, 0, 100),
    blendedCostEnabled: typeof record.blendedCostEnabled === "boolean"
      ? record.blendedCostEnabled : DEFAULT_ADVANCED_PREFERENCES.blendedCostEnabled,
    blendedCostPerMillionUSD: boundedNumber(
      record.blendedCostPerMillionUSD,
      DEFAULT_ADVANCED_PREFERENCES.blendedCostPerMillionUSD,
      0.01,
      1_000
    ),
    promptCaching: typeof record.promptCaching === "boolean" ? record.promptCaching : DEFAULT_ADVANCED_PREFERENCES.promptCaching,
    modelCostOverrides: sanitizeModelCostOverrides(record.modelCostOverrides),
    extraLogPaths: stringList(record.extraLogPaths, 20, 1_024),
    ignoredProjects: stringList(record.ignoredProjects, 100, 512),
    staleSessionMinutes: boundedNumber(record.staleSessionMinutes, DEFAULT_ADVANCED_PREFERENCES.staleSessionMinutes, 0, 10_080, true),
    burnRateEnabled: typeof record.burnRateEnabled === "boolean" ? record.burnRateEnabled : DEFAULT_ADVANCED_PREFERENCES.burnRateEnabled,
    burnRateTokensPerMinute: boundedNumber(record.burnRateTokensPerMinute, DEFAULT_ADVANCED_PREFERENCES.burnRateTokensPerMinute, 1_000, 1_000_000_000, true),
    burnRateUSDPerMinute: boundedNumber(record.burnRateUSDPerMinute, DEFAULT_ADVANCED_PREFERENCES.burnRateUSDPerMinute, 0.01, 100_000),
    resetCountdownEnabled: typeof record.resetCountdownEnabled === "boolean" ? record.resetCountdownEnabled : DEFAULT_ADVANCED_PREFERENCES.resetCountdownEnabled,
    resetCountdownMinutes: boundedNumber(record.resetCountdownMinutes, DEFAULT_ADVANCED_PREFERENCES.resetCountdownMinutes, 1, 240, true),
    dnd: typeof record.dnd === "boolean" ? record.dnd : DEFAULT_ADVANCED_PREFERENCES.dnd,
    notifyLogErrors: typeof record.notifyLogErrors === "boolean" ? record.notifyLogErrors : DEFAULT_ADVANCED_PREFERENCES.notifyLogErrors,
    notificationSounds: typeof record.notificationSounds === "boolean" ? record.notificationSounds : DEFAULT_ADVANCED_PREFERENCES.notificationSounds,
    redactProjects: typeof record.redactProjects === "boolean" ? record.redactProjects : DEFAULT_ADVANCED_PREFERENCES.redactProjects,
    retentionDays: retention,
    exportSchedule: typeof record.exportSchedule === "string" && exportScheduleSet.has(record.exportSchedule)
      ? record.exportSchedule as ExportSchedule : DEFAULT_ADVANCED_PREFERENCES.exportSchedule,
    exportDirectory: typeof record.exportDirectory === "string" && record.exportDirectory.length <= 1_024
      ? record.exportDirectory : null,
    encryptExports: typeof record.encryptExports === "boolean" ? record.encryptExports : DEFAULT_ADVANCED_PREFERENCES.encryptExports,
    lastExportAt: typeof record.lastExportAt === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(record.lastExportAt)
      ? record.lastExportAt : null
  };
}

export const BUILT_IN_BACKGROUND_IDS = [
  "mist", "valley", "anime-calm", "monterey", "big-sur",
  "sierra", "aurora", "dunes", "tide", "orchid", "solstice"
] as const;
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

/**
 * Which publisher's releases this build updates from: this fork's GitHub
 * releases, or upstream's own update mirror.
 */
export const UPDATE_CHANNELS = ["fork", "upstream", "custom"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];
/** This build ships with the fork's features, so its releases are the default source. */
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = "fork";

const updateChannelSet = new Set<string>(UPDATE_CHANNELS);

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return typeof value === "string" && updateChannelSet.has(value);
}

export function sanitizeUpdateChannel(value: unknown): UpdateChannel {
  return isUpdateChannel(value) ? value : DEFAULT_UPDATE_CHANNEL;
}

/** `owner/name` of a GitHub repository, as typed in Settings. */
const UPDATE_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

export function isUpdateRepository(value: unknown): value is string {
  return typeof value === "string" && UPDATE_REPOSITORY.test(value.trim());
}

/** Anything that is not a repository name reads as “not set”. */
export function sanitizeUpdateRepository(value: unknown): string {
  return isUpdateRepository(value) ? value.trim() : "";
}

export interface DesktopPreferences {
  /** Interface language, or `system` to follow the OS. */
  language: Language;
  /** Typography, ink colour and app mark. */
  appearance: AppearancePreferences;
  backgroundImage: BackgroundImagePreference;
  /** Publisher whose releases the app updates from. */
  updateChannel: UpdateChannel;
  /** GitHub repository read on the `custom` channel, as `owner/name`. */
  updateRepository: string;
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
  /** Daily per-source token warning, independent of provider quota windows. */
  tokenAlerts: TokenAlertPreferences;
  /** Local provider → the official providers and models its cloud save is reported as. */
  reportPlans: ReportPlan[];
  /** Start in the tray when Windows launches the app at sign-in. */
  startMinimized: boolean;
  /** Electron accelerator that toggles the mini window. */
  hotkey: string;
  /** How often model prices are re-fetched; 0 disables background refresh. */
  pricingSyncHours: number;
  /** Slow polling and pause animations while the machine runs on battery. */
  powerSaving: boolean;
  widget: WidgetPreferences;
  advanced: AdvancedPreferences;
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

/** One local file the discovery engine proved holds token accounting. */
export interface ProviderDiscoveryFile {
  path: string;
  kind: string;
  /** 0–100, how sure the probe is that this file carries token usage. */
  confidence: number;
  /** Rows or records that matched a token field. */
  matches: number;
  reason: string;
  /** `json · usage.total_tokens` or `sqlite · usage.token_count`, when known. */
  store: string | null;
  fields: string[];
}

/** What Settings → Find a provider shows after a scan. */
export interface ProviderDiscovery {
  provider: string;
  route: "cached" | "discovered";
  files: ProviderDiscoveryFile[];
  folders: number;
  related: number;
  entries: number;
  confidence: number;
  /** Files that independently parse as usage; more than one means a sure route. */
  confirmedBy: number;
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

/**
 * An alert that was just raised. The system toast can be suppressed (Focus
 * assist, notification settings), so the renderer shows the same content as an
 * in-app banner and the click still lands on the right page.
 */
export interface DesktopUsageAlert {
  title: string;
  body: string;
  route: AppRoute;
}

/** One received alert, kept in the in-app notification list. */
export interface DesktopAlertInboxEntry extends DesktopUsageAlert {
  /** ISO timestamp of the moment the window received it. */
  receivedAt: string;
}

export interface UsageAtlasDesktopAPI {
  /** Renderer-side platform check: macOS keeps its own traffic lights. */
  readonly platform: string;
  /** PNG data URLs for every application mark, keyed by id. */
  getAppMarks(): Promise<Record<AppMark, string>>;
  /** Shows a desktop notification now, to check that alerts arrive. */
  sendTestAlert(tokens: number, providerName: string): Promise<boolean>;
  /** Mirrors every alert in the window, so a blocked toast is still visible. */
  onUsageAlert(listener: (alert: DesktopUsageAlert) => void): () => void;
  minimizeWindow(): Promise<void>;
  /** Returns the state the window is in after the toggle. */
  toggleMaximizeWindow(): Promise<boolean>;
  closeWindow(): Promise<void>;
  getWindowState(): Promise<boolean>;
  onWindowMaximized(listener: (maximized: boolean) => void): () => void;
  getProviderCredentials(): Promise<Record<string, ProviderCredentialStatus>>;
  setProviderCredential(provider: QuotaProviderId, credential: ProviderCredential | null): Promise<Record<string, ProviderCredentialStatus>>;
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<void>;
  rollbackUpdate(): Promise<boolean>;
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
  /** Probes a provider by name. Reads local files only; never touches the network. */
  discoverProvider(name: string): Promise<ProviderDiscovery>;
  /** Seed names offered by the discovery field. */
  listDiscoverableProviders(): Promise<string[]>;
  /** Catalog names whose folders exist on this computer. Reads no file contents. */
  scanInstalledProviders(): Promise<InstalledProvider[]>;
  /** Every catalog entry with the reader it has and whether it is tracked. */
  getProviderDirectory(): Promise<ProviderDirectoryEntry[]>;
  setProviderEnabled(providerID: string, enabled: boolean): Promise<DashboardState>;
  setReportPlans(plans: ReportPlan[]): Promise<DesktopPreferences>;
  getPreferences(): Promise<DesktopPreferences>;
  updatePreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>;
  /** Floating mini window controls, also reachable from the tray and a hotkey. */
  showWidget(): Promise<void>;
  hideWidget(): Promise<void>;
  toggleWidget(): Promise<void>;
  expandWidget(): Promise<void>;
  /**
   * Starts a pointer-driven resize of the mini window. The window is transparent,
   * and Windows does not give one a native resize border, so the card draws its
   * own handles and the main process follows the cursor until `endWidgetResize`.
   */
  beginWidgetResize(edge: WidgetResizeEdge): Promise<void>;
  endWidgetResize(): Promise<void>;
  /** Writes every setting to a JSON file, optionally encrypted. */
  exportSettings(): Promise<boolean>;
  importSettings(): Promise<DesktopPreferences | null>;
  chooseFolder(): Promise<string | null>;
  chooseExportDirectory(): Promise<string | null>;
  /** Writes the current dashboard and history summary to the export folder. */
  exportUsageNow(): Promise<boolean>;
  /** Relaunches after an icon or native-surface change. */
  restartApp(): Promise<void>;
  getDiagnostics(): Promise<EngineDiagnostics>;
  openExternal(url: string): Promise<boolean>;
  onEngineStatus(listener: (status: EngineStatus) => void): () => void;
  onNavigate(listener: (route: AppRoute) => void): () => void;
  onSnapshot(listener: (state: DashboardState) => void): () => void;
}

/** One row of Settings → Providers, merged from the catalog and the settings. */
export interface ProviderDirectoryEntry {
  name: string;
  kind: string;
  /** The engine adapter id, or null when the app cannot read this tool yet. */
  adapter: string | null;
  /** True when the adapter is on in the dashboard. */
  tracked: boolean;
  /** The data folder found on this computer, if any. */
  installedFolder: string | null;
}

/** A catalog entry whose folder was found on this computer. */
export interface InstalledProvider {
  name: string;
  folder: string;
  kind?: string;
}

/** Which side of the mini window a drag grabs. */
export type WidgetResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const IPC = {
  getAppMarks: "app:marks",
  sendTestAlert: "alerts:test",
  usageAlert: "alerts:raised",
  getProviderCredentials: "providers:credentials-status",
  setProviderCredential: "providers:set-credential",
  getUpdateState: "updates:get",
  checkForUpdates: "updates:check",
  installUpdate: "updates:install",
  rollbackUpdate: "updates:rollback",
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
  discoverProvider: "providers:discover",
  discoverableProviders: "providers:catalog",
  providerDirectory: "providers:directory",
  scanInstalledProviders: "providers:scan-installed",
  setReportPlans: "settings:set-report-plans",
  getPreferences: "preferences:get",
  updatePreferences: "preferences:update",
  showWidget: "widget:show",
  hideWidget: "widget:hide",
  toggleWidget: "widget:toggle",
  expandWidget: "widget:expand",
  beginWidgetResize: "widget:resize-start",
  endWidgetResize: "widget:resize-end",
  exportSettings: "settings:export",
  importSettings: "settings:import",
  chooseFolder: "settings:choose-folder",
  chooseExportDirectory: "settings:choose-export-directory",
  exportUsageNow: "settings:export-usage",
  restartApp: "app:restart",
  getDiagnostics: "engine:diagnostics",
  engineStatus: "engine:status",
  navigate: "shell:navigate",
  snapshotUpdated: "dashboard:updated",
  openExternal: "shell:open-external",
  minimizeWindow: "window:minimize",
  toggleMaximizeWindow: "window:toggle-maximize",
  closeWindow: "window:close",
  getWindowState: "window:state",
  windowMaximized: "window:maximized"
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
  /**
   * Sources with usage waiting on this computer that the server does not model.
   * Capitalized display names.
   */
  heldBack: string[];
  /** Pending observations `heldBack` covers. `pending` includes them, so subtract. */
  heldBackCount: number;
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
