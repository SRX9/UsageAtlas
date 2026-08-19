import {
  HISTORY_DAY_PAYLOAD_VERSION,
  HISTORY_LOCAL_ACCOUNT_KEY,
  type HistoryDayPayload,
  type LocalUsageAnalytics,
  type UsageTotals
} from "@usageatlas/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateDashboard } from "../../main/dashboard-validation";
import { EngineService } from "../engine-service";
import { openWritableSqlite } from "../platform/sqlite";
import type { ProviderAdapter } from "../provider";
import { ProviderError } from "../provider";
import {
  composeProviderAnalytics,
  historyDaysForAccount,
  persistProviderHistory,
  HISTORY_SNAPSHOT_DAYS,
  MemoryHistoryStore,
  SqliteHistoryStore,
  type HistoryStore
} from "./index";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("HistoryStore", () => {
  it("seals drafts before today and never empty-clobbers a sealed day", () => {
    const store = new MemoryHistoryStore("replica-1");
    const day = "2026-08-18";
    store.upsertDraft("cursor", "user-a", day, payload({ totals: tokens(100) }));
    store.sealDraftsBefore("cursor", "2026-08-19");
    expect(store.get("cursor", "user-a", day)?.sealed).toBe(true);

    store.sealDay("cursor", "user-a", day, payload({ totals: tokens(0) }));
    expect(store.get("cursor", "user-a", day)?.payload.totals.totalTokens).toBe(100);
  });

  it("keeps separate rows per account and reports missing days per account", () => {
    const store = new MemoryHistoryStore();
    store.sealDay("cursor", "user-a", "2026-08-17", payload({ totals: tokens(40) }));
    store.sealDay("cursor", "user-a", "2026-08-18", payload({ totals: tokens(60) }));
    expect(store.missingDays("cursor", "user-a", "2026-08-17", "2026-08-18")).toEqual([]);
    expect(store.missingDays("cursor", "user-b", "2026-08-17", "2026-08-18")).toEqual([
      "2026-08-17",
      "2026-08-18"
    ]);
    expect(historyDaysForAccount(store, "cursor", "user-b", new Date("2026-08-19T12:00:00"))).toBe(90);
    expect(historyDaysForAccount(store, "cursor", "user-a", new Date("2026-08-19T12:00:00"))).toBe(1);
  });

  it("composes same-day account switch totals without losing the prior draft", () => {
    const store = new MemoryHistoryStore();
    const today = "2026-08-19";
    store.upsertDraft("cursor", "user-a", today, payload({
      accountKey: "user-a",
      totals: tokens(200),
      hourly: [{ date: today, hour: 9, ...tokens(200) }]
    }));
    const live = analyticsFixture(today, tokens(150), [{ date: today, hour: 14, ...tokens(150) }]);
    const composed = composeProviderAnalytics({
      now: new Date("2026-08-19T18:00:00"),
      stored: store.getRange("cursor", today, today),
      liveToday: live,
      currentAccountKey: "user-b",
      historyDays: 7
    });
    expect(composed.today.totalTokens).toBe(350);
    expect(composed.daily.find((day) => day.date === today)?.totalTokens).toBe(350);
  });

  it("persists a stable replica id and change sequence across sqlite reopen", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "usageatlas-history-"));
    directories.push(directory);
    const databasePath = path.join(directory, "history.sqlite");
    const first = SqliteHistoryStore.open(databasePath);
    const replica = first.replicaId();
    first.sealDay("claude", HISTORY_LOCAL_ACCOUNT_KEY, "2026-08-18", payload({ totals: tokens(25) }));
    const changes = first.changesSince(0);
    expect(changes).toHaveLength(1);
    first.close();

    const second = SqliteHistoryStore.open(databasePath);
    expect(second.replicaId()).toBe(replica);
    expect(second.get("claude", HISTORY_LOCAL_ACCOUNT_KEY, "2026-08-18")?.payload.totals.totalTokens).toBe(25);
    expect(second.changesSince(0)).toHaveLength(1);
    second.close();
  });

  it("lets sqlite replace a sealed partial day and refuses empty inserts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "usageatlas-history-"));
    directories.push(directory);
    const store = SqliteHistoryStore.open(path.join(directory, "history.sqlite"));
    expect(store.sealDay("claude", HISTORY_LOCAL_ACCOUNT_KEY, "2026-08-18", payload({ totals: tokens(0) })))
      .toBeNull();
    expect(store.get("claude", HISTORY_LOCAL_ACCOUNT_KEY, "2026-08-18")).toBeNull();

    store.sealDay("claude", HISTORY_LOCAL_ACCOUNT_KEY, "2026-08-18", payload({
      status: "partial",
      totals: tokens(10),
      error: { code: "analytics_partial", message: "truncated", retryable: true }
    }));
    store.sealDay("claude", HISTORY_LOCAL_ACCOUNT_KEY, "2026-08-18", payload({
      status: "available",
      totals: tokens(25)
    }));
    expect(store.get("claude", HISTORY_LOCAL_ACCOUNT_KEY, "2026-08-18")?.payload.totals.totalTokens).toBe(25);
    expect(store.get("claude", HISTORY_LOCAL_ACCOUNT_KEY, "2026-08-18")?.payload.status).toBe("available");

    store.sealDay("claude", HISTORY_LOCAL_ACCOUNT_KEY, "2026-08-18", payload({ totals: tokens(0) }));
    expect(store.get("claude", HISTORY_LOCAL_ACCOUNT_KEY, "2026-08-18")?.payload.totals.totalTokens).toBe(25);
    store.close();
  });
});

describe("EngineService history integration", () => {
  it("serves sealed history when a later refresh fails", async () => {
    const store = new MemoryHistoryStore();
    const day = "2026-08-18";
    store.sealDay("fixture", "local", day, payload({ totals: tokens(500) }));
    let fail = false;
    const provider: ProviderAdapter = {
      id: "fixture",
      name: "Fixture",
      refresh: vi.fn(async () => {
        if (fail) throw new ProviderError("refresh_failed", "Provider offline.", true);
        return {
          source: "fixture",
          windows: [{ kind: "session", label: "Session", usedPercent: 10, remainingPercent: 90 }],
          identity: { plan: "pro" },
          credits: null,
          analytics: analyticsFixture("2026-08-19", tokens(20)),
          error: null,
          updatedAt: "2026-08-19T12:00:00.000Z",
          accountKey: "local"
        };
      })
    };
    const now = new Date("2026-08-19T12:00:00.000Z");
    const engine = new EngineService([provider], () => now, store);
    const first = await engine.handle({ id: "1", method: "snapshot.get", params: { force: true } });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstSnapshot = validateDashboard(first.result);
    expect(firstSnapshot.providers[0]?.analytics?.daily.some((entry) => entry.date === day)).toBe(true);

    fail = true;
    const second = await engine.handle({ id: "2", method: "snapshot.get", params: { force: true } });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondSnapshot = validateDashboard(second.result);
    expect(secondSnapshot.providers[0]?.error?.code).toBe("refresh_failed");
    expect(secondSnapshot.providers[0]?.analytics?.daily.find((entry) => entry.date === day)?.totalTokens)
      .toBe(500);
  });

  it("does not let account B overwrite account A sealed days", async () => {
    const store = new MemoryHistoryStore();
    store.sealDay("fixture", "user-a", "2026-08-18", payload({
      accountKey: "user-a",
      totals: tokens(111)
    }));
    const provider: ProviderAdapter = {
      id: "fixture",
      name: "Fixture",
      refresh: vi.fn(async () => ({
        source: "fixture",
        windows: [],
        identity: null,
        credits: null,
        analytics: analyticsFixture("2026-08-19", tokens(9), undefined, ["2026-08-18", "2026-08-19"]),
        error: null,
        updatedAt: "2026-08-19T12:00:00.000Z",
        accountKey: "user-b"
      }))
    };
    const engine = new EngineService([provider], () => new Date("2026-08-19T12:00:00.000Z"), store);
    await engine.handle({ id: "1", method: "snapshot.get", params: { force: true } });
    expect(store.get("fixture", "user-a", "2026-08-18")?.payload.totals.totalTokens).toBe(111);
    expect(store.get("fixture", "user-b", "2026-08-18")?.payload.totals.totalTokens).toBe(9);
    const composed = composeProviderAnalytics({
      now: new Date("2026-08-19T12:00:00.000Z"),
      stored: store.getRange("fixture", "2026-08-18", "2026-08-19"),
      liveToday: analyticsFixture("2026-08-19", tokens(9)),
      currentAccountKey: "user-b",
      historyDays: 7
    });
    expect(composed.daily.find((entry) => entry.date === "2026-08-18")?.totalTokens).toBe(120);
  });

  it("seals yesterday from a draft when the clock rolls to a new local day", () => {
    const store = new MemoryHistoryStore();
    const yesterday = "2026-08-18";
    store.upsertDraft("claude", "local", yesterday, payload({
      totals: tokens(77),
      windows: [{ kind: "session", label: "5-hour", usedPercent: 40, remainingPercent: 60 }]
    }));
    const live = {
      source: "oauth",
      windows: [{ kind: "session", label: "5-hour", usedPercent: 12, remainingPercent: 88 }],
      identity: { plan: "max" },
      credits: null,
      analytics: analyticsFixture("2026-08-19", tokens(5)),
      error: null,
      updatedAt: "2026-08-19T08:00:00.000Z"
    };
    persistProviderHistory({
      store,
      providerId: "claude",
      accountKey: "local",
      now: new Date("2026-08-19T08:00:00.000Z"),
      live
    });
    expect(store.get("claude", "local", yesterday)?.sealed).toBe(true);
    expect(store.get("claude", "local", yesterday)?.payload.totals.totalTokens).toBe(77);
    expect(store.get("claude", "local", "2026-08-19")?.sealed).toBe(false);
  });

  it("keeps live project and session breakdowns when composing a 90-day snapshot", () => {
    const store = new MemoryHistoryStore();
    store.sealDay("claude", "local", "2026-08-18", payload({ totals: tokens(40) }));
    const live = analyticsFixture("2026-08-19", tokens(20));
    live.projects = [{
      id: "proj",
      label: "proj",
      path: "/tmp/proj",
      modelIDs: ["opus"],
      ...tokens(20)
    }];
    live.sessions = [{
      id: "sess",
      label: "sess",
      lastActivity: "2026-08-19T12:00:00.000Z",
      project: "proj",
      modelIDs: ["opus"],
      ...tokens(20)
    }];
    const composed = persistProviderHistory({
      store,
      providerId: "claude",
      accountKey: "local",
      now: new Date("2026-08-19T12:00:00.000Z"),
      live: {
        source: "local_sessions",
        windows: [],
        identity: null,
        credits: null,
        analytics: live,
        error: null,
        updatedAt: "2026-08-19T12:00:00.000Z"
      }
    });
    expect(HISTORY_SNAPSHOT_DAYS).toBe(90);
    expect(composed?.historyDays).toBe(90);
    expect(composed?.daily.length).toBeLessThanOrEqual(90);
    expect(composed?.projects).toEqual([expect.objectContaining({ id: "proj", totalTokens: 20 })]);
    expect(composed?.sessions).toEqual([expect.objectContaining({ id: "sess", totalTokens: 20 })]);
  });

  it("does not seal empty Cursor coverage-start days and shrinks lookback after a past day is sealed", () => {
    const store = new MemoryHistoryStore();
    const today = "2026-08-19";
    const live = analyticsFixture(today, tokens(30));
    live.coverageStart = "2026-05-22";
    live.historyDays = 90;
    persistProviderHistory({
      store,
      providerId: "cursor",
      accountKey: "user-a",
      now: new Date("2026-08-19T12:00:00.000Z"),
      live: {
        source: "cursor_app",
        windows: [],
        identity: null,
        credits: null,
        analytics: live,
        error: null,
        updatedAt: "2026-08-19T12:00:00.000Z"
      }
    });
    expect(store.get("cursor", "user-a", "2026-05-22")).toBeNull();
    expect(historyDaysForAccount(store, "cursor", "user-a", new Date("2026-08-19T12:00:00.000Z"))).toBe(90);

    store.sealDay("cursor", "user-a", "2026-08-18", payload({ accountKey: "user-a", totals: tokens(30) }));
    expect(historyDaysForAccount(store, "cursor", "user-a", new Date("2026-08-19T12:00:00.000Z"))).toBe(1);
    expect(historyDaysForAccount(store, "claude", HISTORY_LOCAL_ACCOUNT_KEY, new Date("2026-08-19T12:00:00.000Z")))
      .toBe(90);
  });

  it("does not clobber a good today draft when analytics returns no_data", () => {
    const store = new MemoryHistoryStore();
    const today = "2026-08-19";
    store.upsertDraft("claude", "local", today, payload({
      totals: tokens(88),
      windows: [{ kind: "session", label: "5-hour", usedPercent: 40, remainingPercent: 60 }]
    }));
    persistProviderHistory({
      store,
      providerId: "claude",
      accountKey: "local",
      now: new Date("2026-08-19T12:00:00.000Z"),
      live: {
        source: "oauth",
        windows: [],
        identity: null,
        credits: null,
        analytics: {
          ...analyticsFixture(today, tokens(0)),
          status: "no_data",
          daily: [],
          hourly: [],
          dailyModels: []
        },
        error: { code: "analytics_unavailable", message: "empty", retryable: true },
        updatedAt: "2026-08-19T12:00:00.000Z"
      }
    });
    const draft = store.get("claude", "local", today);
    expect(draft?.payload.totals.totalTokens).toBe(88);
    expect(draft?.payload.windows[0]?.usedPercent).toBe(40);
  });

  it("does not let an empty available scan hide a non-empty today draft", () => {
    const store = new MemoryHistoryStore();
    const today = "2026-08-19";
    store.upsertDraft("claude", "local", today, payload({ totals: tokens(88) }));
    const live = analyticsFixture(today, tokens(0));
    live.daily = [];
    live.hourly = [];
    live.dailyModels = [];
    const composed = persistProviderHistory({
      store,
      providerId: "claude",
      accountKey: "local",
      now: new Date("2026-08-19T12:00:00.000Z"),
      live: {
        source: "local_sessions",
        windows: [],
        identity: null,
        credits: null,
        analytics: live,
        error: null,
        updatedAt: "2026-08-19T12:00:00.000Z"
      }
    });
    expect(store.get("claude", "local", today)?.payload.totals.totalTokens).toBe(88);
    expect(composed?.today.totalTokens).toBe(88);
  });

  it("keeps last quota windows when a refresh returns an error and empty meters", async () => {
    const store = new MemoryHistoryStore();
    const provider: ProviderAdapter = {
      id: "fixture",
      name: "Fixture",
      refresh: vi.fn(async () => ({
        source: "oauth",
        windows: [],
        identity: null,
        credits: null,
        analytics: analyticsFixture("2026-08-19", tokens(12)),
        error: { code: "refresh_failed", message: "quota failed", retryable: true },
        updatedAt: "2026-08-19T12:00:00.000Z",
        accountKey: "local"
      }))
    };
    store.upsertDraft("fixture", "local", "2026-08-19", payload({
      totals: tokens(12),
      windows: [{ kind: "session", label: "5-hour", usedPercent: 55, remainingPercent: 45 }]
    }));
    const engine = new EngineService([provider], () => new Date("2026-08-19T12:00:00.000Z"), store);
    const response = await engine.handle({ id: "1", method: "snapshot.get", params: { force: true } });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const snapshot = validateDashboard(response.result);
    expect(snapshot.providers[0]?.windows[0]?.usedPercent).toBe(55);
    expect(snapshot.providers[0]?.analytics?.today.totalTokens).toBe(12);
  });

  it("lets a later complete scan replace a sealed partial day", () => {
    const store = new MemoryHistoryStore();
    store.sealDay("claude", "local", "2026-08-18", payload({
      status: "partial",
      totals: tokens(10),
      error: { code: "analytics_partial", message: "truncated", retryable: true }
    }));
    persistProviderHistory({
      store,
      providerId: "claude",
      accountKey: "local",
      now: new Date("2026-08-19T12:00:00.000Z"),
      live: {
        source: "local_sessions",
        windows: [],
        identity: null,
        credits: null,
        analytics: analyticsFixture("2026-08-19", tokens(5), undefined, ["2026-08-18", "2026-08-19"]),
        error: null,
        updatedAt: "2026-08-19T12:00:00.000Z"
      }
    });
    expect(store.get("claude", "local", "2026-08-18")?.payload.totals.totalTokens).toBe(5);
    expect(store.get("claude", "local", "2026-08-18")?.payload.status).toBe("available");
  });

  it("uses the newest today draft for quota meters when refresh throws", async () => {
    const store = new MemoryHistoryStore();
    store.upsertDraft("fixture", "user-a", "2026-08-19", payload({
      accountKey: "user-a",
      windows: [{ kind: "plan", label: "Plan", usedPercent: 10, remainingPercent: 90 }]
    }));
    store.upsertDraft("fixture", "user-b", "2026-08-19", payload({
      accountKey: "user-b",
      windows: [{ kind: "plan", label: "Plan", usedPercent: 80, remainingPercent: 20 }]
    }));
    const provider: ProviderAdapter = {
      id: "fixture",
      name: "Fixture",
      refresh: vi.fn(async () => {
        throw new ProviderError("refresh_failed", "offline", true);
      })
    };
    const engine = new EngineService([provider], () => new Date("2026-08-19T12:00:00.000Z"), store);
    const response = await engine.handle({ id: "1", method: "snapshot.get", params: { force: true } });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const snapshot = validateDashboard(response.result);
    expect(snapshot.providers[0]?.windows[0]?.usedPercent).toBe(80);
  });

  it("keeps yesterday's sealed quota meters when a new-day refresh throws", async () => {
    const store = new MemoryHistoryStore();
    store.sealDay("fixture", "local", "2026-08-18", payload({
      totals: tokens(40),
      identity: { plan: "max" },
      windows: [{ kind: "session", label: "5-hour", usedPercent: 40, remainingPercent: 60 }]
    }));
    const provider: ProviderAdapter = {
      id: "fixture",
      name: "Fixture",
      refresh: vi.fn(async () => {
        throw new ProviderError("refresh_failed", "Provider offline.", true);
      })
    };
    const engine = new EngineService([provider], () => new Date("2026-08-19T08:00:00.000Z"), store);
    const response = await engine.handle({ id: "1", method: "snapshot.get", params: { force: true } });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const snapshot = validateDashboard(response.result);
    expect(snapshot.providers[0]?.error?.code).toBe("refresh_failed");
    expect(snapshot.providers[0]?.windows[0]?.usedPercent).toBe(40);
    expect(snapshot.providers[0]?.identity?.plan).toBe("max");
    expect(snapshot.providers[0]?.analytics?.daily.find((entry) => entry.date === "2026-08-18")?.totalTokens)
      .toBe(40);
  });

  it("keeps in-memory quota meters when an overnight refresh throws", async () => {
    const store = new MemoryHistoryStore();
    let now = new Date("2026-08-18T22:00:00.000Z");
    let fail = false;
    const provider: ProviderAdapter = {
      id: "fixture",
      name: "Fixture",
      refresh: vi.fn(async () => {
        if (fail) throw new ProviderError("refresh_failed", "Provider offline.", true);
        return {
          source: "oauth",
          windows: [{ kind: "session", label: "5-hour", usedPercent: 22, remainingPercent: 78 }],
          identity: { plan: "pro" },
          credits: null,
          analytics: analyticsFixture("2026-08-18", tokens(15)),
          error: null,
          updatedAt: "2026-08-18T22:00:00.000Z",
          accountKey: "local"
        };
      })
    };
    const engine = new EngineService([provider], () => now, store);
    await engine.handle({ id: "1", method: "snapshot.get", params: { force: true } });
    fail = true;
    now = new Date("2026-08-19T08:00:00.000Z");
    const response = await engine.handle({ id: "2", method: "snapshot.get", params: { force: true } });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const snapshot = validateDashboard(response.result);
    expect(snapshot.providers[0]?.error?.code).toBe("refresh_failed");
    expect(snapshot.providers[0]?.windows[0]?.usedPercent).toBe(22);
    expect(snapshot.providers[0]?.identity?.plan).toBe("pro");
  });

  it("still serves a live snapshot when history persist throws", async () => {
    const store = new PersistFailStore();
    const provider: ProviderAdapter = {
      id: "fixture",
      name: "Fixture",
      refresh: vi.fn(async () => ({
        source: "oauth",
        windows: [{ kind: "session", label: "5-hour", usedPercent: 33, remainingPercent: 67 }],
        identity: { plan: "pro" },
        credits: { remaining: 12, unit: "USD" },
        analytics: analyticsFixture("2026-08-19", tokens(18)),
        error: null,
        updatedAt: "2026-08-19T12:00:00.000Z",
        accountKey: "local"
      }))
    };
    const engine = new EngineService([provider], () => new Date("2026-08-19T12:00:00.000Z"), store);
    const response = await engine.handle({ id: "1", method: "snapshot.get", params: { force: true } });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const snapshot = validateDashboard(response.result);
    expect(snapshot.providers[0]?.error).toBeNull();
    expect(snapshot.providers[0]?.windows[0]?.usedPercent).toBe(33);
    expect(snapshot.providers[0]?.identity?.plan).toBe("pro");
    expect(snapshot.providers[0]?.analytics?.today.totalTokens).toBe(18);
  });

  it("does not double-count coverage-wide projects sealed on past days", () => {
    const store = new MemoryHistoryStore();
    const project = {
      id: "proj",
      label: "proj",
      path: "/tmp/proj",
      modelIDs: ["opus"],
      ...tokens(20)
    };
    store.sealDay("claude", "local", "2026-08-18", payload({
      totals: tokens(20),
      projects: [project]
    }));
    store.sealDay("claude", "local", "2026-08-19", payload({
      totals: tokens(20),
      projects: [{ ...project, ...tokens(20) }]
    }));
    const composed = composeProviderAnalytics({
      now: new Date("2026-08-19T12:00:00.000Z"),
      stored: store.getRange("claude", "2026-08-18", "2026-08-19"),
      liveToday: null,
      currentAccountKey: "local",
      historyDays: 7
    });
    expect(composed.projects).toEqual([expect.objectContaining({ id: "proj", totalTokens: 20 })]);
  });

  it("skips corrupt sqlite payloads without dropping neighboring days", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "usageatlas-history-"));
    directories.push(directory);
    const databasePath = path.join(directory, "history.sqlite");
    const store = SqliteHistoryStore.open(databasePath);
    store.sealDay("claude", HISTORY_LOCAL_ACCOUNT_KEY, "2026-08-18", payload({ totals: tokens(25) }));
    store.close();

    const database = openWritableSqlite(databasePath);
    database.run(
      `INSERT INTO history_day (
         id, provider_id, account_key, local_day, sealed, change_seq, updated_at, payload_version, payload
       ) VALUES (?, ?, ?, ?, 1, 99, ?, 1, ?)`,
      [
        "corrupt-row",
        "claude",
        HISTORY_LOCAL_ACCOUNT_KEY,
        "2026-08-17",
        "2026-08-19T00:00:00.000Z",
        "{not-json"
      ]
    );
    database.close();

    const reopened = SqliteHistoryStore.open(databasePath);
    expect(reopened.get("claude", HISTORY_LOCAL_ACCOUNT_KEY, "2026-08-17")).toBeNull();
    expect(reopened.get("claude", HISTORY_LOCAL_ACCOUNT_KEY, "2026-08-18")?.payload.totals.totalTokens).toBe(25);
    expect(reopened.getRange("claude", "2026-08-17", "2026-08-18")).toHaveLength(1);
    reopened.close();
  });
});

class PersistFailStore extends MemoryHistoryStore implements HistoryStore {
  override upsertDraft(): never {
    throw new Error("disk full");
  }

  override sealDay(): never {
    throw new Error("disk full");
  }
}

function tokens(totalTokens: number): UsageTotals {
  return {
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    totalTokens,
    requests: totalTokens > 0 ? 1 : 0,
    estimatedCostUSD: totalTokens > 0 ? totalTokens / 1_000_000 : null,
    unpricedTokens: 0
  };
}

function payload(overrides: Partial<HistoryDayPayload> = {}): HistoryDayPayload {
  return {
    payloadVersion: HISTORY_DAY_PAYLOAD_VERSION,
    accountKey: HISTORY_LOCAL_ACCOUNT_KEY,
    windows: [],
    identity: null,
    credits: null,
    source: "fixture",
    capturedAt: "2026-08-19T00:00:00.000Z",
    status: "available",
    analyticsSource: "local_sessions",
    totals: tokens(0),
    hourly: [],
    models: [],
    projects: [],
    sessions: [],
    serviceTiers: [],
    filesScanned: 0,
    recordsProcessed: 0,
    error: null,
    ...overrides
  };
}

function analyticsFixture(
  today: string,
  todayTotals: UsageTotals,
  hourly?: LocalUsageAnalytics["hourly"],
  extraDays: string[] = [today]
): LocalUsageAnalytics {
  const days = [...new Set(extraDays)].sort();
  return {
    status: "available",
    source: "local_sessions",
    historyDays: days.length,
    coverageStart: days[0] ?? today,
    coverageEnd: days.at(-1) ?? today,
    updatedAt: `${today}T12:00:00.000Z`,
    filesScanned: 1,
    recordsProcessed: 1,
    totals: sumDays(days, todayTotals),
    today: todayTotals,
    daily: days.map((date) => ({
      date,
      ...(date === today ? todayTotals : tokens(todayTotals.totalTokens))
    })),
    hourly: hourly ?? [{ date: today, hour: 12, ...todayTotals }],
    models: [],
    dailyModels: days.map((date) => ({
      date,
      id: "model",
      label: "model",
      ...(date === today ? todayTotals : tokens(todayTotals.totalTokens))
    })),
    projects: [],
    sessions: [],
    serviceTiers: [],
    error: null
  };
}

function sumDays(days: string[], todayTotals: UsageTotals): UsageTotals {
  return days.reduce(
    (total, day) => {
      const entry = day === days.at(-1) ? todayTotals : tokens(todayTotals.totalTokens);
      return {
        inputTokens: total.inputTokens + entry.inputTokens,
        cachedInputTokens: total.cachedInputTokens + entry.cachedInputTokens,
        cacheCreationInputTokens: total.cacheCreationInputTokens + entry.cacheCreationInputTokens,
        outputTokens: total.outputTokens + entry.outputTokens,
        totalTokens: total.totalTokens + entry.totalTokens,
        requests: total.requests + entry.requests,
        estimatedCostUSD: (total.estimatedCostUSD ?? 0) + (entry.estimatedCostUSD ?? 0),
        unpricedTokens: total.unpricedTokens + entry.unpricedTokens
      };
    },
    tokens(0)
  );
}
