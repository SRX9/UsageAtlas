import type { UsageFact } from "@usageatlas/contracts/statistics";
import {
  USAGE_BATCH_SIZE,
  USAGE_MAX_BYTES,
  sameUsage,
  validateUsageRecord,
  type CloudRecord,
  type PendingRecord,
  type SaveResult
} from "@usageatlas/contracts/usage";
import type { CloudProgress } from "../../shared/desktop-api";
import {
  KNOWN_PROVIDERS,
  OFFICIAL_PROVIDERS,
  applyTargetToFact,
  applyTargetToRecord,
  isOfficialProvider,
  planFor,
  unaliasUsageRecord,
  type ReportPlan,
  type ReportTarget
} from "../../shared/report-plans";
import { spinTarget } from "./report-wheel";
import { tokenTarget } from "../../shared/report-wheel";
import { identifyFact } from "./statistics-store";
import { ATTRIBUTION_SEPARATOR, parseAttribution, UsageStore } from "./usage-store";

/**
 * The hosted service stores at most this many observations per request. Sending
 * the store's own 250-fact page made it acknowledge only the first 40 and the
 * client treated the rest as a failed save, so one save drained 40 at a time.
 */
const STATISTICS_SAVE_BATCH = 40;

export interface UsageCloud {
  readFacts?(after: string): Promise<{ facts: UsageFact[]; cursor: string; more: boolean }>;
  saveFacts?(facts: UsageFact[]): Promise<string[]>;
  read(after: string | null): Promise<{ records: CloudRecord[]; next: string | null }>;
  save(records: PendingRecord[]): Promise<SaveResult[]>;
}
const AUTOMATIC_SAVE_INTERVAL_MS = 60 * 60 * 1_000;

export class UsageSync {
  private progress: CloudProgress | null = null;
  private lastCompleted: "save" | "restore" | null = null;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cloud: UsageCloud | null = null;
  private error: string | null = null;
  private closed = false;
  private stopping = false;
  private controller: AbortController | null = null;
  private preparedAccount: string | null = null;
  /** Applied to the uploaded copy only; local history keeps its real provider. */
  private reportPlans: ReportPlan[] = [];
  /** Sources the server does not model and no rule renames, kept on this computer. */
  private heldBack: string[] = [];
  /** Token mass already reported per source and target, mirrored in settings. */
  private readonly wheelMass = new Map<string, number>();
  constructor(
    private readonly store: UsageStore,
    private readonly changed: (reason: "account" | "history") => void = () => {},
    private readonly beforeSave?: (signal: AbortSignal) => Promise<void>
  ) {
    store.onChange = () => this.schedule();
  }
  status() {
    const conflicts = this.store.conflicts();
    const counts = this.store.counts();
    return {
      accountId: this.store.owner || null,
      automatic: this.automatic,
      pending: counts.pending,
      busy: this.running !== null,
      progress: this.progress ? { ...this.progress } : null,
      lastCompleted: this.lastCompleted,
      heldBack: [...this.heldBack],
      heldBackCount: this.heldBackPending(),
      error: this.error ?? (counts.invalid
        ? `${counts.invalid} invalid local usage ${counts.invalid === 1 ? "record was" : "records were"} skipped. Other records can still be saved. Refresh usage to retry.`
        : null),
      conflicts: conflicts.flatMap((row) =>
        row.conflict
          ? [
              {
                recordId: row.record.recordId,
                provider: row.record.providerId,
                day: row.record.kind === "usage_day" ? row.record.localDay : null,
                localTokens:
                  row.record.kind === "usage_day" ? (row.record.totals?.totalTokens ?? null) : null,
                cloudTokens:
                  row.conflict.record.kind === "usage_day"
                    ? (row.conflict.record.totals?.totalTokens ?? null)
                    : null
              }
            ]
          : []
      )
    };
  }
  get automatic(): boolean {
    return Boolean(this.store.owner) && this.store.setting(`automatic:${this.store.owner}`) !== "0";
  }
  async configure(account: string, cloud: UsageCloud | null): Promise<void> {
    this.clearTimer();
    // Finish only the in-flight request under its original account. A large history
    // must not keep uploading pages after sign-out or delay an account switch.
    if (this.store.owner !== account) {
      this.stopping = true;
      this.controller?.abort();
    }
    if (this.running) await this.running.catch(() => undefined);
    this.stopping = false;
    // Completion can schedule a retry for the previous account.
    this.clearTimer();
    const switched = this.store.owner !== account;
    this.preparedAccount = null;
    this.lastCompleted = null;
    this.store.selectAccount(account);
    this.cloud = cloud;
    this.error = null;
    this.schedule();
    if (switched) this.changed("account");
  }
  setReportPlans(plans: ReportPlan[]): void {
    this.reportPlans = plans;
    // A new rule takes a source out of the held-back notice right away, instead
    // of waiting for the next save to notice.
    this.reportHeldBack(this.unsupportedProviders(this.uploadableProviders()));
  }
  /**
   * Providers this server accepts: the ones it models, plus the sources a saved
   * rule renames. A source without a rule of its own follows the first saved
   * mix, so it is uploadable too; with no mix at all it stays local.
   */
  private uploadableProviders(): string[] {
    if (this.reportPlans.length > 0) return [...KNOWN_PROVIDERS];
    const providers = new Set<string>(OFFICIAL_PROVIDERS);
    for (const plan of this.reportPlans) providers.add(plan.source);
    return [...providers];
  }
  /** Sources with pending usage that the server would reject as-is. */
  private unsupportedProviders(providers: readonly string[]): string[] {
    const pending = [
      ...this.store.statistics.pendingProviders(),
      ...this.store.pendingProviders()
    ];
    return [...new Set(pending)].filter(provider => !providers.includes(provider)).sort();
  }
  /** Records the local sources with pending usage the server would reject as-is. */
  private reportHeldBack(providers: readonly string[]): void {
    this.heldBack = [...providers];
  }
  /**
   * Usage that no save can upload yet because the server models no such source
   * and no rule renames it. It is counted apart from `pending` so a source the
   * user has not mapped never reads as a save that keeps failing.
   */
  private heldBackPending(): number {
    const held = this.unsupportedProviders(this.uploadableProviders());
    if (!held.length) return 0;
    return this.store.pendingCount(held) + this.store.statistics.pendingCount(held);
  }
  /** Rows a save would send right now, counting the server's own sources only. */
  private uploadablePending(): number {
    const providers = this.uploadableProviders();
    return this.store.uploadableCount(providers) + this.store.statistics.pendingCount(providers);
  }
  /**
   * Renames one pending observation for upload. Its id is the hash of its content,
   * so a renamed copy is renumbered and the id it is stored under here is kept for
   * the acknowledgement. The wheel is spun on the event's identity: every version
   * of one request keeps the same target.
   */
  private renameFact(fact: UsageFact): { fact: UsageFact; localId: string } {
    const tokens = fact.kind === "usage_event" ? (fact.totals?.totalTokens ?? 0) : 0;
    const target = this.targetFor(
      `fact:${fact.id}`, fact.providerId,
      fact.kind === "usage_event" ? fact.eventId : fact.id, tokens
    );
    return target
      ? { fact: identifyFact(applyTargetToFact(fact, target)), localId: fact.id }
      : { fact, localId: fact.id };
  }
  /** Renames one daily record; a day keeps the target it landed on between saves. */
  private renameRecord(row: PendingRecord): PendingRecord {
    const tokens = row.record.kind === "usage_day" ? (row.record.totals?.totalTokens ?? 0) : 0;
    const target = this.targetFor(`record:${row.record.recordId}`, row.record.providerId, row.record.recordId, tokens);
    return target ? { ...row, record: applyTargetToRecord(row.record, target) } : row;
  }
  /**
   * One unit of usage keeps the target it was first reported as, even after the
   * plan's weights change: the server holds a record under one provider and
   * rejects the same record under another. A target that the current plan no
   * longer offers falls back to a fresh spin.
   */
  private targetFor(key: string, source: string, spinKey: string, tokens = 0): ReportTarget | null {
    // An unmapped source is reported through the first saved mix. That is the
    // only way the hosted service can accept Freebuff, Cline or Roo records: it
    // validates the provider name against its own catalog.
    const plan = planFor(this.reportPlans, source)
      ?? (isOfficialProvider(source) ? null : this.reportPlans[0]);
    if (!plan) return null;
    const stored = this.store.attribution(key);
    if (stored) {
      const { reportAs, model } = parseAttribution(stored);
      // The server bound this record to that label, so the plan's current weights
      // and models no longer apply to it; a copy stored without a model borrows the
      // one the plan still offers for that provider.
      if (isOfficialProvider(reportAs)) {
        const fallback = plan.targets.find(target => target.reportAs === reportAs)?.model ?? plan.targets[0].model;
        return { reportAs, model: model || fallback, weight: 0 };
      }
    }
    // Token-bearing usage is allocated by mass so the long-run split equals the
    // chosen shares; scan and quota facts have no tokens and keep the hash wheel.
    const target = tokens > 0 ? this.allocateTarget(plan, source, key, tokens) : spinTarget(plan, spinKey);
    if (target) this.store.setAttribution(key, `${target.reportAs}${ATTRIBUTION_SEPARATOR}${target.model}`);
    return target;
  }
  /**
   * Hands one unit of usage to the target furthest behind its declared token
   * share, then records the mass in settings so the next save (or the next day)
   * continues from the same balance. Observations and daily records keep
   * separate ledgers: a day is not the same usage as its individual requests.
   */
  private allocateTarget(plan: ReportPlan, source: string, key: string, tokens: number): ReportTarget | null {
    const bucket = key.slice(0, key.indexOf(":"));
    const massKey = (target: ReportTarget) =>
      `wheel:${this.store.owner}:${bucket}:${source}:${target.reportAs}:${target.model}`;
    const assigned = (target: ReportTarget): number => {
      const id = massKey(target);
      const cached = this.wheelMass.get(id);
      if (cached !== undefined) return cached;
      const value = Number(this.store.setting(id) ?? 0);
      const mass = Number.isFinite(value) && value > 0 ? value : 0;
      this.wheelMass.set(id, mass);
      return mass;
    };
    const target = tokenTarget(plan, assigned, tokens);
    if (target) {
      const mass = assigned(target) + tokens;
      this.wheelMass.set(massKey(target), mass);
      this.store.setSetting(massKey(target), String(mass));
    }
    return target;
  }
  setAutomatic(enabled: boolean): void {
    if (!this.cloud) throw new Error("Sign in before enabling automatic save.");
    this.store.setSetting(`automatic:${this.store.owner}`, enabled ? "1" : "0");
    this.clearTimer();
    if (enabled) this.schedule();
  }
  save(): Promise<void> {
    return this.run(true);
  }
  restore(): Promise<void> {
    return this.run(false);
  }
  resolve(id: string, choice: "local" | "cloud"): void {
    this.store.resolve(id, choice);
    this.changed("history");
  }
  close(): void {
    this.closed = true;
    this.controller?.abort();
    this.cloud = null;
    this.clearTimer();
    this.store.onChange = undefined;
  }
  private run(upload: boolean): Promise<void> {
    if (this.running) return this.running;
    if (!this.cloud || !this.store.owner) return Promise.reject(new Error("Sign in to your account first."));
    this.clearTimer();
    const cloud = this.cloud;
    const controller = new AbortController();
    this.controller = controller;
    this.progress = { operation: upload ? "save" : "restore", phase: "reading", completed: 0, total: null };
    this.lastCompleted = null;
    this.running = (async () => {
      this.error = null;
      const providers = this.uploadableProviders();
      if (!upload) this.heldBack = [];
      if (upload) {
        if (this.beforeSave) await this.beforeSave(controller.signal);
        if (this.closed || this.stopping) return;
        const owner = this.store.owner;
        while (this.store.statistics.hasLocal()) {
          await this.store.statistics.claimLocalBatch(owner);
          await new Promise<void>(resolve => setImmediate(resolve));
          if (this.closed || this.stopping) return;
        }
        this.store.claimLocal();
        this.maybeReassertRecentDays();
        // An empty day is not usage. Uploading it made the server list a saved
        // day with no data, which the public profile reports as incomplete.
        this.store.skipEmptyDays();
        // Pruning only shrinks the upload. A stopped history writer must not keep pending facts from saving.
        await this.store.statistics.dropRepricedCopies(() => this.closed || this.stopping).catch(() => undefined);
        if (this.closed || this.stopping) return;
      }
      // Observations are not restored. The server already holds them, the local
      // day records carry the same totals, and re-reading them used to copy the
      // whole cloud ledger into this database on every restore.
      if (upload) {
        this.progress = { operation: "save", phase: "saving", completed: 0, total: this.store.statistics.pendingCount() };
        for (;;) {
          // The server fingerprints an observation's content and only stores a copy
          // whose id still matches it, so a renamed fact is renumbered here and the
          // acknowledgement is translated back to the row this computer wrote.
          const outgoing = this.store.statistics.pending(providers)
            .slice(0, STATISTICS_SAVE_BATCH)
            .map(fact => this.renameFact(fact));
          if (!outgoing.length) break;
          if (!cloud.saveFacts) throw new Error("This server does not support saving usage observations. Update before saving.");
          const saved = await cloud.saveFacts(outgoing.map(entry => entry.fact));
          if (this.closed || this.stopping) return;
          if (saved.length !== outgoing.length || new Set(saved).size !== outgoing.length
            || saved.some(id => !outgoing.some(entry => entry.fact.id === id))) throw new Error("Incomplete statistics acknowledgement.");
          const local = saved.map(id => outgoing.find(entry => entry.fact.id === id)!.localId);
          if (new Set(local).size !== local.length) throw new Error("Ambiguous statistics acknowledgement.");
          this.store.transaction(() => this.store.statistics.acknowledge(local));
          this.progress!.completed += saved.length;
        }
      }
      if (!upload || this.preparedAccount !== this.store.owner) {
        this.progress = { operation: upload ? "save" : "restore", phase: "reading", completed: 0, total: null };
        let after: string | null = null;
        do {
          const page = await cloud.read(after);
          if (this.closed || this.stopping) return;
          for (const record of page.records) this.store.merge(record, unaliasUsageRecord);
          if (page.next !== null && ((after !== null && page.next <= after) || page.records.length === 0)) {
            throw new Error("Invalid cloud page.");
          }
          this.progress!.completed += page.records.length;
          after = page.next;
        } while (after !== null);
        this.preparedAccount = this.store.owner;
      }
      if (upload) {
        let pending = this.store.pending(providers);
        const counts = this.store.counts();
        this.progress = { operation: "save", phase: "saving", completed: 0, total: counts.pending - counts.conflicts - counts.invalid };
        while (pending.length) {
          const outgoing = pending.map((row) => this.renameRecord(row));
          const sent = new Map(outgoing.map(row => [row.record.recordId, this.stateOf(row)]));
          const results = await cloud.save(outgoing);
          if (this.closed || this.stopping) return;
          if (
            results.length !== pending.length ||
            new Set(results.map((row) => row.record.recordId)).size !== pending.length
          )
            throw new Error("Incomplete cloud save response.");
          for (const result of results) {
            const sent = outgoing.find((row) => row.record.recordId === result.record.recordId);
            const local = pending.find((row) => row.record.recordId === result.record.recordId);
            if (!sent || !local) throw new Error("Unexpected cloud save response.");
            if (result.status === "saved") {
              if (!sameUsage(sent.record, result.record) || result.revision < sent.revision)
                throw new Error("Cloud acknowledgement does not match the sent record.");
              // Acknowledge the local row: the cloud only ever saw the relabelled copy.
              this.store.acknowledge(local, result);
              this.progress.completed += 1;
            } else this.store.merge(result, unaliasUsageRecord);
          }
          // Only the rows this pass sent count as progress: a source the server
          // refuses to accept stays pending and is reported instead of retried.
          const next = this.store.pending(providers);
          // A row the server keeps answering about must change something — its own
          // version, its revision, or the provider it is reported as — or the save
          // would spin forever. Parking the server's copy as a conflict keeps the
          // row out of `pending` and lets every other record finish; failing the
          // whole save here is what users saw as `Cloud save made no progress`
          // even though their usage was already on the server.
          const stalled = next.filter((row) =>
            sent.has(row.record.recordId) && sent.get(row.record.recordId) === this.stateOf(row));
          if (stalled.length) {
            for (const row of stalled) {
              const answer = results.find((result) => result.record.recordId === row.record.recordId);
              if (answer) this.store.hold(row.record.recordId, answer);
            }
            const stuck = this.store.pending(providers)
              .filter((row) => sent.get(row.record.recordId) === this.stateOf(row));
            if (stuck.length) break;
          }
          pending = this.store.pending(providers);
          const remaining = this.store.counts();
          this.progress.total = this.progress.completed + remaining.pending - remaining.conflicts - remaining.invalid;
        }
      }
      if (upload) this.reportHeldBack(this.unsupportedProviders(providers));
      this.lastCompleted = upload ? "save" : "restore";
    })()
      .catch((error: unknown) => {
        if (this.closed || this.stopping) return;
        this.error = error instanceof Error ? error.message : "Cloud save failed. Your local usage is safe.";
        throw error;
      })
      .finally(() => {
        this.running = null;
        this.controller = null;
        this.progress = null;
        if (this.closed || this.stopping) return;
        this.changed("history");
        this.schedule();
      });
    return this.running;
  }
  /**
   * Once a day, rewrites the copy of the last closed days so a record first
   * uploaded while still open is replaced by its complete version.
   */
  private maybeReassertRecentDays(): void {
    const today = new Date().toISOString().slice(0, 10);
    const key = `cloud:reassert:${this.store.owner}:${today}`;
    if (this.store.setting(key) === "1") return;
    this.store.reassertRecentDays(today);
    this.store.setSetting(key, "1");
  }
  /** What one pending row looks like to the server, for progress checks. */
  private stateOf(row: PendingRecord): string {
    return [row.localVersion, row.revision, this.store.attribution(`record:${row.record.recordId}`)].join("\u0000");
  }
  private schedule(): void {
    if (!this.automatic || !this.cloud || this.closed || this.stopping || this.timer || this.running) return;
    // A source the server refuses without a rule must not keep an hourly save
    // running forever: only what a save can actually upload wakes the timer.
    if (this.uploadablePending() === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save().catch(() => undefined);
    }, AUTOMATIC_SAVE_INTERVAL_MS);
    this.timer.unref?.();
  }
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export function httpUsageCloud(baseURL: string, token: string): UsageCloud {
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${baseURL}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
      redirect: "error"
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "Your session expired. Sign in again."
          : `Cloud request failed (${response.status}). Try again.`
      );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty cloud response.");
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > USAGE_MAX_BYTES) {
        await reader.cancel();
        throw new Error("Cloud response is too large.");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  const records = (value: unknown): CloudRecord[] => {
    if (!Array.isArray(value) || value.length > USAGE_BATCH_SIZE) throw new Error("Invalid cloud records.");
    return value.map((row) => {
      if (!row || !Number.isSafeInteger(row.revision) || row.revision < 1)
        throw new Error("Invalid cloud revision.");
      return { record: validateUsageRecord(row.record), revision: row.revision };
    });
  };
  return {
    async saveFacts(facts) {
      const result = await request("/api/usage/statistics", { facts }) as { saved: unknown };
      if (!Array.isArray(result.saved) || result.saved.some(id => typeof id !== "string")) throw new Error("Invalid statistics acknowledgement.");
      return result.saved as string[];
    },
    async read(after) {
      const value = (await request(`/api/usage${after ? `?after=${encodeURIComponent(after)}` : ""}`)) as {
        records: unknown;
        next: unknown;
      };
      if (value.next !== null && (typeof value.next !== "string" || value.next.length > 64))
        throw new Error("Invalid cloud cursor.");
      return { records: records(value.records), next: value.next as string | null };
    },
    async save(pending) {
      const value = await request("/api/usage", {
        records: pending.map(({ record, revision }) => ({ record, revision }))
      });
      const parsed = records(value);
      return parsed.map((row, index) => {
        const status = (value as { status: unknown }[])[index].status;
        if (status !== "saved" && status !== "conflict") throw new Error("Invalid save status.");
        return { ...row, status };
      });
    }
  };
}
