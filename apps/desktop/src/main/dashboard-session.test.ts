import fixture from "@usageatlas/contracts/fixtures/dashboard-v2.json";
import type { DashboardSnapshot } from "@usageatlas/contracts";
import { describe, expect, it, vi } from "vitest";
import type { DashboardState } from "../shared/desktop-api";
import { DashboardSession } from "./dashboard-session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function snapshot(): DashboardSnapshot {
  return structuredClone(fixture) as DashboardSnapshot;
}
function empty(): DashboardSnapshot {
  const value = snapshot();
  value.providers = value.providers.map(provider => ({ ...provider, windows: [], analytics: null,
    identity: null, credits: null, updatedAt: null,
    error: { code: "provider_not_refreshed", message: "Waiting for collection.", retryable: true }
  }));
  return value;
}
async function setup() {
  const engine = {
    getHydratedSnapshot: vi.fn(async () => snapshot()),
    getSnapshot: vi.fn(async () => snapshot()),
    refreshAll: vi.fn(async () => snapshot()),
    setProviderEnabled: vi.fn(async () => snapshot())
  };
  const states: DashboardState[] = [];
  const collected = vi.fn();
  const session = new DashboardSession(engine, state => states.push(state), collected);
  await session.configure("a", async () => undefined);
  session.activate();
  return { session, engine, states, collected };
}

describe("dashboard account transitions", () => {
  it("scopes local import progress to the selected account and clears it on account switch", async () => {
    const { session, states } = await setup();
    const progress = { completed: 250, total: 701, error: null };
    session.importProgress("a", progress);
    expect(states.at(-1)?.localImport).toEqual(progress);
    await session.configure("b", async () => undefined);
    expect(states.at(-1)?.localImport).toBeNull();
    const current = states.at(-1);
    session.importProgress("a", progress);
    expect(states.at(-1)).toBe(current);
    session.importProgress("b", progress);
    expect(states.at(-1)?.localImport).toEqual(progress);
    session.importProgress("b", null);
    expect(states.at(-1)?.localImport).toBeNull();
    session.close();
    const closed = states.at(-1);
    session.importProgress("b", progress);
    expect(states.at(-1)).toBe(closed);
  });

  it("shows loading and automatically collects after switching to an empty account", async () => {
    const { session, engine, states } = await setup();
    await session.refresh();
    engine.getHydratedSnapshot.mockResolvedValue(empty());
    const live = deferred<DashboardSnapshot>();
    engine.getSnapshot.mockReturnValue(live.promise);
    await session.configure("b", async () => undefined);
    await vi.waitFor(() => expect(engine.getSnapshot).toHaveBeenCalledTimes(2));
    expect(states.at(-1)).toMatchObject({ refreshing: true, error: null });
    expect(states.at(-1)?.snapshot?.providers[0]?.error?.code).toBe("provider_not_refreshed");
    const result = snapshot();
    live.resolve(result);
    await session.refresh();
    expect(states.at(-1)).toMatchObject({ snapshot: result, refreshing: false });
  });

  it("uses saved data immediately and shares manual and automatic refreshes", async () => {
    const { session, engine } = await setup();
    const cached = snapshot();
    engine.getHydratedSnapshot.mockResolvedValue(cached);
    const live = deferred<DashboardSnapshot>();
    engine.getSnapshot.mockReturnValue(live.promise);
    expect(await session.get()).toMatchObject({ snapshot: cached, refreshing: true });
    const first = session.refresh();
    const manual = session.refresh(true);
    expect(manual).toBe(first);
    await vi.waitFor(() => expect(engine.getSnapshot).toHaveBeenCalledOnce());
    live.resolve(snapshot());
    await manual;
    expect(engine.refreshAll).not.toHaveBeenCalled();
  });

  it("keeps a returning account's cache and does not scan when credentials are reconfigured", async () => {
    const { session, engine, states } = await setup();
    await session.refresh();
    const before = states.at(-1);
    const configure = vi.fn(async () => undefined);
    await session.configure("a", configure);
    expect(configure).toHaveBeenCalledOnce();
    expect(states.at(-1)).toBe(before);
    expect(engine.getSnapshot).toHaveBeenCalledOnce();
  });

  it("rechecks the same account after an engine restart", async () => {
    const { session, engine, states } = await setup();
    await session.refresh();
    const previous = states.at(-1)?.snapshot;
    const live = deferred<DashboardSnapshot>();
    engine.getSnapshot.mockReturnValue(live.promise);
    await session.configure("a", async () => undefined, true);
    expect(states.at(-1)).toMatchObject({ snapshot: previous, refreshing: true });
    live.resolve(snapshot());
    await session.refresh();
    expect(engine.getSnapshot).toHaveBeenCalledTimes(2);
  });

  it("ignores a previous account's late collection and never evaluates its alerts", async () => {
    const { session, engine, states, collected } = await setup();
    const old = deferred<DashboardSnapshot>();
    engine.getSnapshot.mockReturnValueOnce(old.promise);
    const pending = session.refresh();
    await vi.waitFor(() => expect(engine.getSnapshot).toHaveBeenCalledOnce());
    const current = snapshot();
    engine.getSnapshot.mockResolvedValue(current);
    await session.configure("b", async () => undefined);
    await session.refresh();
    const last = states.at(-1);
    old.resolve(snapshot());
    expect(await pending).toBe(last);
    expect(states.at(-1)).toBe(last);
    expect(collected).toHaveBeenCalledExactlyOnceWith(current);
  });

  it("ignores hydration from before the account switch", async () => {
    const { session, engine, states } = await setup();
    const old = deferred<DashboardSnapshot>();
    engine.getHydratedSnapshot.mockReturnValueOnce(old.promise);
    const pending = session.get();
    await vi.waitFor(() => expect(engine.getHydratedSnapshot).toHaveBeenCalledOnce());
    await session.configure("b", async () => undefined);
    await session.refresh();
    const last = states.at(-1);
    old.resolve(snapshot());
    expect(await pending).toBe(last);
    expect(states.at(-1)).toBe(last);
  });

  it("rehydrates a cloud save or restore without a provider scan", async () => {
    const { session, engine, states } = await setup();
    await session.refresh();
    const restored = snapshot();
    engine.getHydratedSnapshot.mockResolvedValue(restored);
    session.historyChanged();
    await vi.waitFor(() => expect(states.at(-1)?.snapshot).toBe(restored));
    expect(engine.getSnapshot).toHaveBeenCalledOnce();
    expect(states.at(-1)?.refreshing).toBe(false);
  });

  it("rehydrates cloud changes made during a scan after collection finishes", async () => {
    const { session, engine, states } = await setup();
    const live = deferred<DashboardSnapshot>();
    engine.getSnapshot.mockReturnValue(live.promise);
    const pending = session.refresh();
    await vi.waitFor(() => expect(engine.getSnapshot).toHaveBeenCalledOnce());
    const restored = snapshot();
    engine.getHydratedSnapshot.mockResolvedValue(restored);
    session.historyChanged();
    live.resolve(snapshot());
    await pending;
    expect(states.at(-1)?.snapshot).toBe(restored);
    expect(engine.getSnapshot).toHaveBeenCalledOnce();
  });

  it("does not drop a cloud update arriving during an earlier hydration", async () => {
    const { session, engine, states } = await setup();
    await session.refresh();
    const pending = deferred<DashboardSnapshot>();
    const latest = snapshot();
    engine.getHydratedSnapshot.mockReturnValueOnce(pending.promise).mockResolvedValue(latest);
    session.historyChanged();
    await vi.waitFor(() => expect(engine.getHydratedSnapshot).toHaveBeenCalledTimes(2));
    session.historyChanged();
    pending.resolve(snapshot());
    await vi.waitFor(() => expect(states.at(-1)?.snapshot).toBe(latest));
    expect(engine.getSnapshot).toHaveBeenCalledOnce();
  });

  it("stops publishing and collecting alerts after the app closes", async () => {
    const { session, engine, states, collected } = await setup();
    const live = deferred<DashboardSnapshot>();
    engine.getSnapshot.mockReturnValue(live.promise);
    const pending = session.refresh();
    await vi.waitFor(() => expect(engine.getSnapshot).toHaveBeenCalledOnce());
    session.close();
    const before = states.at(-1);
    live.resolve(snapshot());
    await pending;
    expect(states.at(-1)).toBe(before);
    expect(collected).not.toHaveBeenCalled();
  });

  it("retains current-account cached data on failure and permits a forced retry", async () => {
    const { session, engine, states } = await setup();
    const cached = snapshot();
    engine.getHydratedSnapshot.mockResolvedValue(cached);
    engine.getSnapshot.mockRejectedValue(new Error("offline"));
    await session.refresh();
    expect(states.at(-1)).toMatchObject({ snapshot: cached, refreshing: false, error: "offline" });
    await session.refresh(true);
    expect(engine.refreshAll).toHaveBeenCalledOnce();
    expect(states.at(-1)).toMatchObject({ refreshing: false, error: null });
  });

  it("does not read an old account when configuring the new account fails", async () => {
    const { session, engine, states } = await setup();
    await session.refresh();
    await expect(session.configure("b", async () => { throw new Error("configuration failed"); }))
      .rejects.toThrow("configuration failed");
    expect(await session.get()).toMatchObject({ snapshot: null, refreshing: false, error: "configuration failed" });
    await session.refresh(true);
    expect(states.at(-1)).toMatchObject({ snapshot: null, refreshing: false, error: "configuration failed" });
    expect(engine.refreshAll).not.toHaveBeenCalled();
    await session.configure("b", async () => undefined);
    await session.refresh();
    expect(states.at(-1)).toMatchObject({ refreshing: false, error: null });
    expect(engine.getSnapshot).toHaveBeenCalledTimes(2);
  });
});
