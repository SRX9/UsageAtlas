import type { HistoryDayPayload, HistoryDayRecord, UsageTotals } from "@usageatlas/contracts";
import { validateUsageRecord, type UsageDay } from "@usageatlas/contracts/usage";
import { describe, expect, it } from "vitest";
import { emptyUsageTotals } from "./payload";
import { previewModelRecovery, toUsageDay } from "./usage-payload";

function totals(count: number): UsageTotals {
  return { ...emptyUsageTotals(), inputTokens: count, totalTokens: count, requests: 1 };
}
function history(model = "gpt-5.6-sol"): HistoryDayRecord {
  const payload: HistoryDayPayload = {
    payloadVersion: 1, accountKey: "local", capturedAt: "2026-09-20T00:00:00Z",
    status: "available", source: "fixture", analyticsSource: "local_sessions",
    totals: totals(100), models: [{ id: model, label: model, ...totals(100) }],
    hourly: [], windows: [], identity: null, credits: null, projects: [], sessions: [],
    serviceTiers: [], filesScanned: 0, recordsProcessed: 0, error: null,
  };
  return { id: "", providerId: "codex", accountKey: "local", localDay: "2026-09-20",
    sealed: true, changeSeq: 1, updatedAt: payload.capturedAt, payload };
}
function savedOther(row: HistoryDayRecord): UsageDay {
  const record = toUsageDay(row, "replica", "UTC");
  return { ...record, models: [{ modelKey: "other", totals: record.totals! }] };
}

describe("private model preservation", () => {
  it.each(["gpt-5.6-sol", "gpt-6-astra", "claude-opus-5", "cursor-grok-4.6-xhigh", "composer-2.5", "muse-spark-1.3-contributor-free"])("preserves %s through cloud serialization", (model) => {
    const record = toUsageDay(history(model), "replica", "UTC");
    expect(record.models?.[0].modelKey).toBe(model);
    expect(() => validateUsageRecord(record)).not.toThrow();
  });
  it.each(["private-project-name", "gpt-5.6-sol-private-project", "/home/user/private", "unknown"])("retains tool-reported identifier %s in private storage", (model) => {
    const record = toUsageDay(history(model), "replica", "UTC");
    expect(record.models?.[0].modelKey).toBe(model);
  });
  it("previews label recovery without changing its input, totals, dates, or identity", () => {
    const row = history();
    const record = savedOther(row);
    const before = structuredClone(record);
    const recovered = previewModelRecovery(record, row.payload)!;
    expect(recovered.models?.[0].modelKey).toBe("gpt-5.6-sol");
    expect({ ...recovered, models: record.models }).toEqual(record);
    expect(record).toEqual(before);
    expect(previewModelRecovery(recovered, row.payload)).toBeNull();
  });
  it("rejects stale local totals and incomplete model breakdowns", () => {
    const row = history();
    const record = savedOther(row);
    expect(previewModelRecovery(record, { ...row.payload, totals: totals(101) })).toBeNull();
    expect(previewModelRecovery(record, { ...row.payload, models: [{ id: "gpt-5.6-sol", label: "Sol", ...totals(90) }] })).toBeNull();
  });
  it("does not replace already named models with a different breakdown", () => {
    const row = history();
    const record = savedOther(row);
    record.models = [
      { modelKey: "gpt-5.5", totals: { ...record.totals!, inputTokens: 40, totalTokens: 40, requests: 0 } },
      { modelKey: "other", totals: { ...record.totals!, inputTokens: 60, totalTokens: 60 } },
    ];
    expect(previewModelRecovery(record, row.payload)).toBeNull();
  });
  it("recovers the reported unknown label and leaves absent breakdowns unchanged", () => {
    const row = history("unknown");
    const record = savedOther(row);
    expect(previewModelRecovery(record, row.payload)?.models?.[0].modelKey).toBe("unknown");
    expect(previewModelRecovery({ ...record, models: null }, row.payload)).toBeNull();
  });
});
