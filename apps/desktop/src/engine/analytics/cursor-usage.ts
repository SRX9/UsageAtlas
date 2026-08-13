import type { LocalUsageAnalytics, ProviderFailure } from "@usageatlas/contracts";
import { ProviderError } from "../provider";
import { fetchProviderJson, type FetchImplementation } from "../platform/http";
import { buildAnalytics, unavailableAnalytics, type UsageRecord } from "./local-usage";

export interface CursorUsageHistoryOptions {
  fetch?: FetchImplementation;
  historyDays?: number;
  maxEvents?: number;
  pageSize?: number;
}

interface CursorUsagePage {
  page: number;
  records: UsageRecord[];
  rowCount: number;
  skipped: number;
  totalCount: number | null;
  totalPages: number | null;
}

const DEFAULT_HISTORY_DAYS = 90;
const DEFAULT_MAX_EVENTS = 200_000;
const DEFAULT_PAGE_SIZE = 1_000;
const CURSOR_USAGE_EVENTS_URL = "https://cursor.com/api/dashboard/get-filtered-usage-events";

export async function scanCursorUsageHistory(
  context: { signal: AbortSignal; now: Date },
  headers: Record<string, string>,
  options: CursorUsageHistoryOptions = {}
): Promise<LocalUsageAnalytics> {
  const historyDays = clampInteger(options.historyDays ?? DEFAULT_HISTORY_DAYS, 1, 366);
  try {
    return await fetchCursorUsageHistory(context, headers, { ...options, historyDays });
  } catch (error) {
    if (context.signal.aborted) throw new DOMException("Cursor usage history timed out.", "AbortError");
    return unavailableAnalytics(
      context.now,
      historyDays,
      analyticsFailure(error),
      "remote_usage"
    );
  }
}

export async function fetchCursorUsageHistory(
  context: { signal: AbortSignal; now: Date },
  headers: Record<string, string>,
  options: CursorUsageHistoryOptions = {}
): Promise<LocalUsageAnalytics> {
  context.signal.throwIfAborted();
  const historyDays = clampInteger(options.historyDays ?? DEFAULT_HISTORY_DAYS, 1, 366);
  const maxEvents = clampInteger(options.maxEvents ?? DEFAULT_MAX_EVENTS, 1, 200_000);
  const pageSize = clampInteger(options.pageSize ?? DEFAULT_PAGE_SIZE, 1, 1_000);
  const start = new Date(context.now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (historyDays - 1));
  const requestHeaders = {
    ...headers,
    "Content-Type": "application/json"
  };
  const requestPage = async (page: number): Promise<CursorUsagePage> => {
    const payload = await fetchProviderJson(
      "Cursor",
      CURSOR_USAGE_EVENTS_URL,
      {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          startDate: String(start.valueOf()),
          endDate: String(context.now.valueOf()),
          page,
          pageSize
        }),
        signal: context.signal
      },
      options.fetch
    );
    return parseCursorUsageEventsPage(payload, page);
  };

  const maximumPages = Math.max(1, Math.ceil(maxEvents / pageSize));
  const pages: CursorUsagePage[] = [];
  let expectedTotal: number | null = null;
  let completed = false;
  for (let page = 1; page <= maximumPages; page += 1) {
    context.signal.throwIfAborted();
    const result = await requestPage(page);
    if (result.skipped > 0) throw invalidCursorHistory();
    if (result.totalCount !== null) {
      if (expectedTotal !== null && result.totalCount !== expectedTotal) {
        throw incompleteCursorHistory(expectedTotal, result.totalCount);
      }
      expectedTotal = result.totalCount;
      if (expectedTotal > maxEvents) throw incompleteCursorHistory(expectedTotal, maxEvents);
    }
    pages.push(result);
    if (result.rowCount < pageSize) {
      completed = true;
      break;
    }
  }
  if (!completed) {
    throw incompleteCursorHistory(expectedTotal, pages.reduce((total, page) => total + page.rowCount, 0));
  }
  const records = reconcileCursorPages(pages, expectedTotal);
  const analytics = buildAnalytics(
    records,
    context.now,
    historyDays,
    pages.length,
    false,
    "remote_usage",
    "Cursor dashboard usage history could not be loaded completely.",
    { start: localDay(start), end: localDay(context.now) }
  );
  return { ...analytics, projects: [] };
}

export function parseCursorUsageEventsPage(value: unknown, page: number): CursorUsagePage {
  const root = record(value);
  if (!root) throw invalidCursorHistory();
  const rows = array(root.usageEventsDisplay) ?? array(root.usageEvents);
  if (!rows) throw invalidCursorHistory();
  const records: UsageRecord[] = [];
  let skipped = 0;
  for (const row of rows) {
    const parsed = parseCursorUsageEvent(row);
    if (parsed) records.push(parsed);
    else skipped += 1;
  }
  const pagination = record(root.pagination);
  return {
    page,
    records,
    rowCount: rows.length,
    skipped,
    totalCount: nonNegativeInteger(root.totalUsageEventsCount),
    totalPages: nonNegativeInteger(pagination?.numPages)
  };
}

function parseCursorUsageEvent(value: unknown): UsageRecord | null {
  const root = record(value);
  if (!root) return null;
  const timestamp = timestampString(root.timestamp);
  if (!timestamp) return null;
  const tokenUsage = record(root.tokenUsage);
  const inputTokens = tokenCount(tokenUsage?.inputTokens ?? tokenUsage?.input_tokens);
  const cachedInputTokens = tokenCount(tokenUsage?.cacheReadTokens ?? tokenUsage?.cache_read_tokens);
  const cacheCreationInputTokens = tokenCount(tokenUsage?.cacheWriteTokens ?? tokenUsage?.cache_write_tokens);
  const outputTokens = tokenCount(tokenUsage?.outputTokens ?? tokenUsage?.output_tokens);
  const totalTokens = inputTokens + cachedInputTokens + cacheCreationInputTokens + outputTokens;
  const day = localDay(new Date(timestamp));
  const model = firstText(root.model, root.modelName) ?? "unknown";
  const kind = firstText(root.kind) ?? "unknown";
  const estimatedCostUSD = cursorEventCost(root, tokenUsage);
  return {
    timestamp,
    day,
    model,
    sessionID: `cursor-${day}`,
    projectPath: null,
    projectLabel: "Unknown project",
    serviceTier: cursorEventTier(kind, root.maxMode === true, root.isHeadless === true),
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUSD,
    eventKey: [
      "cursor",
      timestamp,
      model,
      kind,
      inputTokens,
      cachedInputTokens,
      cacheCreationInputTokens,
      outputTokens,
      finiteNumber(tokenUsage?.totalCents) ?? "unpriced",
      finiteNumber(root.requestsCosts) ?? "",
      firstText(root.usageBasedCosts) ?? "",
      root.isTokenBasedCall === true,
      firstText(root.owningUser) ?? "",
      firstText(root.owningTeam) ?? "",
      finiteNumber(root.cursorTokenFee) ?? "",
      root.isChargeable === true,
      root.maxMode === true,
      root.isHeadless === true,
      finiteNumber(root.chargedCents) ?? ""
    ].join("|")
  };
}

function cursorEventCost(
  _root: Record<string, unknown>,
  tokenUsage: Record<string, unknown> | null
): number | null {
  const tokenCents = finiteNumber(tokenUsage?.totalCents);
  return tokenCents === null ? null : tokenCents / 100;
}

function reconcileCursorPages(pages: CursorUsagePage[], expectedTotal: number | null): UsageRecord[] {
  const ordered = [...pages].sort((left, right) => left.page - right.page);
  const rawRecords = ordered.flatMap((page) => page.records);
  if (expectedTotal === null) return rawRecords;
  if (rawRecords.length < expectedTotal) throw incompleteCursorHistory(expectedTotal, rawRecords.length);
  if (rawRecords.length === expectedTotal) return rawRecords;

  let removalsRemaining = rawRecords.length - expectedTotal;
  const reconciled = [...(ordered[0]?.records ?? [])];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]?.records ?? [];
    const current = ordered[index]?.records ?? [];
    const removalCount = Math.min(boundaryOverlap(previous, current), removalsRemaining);
    reconciled.push(...current.slice(removalCount));
    removalsRemaining -= removalCount;
  }
  if (removalsRemaining > 0 || reconciled.length !== expectedTotal) {
    throw incompleteCursorHistory(expectedTotal, rawRecords.length);
  }
  return reconciled;
}

function boundaryOverlap(previous: UsageRecord[], current: UsageRecord[]): number {
  const limit = Math.min(previous.length, current.length);
  for (let count = limit; count > 0; count -= 1) {
    const suffix = previous.slice(previous.length - count);
    const prefix = current.slice(0, count);
    if (suffix.every((record, index) => record.eventKey === prefix[index]?.eventKey)) return count;
  }
  return 0;
}

function cursorEventTier(kind: string, maxMode: boolean, headless: boolean): string {
  const tiers: string[] = [];
  const normalizedKind = kind
    .toLowerCase()
    .replace(/^usage_event_kind_/u, "")
    .replaceAll("_", "-");
  if (normalizedKind && normalizedKind !== "unknown") tiers.push(normalizedKind);
  if (maxMode) tiers.push("max-mode");
  if (headless) tiers.push("background-agent");
  return tiers.join(" + ") || "standard";
}

function analyticsFailure(error: unknown): ProviderFailure {
  if (error instanceof ProviderError) {
    return {
      code: error.code,
      message: error.code === "auth_required"
        ? "Cursor usage history requires a current Cursor desktop sign-in."
        : "Cursor dashboard usage history could not be refreshed.",
      retryable: error.retryable
    };
  }
  return {
    code: "analytics_unavailable",
    message: "Cursor dashboard usage history could not be refreshed.",
    retryable: true
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function array(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function tokenCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function timestampString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return dateISOString(value < 10_000_000_000 ? value * 1_000 : value);
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? dateISOString(numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : dateISOString(value);
}

function dateISOString(value: string | number): string | null {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

function localDay(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function invalidCursorHistory(): ProviderError {
  return new ProviderError("invalid_response", "Cursor returned an invalid usage-history response.");
}

function incompleteCursorHistory(expected: number | null, received: number): ProviderError {
  const expectation = expected === null ? "all reported events" : `${expected} events`;
  return new ProviderError(
    "analytics_unavailable",
    `Cursor usage history was incomplete: expected ${expectation}, received ${received}.`,
    true
  );
}
