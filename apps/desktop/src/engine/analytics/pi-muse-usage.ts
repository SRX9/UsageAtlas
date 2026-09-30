import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { LocalUsageAnalytics } from "@usageatlas/contracts";
import type { AnalyticsScanContext, UsageRecord } from "./local-usage";
import { emptyPricingCatalog, type PricingCatalog } from "./models-dev";
import { normalizeClaudeModel, normalizeCodexModel } from "./pricing";
import { aliases, counter, discoverSessions, estimateSessionCost, localRecord, object,
  SessionFileCache, sessionAnalytics, sum, text, timestamp, type SessionRoot, type SessionSourceOptions } from "./session-source";

export type JsonSessionProvider = "pi" | "muse";

export class JsonSessionUsageScanner {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly cache = new SessionFileCache();
  private nextFile: string | null = null;
  constructor(readonly provider: JsonSessionProvider, private readonly options: SessionSourceOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.home = options.homeDirectory ?? homedir();
  }
  private roots(): Promise<SessionRoot[]> { return sessionRoots(this.provider, this.environment, this.home); }
  async isAvailable(): Promise<boolean> {
    try {
      const discovery = await discoverSessions(await this.roots(), name => this.accepts(name), new AbortController().signal, 1);
      return discovery.files.length > 0 || discovery.partial;
    } catch { return true; }
  }
  private accepts(name: string): boolean { return this.provider === "muse" ? name === "session.jsonl" : name.endsWith(".jsonl"); }
  async scan(context: AnalyticsScanContext): Promise<LocalUsageAnalytics> {
    context.signal.throwIfAborted();
    let roots: SessionRoot[];
    try { roots = await this.roots(); } catch { return sessionAnalytics({ records: [], partial: true }, 0, context); }
    // Discovery has its own entry bound. The per-refresh file budget is applied after
    // choosing a recent source and the next historical batch, so it can advance.
    const discovery = await discoverSessions(roots, name => this.accepts(name), context.signal, 50_000);
    const candidates = discovery.files.sort();
    const positions = new Map(candidates.map((file, index) => [file, index]));
    const limit = Math.max(1, this.options.maxFiles ?? 5_000);
    let start = this.nextFile ? candidates.findIndex(file => file >= this.nextFile!) : 0;
    if (start < 0) start = 0;
    const latest = candidates.reduce<string | null>((chosen, file) => chosen === null
      || discovery.modified.get(file)! >= discovery.modified.get(chosen)! ? file : chosen, null);
    const ordered = [...new Set([...(latest && limit > 1 ? [latest] : []), ...candidates.slice(start), ...candidates.slice(0, start)])];
    // Muse has no monetary data or known API-equivalent price. Never fetch prices for it.
    const catalog = this.provider === "pi" && discovery.files.length && this.options.pricingCatalogLoader
      ? await this.options.pricingCatalogLoader(context).catch(() => emptyPricingCatalog()) : emptyPricingCatalog();
    const parsed = { records: [] as UsageRecord[], partial: discovery.partial };
    const budget = { bytes: this.options.maxBytes ?? 512 * 1024 * 1024 };
    let files = 0, visited = 0;
    let latestPartial = false, latestRecords = 0;
    for (const file of ordered) {
      context.signal.throwIfAborted();
      const remaining = 100_000 - parsed.records.length;
      if (visited >= limit || remaining < 2 || budget.bytes <= 0) break;
      try {
        const parser = this.provider === "pi" ? piSessionParser(file, catalog) : museSessionParser(file);
        // Reserve room for older files even when the active session is very large.
        const records = visited === 0 && ordered.length > 1 ? Math.floor(remaining / 2) : remaining;
        const result = await this.cache.read(file, context, budget, parser, catalog.revision, records);
        parsed.records.push(...result.records); files++;
        if (visited === 0 && file === latest && limit > 1) {
          latestPartial = result.partial; latestRecords = result.records.length;
        } else parsed.partial ||= result.partial;
      } catch { context.signal.throwIfAborted(); parsed.partial = true; }
      visited++;
      if (file !== latest || limit === 1) this.nextFile = candidates[(positions.get(file)! + 1) % candidates.length];
    }
    if (latestPartial && latest && visited === candidates.length) {
      const expanded = await this.cache.expandComplete(latest, 100_000 - parsed.records.length + latestRecords, catalog.revision);
      if (expanded) { parsed.records = [...expanded.records, ...parsed.records.slice(latestRecords)]; latestPartial = false; }
    }
    parsed.partial ||= latestPartial;
    parsed.partial ||= visited < candidates.length;
    if (!discovery.partial) this.cache.prune(discovery.files);
    return sessionAnalytics(parsed, files, context, this.provider === "muse");
  }
}

function selectedPath(value: string, home: string): string {
  const expanded = value === "~" ? home : value.startsWith("~/") || value.startsWith("~\\") ? path.join(home, value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) throw new Error("Session directory overrides must be absolute.");
  return path.normalize(expanded);
}

export async function sessionRoots(provider: JsonSessionProvider, env: NodeJS.ProcessEnv, home: string): Promise<SessionRoot[]> {
  const dataHome = text(env.XDG_DATA_HOME) ? selectedPath(env.XDG_DATA_HOME!, home) : path.join(home, ".local", "share");
  if (provider === "muse") return [{ path: text(env.MUSE_SESSIONS_DIR) ? selectedPath(env.MUSE_SESSIONS_DIR!, home)
    : path.join(dataHome, "muse", "sessions"), required: !!text(env.MUSE_SESSIONS_DIR), depth: 4 }];
  if (text(env.PI_CODING_AGENT_SESSION_DIR)) return [{ path: selectedPath(env.PI_CODING_AGENT_SESSION_DIR!, home), required: true, depth: 3 }];
  const customAgent = text(env.PI_CODING_AGENT_DIR);
  const pi = { path: path.join(customAgent ? selectedPath(customAgent, home) : path.join(home, ".pi", "agent"), "sessions"), required: !!customAgent, depth: 3 };
  const configName = text(env.PI_CONFIG_DIR) ?? ".omp";
  const config = path.resolve(home, configName);
  const relative = path.relative(home, config);
  if (path.isAbsolute(configName) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("Invalid OMP configuration root.");
  const profile = text(env.OMP_PROFILE ?? env.PI_PROFILE);
  if (profile && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) throw new Error("Invalid OMP profile.");
  const parents = [path.join(config, "profiles"), path.join(dataHome, "omp", "profiles")];
  const roots: SessionRoot[] = [pi];
  if (!profile || profile === "default") {
    if (!customAgent) roots.push({ path: path.join(config, "agent", "sessions"), depth: 3 }, { path: path.join(dataHome, "omp", "sessions"), depth: 3 });
  }
  for (const parent of parents) {
    let names: string[] = [];
    if (profile && profile !== "default") names = [profile];
    else if (!profile && !customAgent) {
      try { names = (await readdir(parent, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    for (const name of names) roots.push({ path: path.join(parent, name, "sessions"), depth: 3 }, { path: path.join(parent, name, "agent", "sessions"), depth: 3 });
  }
  if (profile && profile !== "default") {
    // Either named-profile layout may exist; do not mark its absent sibling as lost history.
    const profileRoots = roots.slice(1);
    const present = await discoverSessions(profileRoots, name => name.endsWith(".jsonl"), new AbortController().signal, 1);
    if (!present.files.length) throw new Error("Selected OMP profile has no readable sessions.");
  }
  return roots;
}

export function piSessionParser(file: string, catalog: PricingCatalog = emptyPricingCatalog()): (row: Record<string, unknown>, line: number) => UsageRecord | null {
  let sessionID: string | null = null, project: string | null = null, modelContext: string | null = null, providerContext: string | null = null;
  return (row, line) => {
    if (row.type === "session") {
      sessionID = text(row.id) ?? text(row.sessionId) ?? text(row.session_id);
      project = text(row.cwd); return null;
    }
    if (row.type === "model_change") { modelContext = text(row.modelId) ?? text(row.model); providerContext = text(row.provider); return null; }
    const message = object(row.message);
    if (row.type !== "message" || message?.role !== "assistant") return null;
    const provider = text(message.provider) ?? text(row.provider) ?? providerContext;
    if (provider !== "anthropic" && provider !== "openai-codex") throw new Error("Unsupported Pi backend.");
    const usage = object(message.usage);
    if (!usage) throw new Error("Missing assistant usage.");
    const input = aliases(usage, ["input", "inputTokens", "input_tokens", "promptTokens", "prompt_tokens"], true);
    const output = aliases(usage, ["output", "outputTokens", "output_tokens", "completionTokens", "completion_tokens"], true);
    const cacheRead = aliases(usage, ["cacheRead", "cacheReadTokens", "cache_read", "cache_read_tokens", "cacheReadInputTokens", "cache_read_input_tokens"]);
    const cacheWrite = aliases(usage, ["cacheWrite", "cacheWriteTokens", "cache_write", "cache_write_tokens", "cacheCreationTokens", "cache_creation_tokens", "cacheCreationInputTokens", "cache_creation_input_tokens"]);
    const total = sum(input, output, cacheRead, cacheWrite);
    const reportedTotalKeys = ["totalTokens", "total_tokens", "tokenCount", "token_count", "tokens"];
    if (reportedTotalKeys.some(key => usage[key] !== undefined) && aliases(usage, reportedTotalKeys) !== total) throw new Error("Inconsistent Pi totals.");
    const rawModel = text(message.model) ?? text(message.modelId) ?? text(row.model) ?? text(row.modelId)
      ?? (provider === providerContext ? modelContext : null) ?? "unknown";
    const model = provider === "anthropic" ? normalizeClaudeModel(rawModel) : normalizeCodexModel(rawModel);
    const id = text(row.id) ?? text(row.entryId) ?? text(row.entry_id);
    const identity = sessionID && id ? "source" : "fingerprint";
    const session = sessionID ?? `file:${path.basename(file)}`;
    const fallback = createHash("sha256").update(`${path.resolve(file)}|${line}`).digest("hex");
    const record = localRecord({ timestamp: timestamp(message.timestamp ?? row.timestamp), model, reportedModel: rawModel, modelProvider: provider,
      sessionID: session, projectPath: project, projectLabel: project ? path.basename(project.replaceAll("\\", "/")) : "Unknown project",
      eventKey: `pi|${session}|${identity === "source" ? id : fallback}`, eventIdentity: identity,
      inputTokens: input, cachedInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite, outputTokens: output,
      rawTokens: { input, output, cacheRead, cacheWrite, total: reportedTotalKeys.some(key => usage[key] !== undefined) ? aliases(usage, reportedTotalKeys) : null },
      // Pi's usage.cost is itself an API-price estimate, not a billed charge.
      pricingVersion: catalog.revision });
    record.estimatedCostUSD = estimateSessionCost(record, catalog);
    return record;
  };
}

export function museSessionParser(file: string): (row: Record<string, unknown>) => UsageRecord | null {
  const sessionID = path.basename(path.dirname(file));
  return row => {
    if (row.schema_version !== 1 || row.record_type !== "event" || row.payload_type !== "runtime.session" || row.payload_schema_version !== 1) throw new Error("Unsupported Muse schema.");
    const event = object(object(row.payload)?.event);
    if (!event) throw new Error("Missing Muse event.");
    if (["resource_usage_sampled", "workflow_child_lifecycle", "goal_usage_attribution"].includes(String(event.kind))) return null;
    if (event.kind !== "model_completed" && event.kind !== "automated_review_completed") {
      if (JSON.stringify(event).match(/"(?:input_tokens|output_tokens|total_tokens|cached_tokens|cached_input_tokens|cache_read_tokens|cache_write_tokens|reasoning_tokens)"/)) throw new Error("Unknown Muse usage event.");
      return null;
    }
    const usage = object(event.usage), id = text(row.id);
    if (!usage || !id) throw new Error("Missing Muse usage identity.");
    const input = counter(usage.input_tokens), output = counter(usage.output_tokens);
    const cacheRead = aliases(usage, ["cache_read_tokens", "cached_input_tokens", "cached_tokens"]);
    const cacheWrite = aliases(usage, ["cache_write_tokens"]), reasoning = aliases(usage, ["reasoning_tokens"]);
    if (sum(cacheRead, cacheWrite) > input || reasoning > output || (usage.total_tokens !== undefined && counter(usage.total_tokens) !== sum(input, output))) throw new Error("Inconsistent Muse totals.");
    // Muse timestamps are microseconds. Preserve numeric provenance, bucket at millisecond precision.
    const time = counter(row.recorded_at);
    if (time <= 0 || time / 1000 > 253402300799999) throw new Error("Invalid Muse timestamp.");
    const model = text(event.model) ?? text(object(event.model)?.model_id) ?? "unknown";
    return localRecord({ timestamp: new Date(Math.floor(time / 1000)).toISOString(), model, sessionID, modelProvider: "meta",
      eventKey: `muse|${id}`, inputTokens: input - cacheRead - cacheWrite, cachedInputTokens: cacheRead,
      cacheCreationInputTokens: cacheWrite, outputTokens: output,
      rawTokens: { input, output, cacheRead, cacheWrite, reasoning, total: usage.total_tokens === undefined ? null : counter(usage.total_tokens) } });
  };
}
