import { USAGE_PARSER_VERSION, type CollectedUsageEvent } from "@usageatlas/contracts/statistics";
import { localCalendarDay } from "../history/days";
import type {
  LocalUsageAnalytics,
  ProviderFailure,
  UsageBreakdown,
  UsageDailyMetric,
  UsageDailyModelMetric,
  UsageHourlyMetric,
  UsageProjectBreakdown,
  UsageSessionBreakdown,
  UsageTotals
} from "@usageatlas/contracts";
import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { visit } from "jsonc-parser";
import { emptyPricingCatalog, type PricingCatalog } from "./models-dev";
import {
  estimateClaudeCost,
  estimateCodexCost,
  normalizeClaudeModel,
  normalizeCodexModel
} from "./pricing";

export type AnalyticsProvider = "codex" | "claude";

export interface AnalyticsScanContext {
  signal: AbortSignal;
  now: Date;
  historyDays?: number;
  timeZone?: string;
}

export interface AnalyticsScanner {
  scan(provider: AnalyticsProvider, context: AnalyticsScanContext): Promise<LocalUsageAnalytics>;
}

export interface LocalUsageScannerOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  historyDays?: number;
  maxFiles?: number;
  maxLineBytes?: number;
  pricingCatalogLoader?: (context: AnalyticsScanContext) => Promise<PricingCatalog>;
}

export type UsageRecord = CollectedUsageEvent;

interface ParsedFile {
  records: UsageRecord[];
  skippedLines: number;
  oversizedLines: number;
}

interface FileCacheEntry extends ParsedFile {
  size: number;
  modifiedAt: number;
}

interface DiscoveryResult {
  files: string[];
  errors: number;
  truncated: boolean;
}

/** Everything a scan knowingly failed to read, so the reason can be shown instead of guessed at. */
interface ScanGaps {
  unreadableDirectories: number;
  unreadableFiles: number;
  truncated: boolean;
  skippedLines: number;
  oversizedLines: number;
}

interface MutableTotals {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  estimatedCostUSD: number;
  pricedRequests: number;
  unpricedTokens: number;
}

interface MutableBreakdown {
  totals: MutableTotals;
  label: string;
}

interface MutableProject extends MutableBreakdown {
  path: string | null;
  models: Set<string>;
}

interface MutableSession extends MutableBreakdown {
  lastActivity: string;
  project: string | null;
  models: Set<string>;
}

const DEFAULT_HISTORY_DAYS = 90;
const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const MAX_PROJECTS = 200;
const MAX_SESSIONS = 250;
/** Model Ã— day rows, trimmed smallest-first so the busiest models keep every day. */
const MAX_DAILY_MODELS = 5_000;
const SKIPPED_DIRECTORIES = new Set([".git", ".build", "build", "DerivedData", "node_modules", "outputs", "target"]);

export class LocalUsageScanner implements AnalyticsScanner {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly homeDirectory: string;
  private readonly historyDays: number;
  private readonly maxFiles: number;
  private readonly maxLineBytes: number;
  private readonly pricingCatalogLoader?: (context: AnalyticsScanContext) => Promise<PricingCatalog>;
  private readonly cache = new Map<string, FileCacheEntry>();
  private catalogRevision = "";

  constructor(options: LocalUsageScannerOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.historyDays = clampInteger(options.historyDays ?? DEFAULT_HISTORY_DAYS, 1, 366);
    this.maxFiles = clampInteger(options.maxFiles ?? DEFAULT_MAX_FILES, 1, 20_000);
    this.maxLineBytes = clampInteger(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES, 64 * 1024, 4 * 1024 * 1024);
    this.pricingCatalogLoader = options.pricingCatalogLoader;
  }

  async scan(provider: AnalyticsProvider, context: AnalyticsScanContext): Promise<LocalUsageAnalytics> {
    context.signal.throwIfAborted();
    const historyDays = clampInteger(context.historyDays ?? this.historyDays, 1, 366);
    const catalog = this.pricingCatalogLoader
      ? await this.pricingCatalogLoader(context).catch(() => emptyPricingCatalog())
      : emptyPricingCatalog();
    if (catalog.revision !== this.catalogRevision) {
      this.cache.clear();
      this.catalogRevision = catalog.revision;
    }
    const roots = localUsageRoots(provider, this.environment, this.homeDirectory);
    const discovery = await discoverJsonlFiles(roots, this.maxFiles, context.signal);
    const activeFiles = new Set(discovery.files);
    for (const cachedPath of this.cache.keys()) {
      if (!activeFiles.has(cachedPath)) this.cache.delete(cachedPath);
    }

    const parsed: ParsedFile[] = new Array(discovery.files.length);
    let cursor = 0;
    let unreadableFiles = 0;
    const workers = Array.from({ length: Math.min(4, Math.max(discovery.files.length, 1)) }, async () => {
      while (cursor < discovery.files.length) {
        const index = cursor;
        cursor += 1;
        const file = discovery.files[index];
        if (!file) continue;
        try {
          parsed[index] = await this.parseOrReuse(provider, file, context.signal, catalog);
        } catch (error) {
          // A single unreadable file (rotated away mid-scan, locked, permission denied)
          // must not abandon the files this worker has not reached yet.
          if (context.signal.aborted) throw error;
          unreadableFiles += 1;
        }
      }
    });
    await Promise.all(workers);
    context.signal.throwIfAborted();
    if (unreadableFiles > 0 && unreadableFiles === discovery.files.length) {
      return unavailableAnalytics(context.now, historyDays, {
        code: "analytics_unavailable",
        message: "Local session analytics could not read the available logs.",
        retryable: true
      });
    }

    const skippedLines = parsed.reduce((total, entry) => total + (entry?.skippedLines ?? 0), 0);
    const records = deduplicateRecords(parsed.flatMap((entry) => entry?.records ?? []));
    const gaps: ScanGaps = {
      unreadableDirectories: discovery.errors,
      unreadableFiles,
      truncated: discovery.truncated,
      skippedLines,
      oversizedLines: parsed.reduce((total, entry) => total + (entry?.oversizedLines ?? 0), 0)
    };
    const gapMessage = scanGapMessage(gaps, this.maxFiles);
    return buildAnalytics(
      records,
      context.now,
      historyDays,
      discovery.files.length,
      gapMessage !== null,
      "local_sessions",
      gapMessage ?? undefined,
      undefined,
      context.timeZone
    );
  }

  private async parseOrReuse(
    provider: AnalyticsProvider,
    file: string,
    signal: AbortSignal,
    catalog: PricingCatalog
  ): Promise<ParsedFile> {
    signal.throwIfAborted();
    const metadata = await stat(file);
    const cached = this.cache.get(file);
    if (cached && cached.size === metadata.size && cached.modifiedAt === metadata.mtimeMs) {
      return cached;
    }
    const parsed = provider === "codex"
      ? await parseCodexFile(file, signal, this.maxLineBytes, catalog)
      : await parseClaudeFile(file, signal, this.maxLineBytes, catalog);
    this.cache.set(file, { ...parsed, size: metadata.size, modifiedAt: metadata.mtimeMs });
    return parsed;
  }
}

/**
 * Names what the scan missed, or returns null when nothing was missed. The text is shown to
 * the user, so it has to be specific enough to act on.
 */
function scanGapMessage(gaps: ScanGaps, maxFiles: number): string | null {
  if (gaps.truncated) {
    return `More than ${maxFiles.toLocaleString("en-US")} session files were found. Totals and cost estimates include only the scanned files.`;
  }
  const reasons: string[] = [];
  if (gaps.unreadableDirectories > 0) {
    reasons.push(`${countLabel(gaps.unreadableDirectories, "session folder")} could not be opened`);
  }
  if (gaps.unreadableFiles > 0) {
    reasons.push(`${countLabel(gaps.unreadableFiles, "session file")} could not be read`);
  }
  if (gaps.skippedLines > 0) {
    reasons.push(`${countLabel(gaps.skippedLines, "log entry", "log entries")} could not be parsed`);
  }
  if (gaps.oversizedLines > 0) {
    reasons.push(`${countLabel(gaps.oversizedLines, "usage or session metadata entry", "usage or session metadata entries")} exceeded the scan size limit`);
  }
  if (reasons.length === 0) return null;
  return `${capitalize(joinReasons(reasons))}. Totals and cost estimates include the entries that could be read.`;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : plural}`;
}

function joinReasons(reasons: string[]): string {
  if (reasons.length === 1) return reasons[0] as string;
  return `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function unavailableAnalytics(
  now: Date,
  historyDays = DEFAULT_HISTORY_DAYS,
  error: ProviderFailure,
  source: LocalUsageAnalytics["source"] = "local_sessions"
): LocalUsageAnalytics {
  const end = localDay(now);
  return {
    status: "unavailable",
    source,
    historyDays,
    coverageStart: end,
    coverageEnd: end,
    updatedAt: now.toISOString(),
    filesScanned: 0,
    recordsProcessed: 0,
    totals: emptyTotals(),
    today: emptyTotals(),
    daily: [],
    hourly: [],
    models: [],
    dailyModels: [],
    projects: [],
    sessions: [],
    serviceTiers: [],
    error
  };
}

function localUsageRoots(
  provider: AnalyticsProvider,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string
): string[] {
  if (provider === "codex") {
    const root = nonEmpty(environment.CODEX_HOME) ?? path.join(homeDirectory, ".codex");
    return [path.join(root, "sessions"), path.join(root, "archived_sessions")];
  }

  const configured = nonEmpty(environment.CLAUDE_CONFIG_DIR);
  const roots = configured
    ? configured.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => (
        path.basename(entry).toLowerCase() === "projects" ? entry : path.join(entry, "projects")
      ))
    : [
        path.join(homeDirectory, ".config", "claude", "projects"),
        path.join(homeDirectory, ".claude", "projects")
      ];
  const applicationData = nonEmpty(environment.APPDATA);
  if (applicationData) {
    roots.push(
      path.join(applicationData, "Claude", "local-agent-mode-sessions"),
      path.join(applicationData, "Claude", "claude-code-sessions")
    );
  }
  roots.push(
    path.join(homeDirectory, "Library", "Application Support", "Claude", "local-agent-mode-sessions"),
    path.join(homeDirectory, "Library", "Application Support", "Claude", "claude-code-sessions")
  );
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

async function discoverJsonlFiles(roots: string[], maxFiles: number, signal: AbortSignal): Promise<DiscoveryResult> {
  const files: string[] = [];
  let errors = 0;
  let truncated = false;

  async function walk(directory: string): Promise<void> {
    signal.throwIfAborted();
    if (truncated) return;
    let handle;
    try {
      handle = await opendir(directory);
    } catch (error) {
      if (!isMissing(error)) errors += 1;
      return;
    }
    try {
      for await (const entry of handle) {
        signal.throwIfAborted();
        if (truncated) break;
        const candidate = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(candidate);
        } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".jsonl") {
          if (files.length === maxFiles) {
            truncated = true;
            break;
          }
          files.push(candidate);
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!isMissing(error)) errors += 1;
    } finally {
      try { await handle.close(); } catch { /* Async iteration already closes the directory. */ }
    }
  }

  for (const root of roots) await walk(root);
  files.sort((left, right) => right.localeCompare(left));
  return { files, errors, truncated };
}

async function parseCodexFile(
  file: string,
  signal: AbortSignal,
  maxLineBytes: number,
  catalog: PricingCatalog
): Promise<ParsedFile> {
  let currentModel = "unknown";
  let reportedModel = "unknown";
  let currentTier = "standard";
  let currentTurnID: string | null = null;
  let sessionID = path.basename(file, path.extname(file));
  let projectPath: string | null = null;
  let previousTotal: TokenTriple | null = null;
  const seenTotals = new Set<string>();
  let skippedLines = 0;
  const records: UsageRecord[] = [];

  const oversizedLines = await scanLines(file, signal, maxLineBytes, "codex", (line, final) => {
    if (
      !line.includes("session_meta")
      && !line.includes("turn_context")
      && !line.includes("event_msg")
      && !line.includes("world_state")
    ) return;
    const root = parseObject(line);
    if (!root) {
      // The active session file can end mid-entry while the tool is still writing it.
      if ((!final || /\}\s*$/u.test(line)) && couldContainUsage("codex", line)) skippedLines += 1;
      return;
    }
    const type = stringValue(root.type);
    const payload = objectValue(root.payload);
    if (type === "session_meta") {
      sessionID = firstString(payload?.id, payload?.session_id, payload?.sessionId, root.id, root.session_id) ?? sessionID;
      projectPath = firstString(payload?.cwd, root.cwd) ?? projectPath;
      return;
    }
    if (type === "world_state") {
      const state = objectValue(payload?.state) ?? payload;
      const personality = objectValue(state?.personality);
      const model = firstString(state?.model, personality?.model, payload?.model);
      if (model !== null) { currentModel = normalizeCodexModel(model); reportedModel = model; }
      currentTier = normalizeServiceTier(firstString(state?.service_tier, payload?.service_tier)) ?? currentTier;
      return;
    }
    if (type === "turn_context") {
      currentTurnID = firstString(payload?.turn_id, payload?.turnId) ?? currentTurnID;
      const info = objectValue(payload?.info);
      const model = firstString(payload?.model, payload?.model_name, info?.model, info?.model_name);
      if (model !== null) { currentModel = normalizeCodexModel(model); reportedModel = model; }
      currentTier = normalizeServiceTier(firstString(payload?.service_tier, payload?.serviceTier, info?.service_tier))
        ?? (payload?.service_tier === null || payload?.serviceTier === null || info?.service_tier === null ? "standard" : currentTier);
      return;
    }
    if (type !== "event_msg" || !payload) return;
    const payloadType = stringValue(payload.type);
    if (payloadType === "thread_settings_applied") {
      const settings = objectValue(payload.thread_settings);
      const model = firstString(settings?.model);
      if (model !== null) { currentModel = normalizeCodexModel(model); reportedModel = model; }
      currentTier = normalizeServiceTier(firstString(settings?.service_tier)) ?? currentTier;
      return;
    }
    if (payloadType === "task_started") {
      currentTurnID = firstString(payload.turn_id, payload.turnId, payload.id);
      return;
    }
    if (payloadType !== "token_count") return;
    const info = objectValue(payload.info);
    if (!info) return;
    const lastValue = objectValue(info.last_token_usage), totalValue = objectValue(info.total_token_usage);
    const last = tokenTriple(lastValue);
    const total = tokenTriple(totalValue);
    if ((info.last_token_usage != null && !last) || (info.total_token_usage != null && !total)) {
      skippedLines += 1;
      return;
    }
    const timestamp = dateString(root.timestamp);
    if (!timestamp) { if (last || total) skippedLines += 1; return; }
    const totalKey = total ? JSON.stringify(total) : null;
    if (totalKey && seenTotals.has(totalKey)) return;
    if (total && previousTotal && total.input <= previousTotal.input && total.output <= previousTotal.output
      && !equalTriple(total, previousTotal)) {
      // A fresh counter equal to the last request establishes a reset. Other regressions are stale snapshots.
      if (last && equalTriple(total, last)) { previousTotal = null; seenTotals.clear(); }
      else return;
    }
    const delta = codexDelta(last, total, previousTotal);
    if (totalKey) seenTotals.add(totalKey);
    if (total) previousTotal = total;
    else if (last) previousTotal = addTriple(previousTotal, last);
    if (!delta || delta.input + delta.output === 0) return;
    const rawModel = firstString(info.model, info.model_name, payload.model, root.model);
    const model = currentModel !== "unknown"
      ? currentModel
      : normalizeCodexModel(rawModel ?? "unknown");
    const tier = normalizeServiceTier(firstString(info.service_tier, info.serviceTier, payload.service_tier))
      ?? currentTier;
    const cached = Math.min(delta.cached, delta.input);
    const cacheCreation = Math.min(delta.cacheWrite, Math.max(0, delta.input - cached));
    const freshInput = Math.max(0, delta.input - cached - cacheCreation);
    const costInput = {
      model,
      inputTokens: delta.input,
      cachedInputTokens: cached,
      cacheCreationInputTokens: cacheCreation,
      outputTokens: delta.output,
      serviceTier: tier
    };
    const turnID = firstString(payload.turn_id, payload.turnId, payload.id) ?? currentTurnID;
    records.push({
      timestamp,
      day: localDay(new Date(timestamp)),
      model,
      reportedModel: reportedModel !== "unknown" ? reportedModel : rawModel ?? "unknown",
      pricingVersion: catalog.revision,
      rawTokens: { ...numericUsageFields(info.last_token_usage, "last"), ...numericUsageFields(info.total_token_usage, "total") },
      sessionID,
      projectPath,
      projectLabel: projectName(projectPath),
      serviceTier: tier,
      inputTokens: freshInput,
      cachedInputTokens: cached,
      cacheCreationInputTokens: cacheCreation,
      outputTokens: delta.output,
      totalTokens: delta.input + delta.output,
      estimatedCostUSD: estimateCodexCost(costInput, catalog),
      eventKey: `codex|${timestamp}|${turnID ?? sessionID}|${model}|${tier}|${delta.input}|${cached}|${cacheCreation}|${delta.output}`
    });
  });

  return {
    records: records.map((record) => ({
      ...record,
      sessionID,
      projectPath,
      projectLabel: projectName(projectPath)
    })),
    skippedLines, oversizedLines
  };
}

async function parseClaudeFile(
  file: string,
  signal: AbortSignal,
  maxLineBytes: number,
  catalog: PricingCatalog
): Promise<ParsedFile> {
  let skippedLines = 0;
  const records: UsageRecord[] = [];
  let anonymousOrdinal = 0;
  const oversizedLines = await scanLines(file, signal, maxLineBytes, "claude", (line, final) => {
    if (!line.includes("\"assistant\"") || !line.includes("\"usage\"")) return;
    const root = parseObject(line);
    if (!root) {
      // The active session file can end mid-entry while the tool is still writing it.
      if ((!final || /\}\s*$/u.test(line)) && couldContainUsage("claude", line)) skippedLines += 1;
      return;
    }
    if (stringValue(root.type) !== "assistant" || isVertexClaudeRecord(root)) return;
    const message = objectValue(root.message);
    const usage = objectValue(message?.usage);
    const timestamp = dateString(root.timestamp);
    const rawModel = firstString(message?.model) ?? "unknown";
    if (!message || !usage) return;
    if (!timestamp) { skippedLines += 1; return; }
    const inputTokens = integerValue(usage.input_tokens);
    const cachedInputTokens = integerValue(usage.cache_read_input_tokens);
    const cacheCreation = objectValue(usage.cache_creation);
    const cacheCreation5mInputTokens = integerValue(cacheCreation?.ephemeral_5m_input_tokens);
    const cacheCreation1hInputTokens = integerValue(cacheCreation?.ephemeral_1h_input_tokens);
    const cacheCreationBreakdown = cacheCreation5mInputTokens + cacheCreation1hInputTokens;
    const cacheCreationInputTokens = usage.cache_creation_input_tokens !== undefined
      ? integerValue(usage.cache_creation_input_tokens)
      : cacheCreationBreakdown;
    const outputTokens = integerValue(usage.output_tokens);
    const totalTokens = inputTokens + cachedInputTokens + cacheCreationInputTokens + outputTokens;
    const complete = [usage.input_tokens, usage.output_tokens].every(isTokenCount)
      && [usage.cache_read_input_tokens, usage.cache_creation_input_tokens,
        cacheCreation?.ephemeral_5m_input_tokens, cacheCreation?.ephemeral_1h_input_tokens]
        .every(value => value === undefined || isTokenCount(value))
      && (usage.cache_creation === undefined || cacheCreation !== null)
      && cacheCreationBreakdown <= cacheCreationInputTokens
      && Number.isSafeInteger(totalTokens);
    if (totalTokens === 0 && complete) return;
    const model = normalizeClaudeModel(rawModel);
    const metadata = objectValue(root.metadata);
    const sessionID = firstString(
      root.sessionId,
      root.session_id,
      metadata?.sessionId
    ) ?? path.basename(file, path.extname(file));
    const projectPath = firstString(root.cwd, root.projectPath, metadata?.cwd, metadata?.projectPath);
    const resolvedProjectLabel = projectName(projectPath, path.basename(path.dirname(file)));
    const baseServiceTier = normalizeServiceTier(firstString(root.service_tier, root.serviceTier, metadata?.service_tier))
      ?? "standard";
    const speed = firstString(usage.speed, message.speed)?.trim().toLowerCase() ?? "standard";
    const serviceTier = speed === "fast" ? `${baseServiceTier} + fast` : baseServiceTier;
    const costInput = {
      model,
      inputTokens,
      cachedInputTokens,
      cacheCreationInputTokens,
      cacheCreation1hInputTokens,
      outputTokens,
      occurredAt: timestamp,
      speed
    };
    const messageID = firstString(message.id);
    const requestID = firstString(root.requestId, root.request_id);
    const identity = messageID
      ? JSON.stringify(requestID ? [messageID, requestID] : [sessionID, messageID])
      : requestID ? JSON.stringify([sessionID, requestID]) : null;
    records.push({
      timestamp,
      day: localDay(new Date(timestamp)),
      model,
      sessionID,
      projectPath,
      projectLabel: resolvedProjectLabel,
      serviceTier,
      inputTokens,
      cachedInputTokens,
      cacheCreationInputTokens,
      outputTokens,
      totalTokens,
      estimatedCostUSD: complete ? estimateClaudeCost(costInput, catalog) : null,
      measurement: complete ? "known" : "unknown",
      reportedModel: rawModel,
      pricingVersion: catalog.revision,
      rawTokens: numericUsageFields(usage, "usage"),
      eventIdentity: identity ? "source" : "fingerprint",
      eventKey: identity
        ? `claude|${identity}`
        : `claude|${file}|${anonymousOrdinal++}|${timestamp}`
    });
  });
  return { records, skippedLines, oversizedLines };
}

/** Retains at most maxLineBytes per record, even for a multi-megabyte tool result. */
async function scanLines(
  file: string,
  signal: AbortSignal,
  maxLineBytes: number,
  provider: AnalyticsProvider,
  onLine: (line: string, final: boolean) => void
): Promise<number> {
  let oversized = 0;
  const stream = createReadStream(file, { signal });
  let parts: Buffer[] = [];
  let length = 0;
  let retained = 0;
  let lastNonWhitespace = 0;
  const append = (part: Buffer): void => {
    length += part.length;
    for (let index = part.length - 1; index >= 0; index -= 1) {
      const byte = part[index]!;
      if (byte !== 32 && byte !== 9 && byte !== 13) { lastNonWhitespace = byte; break; }
    }
    if (retained < maxLineBytes) {
      const prefix = part.subarray(0, maxLineBytes - retained);
      parts.push(prefix);
      retained += prefix.length;
    }
  };
  const emit = (final: boolean): void => {
    const line = Buffer.concat(parts, retained).toString("utf8").replace(/\r$/u, "");
    if (length <= maxLineBytes) onLine(line, final);
    else if ((!final || lastNonWhitespace === 125) && couldContainUsage(provider, line)) oversized += 1;
    parts = []; length = 0; retained = 0; lastNonWhitespace = 0;
  };
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted();
      const buffer = chunk as Buffer;
      let start = 0;
      let end: number;
      while ((end = buffer.indexOf(10, start)) !== -1) {
        append(buffer.subarray(start, end));
        emit(false);
        start = end + 1;
      }
      append(buffer.subarray(start));
    }
    if (length > 0) emit(true);
    return oversized;
  } finally {
    stream.destroy();
  }
}

/** Read structural fields from a bounded prefix. Nested content cannot impersonate a record type. */
function couldContainUsage(provider: AnalyticsProvider, line: string): boolean {
  let type: unknown;
  let payloadType: unknown;
  visit(line, {
    onLiteralValue(value, _offset, _length, _line, _character, getPath) {
      const path = getPath();
      if (path.length === 1 && path[0] === "type") type = value;
      if (path.length === 2 && path[0] === "payload" && path[1] === "type") payloadType = value;
    }
  });
  if (type === undefined) return true;
  if (provider === "claude") return type === "assistant";
  if (type === "session_meta" || type === "turn_context" || type === "world_state") return true;
  if (type !== "event_msg") return false;
  return payloadType === undefined || payloadType === "token_count" || payloadType === "thread_settings_applied" || payloadType === "task_started";
}

function deduplicateRecords(records: UsageRecord[]): UsageRecord[] {
  const seen = new Set<string>();
  return records
    .sort((left, right) => Number(left.measurement === "unknown") - Number(right.measurement === "unknown")
      || right.timestamp.localeCompare(left.timestamp) || right.totalTokens - left.totalTokens || left.eventKey.localeCompare(right.eventKey))
    .filter((record) => {
      if (seen.has(record.eventKey)) return false;
      seen.add(record.eventKey);
      return true;
    });
}

export function buildAnalytics(
  allRecords: UsageRecord[],
  now: Date,
  historyDays: number,
  filesScanned: number,
  partial: boolean,
  source: LocalUsageAnalytics["source"] = "local_sessions",
  partialMessage = "Some local session logs were skipped or could not be read.",
  explicitCoverage?: { start: string; end: string },
  timeZone?: string
): LocalUsageAnalytics {
  timeZone ??= Intl.DateTimeFormat().resolvedOptions().timeZone;
  const requestedCoverageEnd = localCalendarDay(now, timeZone);
  const hourFormat = timeZone ? new Intl.DateTimeFormat("en", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }) : null;
  if (timeZone) allRecords = allRecords.map(record => ({ ...record, day: localCalendarDay(new Date(record.timestamp), timeZone) }));
  const requestedCoverageStart = shiftDay(requestedCoverageEnd, -(historyDays - 1));
  const inRange = allRecords.filter(record => record.day >= requestedCoverageStart && record.day <= requestedCoverageEnd);
  const unknownCount = inRange.filter(record => record.measurement === "unknown").length;
  if (unknownCount > 0 && !partial) partialMessage = `${countLabel(unknownCount, "usage entry", "usage entries")} had missing or invalid token counts. Totals include only complete entries.`;
  partial ||= unknownCount > 0;
  const records = inRange.filter(record => record.measurement !== "unknown");
  const coverageStart = explicitCoverage?.start
    ?? records.reduce<string | null>(
      (earliest, record) => earliest === null || record.day < earliest ? record.day : earliest,
      null
    )
    ?? requestedCoverageEnd;
  const coverageEnd = explicitCoverage?.end
    ?? records.reduce<string | null>(
      (latest, record) => latest === null || record.day > latest ? record.day : latest,
      null
    )
    ?? requestedCoverageEnd;
  const totals = mutableTotals();
  const days = new Map<string, MutableBreakdown>();
  const hours = new Map<string, MutableBreakdown>();
  const models = new Map<string, MutableBreakdown>();
  const modelDays = new Map<string, MutableBreakdown>();
  const projects = new Map<string, MutableProject>();
  const sessions = new Map<string, MutableSession>();
  const serviceTiers = new Map<string, MutableBreakdown>();

  for (const record of records) {
    addRecord(totals, record);
    addBreakdown(days, record.day, record.day, record);
    const timestamp = new Date(record.timestamp);
    const parts = hourFormat!.formatToParts(timestamp);
    const part = (name: string) => Number(parts.find(p => p.type === name)?.value);
    const utcStart = new Date(timestamp.valueOf() - part("minute") * 60_000 - part("second") * 1_000 - timestamp.getUTCMilliseconds()).toISOString();
    const hourKey = `${record.day}T${String(part("hour")).padStart(2, "0")}|${utcStart}`;
    addBreakdown(hours, hourKey, hourKey, record);
    addBreakdown(models, record.model, record.model, record);
    addBreakdown(modelDays, `${record.day} ${record.model}`, record.model, record);
    addBreakdown(serviceTiers, record.serviceTier, titleCase(record.serviceTier), record);

    const projectID = record.projectPath ?? record.projectLabel;
    let project = projects.get(projectID);
    if (!project) {
      project = { totals: mutableTotals(), label: record.projectLabel, path: record.projectPath, models: new Set() };
      projects.set(projectID, project);
    }
    addRecord(project.totals, record);
    project.models.add(record.model);

    let session = sessions.get(record.sessionID);
    if (!session) {
      session = {
        totals: mutableTotals(),
        label: shortSessionLabel(record.sessionID),
        lastActivity: record.timestamp,
        project: record.projectLabel === "Unknown project" ? null : record.projectLabel,
        models: new Set()
      };
      sessions.set(record.sessionID, session);
    }
    addRecord(session.totals, record);
    session.models.add(record.model);
    if (record.timestamp > session.lastActivity) session.lastActivity = record.timestamp;
  }

  const error = partial ? {
    code: "analytics_partial",
    message: partialMessage,
    retryable: true
  } satisfies ProviderFailure : null;
  const daily: UsageDailyMetric[] = [...days.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, value]) => ({ date, ...finalizeTotals(value.totals) }));
  const hourly: UsageHourlyMetric[] = [...hours.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({
      date: key.slice(0, 10),
      hour: Number(key.slice(11, 13)),
      utcStart: key.split("|")[1],
      ...finalizeTotals(value.totals)
    }));
  // Trimmed by size rather than by date so a busy model keeps its whole history when
  // the cap bites; the day- and range-scoped model mixes read from these rows.
  const dailyModels: UsageDailyModelMetric[] = [...modelDays.entries()]
    .map(([key, value]) => ({
      date: key.slice(0, 10),
      id: value.label,
      label: value.label,
      ...finalizeTotals(value.totals)
    }))
    .sort(compareUsage)
    .slice(0, MAX_DAILY_MODELS)
    .sort((left, right) => left.date.localeCompare(right.date) || compareUsage(left, right));
  const projectRows: UsageProjectBreakdown[] = [...projects.entries()]
    .map(([id, value]) => ({
      id,
      label: value.label,
      path: value.path,
      modelIDs: [...value.models].sort(),
      ...finalizeTotals(value.totals)
    }))
    .sort(compareUsage)
    .slice(0, MAX_PROJECTS);
  const sessionRows: UsageSessionBreakdown[] = [...sessions.entries()]
    .map(([id, value]) => ({
      id,
      label: value.label,
      lastActivity: value.lastActivity,
      project: value.project,
      modelIDs: [...value.models].sort(),
      ...finalizeTotals(value.totals)
    }))
    .sort((left, right) => right.lastActivity.localeCompare(left.lastActivity))
    .slice(0, MAX_SESSIONS);

  return {
    collection: {
      events: allRecords,
      parserVersion: USAGE_PARSER_VERSION,
      pricingVersion: allRecords.find(record => record.pricingVersion)?.pricingVersion ?? null,
      timeZone, coverageStart, coverageEnd,
      status: partial ? "partial" : records.length ? "available" : "no_data",
      filesScanned, recordsProcessed: records.length, reasonCode: error?.code ?? null
    },
    status: records.length === 0 ? (partial ? "partial" : "no_data") : (partial ? "partial" : "available"),
    source,
    historyDays,
    coverageStart,
    coverageEnd,
    updatedAt: now.toISOString(),
    filesScanned,
    recordsProcessed: records.length,
    totals: finalizeTotals(totals),
    today: days.has(requestedCoverageEnd)
      ? finalizeTotals(days.get(requestedCoverageEnd)?.totals ?? mutableTotals())
      : emptyTotals(),
    daily,
    hourly,
    models: finalizeBreakdowns(models, 200),
    dailyModels,
    projects: projectRows,
    sessions: sessionRows,
    serviceTiers: finalizeBreakdowns(serviceTiers, 10),
    error
  };
}

function addBreakdown(
  target: Map<string, MutableBreakdown>,
  id: string,
  label: string,
  record: UsageRecord
): void {
  let value = target.get(id);
  if (!value) {
    value = { totals: mutableTotals(), label };
    target.set(id, value);
  }
  addRecord(value.totals, record);
}

function addRecord(target: MutableTotals, record: UsageRecord): void {
  target.inputTokens += record.inputTokens;
  target.cachedInputTokens += record.cachedInputTokens;
  target.cacheCreationInputTokens += record.cacheCreationInputTokens;
  target.outputTokens += record.outputTokens;
  target.totalTokens += record.totalTokens;
  target.requests += 1;
  if (record.estimatedCostUSD === null) {
    target.unpricedTokens += record.totalTokens;
  } else {
    target.estimatedCostUSD += record.estimatedCostUSD;
    target.pricedRequests += 1;
  }
}

function finalizeBreakdowns(
  values: Map<string, MutableBreakdown>,
  limit = 200
): UsageBreakdown[] {
  return [...values.entries()]
    .map(([id, value]) => ({ id, label: value.label, ...finalizeTotals(value.totals) }))
    .sort(compareUsage)
    .slice(0, limit);
}

function compareUsage(left: UsageTotals, right: UsageTotals): number {
  const costDifference = (right.estimatedCostUSD ?? -1) - (left.estimatedCostUSD ?? -1);
  return costDifference || right.totalTokens - left.totalTokens;
}

function mutableTotals(): MutableTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requests: 0,
    estimatedCostUSD: 0,
    pricedRequests: 0,
    unpricedTokens: 0
  };
}

function finalizeTotals(value: MutableTotals): UsageTotals {
  return {
    inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens,
    cacheCreationInputTokens: value.cacheCreationInputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    requests: value.requests,
    estimatedCostUSD: value.pricedRequests > 0
      ? roundCost(value.estimatedCostUSD)
      : null,
    unpricedTokens: value.unpricedTokens
  };
}

function emptyTotals(): UsageTotals {
  return finalizeTotals(mutableTotals());
}

interface TokenTriple {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function tokenTriple(value: Record<string, unknown> | null): TokenTriple | null {
  if (!value || ![value.input_tokens, value.output_tokens].every(isTokenCount)) return null;
  const optional = [value.cached_input_tokens, value.cache_read_input_tokens, value.cache_write_input_tokens, value.cache_creation_input_tokens];
  if (!optional.every(count => count === undefined || isTokenCount(count))) return null;
  const input = integerValue(value.input_tokens);
  const cached = Math.max(integerValue(value.cached_input_tokens), integerValue(value.cache_read_input_tokens));
  const cacheWrite = Math.max(integerValue(value.cache_write_input_tokens), integerValue(value.cache_creation_input_tokens));
  const output = integerValue(value.output_tokens);
  if (cached + cacheWrite > input || !Number.isSafeInteger(input + output)) return null;
  return { input, cached, cacheWrite, output };
}

function codexDelta(last: TokenTriple | null, total: TokenTriple | null, previous: TokenTriple | null): TokenTriple | null {
  if (total && previous && equalTriple(total, previous)) return null;
  if (last && total && previous) {
    const totalDelta = subtractTriple(total, previous);
    if (
      totalDelta.input <= last.input
      && totalDelta.cached <= last.cached
      && totalDelta.cacheWrite <= last.cacheWrite
      && totalDelta.output <= last.output
    ) {
      return totalDelta;
    }
  }
  if (last) return last;
  if (total) return subtractTriple(total, previous);
  return null;
}

function subtractTriple(current: TokenTriple, previous: TokenTriple | null): TokenTriple {
  return {
    input: Math.max(0, current.input - (previous?.input ?? 0)),
    cached: Math.max(0, current.cached - (previous?.cached ?? 0)),
    cacheWrite: Math.max(0, current.cacheWrite - (previous?.cacheWrite ?? 0)),
    output: Math.max(0, current.output - (previous?.output ?? 0))
  };
}

function addTriple(previous: TokenTriple | null, delta: TokenTriple): TokenTriple {
  return {
    input: (previous?.input ?? 0) + delta.input,
    cached: (previous?.cached ?? 0) + delta.cached,
    cacheWrite: (previous?.cacheWrite ?? 0) + delta.cacheWrite,
    output: (previous?.output ?? 0) + delta.output
  };
}

function equalTriple(left: TokenTriple, right: TokenTriple): boolean {
  return left.input === right.input
    && left.cached === right.cached
    && left.cacheWrite === right.cacheWrite
    && left.output === right.output;
}

function isVertexClaudeRecord(value: Record<string, unknown>): boolean {
  const message = objectValue(value.message);
  const messageID = firstString(message?.id, value.requestId);
  const model = stringValue(message?.model);
  if (messageID?.includes("_vrtx_") || model?.includes("@")) return true;
  const metadata = JSON.stringify(value.metadata ?? "").toLowerCase();
  return metadata.includes("vertex") || metadata.includes("google_vertex");
}

function parseObject(line: string): Record<string, unknown> | null {
  try {
    return objectValue(JSON.parse(line) as unknown);
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = stringValue(value)?.trim();
    if (text) return text;
  }
  return null;
}

function integerValue(value: unknown): number {
  return isTokenCount(value) ? value : 0;
}

function dateString(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

function localDay(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDay(day: string, amount: number): string {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return localDay(date);
}

function projectName(projectPath: string | null, fallback = "Unknown project"): string {
  if (!projectPath) return fallback || "Unknown project";
  const normalized = projectPath.replace(/[\\/]+$/u, "");
  const parts = normalized.split(/[\\/]/u);
  return parts.at(-1) || fallback || "Unknown project";
}

function shortSessionLabel(sessionID: string): string {
  const clean = sessionID.replace(/^rollout-[^-]+-[^-]+-/u, "");
  return clean.length > 20 ? `${clean.slice(0, 8)}â€¦${clean.slice(-6)}` : clean;
}

function normalizeServiceTier(value: string | null): string | null {
  if (!value) return null;
  const tier = value.trim().toLowerCase().replaceAll("_", "-");
  if (tier.includes("priority") || tier.includes("fast")) return "priority";
  if (tier.includes("standard") || tier.includes("default")) return "standard";
  return tier;
}

function titleCase(value: string): string {
  return value.replaceAll("-", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Only numeric usage fields are retained. Text, messages, and other source data never enter the ledger. */
export function numericUsageFields(value: unknown, prefix = ""): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const [key, field] of Object.entries(objectValue(value) ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(key)) continue;
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof field === "number") result[name] = Number.isSafeInteger(field) && field >= 0 ? field : null;
    else if (field === null) result[name] = null;
    else if (objectValue(field) && !prefix.includes(".")) Object.assign(result, numericUsageFields(field, name));
  }
  return result;
}
