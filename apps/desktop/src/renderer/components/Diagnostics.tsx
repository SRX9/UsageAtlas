import type { DashboardProvider } from "@usageatlas/contracts";
import type { EngineDiagnostics, EngineStatus } from "../../shared/desktop-api";
import { Button, Card, Skeleton } from "@heroui/react";
import { ExternalIcon, RefreshIcon } from "../icons";

const REPOSITORY_URL = "https://github.com/SRX9/UsageAtlas";

interface DiagnosticsProps {
  diagnostics: EngineDiagnostics | null;
  loading: boolean;
  providers: DashboardProvider[];
  onOpenExternal(url: string): Promise<void>;
  onReload(): Promise<void>;
}

export function Diagnostics({
  diagnostics,
  loading,
  providers,
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
          <p className="mt-2 max-w-2xl text-sm text-muted">Current status of the local UsageAtlas engine.</p>
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

      <Card className="mt-4" variant="transparent">
        <Card.Header>
          <Card.Title>History coverage</Card.Title>
          <Card.Description>
            What each enabled tool reported on the last scan. Notices dismissed on the usage pages stay here.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {reporting.length === 0 ? (
            <p className="text-sm text-muted">No tools are enabled yet.</p>
          ) : (
            <ul className="atlas-coverage-list">
              {reporting.map((provider) => (
                <li className="atlas-coverage-row" key={provider.id}>
                  <div className="min-w-0">
                    <p className="atlas-coverage-row__name">{provider.name}</p>
                    <p className="atlas-coverage-row__detail">{coverageDetail(provider)}</p>
                  </div>
                  <span className="atlas-coverage-row__status" data-status={provider.analytics?.status ?? "unavailable"}>
                    {coverageLabel(provider)}
                  </span>
                </li>
              ))}
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
  if (!analytics) return provider.error?.message ?? "This tool does not report a local usage history.";
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
