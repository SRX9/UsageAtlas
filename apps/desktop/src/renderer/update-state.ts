import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopUpdateState } from "../shared/desktop-api";

export function useDesktopUpdates() {
  const eventVersion = useRef(0);
  const [state, setState] = useState<DesktopUpdateState | null>(null);

  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const unsubscribe = window.usageAtlas.onUpdateState(next => {
      receivedEvent = true;
      eventVersion.current += 1;
      if (active) setState(next);
    });
    void window.usageAtlas.getUpdateState().then(next => {
      if (active && !receivedEvent) setState(next);
    }).catch(() => {
      if (active && !receivedEvent) setState({
        status: "error", currentVersion: "", availableVersion: null, previousVersion: null,
        error: "Unable to read update status. Try checking again."
      });
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  const run = useCallback(async (action: "check" | "install" | "rollback") => {
    try {
      if (action === "rollback") {
        if (!(await window.usageAtlas.rollbackUpdate())) throw new Error("No previous build");
        return;
      }
      if (action === "check") {
        const version = eventVersion.current;
        const next = await window.usageAtlas.checkForUpdates();
        if (version === eventVersion.current) setState(next);
      }
      else await window.usageAtlas.installUpdate();
    } catch {
      setState(current => ({
        status: "error", currentVersion: current?.currentVersion ?? "", availableVersion: null,
        previousVersion: current?.previousVersion ?? null,
        error: "Unable to update. Try checking again."
      }));
    }
  }, []);

  return {
    state,
    check: () => run("check"),
    install: () => run("install"),
    rollback: () => run("rollback")
  };
}
