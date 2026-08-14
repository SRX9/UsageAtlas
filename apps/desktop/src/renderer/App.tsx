import type { DashboardSnapshot } from "@usageatlas/contracts";
import { useCallback, useEffect, useState } from "react";
import type {
  AppRoute,
  DesktopPreferences,
  EngineDiagnostics,
  EngineStatus
} from "../shared/desktop-api";
import { AppShell } from "./components/AppShell";
import { DayDashboard } from "./components/DayDashboard";
import { Diagnostics } from "./components/Diagnostics";
import { InsightsDashboard } from "./components/InsightsDashboard";
import { LimitsDashboard } from "./components/LimitsDashboard";
import { Settings } from "./components/Settings";
import { TrendsDashboard } from "./components/TrendsDashboard";
import { UsageAlertsPage } from "./components/UsageAlertsPage";
import type { PageNotice } from "./components/UsagePageState";
import { UsageEmpty, UsageFailure, UsageLoading } from "./components/UsagePageState";
import { isSnapshotStale } from "./dashboard-model";
import type { AnalyticsRange, ProviderScope } from "./personal-analytics";
import { analyticsIssue, enabledProviders, todayDay } from "./personal-analytics";

export function App(): React.JSX.Element {
  const [route, setRoute] = useState<AppRoute>(() => routeFromHash(location.hash));
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [preferences, setPreferences] = useState<DesktopPreferences | null>(null);
  const [customBackgroundUrl, setCustomBackgroundUrl] = useState<string | null>(null);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<EngineDiagnostics | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>("starting");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [providerSaving, setProviderSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState(() => todayDay());
  const [trendEndDay, setTrendEndDay] = useState(() => todayDay());
  const [trendRange, setTrendRange] = useState<AnalyticsRange>(30);
  const [providerScope, setProviderScope] = useState<ProviderScope>("all");

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
    location.hash = next;
    setRoute(next);
    if (next === "diagnostics") void loadDiagnostics();
  }, [loadDiagnostics]);

  useEffect(() => {
    let active = true;
    const bootstrap = async (): Promise<void> => {
      try {
        const [nextSnapshot, nextPreferences, nextBackgroundUrl] = await Promise.all([
          window.usageAtlas.getSnapshot(),
          window.usageAtlas.getPreferences(),
          window.usageAtlas.getCustomBackground()
        ]);
        const nextDiagnostics = await window.usageAtlas.getDiagnostics();
        if (!active) return;
        setSnapshot(nextSnapshot);
        setPreferences(nextPreferences);
        setCustomBackgroundUrl(nextBackgroundUrl);
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
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const useCustomBackground = preferences?.backgroundImage === "custom" && customBackgroundUrl;
    if (useCustomBackground) {
      document.body.style.setProperty("--atlas-wallpaper-image", `url("${customBackgroundUrl}")`);
    } else {
      document.body.style.removeProperty("--atlas-wallpaper-image");
    }
  }, [customBackgroundUrl, preferences?.backgroundImage]);

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash(location.hash));
    window.addEventListener("hashchange", onHashChange);
    const removeNavigate = window.usageAtlas.onNavigate((next) => navigate(next));
    const removeStatus = window.usageAtlas.onEngineStatus(setEngineStatus);
    const removeSnapshot = window.usageAtlas.onSnapshot((next) => {
      setSnapshot(next);
      setError(null);
    });
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      removeNavigate();
      removeStatus();
      removeSnapshot();
    };
  }, [navigate]);

  async function refreshAll(): Promise<void> {
    setRefreshing(true);
    try {
      setSnapshot(await window.usageAtlas.refreshAll());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The local engine did not respond.");
    } finally {
      setLoading(false);
      setRefreshing(false);
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
      setSnapshot(await window.usageAtlas.setProviderEnabled(providerID, enabled));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The provider setting could not be saved.");
    } finally {
      setProviderSaving(null);
    }
  }

  const today = todayDay();
  const usageRoute = route === "day" || route === "trends" || route === "insights" || route === "limits";
  const providerAnalyticsIssue = snapshot ? analyticsIssue(snapshot, providerScope) : null;
  const message = error ?? providerAnalyticsIssue?.message ?? (snapshot && isSnapshotStale(snapshot)
    ? "This snapshot is older than its refresh window. Check now for current usage."
    : null);
  // Dismissal is keyed on the wording, so a different problem always breaks through.
  const notice: PageNotice | null = message === null || message === dismissedNotice
    ? null
    : {
      message,
      detail: error ? null : providerAnalyticsIssue?.detail ?? null,
      tone: error ? "error" : providerAnalyticsIssue?.tone ?? "stale",
      onDismiss: () => setDismissedNotice(message)
    };

  function selectDay(day: string): void {
    setSelectedDay(day > today ? today : day);
    navigate("day");
  }

  function openTrends(range: AnalyticsRange): void {
    setTrendRange(range);
    setTrendEndDay(today);
    navigate("trends");
  }

  function renderUsageRoute(): React.JSX.Element | null {
    if (!usageRoute) return null;
    if (loading) return <UsageLoading />;
    if (error && !snapshot) return <UsageFailure error={error} onRetry={refreshAll} />;
    if (!snapshot || enabledProviders(snapshot).length === 0) {
      return <UsageEmpty onOpenSettings={() => navigate("settings")} />;
    }
    if (route === "day") {
      return (
        <DayDashboard
          limitOrder={preferences?.limitOrder ?? []}
          notice={notice}
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
          endDay={trendEndDay}
          notice={notice}
          onEndDayChange={setTrendEndDay}
          onOpenDay={selectDay}
          onProviderScopeChange={setProviderScope}
          onRangeChange={(range) => { setTrendRange(range); setTrendEndDay(today); }}
          onRefresh={refreshAll}
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
          notice={notice}
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
          limitOrder={preferences?.limitOrder ?? []}
          notice={notice}
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
    <AppShell engineStatus={engineStatus} onNavigate={navigate} route={route}>
      {renderUsageRoute()}
      {route === "alerts" && (
        <UsageAlertsPage
          onUpdate={updatePreferences}
          preferences={preferences}
          providers={snapshot?.providers ?? []}
          saving={saving}
        />
      )}
      {route === "settings" && (
        <Settings
          backgroundError={backgroundError}
          customBackgroundUrl={customBackgroundUrl}
          onChooseCustomBackground={chooseCustomBackground}
          onOpenExternal={openExternal}
          onSetProviderEnabled={setProviderEnabled}
          onUpdate={updatePreferences}
          preferences={preferences}
          providerSaving={providerSaving}
          providers={snapshot?.providers ?? []}
          saving={saving}
        />
      )}
      {route === "diagnostics" && (
        <Diagnostics
          diagnostics={diagnostics}
          loading={diagnosticsLoading}
          onOpenExternal={openExternal}
          onReload={loadDiagnostics}
          providers={snapshot?.providers ?? []}
        />
      )}
    </AppShell>
  );
}

async function openExternal(url: string): Promise<void> {
  await window.usageAtlas.openExternal(url);
}

function backgroundImageErrorMessage(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : "";
  if (message.includes("25 MB")) return "Choose an image smaller than 25 MB.";
  if (message.includes("supported image")) return "Choose a valid JPG, PNG, or WebP image.";
  return "Unable to use that image. Try another file.";
}

function routeFromHash(hash: string): AppRoute {
  const candidate = hash.replace(/^#/, "");
  if (candidate === "trends" || candidate === "insights" || candidate === "limits" || candidate === "alerts" || candidate === "settings" || candidate === "diagnostics") {
    return candidate;
  }
  return "day";
}
