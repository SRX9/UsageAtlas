import { homedir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { LocalUsageAnalytics } from "@usageatlas/contracts";
import type { AnalyticsScanContext } from "./local-usage";
import { emptyPricingCatalog } from "./models-dev";
import type { AntigravityDatabaseResult } from "./antigravity-database";
import { discoverSessions, estimateSessionCost, sessionAnalytics, text, type SessionRoot, type SessionSourceOptions } from "./session-source";

export interface AntigravitySourceOptions extends SessionSourceOptions { workerPath?: string; }

export function antigravityRoots(options: SessionSourceOptions = {}): SessionRoot[] {
  const env = options.environment ?? process.env, home = options.homeDirectory ?? homedir();
  const override = text(env.GEMINI_CLI_HOME);
  const root = override?.startsWith("~/") || override?.startsWith("~\\") ? path.join(home, override.slice(2)) : override ?? path.join(home, ".gemini");
  if (!path.isAbsolute(root)) throw new Error("GEMINI_CLI_HOME must be absolute.");
  return [path.join(root, "antigravity-cli", "conversations"), path.join(root, "antigravity"), path.join(root, "antigravity", "conversations")]
    .map(directory => ({ path: directory, depth: 0 }));
}

export class AntigravityUsageScanner {
  private nextFile: string | null = null;
  private recentFirst = true;
  constructor(private readonly options: AntigravitySourceOptions = {}) {}
  async isAvailable(): Promise<boolean> {
    try {
      const found = await discoverSessions(antigravityRoots(this.options), name => name.endsWith(".db"), new AbortController().signal, 1);
      return found.files.length > 0 || found.partial;
    } catch { return true; }
  }
  async scan(context: AnalyticsScanContext): Promise<LocalUsageAnalytics> {
    context.signal.throwIfAborted();
    let roots: SessionRoot[];
    try { roots = antigravityRoots(this.options); } catch { return sessionAnalytics({ records: [], partial: true }, 0, context); }
    const found = await discoverSessions(roots, name => name.endsWith(".db"), context.signal, 50_000);
    const candidates = found.files.sort();
    const positions = new Map(candidates.map((file, index) => [file, index]));
    const limit = Math.max(1, this.options.maxFiles ?? 500);
    let start = this.nextFile ? candidates.findIndex(file => file >= this.nextFile!) : 0;
    if (start < 0) start = 0;
    const latest = candidates.reduce<string | null>((chosen, file) => chosen === null
      || found.modified.get(file)! >= found.modified.get(chosen)! ? file : chosen, null);
    const archive = [...candidates.slice(start), ...candidates.slice(0, start)].filter(file => limit === 1 || file !== latest);
    const selected = limit === 1 ? archive.slice(0, 1)
      : this.recentFirst ? [latest!, ...archive.slice(0, limit - 1)].filter(Boolean)
        : [archive[0], latest!, ...archive.slice(1, limit - 1)].filter(Boolean);
    let parsed: AntigravityDatabaseResult = { records: [], partial: found.partial, files: 0, visited: 0 };
    if (selected.length) {
      try {
        parsed = await readInWorker(selected, this.options, context.signal);
        parsed.partial ||= found.partial;
      } catch { context.signal.throwIfAborted(); parsed.partial = true; }
    }
    const visitedArchive = selected.slice(0, parsed.visited).filter(file => limit === 1 || file !== latest);
    const lastArchive = visitedArchive.at(-1);
    if (lastArchive) this.nextFile = candidates[(positions.get(lastArchive)! + 1) % candidates.length];
    // Alternate priority so either a large active file or archive can use the full
    // worker budget without permanently starving the other. Advance stalled archives.
    this.recentFirst = !this.recentFirst;
    if (parsed.visited === 0 && selected[0] !== latest && archive[0])
      this.nextFile = candidates[(positions.get(archive[0])! + 1) % candidates.length];
    parsed.partial ||= parsed.visited < candidates.length;
    const catalog = parsed.records.length && this.options.pricingCatalogLoader
      ? await this.options.pricingCatalogLoader(context).catch(() => emptyPricingCatalog()) : emptyPricingCatalog();
    for (const record of parsed.records) {
      // Preserve the recorded model; routing suffix aliases are used for pricing only.
      const pricingModel = record.model.replace(/-(?:tiered|low|thinking)$/i, "");
      record.estimatedCostUSD = estimateSessionCost(record, catalog)
        ?? estimateSessionCost({ ...record, model: pricingModel }, catalog);
      record.pricingVersion = catalog.revision;
    }
    context.signal.throwIfAborted();
    return sessionAnalytics(parsed, parsed.files, context);
  }
}

function readInWorker(files: string[], options: AntigravitySourceOptions, signal: AbortSignal): Promise<AntigravityDatabaseResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(options.workerPath ?? path.join(__dirname, "antigravity-worker.js"), {
      workerData: { files, maxBytes: options.maxBytes ?? 128 * 1024 * 1024 }
    });
    let result: AntigravityDatabaseResult | undefined, stopped = false;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const stop = (error: Error) => {
      if (stopped) return;
      stopped = true; cleanup();
      void worker.terminate().then(() => reject(error), () => reject(error));
    };
    const abort = () => stop(new DOMException("Antigravity scan cancelled.", "AbortError"));
    const timer = setTimeout(() => stop(new Error("Antigravity history scan timed out.")), 15_000);
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (value: AntigravityDatabaseResult) => { result = value; });
    worker.once("error", stop);
    worker.once("exit", code => {
      if (stopped) return;
      stopped = true; cleanup();
      if (code === 0 && result) resolve(result);
      else reject(new Error("Antigravity history worker stopped before returning its results."));
    });
    if (signal.aborted) abort();
  });
}
