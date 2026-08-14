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
import { createInterface } from "node:readline";
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

export interface UsageRecord {
  timestamp: string;
  day: string;
  model: string;
  sessionID: string;
  projectPath: string | null;
  projectLabel: string;
  serviceTier: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUSD: number | null;
  eventKey: string;
}

interface ParsedFile {
  records: UsageRecord[];
  skippedLines: number;
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
/** Model × day rows, trimmed smallest-first so the busiest models keep every day. */
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
      return unavailableAnalytics(context.now, this.historyDays, {
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
      skippedLines
    };
    const gapMessage = scanGapMessage(gaps, this.maxFiles);
    return buildAnalytics(
      records,
      context.now,
      this.historyDays,
      discovery.files.length,
      gapMessage !== null,
      "local_sessions",
      gapMessage ?? undefined
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
    return `More than ${maxFiles.toLocaleString("en-US")} session files were found, so the oldest ones were not scanned. Delete or archive old session logs to bring the full history back.`;
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
  if (reasons.length === 0) return null;
  return `${capitalize(joinReasons(reasons))}. This usually clears on the next refresh; if it does not, those logs are damaged and deleting them restores the rest of the history.`;
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
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
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
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
        const candidate = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(candidate);
        } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".jsonl") {
          files.push(candidate);
        }
      }
    } catch (error) {
      if (!isMissing(error)) errors += 1;
    } finally {
      await handle.close().catch(() => undefined);
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
  let currentTier = "standard";
  let currentTurnID: string | null = null;
  let sessionID = path.basename(file, path.extname(file));
  let projectPath: string | null = null;
  let previousTotal: TokenTriple | null = null;
  let skippedLines = 0;
  const records: UsageRecord[] = [];

  await scanLines(file, signal, maxLineBytes, (line, final) => {
    if (
      !line.includes("session_meta")
      && !line.includes("turn_context")
      && !line.includes("event_msg")
      && !line.includes("world_state")
    ) return;
    const root = parseObject(line);
    if (!root) {
      // The active session file can end mid-entry while the tool is still writing it.
      if (!final) skippedLines += 1;
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
      if (model !== null) currentModel = normalizeCodexModel(model);
      currentTier = normalizeServiceTier(firstString(state?.service_tier, payload?.service_tier)) ?? currentTier;
      return;
    }
    if (type === "turn_context") {
      const info = objectValue(payload?.info);
      const model = firstString(payload?.model, payload?.model_name, info?.model, info?.model_name);
      if (model !== null) currentModel = normalizeCodexModel(model);
      currentTier = normalizeServiceTier(firstString(payload?.service_tier, payload?.serviceTier, info?.service_tier))
        ?? currentTier;
      return;
    }
    if (type !== "event_msg" || !payload) return;
    const payloadType = stringValue(payload.type);
    if (payloadType === "thread_settings_applied") {
      const settings = objectValue(payload.thread_settings);
      const model = firstString(settings?.model);
      if (model !== null) currentModel = normalizeCodexModel(model);
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
    const last = tokenTriple(objectValue(info.last_token_usage));
    const total = tokenTriple(objectValue(info.total_token_usage));
    const delta = codexDelta(last, total, previousTotal);
    if (total) previousTotal = total;
    else if (last) previousTotal = addTriple(previousTotal, last);
    if (!delta || delta.input + delta.output === 0) return;
    const timestamp = dateString(root.timestamp);
    if (!timestamp) return;
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
      eventKey: `codex|${timestamp}|${turnID ?? ""}|${model}|${tier}|${delta.input}|${cached}|${cacheCreation}|${delta.output}`
    });
  });

  return {
    records: records.map((record) => ({
      ...record,
      sessionID,
      projectPath,
      projectLabel: projectName(projectPath)
    })),
    skippedLines
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
  await scanLines(file, signal, maxLineBytes, (line, final) => {
    if (!line.includes("\"assistant\"") || !line.includes("\"usage\"")) return;
    const root = parseObject(line);
    if (!root) {
      // The active session file can end mid-entry while the tool is still writing it.
      if (!final) skippedLines += 1;
      return;
    }
    if (stringValue(root.type) !== "assistant" || isVertexClaudeRecord(root)) return;
    const message = objectValue(root.message);
    const usage = objectValue(message?.usage);
    const timestamp = dateString(root.timestamp);
    const rawModel = stringValue(message?.model);
    if (!message || !usage || !timestamp || !rawModel) return;
    const inputTokens = integerValue(usage.input_tokens);
    const cachedInputTokens = integerValue(usage.cache_read_input_tokens);
    const cacheCreation = objectValue(usage.cache_creation);
    const cacheCreation5mInputTokens = integerValue(cacheCreation?.ephemeral_5m_input_tokens);
    const cacheCreation1hInputTokens = integerValue(cacheCreation?.ephemeral_1h_input_tokens);
    const cacheCreationBreakdown = cacheCreation5mInputTokens + cacheCreation1hInputTokens;
    const cacheCreationInputTokens = cacheCreationBreakdown > 0
      ? cacheCreationBreakdown
      : integerValue(usage.cache_creation_input_tokens);
    const outputTokens = integerValue(usage.output_tokens);
    const totalTokens = inputTokens + cachedInputTokens + cacheCreationInputTokens + outputTokens;
    if (totalTokens === 0) return;
    const model = normalizeClaudeModel(rawModel);
    const metadata = objectValue(root.metadata);
    const sessionID = firstString(
      root.sessionId,
      root.session_id,
      metadata?.sessionId,
      message.id
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
    const messageID = firstString(message.id, root.requestId, root.request_id);
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
      estimatedCostUSD: estimateClaudeCost(costInput, catalog),
      eventKey: messageID
        ? `claude|${messageID}`
        : `claude|${timestamp}|${model}|${speed}|${inputTokens}|${cachedInputTokens}|${cacheCreationInputTokens}|${cacheCreation1hInputTokens}|${outputTokens}`
    });
  });
  return { records, skippedLines };
}

/** Reads a JSONL file line by line, flagging the last line so callers can treat it as an in-progress write. */
async function scanLines(
  file: string,
  signal: AbortSignal,
  maxLineBytes: number,
  onLine: (line: string, final: boolean) => void
): Promise<void> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const emit = (line: string, final: boolean): void => {
    if (Buffer.byteLength(line, "utf8") <= maxLineBytes) onLine(line, final);
  };
  let pending: string | null = null;
  try {
    for await (const line of lines) {
      signal.throwIfAborted();
      if (pending !== null) emit(pending, false);
      pending = line;
    }
    if (pending !== null) emit(pending, true);
  } finally {
    lines.close();
    stream.destroy();
  }
}

function deduplicateRecords(records: UsageRecord[]): UsageRecord[] {
  const seen = new Set<string>();
  return records
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.eventKey.localeCompare(right.eventKey))
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
  explicitCoverage?: { start: string; end: string }
): LocalUsageAnalytics {
  const requestedCoverageEnd = localDay(now);
  const requestedCoverageStart = shiftDay(requestedCoverageEnd, -(historyDays - 1));
  const records = allRecords.filter(
    (record) => record.day >= requestedCoverageStart && record.day <= requestedCoverageEnd
  );
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
    const hourKey = `${record.day}T${String(new Date(record.timestamp).getHours()).padStart(2, "0")}`;
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
    .map(([date, value]) => ({ date, ...finalizeTotals(value.totals, partial) }));
  const hourly: UsageHourlyMetric[] = [...hours.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({
      date: key.slice(0, 10),
      hour: Number(key.slice(11)),
      ...finalizeTotals(value.totals, partial)
    }));
  // Trimmed by size rather than by date so a busy model keeps its whole history when
  // the cap bites; the day- and range-scoped model mixes read from these rows.
  const dailyModels: UsageDailyModelMetric[] = [...modelDays.entries()]
    .map(([key, value]) => ({
      date: key.slice(0, 10),
      id: value.label,
      label: value.label,
      ...finalizeTotals(value.totals, partial)
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
      ...finalizeTotals(value.totals, partial)
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
      ...finalizeTotals(value.totals, partial)
    }))
    .sort((left, right) => right.lastActivity.localeCompare(left.lastActivity))
    .slice(0, MAX_SESSIONS);

  return {
    status: records.length === 0 ? (partial ? "partial" : "no_data") : (partial ? "partial" : "available"),
    source,
    historyDays,
    coverageStart,
    coverageEnd,
    updatedAt: now.toISOString(),
    filesScanned,
    recordsProcessed: records.length,
    totals: finalizeTotals(totals, partial),
    today: days.has(requestedCoverageEnd)
      ? finalizeTotals(days.get(requestedCoverageEnd)?.totals ?? mutableTotals(), partial)
      : emptyTotals(),
    daily,
    hourly,
    models: finalizeBreakdowns(models, 200, partial),
    dailyModels,
    projects: projectRows,
    sessions: sessionRows,
    serviceTiers: finalizeBreakdowns(serviceTiers, 10, partial),
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
  limit = 200,
  suppressCost = false
): UsageBreakdown[] {
  return [...values.entries()]
    .map(([id, value]) => ({ id, label: value.label, ...finalizeTotals(value.totals, suppressCost) }))
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

function finalizeTotals(value: MutableTotals, suppressCost = false): UsageTotals {
  return {
    inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens,
    cacheCreationInputTokens: value.cacheCreationInputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    requests: value.requests,
    estimatedCostUSD: !suppressCost && value.pricedRequests > 0
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

function tokenTriple(value: Record<string, unknown> | null): TokenTriple | null {
  if (!value) return null;
  return {
    input: integerValue(value.input_tokens),
    cached: integerValue(value.cached_input_tokens ?? value.cache_read_input_tokens),
    cacheWrite: integerValue(value.cache_write_input_tokens ?? value.cache_creation_input_tokens),
    output: integerValue(value.output_tokens)
  };
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
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
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
  return clean.length > 20 ? `${clean.slice(0, 8)}…${clean.slice(-6)}` : clean;
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
