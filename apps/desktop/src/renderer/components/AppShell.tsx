import type { AppRoute, EngineStatus } from "../../shared/desktop-api";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AttributionIcon, BellIcon, DayIcon, InsightsIcon, ProfileIcon, PulseIcon, SettingsIcon, TrendsIcon } from "../icons";
import { useI18n } from "../i18n";
import type { MessageKey } from "../i18n";

interface AppShellProps {
  route: AppRoute;
  engineStatus: EngineStatus;
  /** Open health notices — the rail dot is the only place they interrupt anything. */
  noticeCount: number;
  onNavigate(route: AppRoute): void;
  /** A quiet dot on Profile until the page has been opened once. */
  profileBadge?: boolean;
  /** PNG data URL for the mark chosen in Settings → Appearance. */
  appMarkUrl?: string | null;
  /** Where the user came from, so the incoming page glides in from the right side. */
  previousRoute?: AppRoute | null;
  activityControl?: React.ReactNode;
  updateControl?: React.ReactNode;
  /** An alert raised while the user is somewhere else, mirrored from the toast. */
  alertBanner?: React.ReactNode;
  children: React.ReactNode;
}

const primaryNavigation: Array<{
  route: AppRoute;
  labelKey: MessageKey;
  icon: (props: React.SVGProps<SVGSVGElement>) => React.JSX.Element;
}> = [
  { route: "day", labelKey: "nav.today", icon: DayIcon },
  { route: "trends", labelKey: "nav.history", icon: TrendsIcon },
  { route: "insights", labelKey: "nav.insights", icon: InsightsIcon },
  { route: "alerts", labelKey: "nav.alerts", icon: BellIcon },
  { route: "profile", labelKey: "nav.profile", icon: ProfileIcon }
];

const routeTitleKeys: Record<AppRoute, MessageKey> = {
  day: "nav.today",
  trends: "nav.history",
  insights: "nav.insights",
  limits: "nav.history",
  alerts: "nav.alerts",
  profile: "nav.profile",
  attribution: "nav.attribution",
  diagnostics: "nav.diagnostics",
  settings: "nav.settings"
};

/** Reading order of the rail, so a page slides in from the side it comes from. */
const routeOrder: Record<AppRoute, number> = {
  day: 0,
  trends: 1,
  insights: 2,
  limits: 3,
  alerts: 4,
  profile: 5,
  attribution: 6,
  diagnostics: 7,
  settings: 8
};

export function AppShell({ route, engineStatus, noticeCount, onNavigate, profileBadge = false, appMarkUrl = null, previousRoute = null,  activityControl,
  updateControl,
  alertBanner,
  children
}: AppShellProps): React.JSX.Element {
  const { t } = useI18n();
  const workspaceRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const railButtons = useRef(new Map<AppRoute, HTMLButtonElement>());
  const [highlight, setHighlight] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [settled, setSettled] = useState(false);
  // A later page in the rail slides in from the right, an earlier one from the left.
  const direction = previousRoute && routeOrder[route] < routeOrder[previousRoute] ? "back" : "forward";

  const registerRailButton = useCallback((item: AppRoute, node: HTMLButtonElement | null) => {
    if (node) railButtons.current.set(item, node);
    else railButtons.current.delete(item);
  }, []);

  // The highlight is one element moved with a transform, so the pill glides from
  // the page you left to the one you opened. Measuring the real buttons keeps it
  // aligned through font-scale and window-size changes.
  const measureRail = useCallback(() => {
    const rail = railRef.current;
    const button = railButtons.current.get(route);
    if (!rail) return;
    // A sub-page such as Limits has no rail entry, so nothing is highlighted.
    if (!button) {
      setHighlight(null);
      return;
    }
    const railBox = rail.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    setHighlight({
      top: box.top - railBox.top,
      left: box.left - railBox.left,
      width: box.width,
      height: box.height
    });
  }, [route]);

  useLayoutEffect(() => {
    measureRail();
  }, [measureRail]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const observer = new ResizeObserver(measureRail);
    observer.observe(rail);
    // The first placement must not animate from the top of the rail.
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [measureRail]);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    workspace.scrollTop = 0;
    workspace.scrollLeft = 0;
    workspace.removeAttribute("data-scrolled");
  }, [route]);

  return (
    <div className="atlas-app-shell">
      <header aria-label="UsageAtlas" className="atlas-app-shell__titlebar drag-region">
        <div className="atlas-app-shell__brand">
          <span aria-hidden="true" className="atlas-app-shell__brand-mark">
            <img alt="" src={appMarkUrl ?? "./usageatlas.png"} />
          </span>
          <span className="atlas-app-shell__brand-name">UsageAtlas</span>
          {updateControl}
          <span aria-hidden="true" className="atlas-app-shell__brand-divider" />
          <span className="atlas-app-shell__route-name">{t(routeTitleKeys[route])}</span>
          {activityControl}
        </div>
        <WindowControls />
      </header>

      <aside aria-label="Primary navigation" className="atlas-app-shell__rail no-drag" ref={railRef}>
        {highlight ? (
          <span
            aria-hidden="true"
            className="atlas-app-shell__rail-highlight"
            data-settled={settled ? "true" : "false"}
            style={{
              width: highlight.width,
              height: highlight.height,
              transform: `translate(${highlight.left}px, ${highlight.top}px)`
            }}
          />
        ) : null}
        <nav aria-label="Main navigation" className="atlas-app-shell__navigation">
          {primaryNavigation.map((item) => (
            <RailButton
              icon={item.icon}
              badge={item.route === "profile" && profileBadge}
              isCurrent={route === item.route}
              itemRef={(node) => registerRailButton(item.route, node)}
              key={item.route}
              label={t(item.labelKey)}
              onPress={() => onNavigate(item.route)}
            />
          ))}
        </nav>

        <nav aria-label="App controls" className="atlas-app-shell__navigation atlas-app-shell__navigation--footer">
          <RailButton
            icon={PulseIcon}
            isCurrent={route === "diagnostics"}
            itemRef={(node) => registerRailButton("diagnostics", node)}
            label={t("nav.diagnostics")}
            noticeCount={noticeCount}
            onPress={() => onNavigate("diagnostics")}
            status={engineStatus}
          />
          <RailButton
            icon={AttributionIcon}
            isCurrent={route === "attribution"}
            itemRef={(node) => registerRailButton("attribution", node)}
            label={t("nav.attribution")}
            onPress={() => onNavigate("attribution")}
          />
          <RailButton
            icon={SettingsIcon}
            isCurrent={route === "settings"}
            itemRef={(node) => registerRailButton("settings", node)}
            label={t("nav.settings")}
            onPress={() => onNavigate("settings")}
          />
        </nav>
      </aside>

      {alertBanner}

      <main className="atlas-app-shell__workspace no-drag" onScroll={handleWorkspaceScroll} ref={workspaceRef}>
        <div className="atlas-route-view" data-direction={direction} key={route}>
          {children}
        </div>
      </main>
    </div>
  );
}

/**
 * Minimize, maximize and close, drawn by the app on every platform that has no
 * native title bar of its own — the same three controls Freebuff puts in the same
 * corner. macOS keeps its traffic lights, so nothing is rendered there.
 */
function WindowControls(): React.JSX.Element | null {
  const { t } = useI18n();
  const [maximized, setMaximized] = useState(false);
  // Read once, during the first render: the shell also renders outside a browser
  // (tests, static markup) where there is no bridge and no window to draw for.
  const [platform] = useState<string | null>(() => (
    typeof window === "undefined" ? null : window.usageAtlas?.platform ?? null
  ));

  useEffect(() => {
    const api = typeof window === "undefined" ? null : window.usageAtlas;
    if (!api || api.platform === "darwin") return;
    let active = true;
    void api.getWindowState().then(value => {
      if (active) setMaximized(value);
    }, () => undefined);
    const remove = api.onWindowMaximized(setMaximized);
    return () => {
      active = false;
      remove();
    };
  }, []);

  if (!platform || platform === "darwin") return null;

  return (
    <div className="atlas-window-controls no-drag">
      <button
        aria-label={t("window.minimize")}
        className="atlas-window-controls__button"
        onClick={() => void window.usageAtlas.minimizeWindow()}
        type="button"
      >
        <svg aria-hidden="true" viewBox="0 0 12 12">
          <line x1="2" x2="10" y1="6" y2="6" />
        </svg>
      </button>
      <button
        aria-label={t(maximized ? "window.restore" : "window.maximize")}
        className="atlas-window-controls__button"
        onClick={() => void window.usageAtlas.toggleMaximizeWindow().then(setMaximized, () => undefined)}
        type="button"
      >
        {maximized ? (
          <svg aria-hidden="true" viewBox="0 0 12 12">
            <rect height="6.5" width="6.5" x="3.5" y="2.5" />
            <path d="M2.5 5.5v4h6.5" />
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 12 12">
            <rect height="7" width="7" x="2.5" y="2.5" />
          </svg>
        )}
      </button>
      <button
        aria-label={t("window.close")}
        className="atlas-window-controls__button atlas-window-controls__button--close"
        onClick={() => void window.usageAtlas.closeWindow()}
        type="button"
      >
        <svg aria-hidden="true" viewBox="0 0 12 12">
          <path d="M3 3l6 6M9 3l-6 6" />
        </svg>
      </button>
    </div>
  );
}

function handleWorkspaceScroll(event: React.UIEvent<HTMLElement>): void {
  event.currentTarget.toggleAttribute("data-scrolled", event.currentTarget.scrollTop > 12);
}

function RailButton({
  badge = false,
  icon: Icon,
  isCurrent,
  itemRef,
  label,
  noticeCount = 0,
  onPress,
  status
}: {
  badge?: boolean;
  icon: (props: React.SVGProps<SVGSVGElement>) => React.JSX.Element;
  isCurrent: boolean;
  itemRef?(node: HTMLButtonElement | null): void;
  label: string;
  noticeCount?: number;
  onPress(): void;
  status?: EngineStatus;
}): React.JSX.Element {
  const description = status ? `${label}: ${engineLabel(status)}${noticeLabel(noticeCount)}` : badge ? `${label} · New` : label;
  return (
    <button
      aria-current={isCurrent ? "page" : undefined}
      aria-label={description}
      className="atlas-app-shell__rail-button"
      onClick={onPress}
      ref={itemRef}
      title={description}
      type="button"
    >
      <span className="atlas-app-shell__rail-icon">
        <Icon aria-hidden="true" />
        {status ? <StatusDot hasNotices={noticeCount > 0} status={status} /> : null}
        {badge ? <span aria-hidden="true" className="atlas-app-shell__status-dot" data-badge="true" /> : null}
      </span>
      <span className="sr-only">{description}</span>
    </button>
  );
}

function StatusDot({ hasNotices, status }: { hasNotices: boolean; status: EngineStatus }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="atlas-app-shell__status-dot"
      data-notices={hasNotices ? "true" : undefined}
      data-status={status}
    />
  );
}

function noticeLabel(count: number): string {
  if (count === 0) return "";
  return ` · ${count} ${count === 1 ? "notice" : "notices"}`;
}

function engineLabel(status: EngineStatus): string {
  if (status === "ready") return "Ready";
  if (status === "starting") return "Starting";
  if (status === "degraded") return "Needs attention";
  return "Stopped";
}
