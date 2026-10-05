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
import { resolveScanHomes } from "../platform/wsl";
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
const DEFAULT_MAX_RECORDS = 250_000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const GO_LIMITS = { session: 12, weekly: 30, monthly: 60 } as const;

// OpenCode 2.0 creates `session_v2`, copies every v1 session into it with its
// messages in `session_message`, then stops writing `session` / `message` / `part`.
// The copy runs in the background, newest session first. 1.x releases already ship
// an empty `session_message`, so only `session_v2` marks a 2.0 database.
const V2_MESSAGE_TABLE = "session_message";
const V2_SESSION_TABLE = "session_v2";

// v1 sessions that 2.0 has not copied yet: older ones while its import is still
// running, or one that failed to import. Driving the lookup from the small session
// table lets a fully imported install skip the frozen v1 rows entirely.
const PENDING_V1_SESSIONS = `session_id IN (
    SELECT id FROM session WHERE id NOT IN (SELECT id FROM ${V2_SESSION_TABLE})
  )`;
const PENDING_V1_MESSAGES = `message_id IN (SELECT id FROM message WHERE ${PENDING_V1_SESSIONS})`;

// Usage payloads embed the assistant's tool calls, so a single `data` value
// reaches ~100 MB and the message table is over a gigabyte. None of it is parsed,
// and reading whole rows is what used to push these tables past the record cap,
// so select only the keys the parser reads. `json_valid` keeps an unreadable
// payload from failing the whole scan, as it was skipped before. Objects keep
// their JSON subtype through `json_extract`, so `json_object` nests them as-is;
// wrapping them in `json()` would throw on a value that is a plain string.
const V2_MESSAGE_SQL = `
  SELECT id, session_id, time_created,
    json_object(
      'role', type,
      'model', json_extract(data, '$.model'),
      'cost', json_extract(data, '$.cost'),
      'tokens', json_extract(data, '$.tokens'),
      'time', json_object('created', COALESCE(json_extract(data, '$.time.created'), time_created))
    ) AS data
  FROM ${V2_MESSAGE_TABLE}
  WHERE type = 'assistant' AND json_valid(data)
  ORDER BY time_created DESC
  LIMIT ?`;

function messageSql(scope: string): string {
  return `
  SELECT id, session_id, time_created,
    json_object(
      'role', json_extract(data, '$.role'),
      'model', json_extract(data, '$.model'),
      'modelID', json_extract(data, '$.modelID'),
      'providerID', json_extract(data, '$.providerID'),
      'provider', json_extract(data, '$.provider'),
      'cost', json_extract(data, '$.cost'),
      'tokens', json_extract(data, '$.tokens'),
      'usage', json_extract(data, '$.usage'),
      'time', json_object('created', COALESCE(json_extract(data, '$.time.created'), time_created))
    ) AS data
  FROM message
  WHERE ${scope}json_valid(data)
  ORDER BY time_created DESC
  LIMIT ?`;
}

// Only `step-finish` parts carry usage. The tool, text and patch parts that make
// up most of the table are never parsed.
function stepPartSql(scope: string): string {
  return `
  SELECT id, message_id, time_created,
    json_object(
      'type', json_extract(data, '$.type'),
      'cost', json_extract(data, '$.cost'),
      'tokens', json_extract(data, '$.tokens'),
      'usage', json_extract(data, '$.usage'),
      'time', json_object('created', COALESCE(json_extract(data, '$.time.created'), time_created))
    ) AS data
  FROM part
  WHERE ${scope}json_valid(data) AND json_extract(data, '$.type') = 'step-finish'
  ORDER BY time_created DESC
  LIMIT ?`;
}

export class OpenCodeUsageScanner {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly homeDirectory: string;
  private readonly sqliteFactory: ReadonlySqliteFactory;
  private readonly historyDays: number;
  private readonly maxRecords: number;

  constructor(options: OpenCodeUsageScannerOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.sqliteFactory = options.sqliteFactory ?? new NodeReadonlySqliteFactory();
    this.historyDays = clampInteger(options.historyDays ?? DEFAULT_HISTORY_DAYS, 1, 366);
    this.maxRecords = clampInteger(options.maxRecords ?? DEFAULT_MAX_RECORDS, 1, 250_000);
  }

  /** Every OpenCode data root: the primary home plus readable WSL homes. */
  private async allLocations(): Promise<OpenCodeLocations[]> {
    const homes = await resolveScanHomes(this.homeDirectory, { environment: this.environment });
    const locations = homes.map((home) => openCodeLocations({ environment: this.environment, homeDirectory: home }));
    return [...new Map(locations.map((locations) => [locations.root, locations])).values()];
  }

  async isAvailable(): Promise<boolean> {
    for (const locations of await this.allLocations()) {
      if (await fileExists(locations.database) || await fileExists(locations.auth)) return true;
    }
    return false;
  }

  async scan(context: { signal: AbortSignal; now: Date; historyDays?: number; timeZone?: string }): Promise<OpenCodeUsageSnapshot> {
    context.signal.throwIfAborted();
    const databases: OpenCodeLocations[] = [];
    let hasGoAuth = false;
    for (const locations of await this.allLocations()) {
      hasGoAuth ||= await hasOpenCodeGoAuth(locations.auth);
      if (await fileExists(locations.database)) databases.push(locations);
    }
    if (databases.length === 0) {
      throw new ProviderError(
        "credentials_missing",
        "OpenCode local data was not found. Run OpenCode once, then refresh."
      );
    }
    const historyDays = clampInteger(context.historyDays ?? this.historyDays, 1, 366);
    const seen = new Set<string>();
    const records: UsageRecord[] = [];
    let partial = false;
    for (const locations of databases) {
      const parsed = this.readRecords(locations, context.signal);
      partial ||= parsed.partial;
      // Homes can share a database through a mount; one event counts once.
      for (const record of parsed.records) {
        if (seen.has(record.eventKey)) continue;
        seen.add(record.eventKey);
        records.push(record);
      }
    }
    const parsed = { records, partial };
    const hasGoPlan = hasGoAuth || parsed.records.some((record) => record.serviceTier === "opencode-go");
    return {
      analytics: buildAnalytics(
        parsed.records,
        context.now,
        historyDays,
        1,
        parsed.partial,
        "local_sessions",
        undefined,
        undefined,
        context.timeZone
      ),
      windows: hasGoPlan ? buildGoWindows(parsed.records, context.now) : [],
      hasGoPlan
    };
  }

  private readRecords(locations: OpenCodeLocations, signal: AbortSignal): { records: UsageRecord[]; partial: boolean } {
    let database: ReadonlySqliteDatabase | undefined;
    try {
      database = this.sqliteFactory.open(locations.database);
      const tables = new Set(database.all(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      ).map((row) => text(row.name)).filter((name): name is string => name !== null));
      const v2 = tables.has(V2_SESSION_TABLE) && tables.has(V2_MESSAGE_TABLE);
      // On 2.0 a v1 message only counts while its session is still waiting to be copied.
      const v1 = tables.has("message") && (!v2 || tables.has("session"));
      if (!v2 && !v1) {
        throw new ProviderError("analytics_unavailable", "OpenCode's local database has no message history.");
      }
      const limit = this.maxRecords + 1;
      const messageRows = [
        ...(v2 ? database.all(V2_MESSAGE_SQL, [limit]) : []),
        ...(v1 ? database.all(messageSql(v2 ? `${PENDING_V1_SESSIONS} AND ` : ""), [limit]) : [])
      ].sort((left, right) => integer(right.time_created) - integer(left.time_created));
      const partRows = v1 && tables.has("part")
        ? database.all(stepPartSql(v2 ? `${PENDING_V1_MESSAGES} AND ` : ""), [limit])
        : [];
      const sessionLimit = Math.min(this.maxRecords, 10_000);
      const sessionRows = [
        ...(v2 ? readBoundedTable(database, V2_SESSION_TABLE, sessionLimit) : []),
        ...(tables.has("session")
          ? readBoundedTable(database, "session", sessionLimit, v2 ? `id NOT IN (SELECT id FROM ${V2_SESSION_TABLE})` : "")
          : [])
      ];
      signal.throwIfAborted();
      const parsed = parseOpenCodeRows(messageRows.slice(0, this.maxRecords), partRows.slice(0, this.maxRecords), sessionRows, signal);
      return {
        records: parsed.records,
        partial: parsed.skipped > 0
          || messageRows.length > this.maxRecords
          || partRows.length > this.maxRecords
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

function readBoundedTable(database: ReadonlySqliteDatabase, table: string, limit: number, where = ""): SqliteRow[] {
  const columns = new Set(database.all(`PRAGMA table_info(${table})`)
    .map((row) => text(row.name))
    .filter((name): name is string => name !== null));
  const filter = where ? ` WHERE ${where}` : "";
  const order = columns.has("time_created") ? " ORDER BY time_created DESC" : "";
  return database.all(`SELECT * FROM ${table}${filter}${order} LIMIT ?`, [limit]);
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
    else if (!metadata.timestamp && (nested(root, "tokens") || nested(root, "usage") || root.cost !== undefined)) skipped += 1;
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
  if (!tokens && cost === null) return null;
  return {
    timestamp: message.timestamp,
    day: localDay(new Date(message.timestamp)),
    model: message.model,
    reportedModel: message.model,
    modelProvider: message.providerID,
    reportedCostUSD: cost,
    rawTokens: { input: tokenInteger(firstValue(tokens?.input, tokens?.input_tokens)), cacheRead: tokenInteger(firstValue(cache?.read, tokens?.cache_read, tokens?.cached_input_tokens)), cacheWrite: tokenInteger(firstValue(cache?.write, tokens?.cache_write, tokens?.cache_creation_input_tokens)), output: tokenInteger(firstValue(tokens?.output, tokens?.output_tokens)), reasoning: tokenInteger(firstValue(tokens?.reasoning, tokens?.reasoning_tokens)), total: tokenInteger(tokens?.total) },
    measurement: tokens !== null
      && [firstValue(tokens.input, tokens.input_tokens), firstValue(tokens.output, tokens.output_tokens)].every(value => tokenInteger(value) !== null)
      && [firstValue(cache?.read, tokens.cache_read, tokens.cached_input_tokens), firstValue(cache?.write, tokens.cache_write, tokens.cache_creation_input_tokens), firstValue(tokens.reasoning, tokens.reasoning_tokens), tokens.total]
        .every(value => value === undefined || tokenInteger(value) !== null)
      && (tokens.cache === undefined || cache !== null)
      && Number.isSafeInteger(totalTokens) && totalTokens === calculatedTotal ? "known" : "unknown",
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
    eventIdentity: "source",
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
    eventIdentity: "source",
    granularity: "session",
    rawTokens: { input: tokenInteger(firstValue(row.tokens_input, root.tokens_input)), cacheRead: tokenInteger(firstValue(row.tokens_cache_read, root.tokens_cache_read)), cacheWrite: tokenInteger(firstValue(row.tokens_cache_write, root.tokens_cache_write)), output: tokenInteger(firstValue(row.tokens_output, root.tokens_output)), reasoning: tokenInteger(firstValue(row.tokens_reasoning, root.tokens_reasoning)) },
    measurement: [firstValue(row.tokens_input, root.tokens_input), firstValue(row.tokens_output, root.tokens_output)]
      .every(value => tokenInteger(value) !== null)
      && [firstValue(row.tokens_cache_read, root.tokens_cache_read), firstValue(row.tokens_cache_write, root.tokens_cache_write), firstValue(row.tokens_reasoning, root.tokens_reasoning)]
        .every(value => value === undefined || tokenInteger(value) !== null)
      && Number.isSafeInteger(totalTokens) ? "known" : "unknown",
    reportedCostUSD: cost,
    eventKey: `opencode|session|${sessionID}`
  };
}

function buildGoWindows(records: UsageRecord[], now: Date): DashboardWindow[] {
  const goRecords = records.filter((record) => record.serviceTier === "opencode-go" && record.estimatedCostUSD !== null && timestampMs(record.timestamp) <= now.valueOf());
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
    const date = new Date(milliseconds);
    return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
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

function tokenInteger(value: unknown): number | null {
  const parsed = finite(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

function integer(value: unknown): number {
  return tokenInteger(value) ?? 0;
}

function finite(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
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
