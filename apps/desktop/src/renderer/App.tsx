import type { DashboardSnapshot } from "@usageatlas/contracts";
import { useCallback, useEffect, useState } from "react";
import { UsageEmpty, UsageFailure, UsageLoading, UsageRefreshStatus, UsageStorageStatus } from "./components/UsagePageState";
import type {
  AppRoute,
  DashboardState,
  DesktopAlertInboxEntry,
  DesktopPreferences,
  DesktopUsageAlert,
  EngineDiagnostics,
  EngineStatus
} from "../shared/desktop-api";
import { applyWallpaper } from "./wallpapers";
import { applyAppearance } from "./appearance";
import { setCostDisplay } from "./number-format";
import type { AppMark } from "../shared/desktop-api";
import { useAchievementNudge } from "./achievement-nudge";
import { snapshotHasCachedUsage } from "../shared/cached-snapshot";
import { dashboardFailure, dashboardIsLoading, initialDashboardState, latestDashboardState } from "./dashboard-state";
import { useDesktopUpdates } from "./update-state";
import { UpdateTag } from "./components/UpdateControls";
import { I18nProvider, useI18n } from "./i18n";
import { AppShell } from "./components/AppShell";
import { Attribution } from "./components/Attribution";
import { DayDashboard } from "./components/DayDashboard";
import type { HealthNotice } from "./components/Diagnostics";
import { Diagnostics } from "./components/Diagnostics";
import { InsightsDashboard } from "./components/InsightsDashboard";
import { LimitsDashboard } from "./components/LimitsDashboard";
import { ProfilePage } from "./components/ProfilePage";
import { ProfilePromptModal } from "./components/ProfilePromptModal";
import { RecapShareModal } from "./components/RecapShare";
import { Settings } from "./components/Settings";
import { TrendsDashboard } from "./components/TrendsDashboard";
import { UsageAlertsPage } from "./components/UsageAlertsPage";
import { isSnapshotStale } from "./dashboard-model";
import type { AnalyticsRange, ProviderScope } from "./personal-analytics";
import { analyticsIssue, enabledProviders, todayDay } from "./personal-analytics";
import { providerConnection, reconnectSentence } from "./provider-connection";
import { wantsProfilePrompt } from "./profile-promotion";
import { useCloudAccount, useLeaderboard, useProfilePageVisited, useProfilePrompt } from "./profile-state";
import { useWrappedNudge } from "./wrapped-nudge";
import type { ReportPlan } from "../shared/report-plans";

const ALERT_INBOX_KEY = "usageatlas.alert-inbox.v1";
const MAX_INBOX_ENTRIES = 50;

/** Reads the received alerts kept on this computer; a corrupt list starts empty. */
function readAlertInbox(): DesktopAlertInboxEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ALERT_INBOX_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(item => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      if (typeof entry.title !== "string" || typeof entry.body !== "string"
        || typeof entry.route !== "string" || typeof entry.receivedAt !== "string") return [];
      if (Number.isNaN(Date.parse(entry.receivedAt))) return [];
      return [{ title: entry.title, body: entry.body, route: entry.route as AppRoute, receivedAt: entry.receivedAt }];
    }).slice(0, MAX_INBOX_ENTRIES);
  } catch {
    return [];
  }
}

export function App(): React.JSX.Element {
  const updates = useDesktopUpdates();
  const [route, setRoute] = useState<AppRoute>(() => routeFromHash(location.hash));
  // Set on the way to a page, so the shell knows which side that page comes from.
  const [previousRoute, setPreviousRoute] = useState<AppRoute | null>(null);
  const [dashboard, setDashboard] = useState(initialDashboardState);
  const { snapshot, refreshing, progress: refreshProgress } = dashboard;
  const updateDashboard = useCallback((next: DashboardState) => {
    setDashboard(current => latestDashboardState(current, next));
  }, []);
  const [preferences, setPreferences] = useState<DesktopPreferences | null>(null);
  const [customBackgroundUrl, setCustomBackgroundUrl] = useState<string | null>(null);
  const [markUrls, setMarkUrls] = useState<Record<AppMark, string> | null>(null);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<EngineDiagnostics | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>("starting");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [providerSaving, setProviderSaving] = useState<string | null>(null);
  const [aliasSaving, setAliasSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedNotices, setDismissedNotices] = useState<string[]>([]);
  const [usageAlert, setUsageAlert] = useState<DesktopUsageAlert | null>(null);
  const [alertInbox, setAlertInbox] = useState<DesktopAlertInboxEntry[]>(readAlertInbox);
  const [selectedDay, setSelectedDay] = useState(() => todayDay());
  const [trendEndDay, setTrendEndDay] = useState(() => todayDay());
  const [trendRange, setTrendRange] = useState<AnalyticsRange>(30);
  const [providerScope, setProviderScope] = useState<ProviderScope>("all");
  const [recapOpen, setRecapOpen] = useState(false);
  const cloud = useCloudAccount();
  const profileVisited = useProfilePageVisited(route);

  useEffect(() => {
    const unsubscribe = window.usageAtlas?.onUsageAlert?.((alert) => {
      setUsageAlert(alert);
      setAlertInbox(current => [
        { ...alert, receivedAt: new Date().toISOString() },
        ...current
      ].slice(0, MAX_INBOX_ENTRIES));
    });
    return unsubscribe ?? undefined;
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(ALERT_INBOX_KEY, JSON.stringify(alertInbox));
    } catch {
      // The list is a convenience; losing it must never break an alert.
    }
  }, [alertInbox]);

  const loadDiagnostics = useCallback(async (): Promise<void> => {
    setDiagnosticsLoading(true);
    try {
      const next = await window.usageAtlas.getDiagnostics();
      setDiagnostics(next);
      setEngineStatus(next.status);
    } finally {
      setDiagnosticsLoading(false);
    }
  }, []);

  const navigate = useCallback((next: AppRoute): void => {
    setPreviousRoute(route);
    location.hash = next;
    setRoute(next);
    if (next === "diagnostics") void loadDiagnostics();
  }, [loadDiagnostics, route]);

  useEffect(() => {
    let active = true;
    const removeSnapshot = window.usageAtlas.onSnapshot((next) => {
      if (!active) return;
      updateDashboard(next);
      setError(null);
    });
    const bootstrap = async (): Promise<void> => {
      try {
        const [nextDashboard, nextPreferences, nextBackgroundUrl, nextDiagnostics, nextMarks] = await Promise.all([
          window.usageAtlas.getSnapshot(),
          window.usageAtlas.getPreferences(),
          window.usageAtlas.getCustomBackground(),
          window.usageAtlas.getDiagnostics(),
          window.usageAtlas.getAppMarks().catch(() => null)
        ]);
        if (!active) return;
        updateDashboard(nextDashboard);
        setPreferences(nextPreferences);
        setCustomBackgroundUrl(nextBackgroundUrl);
        setMarkUrls(nextMarks);
        setDiagnostics(nextDiagnostics);
        setEngineStatus(nextDiagnostics.status);
        setError(null);
      } catch (caught: unknown) {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "The local engine did not respond.");
      } finally {
        if (active) setLoading(false);
      }
    };
    void bootstrap();
    return () => {
      active = false;
      removeSnapshot();
    };
  }, [updateDashboard]);

  useEffect(() => {
    applyWallpaper(preferences?.backgroundImage, customBackgroundUrl);
  }, [customBackgroundUrl, preferences?.backgroundImage]);

  const appearance = preferences?.appearance;
  useEffect(() => {
    if (appearance) applyAppearance(appearance);
  }, [appearance]);

  const advanced = preferences?.advanced;
  useEffect(() => {
    if (!advanced) return;
    setCostDisplay({
      currency: advanced.currency,
      rate: advanced.currencyRate,
      taxPercent: advanced.taxPercent
    });
  }, [advanced]);

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash(location.hash));
    window.addEventListener("hashchange", onHashChange);
    const removeNavigate = window.usageAtlas.onNavigate((next) => navigate(next));
    const removeStatus = window.usageAtlas.onEngineStatus(setEngineStatus);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      removeNavigate();
      removeStatus();
    };
  }, [navigate]);

  async function refreshAll(): Promise<void> {
    try {
      updateDashboard(await window.usageAtlas.refreshAll());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The local engine did not respond.");
    } finally {
      setLoading(false);
    }
  }

  async function updatePreferences(patch: Partial<DesktopPreferences>): Promise<void> {
    setSaving(true);
    try {
      setPreferences(await window.usageAtlas.updatePreferences(patch));
    } finally {
      setSaving(false);
    }
  }

  async function chooseCustomBackground(): Promise<void> {
    setSaving(true);
    setBackgroundError(null);
    try {
      const selection = await window.usageAtlas.chooseCustomBackground();
      if (!selection) return;
      setPreferences(selection.preferences);
      setCustomBackgroundUrl(selection.imageUrl);
    } catch (caught) {
      setBackgroundError(backgroundImageErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function setProviderEnabled(providerID: string, enabled: boolean): Promise<void> {
    setProviderSaving(providerID);
    try {
      updateDashboard(await window.usageAtlas.setProviderEnabled(providerID, enabled));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The provider setting could not be saved.");
    } finally {
      setProviderSaving(null);
    }
  }

  async function saveReportPlans(plans: ReportPlan[]): Promise<void> {
    setAliasSaving(true);
    try {
      setPreferences(await window.usageAtlas.setReportPlans(plans));
    } finally {
      setAliasSaving(false);
    }
  }

  const usageError = error ?? dashboardFailure(dashboard);
  const usageLoading = loading || (!usageError && dashboardIsLoading(dashboard));
  const today = todayDay();
  const usageRoute = route === "day" || route === "trends" || route === "insights" || route === "limits";
  const providerAnalyticsIssue = snapshot ? analyticsIssue(snapshot, providerScope) : null;
  const usageShown = usageRoute && !usageLoading && !usageError && snapshot !== null && enabledProviders(snapshot).length > 0;
  const profilePrompt = useProfilePrompt({ enabled: usageShown, profile: cloud.profile, snapshot, today });
  const openProfile = useCallback(() => navigate("profile"), [navigate]);
  const wrappedDue = useWrappedNudge({ enabled: usageShown, onOpenExternal: openExternal, preview: profilePrompt.preview, profile: cloud.profile });
  useAchievementNudge({
    automatic: cloud.status?.automatic ?? false,
    enabled: usageShown,
    onOpen: openProfile,
    profile: cloud.profile,
    prompting: profilePrompt.prompt !== null,
    snapshot,
    today,
    waiting: wrappedDue
  });
  const leaderboard = useLeaderboard(route === "profile" || profilePrompt.prompt !== null);
  // Usage pages stay uninterrupted; everything worth knowing about the numbers is
  // collected here for Engine health, with the rail dot as the only nudge. Dismissal is
  // keyed on the wording, so a different problem always breaks through.
  const notices: HealthNotice[] = [
    usageError ? { message: usageError, detail: null, tone: "error" as const } : null,
    ...signInNotices(snapshot),
    providerAnalyticsIssue,
    snapshot && isSnapshotStale(snapshot)
      ? {
        message: "This snapshot is older than its refresh window.",
        detail: "Refresh from any usage page to collect current numbers.",
        tone: "warning" as const
      }
      : null
  ].filter((notice): notice is HealthNotice => notice !== null
    && !dismissedNotices.includes(notice.message));

  function selectDay(day: string): void {
    setSelectedDay(day > today ? today : day);
    navigate("day");
  }

  function openTrends(range: AnalyticsRange): void {
    setTrendRange(range);
    setTrendEndDay(today);
    navigate("trends");
  }

  async function importSettings(): Promise<void> {
    const next = await window.usageAtlas.importSettings().catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "The settings file could not be read.");
      return null;
    });
    if (next) setPreferences(next);
  }

  async function exportUsage(): Promise<void> {
    try {
      await window.usageAtlas.exportUsageNow();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The usage export could not be written.");
    }
  }

  const activity = (
    <div aria-label="Background activity" className="atlas-toolbar-activity" role="group">
      <span className="atlas-toolbar-activity__slot">
        {!usageLoading && refreshing && !usageError ? <UsageRefreshStatus engineStatus={engineStatus} progress={refreshProgress} /> : null}
      </span>
      <span className="atlas-toolbar-activity__slot">
        {dashboard.localImport ? <UsageStorageStatus progress={dashboard.localImport} /> : null}
      </span>
    </div>
  );

  function renderUsageRoute(): React.JSX.Element | null {
    if (!usageRoute) return null;
    if (usageLoading) return <UsageLoading engineStatus={engineStatus} progress={refreshProgress} />;
    if (usageError && (!snapshot || !snapshotHasCachedUsage(snapshot)))
      return <UsageFailure error={usageError} onRetry={refreshAll} />;
    if (!snapshot || enabledProviders(snapshot).length === 0) {
      return <UsageEmpty onOpenSettings={() => navigate("settings")} />;
    }
    if (route === "day") {
      return (
        <DayDashboard
          backgroundActivity={activity}
          limitOrder={preferences?.limitOrder ?? []}
          onOpenLimits={() => navigate("limits")}
          onProviderScopeChange={setProviderScope}
          onRefresh={refreshAll}
          onSelectDay={selectDay}
          onSelectRange={openTrends}
          providerScope={providerScope}
          refreshing={refreshing}
          selectedDay={selectedDay}
          snapshot={snapshot}
          today={today}
        />
      );
    }
    if (route === "trends") {
      return (
        <TrendsDashboard
          backgroundActivity={activity}
          endDay={trendEndDay}
          onEndDayChange={setTrendEndDay}
          onOpenDay={selectDay}
          onProviderScopeChange={setProviderScope}
          onRangeChange={(range) => { setTrendRange(range); setTrendEndDay(today); }}
          onRefresh={refreshAll}
          onShare={() => setRecapOpen(true)}
          providerScope={providerScope}
          range={trendRange}
          refreshing={refreshing}
          snapshot={snapshot}
          today={today}
        />
      );
    }
    if (route === "insights") {
      return (
        <InsightsDashboard
          backgroundActivity={activity}
          onProviderScopeChange={setProviderScope}
          onRefresh={refreshAll}
          providerScope={providerScope}
          refreshing={refreshing}
          snapshot={snapshot}
        />
      );
    }
    if (route === "limits") {
      return (
        <LimitsDashboard
          backgroundActivity={activity}
          limitOrder={preferences?.limitOrder ?? []}
          onBack={() => navigate("day")}
          onLimitOrderChange={(limitOrder) => updatePreferences({ limitOrder })}
          onRefresh={refreshAll}
          onTrayLimitsChange={(trayLimits) => updatePreferences({ trayLimits })}
          refreshing={refreshing}
          snapshot={snapshot}
          trayLimits={preferences?.trayLimits ?? {}}
        />
      );
    }
    return null;
  }

  return (
    <I18nProvider language={preferences?.language ?? "system"}>
    <AppShell activityControl={!usageRoute ? activity : null} appMarkUrl={preferences && markUrls ? markUrls[preferences.appearance.mark] : null}
      engineStatus={engineStatus} previousRoute={previousRoute} noticeCount={notices.length} onNavigate={navigate}
      profileBadge={!profileVisited && cloud.status !== null && wantsProfilePrompt(cloud.status.profile)} route={route}
      updateControl={<UpdateTag state={updates.state} onCheck={updates.check} onInstall={updates.install} />}
      alertBanner={usageAlert ? (
        <UsageAlertBanner
          alert={usageAlert}
          onDismiss={() => setUsageAlert(null)}
          onOpen={() => {
            navigate(usageAlert.route);
            setUsageAlert(null);
          }}
        />
      ) : null}>
      {renderUsageRoute()}
      {route === "alerts" && (
        <UsageAlertsPage
          notifications={alertInbox}
          onClearNotifications={() => setAlertInbox([])}
          onTestAlert={async (tokens, providerName) => window.usageAtlas.sendTestAlert(tokens, providerName)}
          onUpdate={updatePreferences}
          preferences={preferences}
          providers={snapshot?.providers ?? []}
          saving={saving}
        />
      )}
      {route === "profile" && (
        <ProfilePage
          cloud={cloud}
          leaderboard={leaderboard}
          onOpenExternal={openExternal}
          onOpenSettings={() => navigate("settings")}
          snapshot={snapshot}
          today={today}
        />
      )}
      {recapOpen && route === "trends" && snapshot && (
        <RecapShareModal
          initialPeriod={trendRange === 7 ? "week" : "month"}
          onClose={() => setRecapOpen(false)}
          onGetProfile={() => { setRecapOpen(false); navigate("profile"); }}
          onOpenExternal={openExternal}
          profileHandle={cloud.status?.profile.state === "public" ? cloud.status.profile.handle : null}
          snapshot={snapshot}
          today={today}
        />
      )}
      {profilePrompt.prompt && cloud.status && (
        <ProfilePromptModal
          leaderboard={leaderboard}
          onClose={profilePrompt.close}
          onDismiss={profilePrompt.dismiss}
          onOpenExternal={openExternal}
          onOpenProfile={() => navigate("profile")}
          profile={cloud.status.profile}
          prompt={profilePrompt.prompt}
        />
      )}
      {route === "attribution" && (
        <Attribution
          onSave={saveReportPlans}
          preferences={preferences}
          providers={snapshot?.providers ?? []}
          saving={aliasSaving}
        />
      )}
      {route === "settings" && (
        <Settings
          updateState={updates.state}
          onCheckForUpdates={updates.check}
          onInstallUpdate={updates.install}
          onRollbackUpdate={updates.rollback}
          backgroundError={backgroundError}
          customBackgroundUrl={customBackgroundUrl}
          onChooseCustomBackground={chooseCustomBackground}
          onOpenExternal={openExternal}
          onRefresh={refreshAll}
          markUrls={markUrls}
          onSetProviderEnabled={setProviderEnabled}
          onUpdate={updatePreferences}
          preferences={preferences}
          providerSaving={providerSaving}
          providers={snapshot?.providers ?? []}
          refreshing={refreshing}
          saving={saving}
          onShowWidget={() => window.usageAtlas.showWidget()}
          onHideWidget={() => window.usageAtlas.hideWidget()}
          onExportSettings={() => window.usageAtlas.exportSettings().then(() => undefined)}
          onImportSettings={importSettings}
          onChooseFolder={() => window.usageAtlas.chooseFolder()}
          onChooseExportDirectory={() => window.usageAtlas.chooseExportDirectory()}
          onExportUsage={exportUsage}
          onRestartApp={() => window.usageAtlas.restartApp()}
        />
      )}
      {route === "diagnostics" && (
        <Diagnostics
          diagnostics={diagnostics}
          loading={diagnosticsLoading || refreshing}
          notices={notices}
          onDismissNotice={(message) => setDismissedNotices((current) => [...current, message])}
          onOpenExternal={openExternal}
          // Reload is the button next to the source list, so it re-checks the sources
          // themselves and not only the engine — that is what "then reload" asks for.
          onReload={async () => { await Promise.all([loadDiagnostics(), refreshAll()]); }}
          providers={snapshot?.providers ?? []}
        />
      )}
    </AppShell>
    </I18nProvider>
  );
}

/**
 * The same alert the toast carries, kept in the window. Windows may accept a toast
 * and hide it behind Focus assist or a per-app switch, so the message and its link
 * stay reachable here until dismissed.
 */
function UsageAlertBanner({ alert, onDismiss, onOpen }: {
  alert: DesktopUsageAlert;
  onDismiss(): void;
  onOpen(): void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <aside aria-live="polite" className="atlas-usage-banner">
      <span aria-hidden="true" className="atlas-usage-banner__mark">
        <svg fill="none" viewBox="0 0 24 24"><path d="M12 8v5m0 3.5v.5" stroke="currentColor" strokeLinecap="round" strokeWidth="2" /><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" /></svg>
      </span>
      <div className="atlas-usage-banner__body">
        <strong>{alert.title}</strong>
        <span>{alert.body}</span>
      </div>
      <button className="atlas-usage-banner__action" onClick={onOpen} type="button">
        {t("alertBanner.open")}
      </button>
      <button
        aria-label={t("alertBanner.dismiss")}
        className="atlas-usage-banner__close"
        onClick={onDismiss}
        type="button"
      >
        <svg aria-hidden="true" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" /></svg>
      </button>
    </aside>
  );
}

async function openExternal(url: string): Promise<void> {
  await window.usageAtlas.openExternal(url);
}

/**
 * A tool whose sign-in expired keeps counting local history while its live limits go
 * quiet, so nothing on the usage pages says the connection dropped. Each signed-out tool
 * raises its own notice, which is what tints the Diagnostics rail dot.
 */
function signInNotices(snapshot: DashboardSnapshot | null): HealthNotice[] {
  if (!snapshot) return [];
  return enabledProviders(snapshot).flatMap((provider) => {
    const connection = providerConnection(provider);
    if (connection.state !== "sign_in_required") return [];
    return [{
      message: `${provider.name} needs a new sign-in on this computer.`,
      detail: reconnectSentence(connection),
      tone: "warning" as const
    }];
  });
}

function backgroundImageErrorMessage(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : "";
  if (message.includes("25 MB")) return "Choose an image smaller than 25 MB.";
  if (message.includes("supported image")) return "Choose a valid JPG, PNG, or WebP image.";
  return "Unable to use that image. Try another file.";
}

function routeFromHash(hash: string): AppRoute {
  const candidate = hash.replace(/^#/, "");
  if (candidate === "trends" || candidate === "insights" || candidate === "limits" || candidate === "alerts" || candidate === "profile" || candidate === "attribution" || candidate === "settings" || candidate === "diagnostics") {
    return candidate;
  }
  return "day";
}
