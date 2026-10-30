import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderAdapter, ProviderContext } from "../provider";
import { buildAnalytics, type UsageRecord } from "../analytics/local-usage";
import { emptyPricingCatalog, type PricingCatalog } from "../analytics/models-dev";
import { estimateSessionCost } from "../analytics/session-source";
import { metric, reading } from "./quota-shared";
import { resolveFreebuffModel } from "./freebuff-models";
import { resolveFreebuffSources, type FreebuffPathOptions, type FreebuffSources } from "./freebuff-paths";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_METRIC_ROWS = 100_000;
const MAX_HISTORY_RECORDS = 20_000;
const RECENT_DAYS = 3;
const MIN_HISTORY_DAYS = 1;
const MAX_HISTORY_DAYS = 366;

export interface FreebuffOptions extends FreebuffPathOptions {
  maxBytes?: number;
  pricingCatalogLoader?: (context: { signal: AbortSignal; now: Date; historyDays?: number }) => Promise<PricingCatalog>;
}

/**
 * Disjoint token categories: `input` excludes `cached`, so the three of them add
 * up to the turn's total. Freebuff reports cached tokens inside its input count,
 * so both are translated at the edge and never stored overlapping — the history
 * contract requires the categories to reconcile with the day's total.
 */
interface TokenTotals {
  input: number;
  cached: number;
  output: number;
  total: number;
}

interface ParsedUsage extends TokenTotals {
  cost: number | null;
}

/** One row of `messages`, optionally joined to the thread that produced it. */
interface MessageRow {
  seq?: unknown;
  thread_id?: unknown;
  ts?: unknown;
  metrics_json?: unknown;
  model?: unknown;
  project_path?: unknown;
  sponsored?: unknown;
}

interface DesktopScan {
  totals: TokenTotals;
  records: UsageRecord[];
  filesScanned: number;
  unreadable: number;
  truncated: boolean;
}

/**
 * Freebuff Desktop stores provider-reported token usage in a per-project SQLite
 * database (`messages.metrics_json`), and the CLI stores per-message `credits`
 * in chat transcripts. Which folders hold them, and whether they moved or
 * changed, is decided by the dynamic route planner in `freebuff-paths`:
 * a working route is saved and reused, and re-planned as soon as it stops
 * verifying.
 *
 * Inside the database, each assistant row carries the delta for that turn:
 *
 *   {"usage":{"inputTokens":100,"cachedInputTokens":40,"outputTokens":20,
 *             "reasoningOutputTokens":0,"totalTokens":120},"costUsd":0}
 *
 * `cachedInputTokens` is a subset of `inputTokens`; `reasoningOutputTokens` is a
 * subset of `outputTokens`. Cached tokens are counted inside input here, so a
 * turn is stored with its non-cached input, its cached input, and its output —
 * the categories the rest of the app sums. The row's thread adds the model, the project it ran
 * in, and whether the turn was sponsored, so the same rows feed both today's
 * counters and the daily history the dashboard charts. The CLI has no such
 * database: it only records `credits`, so tokens are reported when the Desktop
 * database exists and credits otherwise.
 *
 * Freebuff is a subscription: `costUsd` is always 0, and the model is stored as
 * an opaque `m-<digest>` id (`freebuff-models` reverses it). Turns are therefore
 * priced here, at the resolved model's API rates, the same way the other
 * subscription tools are, and the tool's own zero is kept as reported cost.
 */
export function createFreebuffAdapter(options: FreebuffOptions = {}): ProviderAdapter {
  const pathOptions: FreebuffPathOptions = {
    environment: options.environment,
    homeDirectory: options.homeDirectory,
    cacheFile: options.cacheFile,
    maxDatabases: options.maxDatabases,
    maxChatFiles: options.maxChatFiles
  };
  const locate = (now: Date, signal?: AbortSignal, force = false): Promise<FreebuffSources> =>
    resolveFreebuffSources(pathOptions, now, signal, force);
  return {
    id: "freebuff",
    name: "Freebuff",
    isAvailable: async () =>
      locate(new Date()).then(sources => sources.databases.length > 0 || sources.chats.length > 0, () => false),
    async refresh(context) {
      const timeZone = context.reportingTimeZoneForAccount?.("local");
      const today = localDay(context.now.toISOString(), timeZone);
      const historyDays = clampDays(context.historyDaysForAccount?.("local") ?? context.historyDays);
      const historyCutoff = context.now.valueOf() - historyDays * 86_400_000;
      const recentCutoff = context.now.valueOf() - RECENT_DAYS * 86_400_000;

      let sources = await locate(context.now, context.signal);
      let scan = await readDesktopUsage(sources.databases, context.signal, today, timeZone, recentCutoff, historyCutoff);
      if (!scan && sources.route === "cached") {
        // The saved route verified a moment ago but no longer opens (moved,
        // replaced, or locked). Plan a new route and try that one once.
        sources = await locate(context.now, context.signal, true);
        scan = await readDesktopUsage(sources.databases, context.signal, today, timeZone, recentCutoff, historyCutoff);
      }
      if (scan) {
        const catalog = options.pricingCatalogLoader && scan.records.length
          ? await options.pricingCatalogLoader(context).catch(() => emptyPricingCatalog())
          : emptyPricingCatalog();
        for (const record of scan.records) {
          record.estimatedCostUSD = estimateSessionCost(record, catalog);
          record.pricingVersion = catalog.revision;
        }
        const metrics = [
          metric("tokens_today", "Tokens used today", "tokens", scan.totals.total, null, null, null),
          metric("input_tokens_today", "Input tokens today", "tokens", scan.totals.input, null, null, null),
          metric("output_tokens_today", "Output tokens today", "tokens", scan.totals.output, null, null, null)
        ];
        const partialMessage = scan.truncated
          ? `Only the most recent ${MAX_HISTORY_RECORDS.toLocaleString("en-US")} Freebuff turns were read; older history is outside that window.`
          : "Some Freebuff databases could not be read.";
        return {
          ...reading("Freebuff", metrics),
          accountKey: "local",
          source: "local_sessions",
          analytics: buildAnalytics(
            scan.records,
            context.now,
            historyDays,
            scan.filesScanned,
            scan.unreadable > 0 || scan.truncated,
            "local_sessions",
            partialMessage,
            undefined,
            timeZone
          ),
          error: null,
          updatedAt: context.now.toISOString()
        };
      }

      // CLI fallback: `credits` is 0 in free mode, so this counter can legitimately
      // report zero until Desktop writes a token-bearing database.
      const credits = await readChatCredits(sources.chats, context, options, today, timeZone, recentCutoff);
      const todayCredits = metric("credits_today", "Credits used today", "credits", credits, null, null, null);
      return {
        ...reading("Freebuff", [todayCredits]),
        accountKey: "local",
        source: "local_sessions",
        analytics: null,
        error: null,
        updatedAt: context.now.toISOString()
      };
    }
  };
}

async function readDesktopUsage(
  databases: string[],
  signal: AbortSignal,
  today: string | null,
  timeZone: string | undefined,
  recentCutoff: number,
  historyCutoff: number
): Promise<DesktopScan | null> {
  if (!today) return null;
  let opened = 0;
  let unreadable = 0;
  let truncated = false;
  const totals: TokenTotals = { input: 0, cached: 0, output: 0, total: 0 };
  const records: UsageRecord[] = [];

  for (const file of databases) {
    signal.throwIfAborted();
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(file, { readOnly: true, timeout: 1_000 });
    } catch {
      unreadable += 1;
      continue;
    }
    opened += 1;
    let failed = false;
    try {
      // Today's counters use a narrow window so the number stays exact even when
      // the history cap below trims older turns.
      try {
        for (const row of database.prepare(todayQuery).all(recentCutoff, MAX_METRIC_ROWS) as MessageRow[]) {
          const usage = typeof row.metrics_json === "string" ? parseUsage(row.metrics_json) : null;
          if (!usage || typeof row.ts !== "number") continue;
          if (localDay(new Date(row.ts).toISOString(), timeZone) !== today) continue;
          totals.input = safeAdd(totals.input, usage.input);
          totals.cached = safeAdd(totals.cached, usage.cached);
          totals.output = safeAdd(totals.output, usage.output);
          totals.total = safeAdd(totals.total, usage.total);
        }
      } catch {
        failed = true;
      }
      const want = Math.min(MAX_METRIC_ROWS, MAX_HISTORY_RECORDS - records.length);
      if (want > 0) {
        try {
          const rows = selectHistory(database, historyCutoff, want + 1);
          if (rows.length > want) truncated = true;
          for (const row of rows.slice(0, want)) {
            const record = usageRecord(row, file, timeZone);
            if (record) records.push(record);
          }
        } catch {
          failed = true;
        }
      } else {
        truncated = true;
      }
    } finally {
      try { database.close(); } catch { /* already closed */ }
    }
    if (failed) unreadable += 1;
  }
  return opened > 0 ? { totals, records, filesScanned: opened, unreadable, truncated } : null;
}

const todayQuery = "SELECT ts, metrics_json FROM messages WHERE role = 'assistant' AND ts >= ? LIMIT ?";

/**
 * History joins the thread so each turn keeps its model, project and sponsored
 * status. Older Freebuff builds may not ship a `threads` table yet, so the plain
 * shape is the fallback rather than a failed read.
 */
function selectHistory(database: DatabaseSync, cutoff: number, limit: number): MessageRow[] {
  try {
    return database.prepare(
      `SELECT m.seq AS seq, m.thread_id AS thread_id, m.ts AS ts, m.metrics_json AS metrics_json,
              t.model AS model, t.project_path AS project_path, t.sponsored AS sponsored
         FROM messages m LEFT JOIN threads t ON t.id = m.thread_id
        WHERE m.role = 'assistant' AND m.metrics_json IS NOT NULL AND m.ts >= ?
        ORDER BY m.ts DESC LIMIT ?`
    ).all(cutoff, limit) as MessageRow[];
  } catch {
    return database.prepare(
      `SELECT seq, thread_id, ts, metrics_json FROM messages
        WHERE role = 'assistant' AND metrics_json IS NOT NULL AND ts >= ?
        ORDER BY ts DESC LIMIT ?`
    ).all(cutoff, limit) as MessageRow[];
  }
}

function usageRecord(row: MessageRow, file: string, timeZone: string | undefined): UsageRecord | null {
  if (typeof row.ts !== "number" || typeof row.metrics_json !== "string") return null;
  const usage = parseUsage(row.metrics_json);
  if (!usage) return null;
  const timestamp = new Date(row.ts);
  if (!Number.isFinite(timestamp.valueOf())) return null;
  const day = localDay(timestamp.toISOString(), timeZone);
  if (!day) return null;
  const thread = typeof row.thread_id === "string" && row.thread_id ? row.thread_id : null;
  const projectPath = typeof row.project_path === "string" && row.project_path ? row.project_path : null;
  const reported = typeof row.model === "string" && row.model.trim() ? row.model.trim() : "freebuff";
  const model = resolveFreebuffModel(reported);
  const sponsored = typeof row.sponsored === "string" && row.sponsored ? "sponsored" : "standard";
  const seq = typeof row.seq === "number" ? row.seq : 0;
  return {
    timestamp: timestamp.toISOString(),
    day,
    model: model.model,
    reportedModel: reported,
    ...(model.vendor ? { modelProvider: model.vendor } : {}),
    sessionID: thread ?? file,
    projectPath,
    projectLabel: lastSegment(projectPath ?? dirname(file)),
    serviceTier: sponsored,
    inputTokens: usage.input,
    cachedInputTokens: usage.cached,
    cacheCreationInputTokens: 0,
    outputTokens: usage.output,
    totalTokens: usage.total,
    estimatedCostUSD: null,
    reportedCostUSD: usage.cost,
    eventKey: `${file}\u0000${thread ?? ""}\u0000${seq}`,
    measurement: "known",
    granularity: "event"
  };
}

async function readChatCredits(
  chats: string[],
  context: ProviderContext,
  options: FreebuffOptions,
  today: string | null,
  timeZone: string | undefined,
  cutoff: number
): Promise<number> {
  if (!today) return 0;
  let credits = 0;
  let readBytes = 0;
  for (const file of chats) {
    context.signal.throwIfAborted();
    let info;
    try { info = await stat(file); } catch { continue; }
    if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
    if (info.mtimeMs < cutoff) continue;
    if (readBytes + info.size > (options.maxBytes ?? MAX_TOTAL_BYTES)) continue;
    readBytes += info.size;
    let messages: unknown;
    try { messages = JSON.parse(await readFile(file, "utf8")) as unknown; } catch { continue; }
    if (!Array.isArray(messages)) continue;
    for (const value of messages) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const message = value as Record<string, unknown>;
      const charged = message.credits;
      if (typeof charged !== "number" || !Number.isFinite(charged) || charged < 0) continue;
      if (typeof message.timestamp !== "string" || localDay(message.timestamp, timeZone) !== today) continue;
      credits = Math.min(credits + charged, Number.MAX_SAFE_INTEGER);
    }
  }
  return credits;
}

function parseUsage(json: string): ParsedUsage | null {
  let metrics: unknown;
  try { metrics = JSON.parse(json) as unknown; } catch { return null; }
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
  const record = metrics as Record<string, unknown>;
  const usage = record.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const values = usage as Record<string, unknown>;
  const reported = tokenCount(values.inputTokens);
  const cached = Math.min(tokenCount(values.cachedInputTokens), reported);
  const input = reported - cached;
  const output = tokenCount(values.outputTokens);
  // Derived rather than trusted: the stored total must equal the categories it
  // is split into, and a reported total that disagrees would be rejected later.
  const total = Math.min(input + cached + output, Number.MAX_SAFE_INTEGER);
  if (total === 0) return null;
  return { input, cached, output, total, cost: costValue(record.costUsd) };
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER
    ? Math.floor(value)
    : 0;
}

/** Freebuff reports `costUsd: 0` on its subscription; rows written before that field existed stay unpriced. */
function costValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Windows and POSIX paths both end up here, so the last segment is split by hand. */
function lastSegment(value: string): string {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : value;
}

function safeAdd(left: number, right: number): number {
  return Math.min(left + right, Number.MAX_SAFE_INTEGER);
}

function clampDays(days: number): number {
  return Math.max(MIN_HISTORY_DAYS, Math.min(MAX_HISTORY_DAYS, Number.isFinite(days) ? Math.floor(days) : MIN_HISTORY_DAYS));
}

function localDay(timestamp: string, timeZone?: string): string | null {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit"
    }).format(time);
  } catch {
    return null;
  }
}
