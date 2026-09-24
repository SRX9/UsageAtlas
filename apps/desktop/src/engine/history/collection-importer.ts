import { randomUUID } from "node:crypto";
import type { LocalUsageAnalytics } from "@usageatlas/contracts";
import type { UsageFact } from "@usageatlas/contracts/statistics";
import type { UsageProvider } from "@usageatlas/contracts/usage";
import type { LocalImportProgress } from "../../shared/desktop-api";
import { stableId } from "./usage-payload";
import type { UsageStore } from "./usage-store";

const BATCH_SIZE = 250;
interface ImportJob {
  key: string;
  owner: string;
  version: string;
  facts: Generator<UsageFact>;
  completed: number;
  total: number;
  error: string | null;
}

/** Each tick commits at most one batch, then releases SQLite and the event loop. */
export class CollectionImporter {
  private jobs: ImportJob[] = [];
  private timer: NodeJS.Immediate | null = null;
  private closed = false;
  private pauses = 0;
  private running = false;
  private lastProgress = 0;
  private waiters = new Set<() => void>();
  onProgress?: () => void;

  constructor(private readonly store: UsageStore, private readonly replica: string) {}

  enqueue(provider: UsageProvider, account: string, analytics: LocalUsageAnalytics): void {
    if (this.closed) return;
    const owner = this.store.owner;
    const key = this.key(owner, provider, account);
    const version = randomUUID();
    const job: ImportJob = { key, owner, version,
      facts: this.store.statistics.observations(provider, account, this.replica, analytics),
      completed: 0, total: analytics.collection?.events.length ?? 0, error: null };
    // Keep the active scan and the latest waiting scan for this source. Repeated
    // refresh clicks must not retain unbounded copies of the same log history.
    this.store.setSetting(key, version);
    const waiting = this.jobs.findIndex((entry, index) => entry.key === key && (index > 0 || entry.error !== null));
    if (waiting >= 0) this.jobs[waiting] = job;
    else this.jobs.push(job);
    this.notify();
    this.schedule();
  }

  needsBackfill(provider: string, account: string): boolean {
    return [this.store.owner, ""].some(owner => this.store.setting(this.key(owner, provider, account)) !== null);
  }

  status(owner = this.store.owner): LocalImportProgress | null {
    const job = this.jobs.find(entry => entry.owner === owner || entry.owner === "");
    if (job) return { completed: job.completed, total: job.total, error: job.error };
    return this.hasMarker(owner) ? { completed: 0, total: 0, error: "Local history import was interrupted. Refresh usage to resume." } : null;
  }

  wait(owner: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error): void => {
        this.waiters.delete(check);
        signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve();
      };
      const aborted = (): void => finish(new Error("Local history wait cancelled."));
      const check = (): void => {
        if (signal.aborted || this.closed) { aborted(); return; }
        const jobs = this.jobs.filter(job => job.owner === owner || job.owner === "");
        const failed = jobs.find(job => job.error);
        if (failed) finish(new Error(failed.error!));
        else if (!jobs.length) finish(this.hasMarker(owner)
          ? new Error("Refresh usage to finish storing local history before saving to cloud.") : undefined);
      };
      this.waiters.add(check);
      signal.addEventListener("abort", aborted, { once: true });
      check();
    });
  }

  pause(): void {
    this.pauses++;
    if (this.timer) clearImmediate(this.timer);
    this.timer = null;
  }
  resume(): void {
    this.pauses = Math.max(0, this.pauses - 1);
    this.schedule();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearImmediate(this.timer);
    this.timer = null;
    // Committed batches and unfinished-source markers survive. The next scan
    // backfills interrupted sources and deduplicates already committed facts.
    this.jobs = [];
    for (const check of [...this.waiters]) check();
  }

  private schedule(): void {
    if (this.closed || this.pauses || this.running || this.timer || !this.jobs.some(job => !job.error)) return;
    this.timer = setImmediate(() => { this.timer = null; void this.tick(); });
  }

  private async tick(): Promise<void> {
    const job = this.jobs.find(entry => !entry.error);
    if (!job || this.closed) return;
    this.running = true;
    try {
      const batch: UsageFact[] = [];
      let finished = false;
      while (batch.length < BATCH_SIZE) {
        const next = job.facts.next();
        if (next.done) { finished = true; break; }
        batch.push(next.value);
      }
      await this.store.statistics.putBatch(batch, job.owner, finished ? { key: job.key, version: job.version } : undefined);
      if (this.closed) return;
      job.completed += batch.filter(fact => fact.kind === "usage_event").length;
      if (finished) this.jobs.splice(this.jobs.indexOf(job), 1);
      this.store.onChange?.();
    } catch {
      job.error = "Local history could not be stored. Check free disk space and refresh usage to retry.";
    } finally { this.running = false; }
    if (this.closed) return;
    this.notify(!this.jobs.length || job.error !== null);
    this.schedule();
  }

  private notify(force = true): void {
    if (force || Date.now() - this.lastProgress >= 250) {
      this.lastProgress = Date.now();
      this.onProgress?.();
    }
    for (const check of [...this.waiters]) check();
  }
  private prefix(owner: string): string { return `collection-pending:${stableId(owner)}:`; }
  private key(owner: string, provider: string, account: string): string {
    return `${this.prefix(owner)}${stableId(this.replica, provider, account)}`;
  }
  private hasMarker(owner: string): boolean {
    return [owner, ""].some(account => Boolean(this.store.db.get(
      "SELECT 1 FROM usage_setting WHERE key LIKE ? LIMIT 1", [`${this.prefix(account)}%`])));
  }
}
