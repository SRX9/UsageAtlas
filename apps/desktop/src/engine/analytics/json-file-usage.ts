import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { LocalUsageAnalytics } from "@usageatlas/contracts";
import type { AnalyticsScanContext, UsageRecord } from "./local-usage";
import { emptyPricingCatalog, type PricingCatalog } from "./models-dev";
import {
  counter,
  discoverSessions,
  estimateSessionCost,
  localRecord,
  object,
  SessionFileCache,
  sessionAnalytics,
  sum,
  text,
  timestamp,
  type ParsedSession,
  type SessionRoot,
  type SessionSourceOptions
} from "./session-source";

/**
 * Local history for tools that keep their own transcript files.
 *
 * Each reader below follows a documented on-disk schema and keeps only numeric
 * usage: prompts, tool output and file paths never leave the parser. Unreadable
 * rows mark the scan partial instead of inventing numbers.
 */
export type JsonFileProvider = "gemini" | "qwen" | "cline" | "roo";

type RowParser = (row: Record<string, unknown>, line: number) => UsageRecord | null;

const MAX_ARRAY_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ARRAY_RECORDS = 20_000;
/** VS Code family editors whose globalStorage may hold Cline or Roo tasks. */
const EDITORS = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"] as const;

export class JsonFileUsageScanner {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly platform: NodeJS.Platform;
  private readonly cache = new SessionFileCache();
  private readonly arrays = new Map<string, { signature: string; parsed: ParsedSession }>();
  constructor(readonly provider: JsonFileProvider, private readonly options: SessionSourceOptions & {
    platform?: NodeJS.Platform;
  } = {}) {
    this.environment = options.environment ?? process.env;
    this.home = options.homeDirectory ?? homedir();
    this.platform = options.platform ?? process.platform;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const discovery = await discoverSessions(await this.roots(), name => this.accepts(name), new AbortController().signal, 1);
      return discovery.files.length > 0 || discovery.partial;
    } catch { return true; }
  }

  async scan(context: AnalyticsScanContext): Promise<LocalUsageAnalytics> {
    context.signal.throwIfAborted();
    let roots: SessionRoot[];
    try { roots = await this.roots(); } catch { return sessionAnalytics({ records: [], partial: true }, 0, context); }
    const discovery = await discoverSessions(roots, name => this.accepts(name), context.signal, 5_000);
    const limit = Math.max(1, this.options.maxFiles ?? 5_000);
    const ordered = discovery.files
      .sort((left, right) => (discovery.modified.get(right) ?? 0) - (discovery.modified.get(left) ?? 0))
      .slice(0, limit);
    const catalog = this.options.pricingCatalogLoader && discovery.files.length
      ? await this.options.pricingCatalogLoader(context).catch(() => emptyPricingCatalog())
      : emptyPricingCatalog();
    const budget = { bytes: this.options.maxBytes ?? 512 * 1024 * 1024 };
    const parsed: ParsedSession = { records: [], partial: discovery.partial || ordered.length < discovery.files.length };
    let files = 0;
    for (const file of ordered) {
      context.signal.throwIfAborted();
      if (budget.bytes <= 0) { parsed.partial = true; break; }
      try {
        const result = file.endsWith(".jsonl")
          ? await this.cache.read(file, context, budget,
            this.jsonlParser(file, discovery.modified.get(file) ?? context.now.valueOf(), catalog),
            catalog.revision, MAX_ARRAY_RECORDS)
          : await this.readArray(file, budget, this.arrayParser(file, discovery.modified.get(file) ?? context.now.valueOf(), catalog));
        parsed.records.push(...result.records);
        parsed.partial ||= result.partial;
        files++;
      } catch { context.signal.throwIfAborted(); parsed.partial = true; }
    }
    if (!discovery.partial) this.cache.prune(discovery.files);
    return sessionAnalytics(parsed, files, context);
  }

  private accepts(name: string): boolean {
    return this.provider === "cline" || this.provider === "roo" ? name === "ui_messages.json" : name.endsWith(".jsonl");
  }

  private async roots(): Promise<SessionRoot[]> {
    const env = this.environment;
    if (this.provider === "gemini" || this.provider === "qwen") {
      const override = this.provider === "gemini" ? text(env.GEMINI_DIR) : text(env.QWEN_HOME);
      const home = override ? this.absolute(override) : path.join(this.home, this.provider === "gemini" ? ".gemini" : ".qwen");
      // Gemini CLI stores chats under tmp/<project>/chats; Qwen under projects/<path>/chats.
      return [{ path: path.join(home, this.provider === "gemini" ? "tmp" : "projects"), required: !!override, depth: 4 }];
    }
    const override = this.provider === "cline" ? text(env.CLINE_GLOBAL_STORAGE) : text(env.ROO_GLOBAL_STORAGE);
    if (override) return [{ path: this.absolute(override), required: true, depth: 4 }];
    const base = this.platform === "win32"
      ? text(env.APPDATA) ?? path.join(this.home, "AppData", "Roaming")
      : this.platform === "darwin"
        ? path.join(this.home, "Library", "Application Support")
        : path.join(this.home, ".config");
    return EDITORS.map(editor => ({ path: path.join(base, editor, "User", "globalStorage"), depth: 4 }));
  }

  private absolute(value: string): string {
    const expanded = value === "~" ? this.home : value.startsWith("~/") || value.startsWith("~\\")
      ? path.join(this.home, value.slice(2)) : value;
    if (!path.isAbsolute(expanded)) throw new Error("Session directory overrides must be absolute.");
    return path.normalize(expanded);
  }

  private jsonlParser(file: string, fallbackTimestamp: number, catalog: PricingCatalog): RowParser {
    return this.provider === "gemini"
      ? geminiRowParser(file, fallbackTimestamp, catalog)
      : qwenRowParser(file, fallbackTimestamp, catalog);
  }

  private arrayParser(file: string, fallbackTimestamp: number, catalog: PricingCatalog): RowParser {
    if (this.provider !== "cline" && this.provider !== "roo") throw new Error("Not a task transcript provider.");
    return clineRowParser(this.provider, file, fallbackTimestamp, catalog);
  }

  /** `ui_messages.json` is one pretty-printed array, not a line-delimited stream. */
  private async readArray(file: string, budget: { bytes: number }, parse: RowParser): Promise<ParsedSession> {
    const before = await stat(file);
    const signature = `${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
    const cached = this.arrays.get(file);
    if (cached?.signature === signature) return cached.parsed;
    if (before.size > MAX_ARRAY_FILE_BYTES || before.size > budget.bytes) return { records: [], partial: true };
    const raw = await readFile(file, "utf8");
    budget.bytes -= before.size;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return { records: [], partial: true }; }
    const rows = Array.isArray(value)
      ? value
      : object(value)?.uiMessages as unknown[] | undefined;
    if (!Array.isArray(rows)) return { records: [], partial: true };
    const parsed: ParsedSession = { records: [], partial: false };
    for (const [index, row] of rows.entries()) {
      if (index >= MAX_ARRAY_RECORDS) { parsed.partial = true; break; }
      try {
        const record = object(row) ? parse(object(row)!, index + 1) : null;
        if (record) parsed.records.push(record);
      } catch { parsed.partial = true; }
    }
    if (!parsed.partial) this.arrays.set(file, { signature, parsed });
    return parsed;
  }
}

/**
 * Gemini CLI chat record: model messages carry `tokens.{input,output,cached,
 * thoughts,tool,total}`. `total` is authoritative when present, so the cached
 * share can be separated from the rest of the prompt without double counting.
 */
export function geminiRowParser(file: string, fallbackTimestamp: number, catalog = emptyPricingCatalog()): RowParser {
  const session = path.basename(path.dirname(path.dirname(file)));
  let sessionId: string | null = null;
  let project: string | null = null;
  return (row, line) => {
    const declared = text(row.sessionId);
    if (declared) sessionId = declared;
    if (text(row.projectHash) && !project) project = text(row.projectHash);
    if (row.type !== "gemini" && row.type !== "model") return null;
    const tokens = object(row.tokens) ?? object(object(row.message)?.tokens);
    if (!tokens) return null;
    const output = sum(counter(tokens.output), optionalCounter(tokens.thoughts));
    const reportedTotal = tokens.total === undefined ? null : counter(tokens.total);
    const cached = optionalCounter(tokens.cached);
    const prompt = reportedTotal === null ? sum(counter(tokens.input), cached) : Math.max(0, reportedTotal - output);
    const cacheRead = Math.min(cached, prompt);
    const input = prompt - cacheRead;
    const rawModel = text(row.model) ?? text(object(row.message)?.model) ?? "gemini";
    const identity = text(row.id) ?? text(row.uuid);
    return record({
      provider: "gemini", file, line, session: sessionId ?? session, project,
      timestamp: resolveTimestamp(row.timestamp ?? row.startTime ?? object(row.message)?.timestamp, fallbackTimestamp),
      model: rawModel, modelProvider: "google", total: reportedTotal,
      input, cacheRead, cacheWrite: 0, output,
      raw: { input: counter(tokens.input), output: counter(tokens.output), cacheRead: cached,
        reasoning: optionalCounter(tokens.thoughts), tool: optionalCounter(tokens.tool),
        total: reportedTotal },
      identity, catalog
    });
  };
}

/**
 * Qwen Code chat record: assistant messages carry Gemini-style
 * `usageMetadata.promptTokenCount / candidatesTokenCount / totalTokenCount`.
 */
export function qwenRowParser(file: string, fallbackTimestamp: number, catalog = emptyPricingCatalog()): RowParser {
  const session = path.basename(path.dirname(path.dirname(file)));
  let sessionId: string | null = null;
  let project: string | null = null;
  return (row, line) => {
    if (text(row.sessionId)) sessionId = text(row.sessionId);
    if (text(row.cwd)) project = text(row.cwd);
    const usage = object(row.usageMetadata) ?? object(object(row.message)?.usageMetadata);
    if (!usage) return null;
    const prompt = counter(usage.promptTokenCount);
    const output = counter(usage.candidatesTokenCount);
    const cached = usage.cachedContentTokenCount === undefined ? 0 : counter(usage.cachedContentTokenCount);
    const reportedTotal = usage.totalTokenCount === undefined ? null : counter(usage.totalTokenCount);
    const cacheRead = Math.min(cached, prompt);
    const input = prompt - cacheRead;
    const computed = sum(input, cacheRead, output);
    if (reportedTotal !== null && reportedTotal !== computed) throw new Error("Inconsistent Qwen totals.");
    const rawModel = text(row.model) ?? text(object(row.message)?.model) ?? "qwen";
    return record({
      provider: "qwen", file, line, session: sessionId ?? session, project,
      timestamp: resolveTimestamp(row.timestamp ?? object(row.message)?.timestamp, fallbackTimestamp),
      model: rawModel, modelProvider: "alibaba", total: reportedTotal,
      input, cacheRead, cacheWrite: 0, output,
      raw: { input: prompt, output, cacheRead, total: reportedTotal },
      identity: text(row.uuid) ?? text(row.id), catalog
    });
  };
}

/**
 * Cline and Roo Code task transcripts. `api_req_started` messages carry their
 * request info as a JSON string in `text`, with `tokensIn`, `tokensOut`,
 * `cacheWrites` and `cacheReads`. Roo keeps the same layout.
 */
export function clineRowParser(
  provider: "cline" | "roo",
  file: string,
  fallbackTimestamp: number,
  catalog = emptyPricingCatalog()
): RowParser {
  const task = path.basename(path.dirname(file));
  return (row, line) => {
    const say = text(row.say) ?? text(row.type);
    if (say !== "api_req_started") return null;
    const info = parseRequestInfo(row.text);
    if (!info) return null;
    const input = counter(info.tokensIn);
    const output = counter(info.tokensOut);
    const cacheRead = info.cacheReads === undefined ? 0 : counter(info.cacheReads);
    const cacheWrite = info.cacheWrites === undefined ? 0 : counter(info.cacheWrites);
    if (input + output + cacheRead + cacheWrite === 0) return null;
    const rawModel = text(object(row.modelInfo)?.modelId) ?? text(object(row.modelInfo)?.id)
      ?? text(row.modelId) ?? text(row.apiConfigName) ?? "unknown";
    return record({
      provider, file, line, session: task, project: null,
      timestamp: resolveTimestamp(row.ts, fallbackTimestamp),
      model: rawModel, modelProvider: inferModelProvider(rawModel), total: null,
      input, cacheRead, cacheWrite, output,
      raw: { input, output, cacheRead, cacheWrite,
        cost: typeof info.cost === "number" && Number.isFinite(info.cost) ? info.cost : null },
      identity: null, catalog
    });
  };
}

function record(values: {
  provider: JsonFileProvider;
  file: string;
  line: number;
  session: string;
  project: string | null;
  timestamp: string;
  model: string;
  modelProvider: string | null;
  total: number | null;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  raw: Record<string, number | null>;
  identity: string | null;
  catalog: PricingCatalog;
}): UsageRecord {
  const identity = values.identity
    ? `${values.provider}|${values.session}|${values.identity}`
    : `${values.provider}|${createHash("sha256").update(`${path.resolve(values.file)}|${values.line}`).digest("hex")}`;
  const usage = localRecord({
    timestamp: values.timestamp,
    model: values.model,
    reportedModel: values.model,
    modelProvider: values.modelProvider ?? undefined,
    sessionID: values.session,
    projectPath: values.project,
    projectLabel: values.project ? path.basename(values.project.replaceAll("\\", "/")) : "Unknown project",
    eventKey: identity,
    eventIdentity: values.identity ? "source" : "fingerprint",
    inputTokens: values.input,
    cachedInputTokens: values.cacheRead,
    cacheCreationInputTokens: values.cacheWrite,
    outputTokens: values.output,
    rawTokens: { ...values.raw, total: values.total },
    pricingVersion: values.catalog.revision
  });
  usage.estimatedCostUSD = estimateSessionCost(usage, values.catalog);
  return usage;
}

function parseRequestInfo(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    if (!value.trim() || value.trim() === "{}") return null;
    try { return object(JSON.parse(value)); } catch { return null; }
  }
  return object(value);
}

function optionalCounter(value: unknown): number {
  return value === undefined || value === null ? 0 : counter(value);
}

function resolveTimestamp(value: unknown, fallback: number): string {
  try { return timestamp(value); } catch { return new Date(fallback).toISOString(); }
}

/** Models.dev prices are keyed by vendor; Cline lets any model through, so infer it. */
function inferModelProvider(model: string): string | null {
  const name = model.toLowerCase();
  if (name.startsWith("claude")) return "anthropic";
  if (/^(gpt|o[1-9]|codex)/u.test(name)) return "openai";
  if (name.startsWith("gemini")) return "google";
  if (name.startsWith("qwen")) return "alibaba";
  if (name.startsWith("deepseek")) return "deepseek";
  if (name.startsWith("grok")) return "xai";
  if (name.startsWith("kimi") || name.startsWith("moonshot")) return "moonshotai";
  return null;
}

