import type { DashboardProvider } from "@usageatlas/contracts";
import type { ProviderCredential } from "../shared/quota-providers";

export interface ProviderContext {
  signal: AbortSignal;
  now: Date;
  /** Fallback lookback when the account key is not known yet. */
  historyDays: number;
  /** Preferred lookback once the adapter knows the login identity. */
  historyDaysForAccount(accountKey: string): number;
  reportingTimeZoneForAccount?(accountKey: string): string | undefined;
}

export type ProviderRefreshResult = Omit<DashboardProvider, "id" | "name" | "enabled"> & {
  /** Stable provider-login id when known; omit or use "local" for device-local logs. */
  accountKey?: string;
};

export interface ProviderAdapter {
  configureCredential?(value: ProviderCredential | null, unavailable?: boolean): void;
  /** Selected quota scope, including before the first successful network request. */
  capacityAccountKey?(): Promise<string | null>;
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
