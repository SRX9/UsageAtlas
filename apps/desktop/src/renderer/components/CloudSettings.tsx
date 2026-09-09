import { useEffect, useRef, useState } from "react";
import { Button, Card, Spinner, Switch } from "@heroui/react";
import type {
  CloudAction,
  CloudActionOptions,
  CloudStatus,
} from "../../shared/desktop-api";

export function CloudSettings(): React.JSX.Element {
  const requestVersion = useRef(0);
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [action, setAction] = useState<CloudAction | null>(null);
  const working = action !== null;
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const version = requestVersion.current;
      try {
        const next = await window.usageAtlas.getCloudStatus();
        if (active && version === requestVersion.current) {
          setStatus(next);
          setLoadError(null);
        }
      } catch {
        if (active && version === requestVersion.current) setLoadError("Cloud settings could not be loaded.");
      }
      if (active) timer = setTimeout(() => void refresh(), 3_000);
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  async function act(action: CloudAction, options?: CloudActionOptions) {
    requestVersion.current += 1;
    setAction(action);
    setError(null);
    try {
      setStatus(await window.usageAtlas.cloudAction(action, options));
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Cloud request failed. Your local usage is safe.",
      );
    } finally {
      requestVersion.current += 1;
      setAction(null);
    }
  }
  const visibleError = error || status?.error || loadError;
  const busy = working || Boolean(status?.busy);
  const operation = action === "save" || action === "restore" ? action : status?.progress?.operation;
  const saving = busy && operation === "save";
  const restoring = busy && operation === "restore";
  const progress = status?.progress;
  const message = saving
    ? progress?.phase === "saving"
      ? `Saved ${progress.completed.toLocaleString()} of ${(progress.total ?? 0).toLocaleString()} records…`
      : "Preparing your cloud save…"
    : restoring
      ? `Restoring history${progress?.completed ? ` · ${progress.completed.toLocaleString()} records received` : ""}…`
      : visibleError
        ? "Your local history is safe. Try again when you're ready."
        : status?.conflicts.length
          ? "Choose which version to keep below to finish saving."
          : status?.pending
            ? `${status.lastCompleted === "save" ? "Saved to cloud. " : status.lastCompleted === "restore" ? "History restored. " : ""}${status.pending} ${status.pending === 1 ? "change waiting" : "changes waiting"} to be saved.`
            : status?.lastCompleted === "restore" ? "History restored." : "All changes saved to cloud.";
  return (
    <Card variant="transparent">
      <Card.Header>
        <Card.Title>Cloud save</Card.Title>
        <Card.Description>
          No account is needed to track usage. Create a free account to save
          your usage history and restore it on another computer.
        </Card.Description>
      </Card.Header>
      <Card.Content className="mt-2 space-y-4">
        {!status ? (
          <div
            className="flex items-center gap-2 py-3 text-sm text-muted"
            role="status"
          >
            <Spinner size="sm" /> Loading cloud settings...
          </div>
        ) : status.account ? (
          <>
            <div className="rounded-xl border border-separator px-4 py-3">
              <p className="text-xs text-muted">Connected account</p>
              <p className="mt-1 break-all text-sm font-medium">
                {status.account.email}
              </p>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <strong className="text-sm font-medium">
                  Save automatically
                </strong>
                <p className="mt-1 text-xs text-muted">
                  Save pending usage once an hour while the app is running.
                </p>
              </div>
              <Switch
                aria-label="Save automatically"
                isSelected={status.automatic}
                isDisabled={busy}
                onChange={(enabled) => void act("automatic", { enabled })}
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </Switch>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button
                isPending={saving}
                isDisabled={busy || status.pending === 0}
                onPress={() => void act("save")}
              >
                {saving && <CloudSpinner />}
                {saving ? "Saving…" : "Save to cloud"}
              </Button>
              <Button
                isPending={restoring}
                isDisabled={busy}
                variant="outline"
                onPress={() => void act("restore")}
              >
                {restoring && <CloudSpinner />}
                {restoring ? "Restoring…" : "Restore from cloud"}
              </Button>
              <Button
                isPending={action === "sign-out"}
                isDisabled={busy}
                variant="ghost"
                onPress={() => void act("sign-out")}
              >
                {action === "sign-out" && <CloudSpinner />}
                {action === "sign-out" ? "Signing out…" : "Sign out"}
              </Button>
            </div>
            <div className="space-y-1 text-xs text-muted" role="status" aria-live="polite">
              <p>{message}</p>
              {(saving || restoring) && (
                <p>This may take a minute or two. You can keep using UsageAtlas.</p>
              )}
            </div>
            {status.conflicts.map((conflict) => (
              <div
                className="rounded-lg border border-separator p-3"
                key={conflict.recordId}
              >
                <p className="text-sm">
                  {conflict.provider} {conflict.day ?? "limits"} changed on both
                  devices.
                </p>
                {conflict.localTokens !== null && (
                  <p className="mt-1 text-xs text-muted">
                    Local: {conflict.localTokens.toLocaleString()} tokens.
                    Cloud: {conflict.cloudTokens?.toLocaleString()} tokens.
                  </p>
                )}
                <div className="mt-3 flex gap-3">
                  <Button
                    size="sm"
                    isDisabled={busy}
                    variant="outline"
                    onPress={() =>
                      void act("resolve", {
                        recordId: conflict.recordId,
                        choice: "local",
                      })
                    }
                  >
                    Keep local
                  </Button>
                  <Button
                    size="sm"
                    isDisabled={busy}
                    variant="outline"
                    onPress={() =>
                      void act("resolve", {
                        recordId: conflict.recordId,
                        choice: "cloud",
                      })
                    }
                  >
                    Keep cloud
                  </Button>
                </div>
              </div>
            ))}
          </>
        ) : (
          <>
            <div className="rounded-2xl border border-separator p-5">
              <p className="text-sm font-medium">
                Save your history with a free account
              </p>
              <p className="mb-4 mt-1 max-w-md text-xs leading-relaxed text-muted">
                Continue with Google or GitHub to create an account or sign in.
                Hourly saving is on by default after sign-in while the app is running,
                unless you previously turned it off here. Coding-tool credentials,
                prompts, and project and session details are not included in cloud saves.
              </p>
              <Button
                isPending={action === "sign-in" || Boolean(status.loginCode)}
                isDisabled={working && action !== "sign-in"}
                onPress={() => void act("sign-in")}
              >
                {(action === "sign-in" || status.loginCode) && (
                  <span
                    aria-hidden="true"
                    className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
                  />
                )}
                {action === "sign-in"
                  ? "Opening browser..."
                  : status.loginCode
                    ? "Waiting for approval..."
                    : "Sign in"}
              </Button>
              {status.loginCode && (
                <div
                  className="mt-5 border-t border-separator pt-4"
                  role="status"
                >
                  <p className="text-xs text-muted">
                    Match this code in your browser, then approve sign-in.
                  </p>
                  <p className="my-3 font-mono text-2xl font-semibold tracking-widest">
                    {status.loginCode}
                  </p>
                  <Button
                    isDisabled={working}
                    size="sm"
                    variant="ghost"
                    onPress={() => void act("sign-out")}
                  >
                    Cancel sign-in
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
        {visibleError && (
          <p className="text-sm text-danger" role="alert">
            {visibleError}
          </p>
        )}
      </Card.Content>
    </Card>
  );
}

function CloudSpinner(): React.JSX.Element {
  return <span aria-hidden="true" className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" />;
}
