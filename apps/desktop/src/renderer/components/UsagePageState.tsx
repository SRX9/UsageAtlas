import { Alert, Button, Skeleton, Tooltip } from "@heroui/react";
import { AlertIcon, CloseIcon, ProvidersIcon } from "../icons";
import { EmptyState } from "./UsagePrimitives";

/** The one banner every usage page shows above its content. */
export interface PageNotice {
  message: string;
  detail: string | null;
  tone: "stale" | "error";
  onDismiss(): void;
}

export function AnalyzerNotice({ message, detail, tone, onDismiss }: PageNotice): React.JSX.Element {
  return (
    <div className="atlas-page-notice">
      <Alert status={tone === "error" ? "danger" : "warning"}>
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{message}</Alert.Title>
          {detail ? <Alert.Description>{detail}</Alert.Description> : null}
        </Alert.Content>
        <Tooltip>
          <Button
            aria-label="Dismiss this notice"
            className="atlas-page-notice__dismiss"
            isIconOnly
            onPress={onDismiss}
            variant="ghost"
          >
            <CloseIcon className="size-4" />
          </Button>
          <Tooltip.Content>Hide until it changes · stays listed under Engine health</Tooltip.Content>
        </Tooltip>
      </Alert>
    </div>
  );
}

export function UsageLoading(): React.JSX.Element {
  return (
    <div className="atlas-loading atlas-page grid gap-8" aria-busy="true" aria-label="Loading usage analyzer">
      <Skeleton className="h-9 w-72 rounded-xl" />
      <Skeleton className="h-36 w-full rounded-2xl" />
      <div className="atlas-skeleton-summary">
        {[0, 1, 2, 3].map((item) => <Skeleton className="h-32 rounded-2xl" key={item} />)}
      </div>
      <div className="atlas-content-grid"><Skeleton className="h-80 rounded-2xl" /><Skeleton className="h-80 rounded-2xl" /></div>
    </div>
  );
}

export function UsageFailure({ error, onRetry }: { error: string; onRetry(): Promise<void> }): React.JSX.Element {
  return (
    <div className="grid min-h-[70vh] place-items-center p-6" role="alert">
      <EmptyState className="max-w-md" size="lg">
        <EmptyState.Header>
          <EmptyState.Media className="text-danger" variant="icon"><AlertIcon className="size-6" /></EmptyState.Media>
          <EmptyState.Title>Usage is temporarily unavailable</EmptyState.Title>
          <EmptyState.Description>{error}</EmptyState.Description>
        </EmptyState.Header>
        <EmptyState.Content><Button onPress={() => void onRetry()}>Try again</Button></EmptyState.Content>
      </EmptyState>
    </div>
  );
}

export function UsageEmpty({ onOpenSettings }: { onOpenSettings(): void }): React.JSX.Element {
  return (
    <div className="grid min-h-[70vh] place-items-center p-6">
      <EmptyState className="max-w-md" size="lg">
        <EmptyState.Header>
          <EmptyState.Media variant="icon"><ProvidersIcon className="size-6" /></EmptyState.Media>
          <EmptyState.Title>No tools are reporting yet</EmptyState.Title>
          <EmptyState.Description>Choose the AI tools you use, then UsageAtlas will collect their local usage summaries.</EmptyState.Description>
        </EmptyState.Header>
        <EmptyState.Content><Button onPress={onOpenSettings}>Open settings</Button></EmptyState.Content>
      </EmptyState>
    </div>
  );
}
