import type { DashboardWindow, LocalUsageAnalytics } from "@usageatlas/contracts";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ProviderError } from "../provider";
import {
  NodeReadonlySqliteFactory,
  type ReadonlySqliteDatabase,
  type ReadonlySqliteFactory,
  type SqliteRow
} from "../platform/sqlite";
import { usageWindow } from "../providers/shared";
import { buildAnalytics, type UsageRecord } from "./local-usage";

export interface OpenCodeUsageScannerOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  sqliteFactory?: ReadonlySqliteFactory;
  historyDays?: number;
  maxRecords?: number;
}

export interface OpenCodeLocations {
  root: string;
  auth: string;
  database: string;
}

export interface OpenCodeUsageSnapshot {
  analytics: LocalUsageAnalytics;
  windows: DashboardWindow[];
  hasGoPlan: boolean;
}

interface SessionMetadata {
  projectPath: string | null;
  projectLabel: string;
}

interface MessageMetadata extends SessionMetadata {
  id: string;
  sessionID: string;
  timestamp: string | null;
  model: string;
  providerID: string;
  root: Record<string, unknown>;
}

const DEFAULT_HISTORY_DAYS = 90;
const DEFAULT_MAX_RECORDS = 100_000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const GO_LIMITS = { session: 12, weekly: 30, monthly: 60 } as const;

export class OpenCodeUsageScanner {
  private readonly locations: OpenCodeLocations;
  private readonly sqliteFactory: ReadonlySqliteFactory;
  private readonly historyDays: number;
  private readonly maxRecords: number;

  constructor(options: OpenCodeUsageScannerOptions = {}) {
    this.locations = openCodeLocations(options);
    this.sqliteFactory = options.sqliteFactory ?? new NodeReadonlySqliteFactory();
    this.historyDays = clampInteger(options.historyDays ?? DEFAULT_HISTORY_DAYS, 1, 366);
    this.maxRecords = clampInteger(options.maxRecords ?? DEFAULT_MAX_RECORDS, 1, 250_000);
  }

  async isAvailable(): Promise<boolean> {
    return await fileExists(this.locations.database) || await fileExists(this.locations.auth);
  }

  async scan(context: { signal: AbortSignal; now: Date; historyDays?: number }): Promise<OpenCodeUsageSnapshot> {
    context.signal.throwIfAborted();
    if (!await fileExists(this.locations.database)) {
      throw new ProviderError(
        "credentials_missing",
        "OpenCode local data was not found. Run OpenCode once, then refresh."
      );
    }
    const historyDays = clampInteger(context.historyDays ?? this.historyDays, 1, 366);
    const parsed = this.readRecords(context.signal);
    const hasGoAuth = await hasOpenCodeGoAuth(this.locations.auth);
    const hasGoPlan = hasGoAuth || parsed.records.some((record) => record.serviceTier === "opencode-go");
    return {
      analytics: buildAnalytics(
        parsed.records,
        context.now,
        historyDays,
        1,
        parsed.partial
      ),
      windows: hasGoPlan ? buildGoWindows(parsed.records, context.now) : [],
      hasGoPlan
    };
  }

  private readRecords(signal: AbortSignal): { records: UsageRecord[]; partial: boolean } {
    let database: ReadonlySqliteDatabase | undefined;
    try {
      database = this.sqliteFactory.open(this.locations.database);
      const tables = new Set(database.all(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      ).map((row) => text(row.name)).filter((name): name is string => name !== null));
      if (!tables.has("message")) {
        throw new ProviderError("analytics_unavailable", "OpenCode's local database has no message history.");
      }
      const messageRows = readBoundedTable(database, "message", this.maxRecords);
      const partRows = tables.has("part") ? readBoundedTable(database, "part", this.maxRecords) : [];
      const sessionRows = tables.has("session")
        ? readBoundedTable(database, "session", Math.min(this.maxRecords, 10_000))
        : [];
      signal.throwIfAborted();
      const parsed = parseOpenCodeRows(messageRows, partRows, sessionRows, signal);
      return {
        records: parsed.records,
        partial: parsed.skipped > 0
          || messageRows.length >= this.maxRecords
          || partRows.length >= this.maxRecords
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("analytics_unavailable", "OpenCode local usage could not be read.", true);
    } finally {
      database?.close();
    }
  }
}

export function openCodeLocations(options: OpenCodeUsageScannerOptions = {}): OpenCodeLocations {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const configured = nonEmpty(environment.OPENCODE_DATA_DIR);
  const dataHome = nonEmpty(environment.XDG_DATA_HOME) ?? path.join(homeDirectory, ".local", "share");
  const root = path.resolve(configured ?? path.join(dataHome, "opencode"));
  return {
    root,
    auth: path.join(root, "auth.json"),
    database: path.join(root, "opencode.db")
  };
}

function readBoundedTable(database: ReadonlySqliteDatabase, table: string, limit: number): SqliteRow[] {
  const columns = new Set(database.all(`PRAGMA table_info(${table})`)
    .map((row) => text(row.name))
    .filter((name): name is string => name !== null));
  const order = columns.has("time_created") ? " ORDER BY time_created DESC" : "";
  return database.all(`SELECT * FROM ${table}${order} LIMIT ?`, [limit]);
}

function parseOpenCodeRows(
  messageRows: SqliteRow[],
  partRows: SqliteRow[],
  sessionRows: SqliteRow[],
  signal: AbortSignal
): { records: UsageRecord[]; skipped: number } {
  const sessions = sessionMetadata(sessionRows);
  const messages = new Map<string, MessageMetadata>();
  const messageRecords = new Map<string, UsageRecord>();
  const records: UsageRecord[] = [];
  const messagesWithStepUsage = new Set<string>();
  let skipped = 0;

  for (const row of messageRows) {
    signal.throwIfAborted();
    const root = jsonObject(row.data);
    if (!root) {
      skipped += 1;
      continue;
    }
    const role = firstText(root.role, row.role);
    if (role !== "assistant") continue;
    const id = firstText(row.id, root.id) ?? `message-${messages.size}`;
    const sessionID = firstText(row.session_id, row.sessionID, root.sessionID, root.session_id) ?? "unknown-session";
    const session = sessions.get(sessionID) ?? unknownProject();
    const metadata: MessageMetadata = {
      id,
      sessionID,
      ...session,
      timestamp: timestamp(firstValue(nested(root, "time")?.created, row.time_created, root.createdAt)),
      model: firstText(root.modelID, root.model, nested(root, "model")?.id) ?? "unknown",
      providerID: firstText(root.providerID, root.provider, nested(root, "model")?.providerID) ?? "unknown",
      root
    };
    messages.set(id, metadata);
    const record = usageRecord(metadata, root, `opencode|message|${id}`);
    if (record) messageRecords.set(id, record);
  }

  for (const row of partRows) {
    signal.throwIfAborted();
    const root = jsonObject(row.data);
    if (!root) {
      skipped += 1;
      continue;
    }
    if (firstText(root.type, row.type) !== "step-finish") continue;
    const messageID = firstText(row.message_id, row.messageID, root.messageID, root.message_id);
    if (!messageID) {
      skipped += 1;
      continue;
    }
    const message = messages.get(messageID);
    if (!message) {
      skipped += 1;
      continue;
    }
    const partID = firstText(row.id, root.id) ?? `${messageID}-${records.length}`;
    const record = usageRecord({
      ...message,
      timestamp: timestamp(firstValue(nested(root, "time")?.created, row.time_created)) ?? message.timestamp
    }, root, `opencode|part|${partID}`);
    if (record) {
      records.push(record);
      messagesWithStepUsage.add(messageID);
    } else {
      skipped += 1;
    }
  }

  for (const [messageID, record] of messageRecords) {
    if (!messagesWithStepUsage.has(messageID)) records.push(record);
  }

  const sessionsWithUsage = new Set(records.map((record) => record.sessionID));
  for (const row of sessionRows) {
    signal.throwIfAborted();
    const sessionID = firstText(row.id, jsonObject(row.data)?.id);
    if (!sessionID || sessionsWithUsage.has(sessionID)) continue;
    const record = sessionUsageRecord(row, sessions.get(sessionID) ?? unknownProject());
    if (record) records.push(record);
  }

  return { records, skipped };
}

function sessionMetadata(rows: SqliteRow[]): Map<string, SessionMetadata> {
  const sessions = new Map<string, SessionMetadata>();
  for (const row of rows) {
    const root = jsonObject(row.data) ?? {};
    const id = firstText(row.id, root.id);
    if (!id) continue;
    const projectPath = firstText(
      row.directory,
      row.path,
      root.directory,
      root.path,
      root.cwd
    );
    sessions.set(id, {
      projectPath,
      projectLabel: projectName(projectPath, firstText(row.title, root.title) ?? "Unknown project")
    });
  }
  return sessions;
}

function usageRecord(
  message: MessageMetadata,
  value: Record<string, unknown>,
  eventKey: string
): UsageRecord | null {
  if (!message.timestamp) return null;
  const tokens = nested(value, "tokens") ?? nested(value, "usage");
  const cache = nested(tokens ?? {}, "cache");
  const inputTokens = integer(firstValue(tokens?.input, tokens?.input_tokens));
  const cachedInputTokens = integer(firstValue(cache?.read, tokens?.cache_read, tokens?.cached_input_tokens));
  const cacheCreationInputTokens = integer(firstValue(cache?.write, tokens?.cache_write, tokens?.cache_creation_input_tokens));
  const outputTokens = integer(firstValue(tokens?.output, tokens?.output_tokens))
    + integer(firstValue(tokens?.reasoning, tokens?.reasoning_tokens));
  const calculatedTotal = inputTokens + cachedInputTokens + cacheCreationInputTokens + outputTokens;
  const totalTokens = Math.max(calculatedTotal, integer(tokens?.total));
  const cost = finite(firstValue(value.cost, nested(value, "usage")?.cost));
  if (totalTokens === 0 && cost === null) return null;
  return {
    timestamp: message.timestamp,
    day: localDay(new Date(message.timestamp)),
    model: message.model,
    sessionID: message.sessionID,
    projectPath: message.projectPath,
    projectLabel: message.projectLabel,
    serviceTier: message.providerID,
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUSD: cost,
    eventKey
  };
}

function sessionUsageRecord(row: SqliteRow, session: SessionMetadata): UsageRecord | null {
  const root = jsonObject(row.data) ?? {};
  const sessionID = firstText(row.id, root.id);
  const createdAt = timestamp(firstValue(
    row.time_updated,
    row.time_created,
    nested(root, "time")?.updated,
    nested(root, "time")?.created
  ));
  if (!sessionID || !createdAt) return null;
  const inputTokens = integer(firstValue(row.tokens_input, root.tokens_input));
  const cachedInputTokens = integer(firstValue(row.tokens_cache_read, root.tokens_cache_read));
  const cacheCreationInputTokens = integer(firstValue(row.tokens_cache_write, root.tokens_cache_write));
  const outputTokens = integer(firstValue(row.tokens_output, root.tokens_output))
    + integer(firstValue(row.tokens_reasoning, root.tokens_reasoning));
  const totalTokens = inputTokens + cachedInputTokens + cacheCreationInputTokens + outputTokens;
  const cost = finite(firstValue(row.cost, root.cost));
  if (totalTokens === 0 && (cost === null || cost === 0)) return null;
  const model = jsonObject(row.model) ?? jsonObject(root.model);
  return {
    timestamp: createdAt,
    day: localDay(new Date(createdAt)),
    model: firstText(model?.id, row.model_id, root.modelID) ?? "unknown",
    sessionID,
    projectPath: session.projectPath,
    projectLabel: session.projectLabel,
    serviceTier: firstText(model?.providerID, row.provider_id, root.providerID) ?? "unknown",
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUSD: cost,
    eventKey: `opencode|session|${sessionID}`
  };
}

function buildGoWindows(records: UsageRecord[], now: Date): DashboardWindow[] {
  const goRecords = records.filter((record) => record.serviceTier === "opencode-go" && record.estimatedCostUSD !== null);
  const nowMs = now.valueOf();
  const sessionStart = nowMs - FIVE_HOURS_MS;
  const weekStart = startOfUTCWeek(now).valueOf();
  const weekEnd = weekStart + 7 * 24 * 60 * 60 * 1_000;
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const sessionRecords = goRecords.filter((record) => timestampMs(record.timestamp) >= sessionStart);
  const sessionReset = sessionRecords.length
    ? Math.min(...sessionRecords.map((record) => timestampMs(record.timestamp))) + FIVE_HOURS_MS
    : nowMs + FIVE_HOURS_MS;
  return [
    usageWindow("session", "5-hour (local)", percent(cost(sessionRecords), GO_LIMITS.session), new Date(sessionReset).toISOString()),
    usageWindow("weekly", "Weekly (local)", percent(costBetween(goRecords, weekStart, weekEnd), GO_LIMITS.weekly), new Date(weekEnd).toISOString()),
    usageWindow("monthly", "Monthly (local)", percent(costBetween(goRecords, monthStart, monthEnd), GO_LIMITS.monthly), new Date(monthEnd).toISOString())
  ];
}

async function hasOpenCodeGoAuth(authPath: string): Promise<boolean> {
  try {
    if ((await stat(authPath)).size > 1_048_576) return false;
    const root = JSON.parse(await readFile(authPath, "utf8")) as unknown;
    const entry = nested(jsonRecord(root) ?? {}, "opencode-go");
    return Boolean(firstText(entry?.key));
  } catch {
    return false;
  }
}

function cost(records: UsageRecord[]): number {
  return records.reduce((total, record) => total + (record.estimatedCostUSD ?? 0), 0);
}

function costBetween(records: UsageRecord[], start: number, end: number): number {
  return cost(records.filter((record) => {
    const value = timestampMs(record.timestamp);
    return value >= start && value < end;
  }));
}

function percent(used: number, limit: number): number {
  return Math.round(Math.max(0, Math.min(100, used / limit * 100)) * 10) / 10;
}

function startOfUTCWeek(now: Date): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  return start;
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return new Date(milliseconds).toISOString();
  }
  if (typeof value === "bigint") return timestamp(Number(value));
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return timestamp(numeric);
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return jsonRecord(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  if (value instanceof Uint8Array) return jsonObject(Buffer.from(value).toString("utf8"));
  return jsonRecord(value);
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nested(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return jsonRecord(value[key]);
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const result = text(value);
    if (result) return result;
  }
  return null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function firstValue(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function integer(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function finite(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function localDay(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function projectName(projectPath: string | null, fallback: string): string {
  if (!projectPath) return fallback;
  const parts = projectPath.replace(/[\\/]+$/u, "").split(/[\\/]/u);
  return parts.at(-1) || fallback;
}

function unknownProject(): SessionMetadata {
  return { projectPath: null, projectLabel: "Unknown project" };
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
