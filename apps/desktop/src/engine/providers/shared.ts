import type { DashboardWindow } from "@usageatlas/contracts";
import { ProviderError } from "../provider";

export function object(value: unknown, providerName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse(providerName);
  return value as Record<string, unknown>;
}

export function optionalObject(value: unknown, providerName: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  return object(value, providerName);
}

export function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function finiteNumber(value: unknown, providerName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidResponse(providerName);
  return value;
}

export function optionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function usageWindow(
  kind: string,
  label: string,
  usedPercent: number,
  resetAt: string | null
): DashboardWindow {
  const used = Math.max(0, Math.min(usedPercent, 100));
  return { kind, label, usedPercent: used, remainingPercent: 100 - used, resetAt };
}

export function parseDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

export function invalidResponse(providerName: string): ProviderError {
  return new ProviderError("invalid_response", `${providerName} returned an invalid usage response.`);
}
