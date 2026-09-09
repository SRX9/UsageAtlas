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
import { UsageStore } from "./usage-store";

export interface UsageCloud {
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
  private preparedAccount: string | null = null;
  constructor(
    private readonly store: UsageStore,
    private readonly changed: () => void = () => {}
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
    // Finish the current operation under its original account before switching.
    if (this.running) await this.running.catch(() => undefined);
    // Completion can schedule a retry for the previous account.
    this.clearTimer();
    this.preparedAccount = null;
    this.lastCompleted = null;
    this.store.selectAccount(account);
    this.cloud = cloud;
    this.error = null;
    this.schedule();
    this.changed();
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
    this.changed();
  }
  close(): void {
    this.closed = true;
    this.cloud = null;
    this.clearTimer();
    this.store.onChange = undefined;
  }
  private run(upload: boolean): Promise<void> {
    if (this.running) return this.running;
    if (!this.cloud || !this.store.owner) return Promise.reject(new Error("Sign in to your account first."));
    this.clearTimer();
    const cloud = this.cloud;
    this.progress = { operation: upload ? "save" : "restore", phase: "reading", completed: 0, total: null };
    this.lastCompleted = null;
    this.running = (async () => {
      this.error = null;
      if (upload) this.store.claimLocal();
      if (!upload || this.preparedAccount !== this.store.owner) {
        let after: string | null = null;
        do {
          const page = await cloud.read(after);
          if (this.closed) return;
          for (const record of page.records) this.store.merge(record);
          if (page.next !== null && ((after !== null && page.next <= after) || page.records.length === 0)) {
            throw new Error("Invalid cloud page.");
          }
          this.progress!.completed += page.records.length;
          after = page.next;
        } while (after !== null);
        this.preparedAccount = this.store.owner;
      }
      if (upload) {
        let pending = this.store.pending();
        const counts = this.store.counts();
        this.progress = { operation: "save", phase: "saving", completed: 0, total: counts.pending - counts.conflicts - counts.invalid };
        while (pending.length) {
          const results = await cloud.save(pending);
          if (this.closed) return;
          if (
            results.length !== pending.length ||
            new Set(results.map((row) => row.record.recordId)).size !== pending.length
          )
            throw new Error("Incomplete cloud save response.");
          for (const result of results) {
            const sent = pending.find((row) => row.record.recordId === result.record.recordId);
            if (!sent) throw new Error("Unexpected cloud save response.");
            if (result.status === "saved") {
              if (!sameUsage(sent.record, result.record) || result.revision < sent.revision)
                throw new Error("Cloud acknowledgement does not match the sent record.");
              this.store.acknowledge(sent, result);
              this.progress.completed += 1;
            } else this.store.merge(result);
          }
          const next = this.store.pending();
          if (next.some((row) => pending.some((sent) =>
            row.record.recordId === sent.record.recordId && row.localVersion === sent.localVersion && row.revision === sent.revision
          ))) throw new Error("Cloud save made no progress. Restore from cloud, then try again.");
          pending = next;
          const remaining = this.store.counts();
          this.progress.total = this.progress.completed + remaining.pending - remaining.conflicts - remaining.invalid;
        }
      }
      this.lastCompleted = upload ? "save" : "restore";
    })()
      .catch((error: unknown) => {
        this.error = error instanceof Error ? error.message : "Cloud save failed. Your local usage is safe.";
        throw error;
      })
      .finally(() => {
        this.running = null;
        this.progress = null;
        if (this.closed) return;
        this.changed();
        this.schedule();
      });
    return this.running;
  }
  private schedule(): void {
    if (!this.automatic || !this.cloud || this.closed || this.timer || this.running) return;
    const counts = this.store.counts();
    if (counts.pending <= counts.conflicts + counts.invalid) return;
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
