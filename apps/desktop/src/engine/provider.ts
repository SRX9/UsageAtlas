import type { DashboardProvider } from "@usageatlas/contracts";

export interface ProviderContext {
  signal: AbortSignal;
  now: Date;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly name: string;
  isAvailable?(): Promise<boolean>;
  refresh(context: ProviderContext): Promise<Omit<DashboardProvider, "id" | "name" | "enabled">>;
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
