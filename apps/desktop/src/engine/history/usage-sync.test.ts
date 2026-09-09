import { afterEach, describe, expect, it, vi } from "vitest";
import { openWritableSqlite } from "../platform/sqlite";
import { UsageStore } from "./usage-store";
import { UsageSync, type UsageCloud } from "./usage-sync";
import { sameUsage, validateUsageRecord, type UsageDay, type CloudRecord } from "@usageatlas/contracts/usage";
import fixtures from "@usageatlas/contracts/fixtures/usage-record-v1.json";

const HOUR = 3_600_000;
const resources: Array<() => void> = [];
afterEach(() => {
  for (const close of resources.splice(0).reverse()) close();
  vi.useRealTimers();
});
function store() {
  const db = openWritableSqlite(":memory:");
  resources.push(() => db.close());
  return new UsageStore(db);
}
function day(tokens = 100): UsageDay {
  const record = structuredClone(fixtures[0]) as UsageDay;
  record.hourly = null;
  record.models = null;
  record.totals = {
    inputTokens: tokens,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    totalTokens: tokens,
    requests: tokens ? 1 : 0,
    estimatedCostMicrosUSD: null,
    unpricedTokens: tokens
  };
  return validateUsageRecord(record) as UsageDay;
}
function remoteCloud(): UsageCloud & { rows: Map<string, CloudRecord>; saves: number } {
  return {
    rows: new Map(),
    saves: 0,
    async read() {
      return { records: [...this.rows.values()], next: null };
    },
    async save(records) {
      this.saves += 1;
      return records.map((sent) => {
        const existing = this.rows.get(sent.record.recordId);
        if (existing && sameUsage(existing.record, sent.record))
          return { ...existing, status: "saved" as const };
        if (existing && existing.revision !== sent.revision)
          return { ...existing, status: "conflict" as const };
        const saved = { record: structuredClone(sent.record), revision: (existing?.revision ?? 0) + 1 };
        this.rows.set(saved.record.recordId, saved);
        return { ...saved, status: "saved" as const };
      });
    }
  };
}
function sync(local: UsageStore) {
  const service = new UsageSync(local);
  resources.push(() => service.close());
  return service;
}

describe("usage cloud storage", () => {
  it("restores over a corrupt payload and keeps damaged conflicts out of status", async () => {
    const local = store();
    local.selectAccount("a");
    local.put(day());
    local.db.run("UPDATE usage_record SET payload = 'null' WHERE id = ?", [day().recordId]);
    const cloud = remoteCloud();
    cloud.rows.set(day().recordId, { record: day(200), revision: 1 });
    const service = sync(local);
    await service.configure("a", cloud);
    service.setAutomatic(false);
    await service.restore();
    expect(local.get(day().recordId)?.record).toMatchObject({ totals: { totalTokens: 200 } });
    local.put(day(300));
    local.db.run("UPDATE usage_record SET conflict = '{not-json' WHERE id = ?", [day().recordId]);
    expect(service.status()).toMatchObject({ conflicts: [], pending: 1 });
    expect(service.status().error).toContain("1 invalid local usage record was skipped");
    const healthy = { ...day(), recordId: "ffffffff-ffff-4fff-8fff-ffffffffffff", localDay: "2026-09-06" };
    local.put(healthy);
    await service.save();
    expect(cloud.rows.has(healthy.recordId)).toBe(true);
    local.put(day(400));
    await service.save();
    expect(cloud.rows.get(day().recordId)?.record).toMatchObject({ totals: { totalTokens: 400 } });
    expect(service.status()).toMatchObject({ pending: 0, error: null });
  });

  it.each(["", "a"])("saves healthy records past a corrupt batch owned by '%s' and resumes repaired records", async (owner) => {
    vi.useFakeTimers();
    const local = store();
    local.selectAccount(owner);
    local.put(day());
    const ids = Array.from({ length: 26 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    for (const [index, id] of ids.entries()) {
      const payload = index % 2 ? JSON.stringify({ ...day(), recordId: id, privatePath: "secret" }) : "{not-json";
      local.db.run("INSERT INTO usage_record (owner, id, provider, day, payload) VALUES (?, ?, 'codex', '2026-09-05', ?)", [owner, id, payload]);
    }
    const cloud = remoteCloud();
    const read = vi.spyOn(cloud, "read");
    const service = sync(local);
    await service.configure("a", cloud);
    await service.save();
    expect(cloud.rows.size).toBe(1);
    expect(local.pending()).toEqual([]);
    expect(local.db.get("SELECT payload FROM usage_record WHERE owner = ? AND id = ?", [owner, ids[0]])?.payload).toBe("{not-json");
    expect(service.status()).toMatchObject({ pending: 26, lastCompleted: "save" });
    expect(service.status().error).toContain("26 invalid local usage records were skipped");
    service.close();
    const reopened = new UsageStore(local.db);
    const resumed = sync(reopened);
    await resumed.configure("a", cloud);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(read).toHaveBeenCalledTimes(1);
    expect(cloud.saves).toBe(1);
    reopened.put({ ...day(200), recordId: ids[0], localDay: "2026-09-04" }, null, owner);
    reopened.onChange?.();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(cloud.rows.get(ids[0])?.record).toMatchObject({ totals: { totalTokens: 200 } });
    expect(resumed.status().error).toContain("25 invalid local usage records were skipped");
  });

  it("adds the save-error flag without changing existing records or checkpoints", () => {
    const local = store();
    local.selectAccount("a");
    const record = local.put(day());
    local.acknowledge(record, { record: record.record, revision: 1 });
    local.put(day(200));
    const pending = local.pending();
    local.db.exec("ALTER TABLE usage_record DROP COLUMN save_error");
    const reopened = new UsageStore(local.db);
    expect(reopened.owner).toBe("a");
    expect(reopened.pending()).toEqual(pending);
  });

  it("defaults to hourly automatic save after sign-in and waits an hour before retrying", async () => {
    vi.useFakeTimers();
    const local = store();
    local.put(day());
    const cloud = remoteCloud();
    const save = cloud.save.bind(cloud);
    let offline = true;
    cloud.save = async (rows) => {
      if (offline) {
        offline = false;
        throw new Error("offline");
      }
      return save(rows);
    };
    const service = sync(local);
    expect(service.status().automatic).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(cloud.saves).toBe(0);
    await service.configure("a", cloud);
    expect(service.status().automatic).toBe(true);
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(cloud.saves).toBe(0);
    expect(service.status().error).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(service.status().error).toBe("offline");
    local.put(day(200));
    local.onChange?.();
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(cloud.saves).toBe(0);
    expect(service.status().pending).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(cloud.saves).toBe(1);
    expect(cloud.rows.get(day().recordId)?.record).toMatchObject({ totals: { totalTokens: 200 } });
    expect(local.pending()).toEqual([]);
    service.setAutomatic(false);
    local.put(day(300));
    local.onChange?.();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(cloud.saves).toBe(1);
  });

  it("persists the switch per account and resumes pending saves when switched on", async () => {
    vi.useFakeTimers();
    const local = store();
    const cloud = remoteCloud();
    const service = sync(local);
    await service.configure("a", cloud);
    service.setAutomatic(false);
    local.put(day());
    local.onChange?.();
    await service.configure("", null);
    await service.configure("a", cloud);
    expect(service.status().automatic).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(cloud.saves).toBe(0);
    service.setAutomatic(true);
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(cloud.saves).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(cloud.saves).toBe(1);
    local.put(day(200));
    local.onChange?.();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(cloud.saves).toBe(2);
    await service.configure("b", cloud);
    expect(service.status().automatic).toBe(true);
    service.setAutomatic(false);
    await service.configure("a", cloud);
    expect(service.status().automatic).toBe(true);
  });
  it("cancels a queued automatic save when the switch is turned off", async () => {
    vi.useFakeTimers();
    const local = store();
    local.put(day());
    const cloud = remoteCloud();
    const service = sync(local);
    await service.configure("a", cloud);
    await vi.advanceTimersByTimeAsync(1_000);
    service.setAutomatic(false);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(cloud.saves).toBe(0);
    expect(service.status().pending).toBe(1);
  });
  it("does not carry a retry timer into another account with automatic save off", async () => {
    vi.useFakeTimers();
    const local = store();
    local.selectAccount("b");
    local.put(day(200));
    local.setSetting("automatic:b", "0");
    local.selectAccount("a");
    local.put(day());
    const cloud = remoteCloud();
    let fail!: () => void;
    cloud.read = () => new Promise((_resolve, reject) => { fail = () => reject(new Error("offline")); });
    const service = sync(local);
    await service.configure("a", cloud);
    const saving = service.save().catch(() => undefined);
    const nextCloud = remoteCloud();
    const switching = service.configure("b", nextCloud);
    fail();
    await Promise.all([saving, switching]);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(service.status().automatic).toBe(false);
    expect(nextCloud.saves).toBe(0);
  });
  it("skips automatic requests when nothing needs saving", async () => {
    vi.useFakeTimers();
    const local = store();
    const cloud = remoteCloud();
    const read = vi.spyOn(cloud, "read");
    const service = sync(local);
    await service.configure("a", cloud);
    local.onChange?.();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(read).not.toHaveBeenCalled();
    expect(cloud.saves).toBe(0);
  });

  it("batches frequent local updates into hourly uploads without postponing them", async () => {
    vi.useFakeTimers();
    const local = store();
    const cloud = remoteCloud();
    const read = vi.spyOn(cloud, "read");
    const service = sync(local);
    await service.configure("a", cloud);
    local.put(day());
    local.onChange?.();
    for (let update = 1; update <= 19; update += 1) {
      await vi.advanceTimersByTimeAsync(180_000);
      local.put(day(100 + update));
      local.onChange?.();
      expect(cloud.saves).toBe(0);
    }
    await vi.advanceTimersByTimeAsync(180_000 - 1);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(cloud.saves).toBe(1);
    expect(cloud.rows.get(day().recordId)?.record).toMatchObject({ totals: { totalTokens: 119 } });
    expect(local.pending()).toEqual([]);
    local.put(day(200));
    local.onChange?.();
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(cloud.saves).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(cloud.saves).toBe(2);
    expect(cloud.rows.get(day().recordId)?.record).toMatchObject({ totals: { totalTokens: 200 } });
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(cloud.saves).toBe(2);
  });

  it("saves immediately on manual request and cancels the earlier automatic timer", async () => {
    vi.useFakeTimers();
    const local = store();
    local.put(day());
    const cloud = remoteCloud();
    const service = sync(local);
    await service.configure("a", cloud);
    await vi.advanceTimersByTimeAsync(HOUR / 2);
    await service.save();
    expect(cloud.saves).toBe(1);
    local.put(day(200));
    local.onChange?.();
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(cloud.saves).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(cloud.saves).toBe(2);
  });

  it("does not dirty unchanged observations", () => {
    const local = store();
    const first = local.put(day());
    local.put({ ...day(), observedAt: "2026-09-05T12:00:00Z" });
    expect(local.get(first.record.recordId)?.localVersion).toBe(1);
  });
  it("preserves newer changes when an older save is acknowledged", () => {
    const local = store();
    const sent = local.put(day());
    local.put(day(200));
    local.acknowledge(sent, { record: sent.record, revision: 1 });
    expect(local.pending()[0].record).toMatchObject({ totals: { totalTokens: 200 } });
    expect(local.pending()[0].revision).toBe(1);
  });
  it("restores without generating uploads and accepts downward corrections", () => {
    const local = store();
    local.merge({ record: day(200), revision: 1 });
    expect(local.pending()).toEqual([]);
    local.merge({ record: day(50), revision: 2 });
    expect(local.get(day().recordId)?.record).toMatchObject({ totals: { totalTokens: 50 } });
    expect(local.pending()).toEqual([]);
  });
  it("keeps both changes in a conflict and uses its revision after choosing local", () => {
    const local = store();
    local.merge({ record: day(), revision: 1 });
    local.put(day(200));
    local.merge({ record: day(300), revision: 2 });
    expect(local.pending()).toEqual([]);
    expect(local.get(day().recordId)?.conflict?.record).toMatchObject({ totals: { totalTokens: 300 } });
    local.resolve(day().recordId, "local");
    expect(local.pending()[0]).toMatchObject({ revision: 2, record: { totals: { totalTokens: 200 } } });
  });
  it("keeps downloaded records and checkpoints isolated by account", () => {
    const local = store();
    local.selectAccount("a");
    local.merge({ record: day(), revision: 1 });
    local.selectAccount("b");
    expect(local.records()).toEqual([]);
    expect(local.pending()).toEqual([]);
    local.put(day(50));
    local.selectAccount("a");
    expect(local.get(day().recordId)?.record).toMatchObject({ totals: { totalTokens: 100 } });
    expect(local.pending()).toEqual([]);
  });
  it("supports manual save and restore with automatic saving turned off", async () => {
    const local = store();
    local.put(day());
    const cloud = remoteCloud();
    const service = sync(local);
    await service.configure("a", cloud);
    service.setAutomatic(false);
    expect(cloud.saves).toBe(0);
    expect(service.status().pending).toBe(1);
    await service.restore();
    expect(cloud.saves).toBe(0);
    await service.save();
    expect(cloud.rows.size).toBe(1);
    expect(local.pending()).toEqual([]);
    local.selectAccount("b");
    expect(local.records()).toEqual([]);
  });
  it("merges cloud-only days on a new device without uploading them again", async () => {
    const cloud = remoteCloud();
    cloud.rows.set(day().recordId, { record: day(), revision: 3 });
    const local = store();
    const service = sync(local);
    await service.configure("a", cloud);
    await service.save();
    expect(cloud.saves).toBe(0);
    expect(local.get(day().recordId)?.revision).toBe(3);
  });
  it("does not overwrite restored cloud data with a local copy collected before restore", async () => {
    const local = store();
    local.put(day(10));
    const cloud = remoteCloud();
    cloud.rows.set(day().recordId, { record: day(100), revision: 1 });
    const service = sync(local);
    await service.configure("a", cloud);
    await service.restore();
    await service.save();
    expect(cloud.saves).toBe(0);
    expect(local.get(day().recordId)?.conflict?.record).toMatchObject({ totals: { totalTokens: 100 } });
    service.resolve(day().recordId, "cloud");
    expect(local.pending()).toEqual([]);
  });
  it("retries after a lost response without duplicate records or revisions", async () => {
    const local = store();
    local.put(day());
    const cloud = remoteCloud();
    const save = cloud.save.bind(cloud);
    let fail = true;
    cloud.save = async (rows) => {
      const result = await save(rows);
      if (fail) {
        fail = false;
        throw new Error("offline");
      }
      return result;
    };
    const service = sync(local);
    await service.configure("a", cloud);
    await expect(service.save()).rejects.toThrow("offline");
    expect(local.pending()).toHaveLength(1);
    await service.save();
    expect(local.pending()).toEqual([]);
    expect(cloud.rows.get(day().recordId)?.revision).toBe(1);
  });
  it("saves a second version collected during the first request", async () => {
    const local = store();
    local.put(day());
    const cloud = remoteCloud();
    const save = cloud.save.bind(cloud);
    cloud.save = async (rows) => {
      const result = await save(rows);
      if (cloud.saves === 1) local.put(day(200));
      return result;
    };
    const service = sync(local);
    await service.configure("a", cloud);
    await service.save();
    expect(cloud.saves).toBe(2);
    expect(cloud.rows.get(day().recordId)?.record).toMatchObject({ totals: { totalTokens: 200 } });
    expect(local.pending()).toEqual([]);
  });
  it("reports batch progress and clears the busy state on completion", async () => {
    const local = store();
    const cloud = remoteCloud();
    const service = sync(local);
    await service.configure("a", cloud);
    for (let index = 0; index < 30; index += 1) {
      local.put({ ...day(), recordId: `11111111-1111-4111-8111-${index.toString().padStart(12, "0")}` });
    }
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const save = cloud.save.bind(cloud);
    cloud.save = async (rows) => {
      if (cloud.saves === 1) await paused;
      return save(rows);
    };
    const pending = service.save();
    expect(service.status()).toMatchObject({ busy: true, progress: { operation: "save", phase: "reading" } });
    await vi.waitFor(() => expect(service.status().progress).toMatchObject({ phase: "saving", completed: 25, total: 30 }));
    release();
    await pending;
    expect(service.status()).toMatchObject({ busy: false, progress: null, lastCompleted: "save", pending: 0, error: null });
    await service.restore();
    expect(service.status()).toMatchObject({ busy: false, progress: null, lastCompleted: "restore" });
  });
  it("ends a save with an error if a cloud response leaves the same record pending", async () => {
    const local = store();
    const cloud = remoteCloud();
    const service = sync(local);
    await service.configure("a", cloud);
    await service.restore();
    local.merge({ record: day(), revision: 1 });
    local.put(day(200));
    const save = vi.fn(async () => [{ record: day(), revision: 1, status: "conflict" as const }]);
    cloud.save = save;
    await expect(service.save()).rejects.toThrow("Cloud save made no progress");
    expect(save).toHaveBeenCalledTimes(1);
    expect(service.status()).toMatchObject({ busy: false, progress: null, lastCompleted: null, pending: 1 });
  });
  it("clears progress after a failed request and allows a successful retry", async () => {
    const local = store();
    local.put(day());
    const cloud = remoteCloud();
    const service = sync(local);
    await service.configure("a", cloud);
    const save = cloud.save.bind(cloud);
    cloud.save = async () => { throw new Error("offline"); };
    await expect(service.save()).rejects.toThrow("offline");
    expect(service.status()).toMatchObject({ busy: false, progress: null, lastCompleted: null, error: "offline" });
    cloud.save = save;
    await service.save();
    expect(service.status()).toMatchObject({ busy: false, progress: null, lastCompleted: "save", error: null });
  });
  it("rejects private fields, invalid totals, and duplicate breakdowns", () => {
    expect(() => validateUsageRecord({ ...day(), path: "/private" })).toThrow();
    expect(() => validateUsageRecord({ ...day(), status: "no_data" })).toThrow();
    expect(() => validateUsageRecord({ ...day(), totals: { ...day().totals, totalTokens: 1 } })).toThrow();
    expect(() =>
      validateUsageRecord({ ...day(), models: [{ modelKey: "private-model", totals: day().totals }] })
    ).toThrow();
  });
});
