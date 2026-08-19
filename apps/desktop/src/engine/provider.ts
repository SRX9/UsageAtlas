import type { DashboardProvider } from "@usageatlas/contracts";

export interface ProviderContext {
  signal: AbortSignal;
  now: Date;
  /** Fallback lookback when the account key is not known yet. */
  historyDays: number;
  /** Preferred lookback once the adapter knows the login identity. */
  historyDaysForAccount(accountKey: string): number;
}

export type ProviderRefreshResult = Omit<DashboardProvider, "id" | "name" | "enabled"> & {
  /** Stable provider-login id when known; omit or use "local" for device-local logs. */
  accountKey?: string;
};

export interface ProviderAdapter {
  readonly id: string;
  readonly name: string;
  isAvailable?(): Promise<boolean>;
  refresh(context: ProviderContext): Promise<ProviderRefreshResult>;
}

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
