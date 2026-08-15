import type { DashboardProvider } from "@usageatlas/contracts";
import type { EngineDiagnostics, EngineStatus } from "../../shared/desktop-api";
import { Alert, Button, Card, Skeleton, Tooltip } from "@heroui/react";
import { CloseIcon, ExternalIcon, RefreshIcon } from "../icons";
import { providerConnection } from "../provider-connection";

const REPOSITORY_URL = "https://github.com/SRX9/UsageAtlas";

/**
 * Something the usage numbers should be read against — a source that needs a new
 * sign-in, a partial history, a snapshot past its refresh window. Usage pages stay
 * clean; these are listed here and flagged by the dot on the Diagnostics rail button.
 */
export interface HealthNotice {
  message: string;
  detail: string | null;
  tone: "warning" | "error";
}

interface DiagnosticsProps {
  diagnostics: EngineDiagnostics | null;
  loading: boolean;
  notices: HealthNotice[];
  providers: DashboardProvider[];
  onDismissNotice(message: string): void;
  onOpenExternal(url: string): Promise<void>;
  onReload(): Promise<void>;
}

export function Diagnostics({
  diagnostics,
  loading,
  notices,
  providers,
  onDismissNotice,
  onOpenExternal,
  onReload
}: DiagnosticsProps): React.JSX.Element {
  const reporting = providers.filter((provider) => provider.enabled);
  return (
    <div className="atlas-page atlas-page--narrow">
      <header className="atlas-page-header flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="atlas-kicker">Support</p>
          <h1 className="atlas-page-title">Engine health</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            The local UsageAtlas engine, and anything that qualifies the usage numbers.
          </p>
        </div>
        <Button isPending={loading} onPress={() => void onReload()} variant="outline">
          <span>Reload</span>
          <RefreshIcon className={`size-4${loading ? " animate-spin" : ""}`} />
        </Button>
      </header>

      {!diagnostics ? (
        <Skeleton className="mt-8 h-28 rounded-2xl" />
      ) : (
        <Card className="mt-8" variant="transparent">
          <Card.Header className="flex-row items-center gap-4">
            <span className="atlas-engine-status__signal" aria-hidden="true">
              <span className="atlas-engine-status__dot" data-status={diagnostics.status} />
            </span>
            <div className="min-w-0">
              <p className="text-xs text-muted">Engine status</p>
              <Card.Title className="mt-1">{engineStatusLabel(diagnostics.status)}</Card.Title>
              <Card.Description>{engineStatusDescription(diagnostics.status)}</Card.Description>
            </div>
          </Card.Header>
        </Card>
      )}

      {notices.length > 0 ? (
        <section aria-label="Open notices" className="atlas-health-notices">
          {notices.map((notice) => (
            <Alert key={notice.message} status={notice.tone === "error" ? "danger" : "warning"}>
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{notice.message}</Alert.Title>
                {notice.detail ? <Alert.Description>{notice.detail}</Alert.Description> : null}
              </Alert.Content>
              <Tooltip>
                <Button
                  aria-label="Dismiss this notice"
                  className="atlas-health-notices__dismiss"
                  isIconOnly
                  onPress={() => onDismissNotice(notice.message)}
                  variant="ghost"
                >
                  <CloseIcon className="size-4" />
                </Button>
                <Tooltip.Content>Hide until it changes · the tool stays listed under Sources</Tooltip.Content>
              </Tooltip>
            </Alert>
          ))}
        </section>
      ) : null}

      <Card className="mt-4" variant="transparent">
        <Card.Header>
          <Card.Title>Sources</Card.Title>
          <Card.Description>
            How each enabled tool is signed in, and what history it reported on the last scan. Anything worth
            knowing about the usage numbers is reported here rather than on the usage pages.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {reporting.length === 0 ? (
            <p className="text-sm text-muted">No tools are enabled yet.</p>
          ) : (
            <ul className="atlas-coverage-list">
              {reporting.map((provider) => {
                const connection = providerConnection(provider);
                return (
                  <li className="atlas-coverage-row" key={provider.id}>
                    <div className="min-w-0">
                      <p className="atlas-coverage-row__name">{provider.name}</p>
                      {connection.state === "connected" ? null : (
                        <p className="atlas-coverage-row__connection" data-connection={connection.state}>
                          {connection.summary}
                          {connection.action ? ` ${connection.action}` : null}
                          {connection.command ? (
                            <code className="atlas-command">{connection.command}</code>
                          ) : null}
                        </p>
                      )}
                      <p className="atlas-coverage-row__detail">{coverageDetail(provider)}</p>
                    </div>
                    <div className="atlas-coverage-row__badges">
                      <span className="atlas-coverage-row__status" data-connection={connection.state}>
                        {connection.label}
                      </span>
                      <span
                        className="atlas-coverage-row__status"
                        data-status={provider.analytics?.status ?? "unavailable"}
                      >
                        {coverageLabel(provider)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card.Content>
      </Card>

      <Card className="mt-4" variant="transparent">
        <Card.Header>
          <Card.Title>Contribute on GitHub</Card.Title>
          <Card.Description>
            If something is not working, open an issue on GitHub. You can also send a pull request with a fix or a new feature.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <Button onPress={() => void onOpenExternal(REPOSITORY_URL)} variant="outline">
            <span>Open UsageAtlas on GitHub</span>
            <ExternalIcon className="size-4" />
          </Button>
        </Card.Content>
      </Card>
    </div>
  );
}

function coverageLabel(provider: DashboardProvider): string {
  const status = provider.analytics?.status;
  if (status === "available") return "Complete";
  if (status === "partial") return "Partial";
  if (status === "no_data") return "No data";
  return "Unavailable";
}

function coverageDetail(provider: DashboardProvider): string {
  const analytics = provider.analytics;
  // The sign-in line above already carries why a failing tool read nothing.
  if (!analytics) return "No local usage history was read on the last scan.";
  if (analytics.error) return analytics.error.message;
  if (analytics.status === "no_data") return "No usage has been recorded yet.";
  return `${analytics.coverageStart} to ${analytics.coverageEnd} · ${analytics.filesScanned.toLocaleString("en-US")} files scanned`;
}

function engineStatusLabel(status: EngineStatus): string {
  if (status === "ready") return "Ready";
  if (status === "starting") return "Starting";
  if (status === "degraded") return "Needs attention";
  return "Stopped";
}

function engineStatusDescription(status: EngineStatus): string {
  if (status === "ready") return "The local engine is running normally.";
  if (status === "starting") return "The local engine is starting. Usage data will appear shortly.";
  if (status === "degraded") return "The local engine is running with limited functionality.";
  return "The local engine is not running. Reload to try again.";
}
