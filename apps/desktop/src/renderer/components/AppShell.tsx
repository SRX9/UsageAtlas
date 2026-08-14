import type { AppRoute, EngineStatus } from "../../shared/desktop-api";
import { useLayoutEffect, useRef } from "react";
import { BellIcon, DayIcon, InsightsIcon, PulseIcon, SettingsIcon, TrendsIcon } from "../icons";

interface AppShellProps {
  route: AppRoute;
  engineStatus: EngineStatus;
  /** Open health notices — the rail dot is the only place they interrupt anything. */
  noticeCount: number;
  onNavigate(route: AppRoute): void;
  children: React.ReactNode;
}

const primaryNavigation: Array<{
  route: AppRoute;
  label: string;
  icon: (props: React.SVGProps<SVGSVGElement>) => React.JSX.Element;
}> = [
  { route: "day", label: "Today", icon: DayIcon },
  { route: "trends", label: "History", icon: TrendsIcon },
  { route: "insights", label: "Insights", icon: InsightsIcon },
  { route: "alerts", label: "Usage alerts", icon: BellIcon }
];

const routeTitles: Record<AppRoute, string> = {
  day: "Today",
  trends: "History",
  insights: "Insights",
  limits: "Limits",
  alerts: "Usage alerts",
  diagnostics: "Diagnostics",
  settings: "Settings"
};

export function AppShell({ route, engineStatus, noticeCount, onNavigate, children }: AppShellProps): React.JSX.Element {
  const workspaceRef = useRef<HTMLElement>(null);

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
            <img alt="" src="./usageatlas.png" />
          </span>
          <span className="atlas-app-shell__brand-name">UsageAtlas</span>
          <span aria-hidden="true" className="atlas-app-shell__brand-divider" />
          <span className="atlas-app-shell__route-name">{routeTitles[route]}</span>
        </div>
      </header>

      <aside aria-label="Primary navigation" className="atlas-app-shell__rail no-drag">
        <nav aria-label="Main navigation" className="atlas-app-shell__navigation">
          {primaryNavigation.map((item) => (
            <RailButton
              icon={item.icon}
              isCurrent={route === item.route}
              key={item.route}
              label={item.label}
              onPress={() => onNavigate(item.route)}
            />
          ))}
        </nav>

        <nav aria-label="App controls" className="atlas-app-shell__navigation atlas-app-shell__navigation--footer">
          <RailButton
            icon={PulseIcon}
            isCurrent={route === "diagnostics"}
            label="Diagnostics"
            noticeCount={noticeCount}
            onPress={() => onNavigate("diagnostics")}
            status={engineStatus}
          />
          <RailButton
            icon={SettingsIcon}
            isCurrent={route === "settings"}
            label="Settings"
            onPress={() => onNavigate("settings")}
          />
        </nav>
      </aside>

      <main className="atlas-app-shell__workspace no-drag" onScroll={handleWorkspaceScroll} ref={workspaceRef}>
        {children}
      </main>
    </div>
  );
}

function handleWorkspaceScroll(event: React.UIEvent<HTMLElement>): void {
  event.currentTarget.toggleAttribute("data-scrolled", event.currentTarget.scrollTop > 12);
}

function RailButton({
  icon: Icon,
  isCurrent,
  label,
  noticeCount = 0,
  onPress,
  status
}: {
  icon: (props: React.SVGProps<SVGSVGElement>) => React.JSX.Element;
  isCurrent: boolean;
  label: string;
  noticeCount?: number;
  onPress(): void;
  status?: EngineStatus;
}): React.JSX.Element {
  const description = status ? `${label}: ${engineLabel(status)}${noticeLabel(noticeCount)}` : label;
  return (
    <button
      aria-current={isCurrent ? "page" : undefined}
      aria-label={description}
      className="atlas-app-shell__rail-button"
      onClick={onPress}
      title={description}
      type="button"
    >
      <span className="atlas-app-shell__rail-icon">
        <Icon aria-hidden="true" />
        {status ? <StatusDot hasNotices={noticeCount > 0} status={status} /> : null}
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
