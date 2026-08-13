import type { DashboardProvider } from "@usageatlas/contracts";
import type { ProviderAdapter, ProviderContext } from "../provider";
import { ProviderError } from "../provider";
import { LocalUsageScanner, type AnalyticsScanner } from "../analytics/local-usage";
import { providerFailure, scanProviderAnalytics } from "../analytics/provider-analytics";
import { credentialLocations } from "../platform/credentials";
import { fetchProviderJson, type FetchImplementation } from "../platform/http";
import { readCredentialJson } from "../platform/json-file";
import {
  object,
  optionalNumber,
  optionalObject,
  optionalString,
  parseDate,
  usageWindow
} from "./shared";

interface ClaudeAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  fetch?: FetchImplementation;
  analyticsScanner?: AnalyticsScanner;
}

interface ClaudeCredential {
  accessToken: string;
  plan: string | null;
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): ProviderAdapter {
  const analyticsScanner = options.analyticsScanner ?? new LocalUsageScanner({
    environment: options.environment,
    homeDirectory: options.homeDirectory
  });
  return {
    id: "claude",
    name: "Claude",
    refresh: (context) => refreshClaude(context, options, analyticsScanner)
  };
}

export function parseClaudeUsage(
  value: unknown,
  plan: string | null,
  now: Date
): Omit<DashboardProvider, "id" | "name" | "enabled"> {
  const payload = object(value, "Claude");
  const windows = [
    claudeWindow(payload.five_hour, "session", "5-hour"),
    claudeWindow(payload.seven_day, "weekly", "Weekly")
  ].filter((window): window is NonNullable<typeof window> => window !== null);
  const extra = optionalObject(payload.extra_usage, "Claude");
  const limit = optionalNumber(extra?.monthly_limit);
  const used = optionalNumber(extra?.used_credits);
  const remaining = extra?.is_enabled === true && limit !== null && used !== null
    ? Math.max(limit - used, 0)
    : null;
  return {
    source: "oauth",
    windows,
    identity: plan ? { plan } : null,
    credits: remaining === null
      ? null
      : { remaining, unit: optionalString(extra?.currency) ?? "credits" },
    analytics: null,
    error: null,
    updatedAt: now.toISOString()
  };
}

async function refreshClaude(
  context: ProviderContext,
  options: ClaudeAdapterOptions,
  analyticsScanner: AnalyticsScanner
): Promise<Omit<DashboardProvider, "id" | "name" | "enabled">> {
  const analyticsPromise = scanProviderAnalytics(analyticsScanner, "claude", context);
  try {
    const remote = await refreshClaudeQuota(context, options);
    return { ...remote, analytics: await analyticsPromise };
  } catch (error) {
    return {
      source: "local_sessions",
      windows: [],
      identity: null,
      credits: null,
      analytics: await analyticsPromise,
      error: providerFailure(error, "Claude usage could not be refreshed."),
      updatedAt: context.now.toISOString()
    };
  }
}

async function refreshClaudeQuota(
  context: ProviderContext,
  options: ClaudeAdapterOptions
): Promise<Omit<DashboardProvider, "id" | "name" | "enabled">> {
  const environment = options.environment ?? process.env;
  const credential = await claudeCredential(environment, options.homeDirectory);
  const payload = await fetchProviderJson(
    "Claude",
    "https://api.anthropic.com/api/oauth/usage",
    {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.0",
        Accept: "application/json"
      },
      signal: context.signal
    },
    options.fetch
  );
  return parseClaudeUsage(payload, credential.plan, context.now);
}

async function claudeCredential(
  environment: NodeJS.ProcessEnv,
  homeDirectory?: string
): Promise<ClaudeCredential> {
  const environmentToken = optionalString(environment.CLAUDE_CODE_OAUTH_TOKEN);
  if (environmentToken) return { accessToken: environmentToken, plan: null };
  const location = credentialLocations(environment, homeDirectory).claude;
  const root = object(await readCredentialJson(location, "Claude"), "Claude");
  const oauth = optionalObject(root.claudeAiOauth, "Claude");
  const accessToken = optionalString(oauth?.accessToken);
  if (!accessToken) throw new ProviderError("credentials_invalid", "Claude credentials are invalid.");
  return { accessToken, plan: optionalString(oauth?.subscriptionType) };
}

function claudeWindow(value: unknown, kind: string, label: string) {
  const candidate = optionalObject(value, "Claude");
  if (!candidate) return null;
  return usageWindow(
    kind,
    label,
    optionalNumber(candidate.utilization) ?? 0,
    parseDate(candidate.resets_at)
  );
}
