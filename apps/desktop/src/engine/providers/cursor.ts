import type { DashboardProvider } from "@usageatlas/contracts";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ProviderAdapter, ProviderContext } from "../provider";
import { ProviderError } from "../provider";
import {
  scanCursorUsageHistory,
  type CursorUsageHistoryOptions
} from "../analytics/cursor-usage";
import { providerFailure } from "../analytics/provider-analytics";
import { fetchProviderJson, type FetchImplementation } from "../platform/http";
import {
  NodeReadonlySqliteFactory,
  type ReadonlySqliteFactory
} from "../platform/sqlite";
import {
  invalidResponse,
  object,
  optionalNumber,
  optionalObject,
  optionalString,
  parseDate,
  usageWindow
} from "./shared";

interface CursorAdapterOptions extends CursorUsageHistoryOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  sqliteFactory?: ReadonlySqliteFactory;
}

interface CursorCredential {
  accessToken: string;
  userID: string;
}

export function createCursorAdapter(options: CursorAdapterOptions = {}): ProviderAdapter {
  const databasePath = cursorDatabasePath(options);
  const sqliteFactory = options.sqliteFactory ?? new NodeReadonlySqliteFactory();
  return {
    id: "cursor",
    name: "Cursor",
    isAvailable: () => fileExists(databasePath),
    refresh: (context) => refreshCursor(context, databasePath, sqliteFactory, options)
  };
}

export function cursorDatabasePath(options: CursorAdapterOptions = {}): string {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const applicationData = nonEmpty(environment.APPDATA) ?? path.join(homeDirectory, "AppData", "Roaming");
    return path.join(applicationData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  const configHome = nonEmpty(environment.XDG_CONFIG_HOME) ?? path.join(homeDirectory, ".config");
  return path.join(configHome, "Cursor", "User", "globalStorage", "state.vscdb");
}

export function parseCursorUsage(
  value: unknown,
  now: Date
): Omit<DashboardProvider, "id" | "name" | "enabled"> {
  const payload = object(value, "Cursor");
  const individual = optionalObject(payload.individualUsage, "Cursor");
  const plan = optionalObject(individual?.plan, "Cursor");
  const resetAt = parseDate(payload.billingCycleEnd);
  const windows = [];
  const totalPercent = optionalNumber(plan?.totalPercentUsed) ?? percentage(plan?.used, plan?.limit);
  if (totalPercent !== null) windows.push(usageWindow("plan", "Plan", totalPercent, resetAt));
  const autoPercent = optionalNumber(plan?.autoPercentUsed);
  if (autoPercent !== null) windows.push(usageWindow("auto", "Auto + Composer", autoPercent, resetAt));
  const apiPercent = optionalNumber(plan?.apiPercentUsed);
  if (apiPercent !== null) windows.push(usageWindow("api", "API", apiPercent, resetAt));
  if (windows.length === 0 && payload.isUnlimited !== true) throw invalidResponse("Cursor");

  const individualOnDemand = optionalObject(individual?.onDemand, "Cursor");
  const team = optionalObject(payload.teamUsage, "Cursor");
  const teamOnDemand = optionalObject(team?.onDemand, "Cursor");
  const onDemand = remainingCents(individualOnDemand) ?? remainingCents(teamOnDemand);
  const membership = optionalString(payload.membershipType);
  return {
    source: "cursor_app",
    windows,
    identity: membership ? { plan: cursorPlanName(membership) } : null,
    credits: onDemand === null ? null : { remaining: onDemand / 100, unit: "USD" },
    analytics: null,
    error: null,
    updatedAt: now.toISOString()
  };
}

export function parseCursorLegacyUsage(
  value: unknown,
  now: Date,
  resetAt: string | null,
  planName: string | null
): Omit<DashboardProvider, "id" | "name" | "enabled"> {
  const payload = object(value, "Cursor");
  const model = optionalObject(payload["gpt-4"], "Cursor");
  const used = optionalNumber(model?.numRequests);
  const limit = optionalNumber(model?.maxRequestUsage) ?? optionalNumber(model?.numRequestsTotal);
  if (used === null || limit === null || limit <= 0) throw invalidResponse("Cursor");
  return {
    source: "cursor_app",
    windows: [usageWindow("plan", "Requests", used / limit * 100, resetAt)],
    identity: planName ? { plan: planName } : null,
    credits: null,
    analytics: null,
    error: null,
    updatedAt: now.toISOString()
  };
}

async function refreshCursor(
  context: ProviderContext,
  databasePath: string,
  sqliteFactory: ReadonlySqliteFactory,
  options: CursorAdapterOptions
): Promise<Omit<DashboardProvider, "id" | "name" | "enabled">> {
  const credential = cursorCredential(databasePath, sqliteFactory, context.now);
  const cookie = `WorkosCursorSessionToken=${encodeURIComponent(`${credential.userID}::${credential.accessToken}`)}`;
  const headers = {
    Accept: "application/json",
    Cookie: cookie,
    Origin: "https://cursor.com",
    Referer: "https://cursor.com/dashboard",
    "User-Agent": "UsageAtlas"
  };
  const analyticsPromise = scanCursorUsageHistory(context, headers, {
    fetch: options.fetch,
    historyDays: options.historyDays,
    maxEvents: options.maxEvents,
    pageSize: options.pageSize
  });
  try {
    const remote = await refreshCursorQuota(context, credential, headers, options.fetch);
    return { ...remote, analytics: await analyticsPromise };
  } catch (error) {
    return {
      source: "cursor_app",
      windows: [],
      identity: null,
      credits: null,
      analytics: await analyticsPromise,
      error: providerFailure(error, "Cursor usage could not be refreshed."),
      updatedAt: context.now.toISOString()
    };
  }
}

async function refreshCursorQuota(
  context: ProviderContext,
  credential: CursorCredential,
  headers: Record<string, string>,
  fetchImplementation?: FetchImplementation
): Promise<Omit<DashboardProvider, "id" | "name" | "enabled">> {
  try {
    const payload = await fetchProviderJson(
      "Cursor",
      "https://cursor.com/api/usage-summary",
      { headers, signal: context.signal },
      fetchImplementation
    );
    try {
      return parseCursorUsage(payload, context.now);
    } catch (error) {
      if (!(error instanceof ProviderError) || error.code !== "invalid_response") throw error;
      const summary = object(payload, "Cursor");
      const membership = optionalString(summary.membershipType);
      const legacy = await fetchProviderJson(
        "Cursor",
        `https://cursor.com/api/usage?user=${encodeURIComponent(credential.userID)}`,
        { headers, signal: context.signal },
        fetchImplementation
      );
      return parseCursorLegacyUsage(
        legacy,
        context.now,
        parseDate(summary.billingCycleEnd),
        membership ? cursorPlanName(membership) : null
      );
    }
  } catch (error) {
    if (error instanceof ProviderError && error.code === "auth_required") {
      throw new ProviderError("auth_required", "Cursor is signed out. Sign in to the Cursor desktop app, then refresh.");
    }
    throw error;
  }
}

function cursorCredential(
  databasePath: string,
  sqliteFactory: ReadonlySqliteFactory,
  now: Date
): CursorCredential {
  let database;
  try {
    database = sqliteFactory.open(databasePath);
    const row = database.get("SELECT value FROM ItemTable WHERE key = ? LIMIT 1", ["cursorAuth/accessToken"]);
    const accessToken = sqliteText(row?.value);
    if (!accessToken) throw new ProviderError("credentials_missing", "Cursor is not signed in on this computer.");
    return parseCursorToken(accessToken, now);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("credentials_invalid", "Cursor's local sign-in could not be read.");
  } finally {
    database?.close();
  }
}

function parseCursorToken(accessToken: string, now: Date): CursorCredential {
  const parts = accessToken.split(".");
  if (parts.length < 2 || !parts[1]) {
    throw new ProviderError("credentials_invalid", "Cursor's local sign-in is invalid.");
  }
  let payload: Record<string, unknown>;
  try {
    payload = object(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown, "Cursor");
  } catch {
    throw new ProviderError("credentials_invalid", "Cursor's local sign-in is invalid.");
  }
  const subject = optionalString(payload.sub);
  const expiresAt = optionalNumber(payload.exp);
  const userID = subject?.split("|").at(-1)?.trim();
  if (!userID || !/^[A-Za-z0-9._-]+$/u.test(userID) || expiresAt === null) {
    throw new ProviderError("credentials_invalid", "Cursor's local sign-in is invalid.");
  }
  if (expiresAt * 1_000 <= now.valueOf() + 60_000) {
    throw new ProviderError("auth_required", "Cursor's local sign-in expired. Open Cursor to sign in again.");
  }
  return { accessToken, userID };
}

function percentage(usedValue: unknown, limitValue: unknown): number | null {
  const used = optionalNumber(usedValue);
  const limit = optionalNumber(limitValue);
  return used === null || limit === null || limit <= 0 ? null : used / limit * 100;
}

function remainingCents(value: Record<string, unknown> | null): number | null {
  if (!value || value.enabled === false) return null;
  const remaining = optionalNumber(value.remaining);
  if (remaining !== null) return Math.max(0, remaining);
  const used = optionalNumber(value.used);
  const limit = optionalNumber(value.limit);
  return used === null || limit === null ? null : Math.max(0, limit - used);
}

function sqliteText(value: unknown): string | null {
  if (typeof value === "string") return nonEmpty(value);
  if (value instanceof Uint8Array) return nonEmpty(Buffer.from(value).toString("utf8"));
  return null;
}

function cursorPlanName(value: string): string {
  return `Cursor ${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
