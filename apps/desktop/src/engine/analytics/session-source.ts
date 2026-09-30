import { createReadStream } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { LocalUsageAnalytics } from "@usageatlas/contracts";
import { buildAnalytics, unavailableAnalytics, type AnalyticsScanContext, type UsageRecord } from "./local-usage";
import { emptyPricingCatalog, type PricingCatalog } from "./models-dev";
import { estimateClaudeCost, estimateCodexCost } from "./pricing";
import { object, sum } from "./session-values";

export interface SessionSourceOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  maxFiles?: number;
  maxBytes?: number;
  pricingCatalogLoader?: (context: AnalyticsScanContext) => Promise<PricingCatalog>;
}
export interface SessionRoot { path: string; required?: boolean; depth: number; }
export interface SessionDiscovery { files: string[]; modified: Map<string, number>; partial: boolean; }
export interface ParsedSession { records: UsageRecord[]; partial: boolean; }

/** Only walk declared session roots, with bounds and canonical paths to avoid symlink loops. */
export async function discoverSessions(roots: SessionRoot[], accept: (name: string) => boolean,
  signal: AbortSignal, maxFiles = 5_000): Promise<SessionDiscovery> {
  const result: SessionDiscovery = { files: [], modified: new Map(), partial: false };
  const directories = new Set<string>(), files = new Set<string>();
  let entries = 0;
  const visit = async (root: SessionRoot): Promise<void> => {
    signal.throwIfAborted();
    let opened = false;
    try {
      const canonical = await realpath(root.path);
      if (directories.has(canonical)) return;
      directories.add(canonical);
      const directory = await opendir(canonical);
      opened = true;
      for await (const entry of directory) {
        signal.throwIfAborted();
        if (++entries > 50_000 || result.files.length >= maxFiles) { result.partial = true; break; }
        try {
          const filename = path.join(canonical, entry.name);
          const info = entry.isSymbolicLink() ? await stat(filename) : entry;
          if (info.isDirectory() && root.depth > 0) await visit({ path: filename, depth: root.depth - 1, required: true });
          else if (info.isFile() && accept(entry.name)) {
            const canonicalFile = await realpath(filename);
            if (!files.has(canonicalFile)) {
              const modified = (await stat(canonicalFile)).mtimeMs;
              files.add(canonicalFile); result.files.push(canonicalFile); result.modified.set(canonicalFile, modified);
            }
          }
        } catch { signal.throwIfAborted(); result.partial = true; }
      }
    } catch (error) {
      signal.throwIfAborted();
      if (opened || root.required || (error as NodeJS.ErrnoException).code !== "ENOENT") result.partial = true;
    }
  };
  for (const root of roots) await visit(root);
  return result;
}

/** A scanner stores only numeric events in memory, never prompts or tool output. */
export class SessionFileCache {
  private readonly entries = new Map<string, { signature: string; parsed: ParsedSession }>();
  private readonly cursors = new Map<string, number>();
  private retainedEvents = 0;
  async read(file: string, context: AnalyticsScanContext, budget: { bytes: number },
    parse: (row: Record<string, unknown>, line: number) => UsageRecord | null, revision: string, maxRecords = 100_000): Promise<ParsedSession> {
    const before = await stat(file);
    const signature = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}:${revision}`;
    const cached = this.entries.get(file);
    const page = new SessionRecordPage(maxRecords, this.cursors.get(file) ?? 0);
    const select = (): ParsedSession => {
      const selection = page.finish();
      if (selection.partial) this.cursors.set(file, selection.next);
      else this.cursors.delete(file);
      return { records: selection.records, partial: selection.partial };
    };
    if (cached?.signature === signature) {
      if (cached.parsed.records.length <= maxRecords) return cached.parsed;
      for (const record of cached.parsed.records) page.add(record);
      return select();
    }
    const parsed: ParsedSession = { records: [], partial: false };
    if (before.size > 256 * 1024 * 1024 || before.size > budget.bytes) return { records: [], partial: true };
    let pending = Buffer.alloc(0), skipping = false, line = 0;
    const consume = (data: Buffer): void => {
      line++;
      if (!data.toString("utf8").trim()) return;
      try {
        const row = object(JSON.parse(data.toString("utf8")));
        if (!row) throw new Error("Expected a JSON object.");
        const record = parse(row, line);
        if (record) page.add(record);
      } catch { parsed.partial = true; }
    };
    const stream = createReadStream(file, { highWaterMark: 64 * 1024, signal: context.signal });
    try {
      for await (const chunk of stream) {
        context.signal.throwIfAborted();
        const bytes = chunk as Buffer;
        budget.bytes -= bytes.length;
        if (budget.bytes < 0) { parsed.partial = true; break; }
        let start = 0;
        for (let index = 0; index < bytes.length; index++) {
          if (bytes[index] !== 10) continue;
          const piece = bytes.subarray(start, index);
          if (!skipping && pending.length + piece.length <= 4 * 1024 * 1024) consume(Buffer.concat([pending, piece]));
          else { parsed.partial = true; line++; }
          pending = Buffer.alloc(0); skipping = false; start = index + 1;
        }
        const tail = bytes.subarray(start);
        if (pending.length + tail.length > 4 * 1024 * 1024) { pending = Buffer.alloc(0); skipping = true; parsed.partial = true; }
        else if (!skipping) pending = Buffer.concat([pending, tail]);
      }
      // An active writer may not have committed this final record yet.
      if (pending.length || skipping) parsed.partial = true;
    } finally { stream.destroy(); }
    const after = await stat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs) parsed.partial = true;
    const selection = select();
    const complete = page.completeRecords();
    if (!parsed.partial && complete) {
      // Bound retained numeric history; eviction only causes a later re-read.
      this.retainedEvents -= this.entries.get(file)?.parsed.records.length ?? 0;
      if (this.entries.size >= 500 || this.retainedEvents + complete.length > 100_000) {
        this.entries.clear(); this.retainedEvents = 0;
      }
      this.entries.set(file, { signature, parsed: { records: complete, partial: false } });
      this.retainedEvents += complete.length;
    }
    parsed.records = selection.records; parsed.partial ||= selection.partial;
    return parsed;
  }
  /** Reclaim unused space reserved for other files, without rereading or advancing a page. */
  async expandComplete(file: string, maximum: number, revision: string): Promise<ParsedSession | null> {
    const entry = this.entries.get(file);
    if (!entry || entry.parsed.records.length > maximum) return null;
    try {
      const info = await stat(file);
      if (entry.signature !== `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${revision}`) return null;
      this.cursors.delete(file);
      return entry.parsed;
    } catch { return null; }
  }
  prune(files: string[]): void {
    const active = new Set(files);
    for (const [file, entry] of this.entries) if (!active.has(file)) {
      this.retainedEvents -= entry.parsed.records.length; this.entries.delete(file);
    }
    for (const file of this.cursors.keys()) if (!active.has(file)) this.cursors.delete(file);
  }
}

/** Keep the live tail and rotate a bounded older page without losing parser context.
 * Reading still starts at the header, so edits and model changes are interpreted each time. */
class SessionRecordPage {
  private count = 0;
  private complete: UsageRecord[] = [];
  private readonly older: { index: number; record: UsageRecord }[] = [];
  private readonly recent: { index: number; record: UsageRecord }[] = [];
  private readonly tailSize: number;
  constructor(private readonly limit: number, private readonly offset: number) {
    this.tailSize = Math.max(1, Math.floor(limit / 2));
  }
  add(record: UsageRecord): void {
    const index = this.count++;
    if (this.count <= 100_000) this.complete.push(record);
    else if (this.count === 100_001) this.complete = [];
    if (index >= this.offset && this.older.length < this.limit - this.tailSize) this.older.push({ index, record });
    this.recent[index % this.tailSize] = { index, record };
  }
  finish(): { records: UsageRecord[]; partial: boolean; next: number } {
    if (this.count <= this.limit) return { records: this.complete, partial: false, next: 0 };
    const selected = new Map([...this.older, ...this.recent].map(item => [item.index, item.record]));
    const next = this.older.length ? this.older[this.older.length - 1].index + 1 : 0;
    return { records: [...selected].sort(([a], [b]) => a - b).map(([, record]) => record), partial: true,
      next: next >= this.count ? 0 : next };
  }
  completeRecords(): UsageRecord[] | null { return this.count <= 100_000 ? this.complete : null; }
}

export function sessionAnalytics(parsed: ParsedSession, files: number, context: AnalyticsScanContext,
  ignoreSessionForDuplicates = false): LocalUsageAnalytics {
  const records = new Map<string, UsageRecord>(), conflicts = new Set<string>();
  for (const record of parsed.records) {
    const prior = records.get(record.eventKey);
    const comparable = (value: UsageRecord) => JSON.stringify(ignoreSessionForDuplicates ? { ...value, sessionID: "" } : value);
    if (prior && comparable(prior) !== comparable(record)) { conflicts.add(record.eventKey); parsed.partial = true; }
    // Muse event IDs survive copies to another session directory. Choose stable attribution,
    // but do not treat a different containing directory as contradictory numeric evidence.
    else if (!prior || record.sessionID < prior.sessionID) records.set(record.eventKey, record);
  }
  for (const key of conflicts) records.delete(key);
  const historyDays = Math.max(1, Math.min(366, context.historyDays ?? 90));
  let tokens = 0, costMicros = 0;
  for (const record of records.values()) {
    tokens += record.totalTokens;
    costMicros += Math.round((record.estimatedCostUSD ?? 0) * 1_000_000);
  }
  if (!Number.isSafeInteger(tokens) || !Number.isSafeInteger(costMicros)) return unavailableAnalytics(context.now, historyDays, {
    code: "analytics_overflow", message: "The recorded totals exceed the supported numeric range.", retryable: false
  });
  if (!records.size && (parsed.partial || files === 0)) return unavailableAnalytics(context.now, historyDays, {
    code: files === 0 && !parsed.partial ? "credentials_missing" : "analytics_unavailable",
    message: files === 0 && !parsed.partial ? "No local session history was found. Use this tool once, then reload."
      : "Local history could not be fully decoded. Reload after the tool finishes writing its session.", retryable: true
  });
  return buildAnalytics([...records.values()], context.now, historyDays, files, parsed.partial, "local_sessions",
    "Some session files or usage records could not be read. Totals include only validated entries.", undefined, context.timeZone);
}

export function estimateSessionCost(record: UsageRecord, catalog: PricingCatalog = emptyPricingCatalog()): number | null {
  if (record.modelProvider === "openai-codex" || record.modelProvider === "openai") return estimateCodexCost({ ...record,
    inputTokens: sum(record.inputTokens, record.cachedInputTokens, record.cacheCreationInputTokens) }, catalog);
  if (record.modelProvider === "anthropic") return estimateClaudeCost(record, catalog);
  const rate = catalog.rate(record.modelProvider ?? "", record.model);
  if (!rate || (record.cachedInputTokens > 0 && rate.cacheRead === undefined) || (record.cacheCreationInputTokens > 0 && rate.cacheWrite === undefined)) return null;
  const context = sum(record.inputTokens, record.cachedInputTokens, record.cacheCreationInputTokens);
  const tier = rate.contextTiers?.filter(t => context > t.threshold).sort((a, b) => b.threshold - a.threshold)[0];
  const above = rate.threshold !== undefined && context > rate.threshold;
  return record.inputTokens * (tier?.input ?? (above ? rate.inputAboveThreshold : undefined) ?? rate.input)
    + record.outputTokens * (tier?.output ?? (above ? rate.outputAboveThreshold : undefined) ?? rate.output)
    + record.cachedInputTokens * (tier?.cacheRead ?? (above ? rate.cacheReadAboveThreshold : undefined) ?? rate.cacheRead ?? 0)
    + record.cacheCreationInputTokens * (tier?.cacheWrite ?? (above ? rate.cacheWriteAboveThreshold : undefined) ?? rate.cacheWrite ?? 0);
}

export { object, text, counter, sum, aliases, timestamp, localRecord } from "./session-values";
