import type { DashboardProvider } from "@usageatlas/contracts";
import { spawn } from "node:child_process";
import type { ProviderAdapter, ProviderContext } from "../provider";
import { ProviderError } from "../provider";
import { LocalUsageScanner, type AnalyticsScanner } from "../analytics/local-usage";
import { providerFailure, scanProviderAnalytics } from "../analytics/provider-analytics";
import { DESKTOP_VERSION } from "../../shared/version";
import {
  finiteNumber,
  object,
  optionalNumber,
  optionalObject,
  optionalString,
  usageWindow
} from "./shared";

const MAXIMUM_MESSAGE_BYTES = 1_048_576;

export type CodexRateLimitsReader = (signal: AbortSignal) => Promise<unknown>;

interface CodexAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  analyticsScanner?: AnalyticsScanner;
  appServer?: CodexRateLimitsReader;
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): ProviderAdapter {
  const analyticsScanner = options.analyticsScanner ?? new LocalUsageScanner({
    environment: options.environment,
    homeDirectory: options.homeDirectory
  });
  return {
    id: "codex",
    name: "Codex",
    refresh: (context) => refreshCodex(context, options, analyticsScanner)
  };
}

export function parseCodexRateLimits(
  value: unknown,
  now: Date
): Omit<DashboardProvider, "id" | "name" | "enabled"> {
  const payload = object(value, "Codex");
  const rateLimits = object(payload.rateLimits, "Codex");
  const candidates = [rateLimits.primary, rateLimits.secondary]
    .filter((candidate) => candidate != null);
  const windows = candidates.map((candidate, index) => {
    const window = object(candidate, "Codex");
    const used = finiteNumber(window.usedPercent, "Codex");
    const durationMinutes = finiteNumber(window.windowDurationMins, "Codex");
    const resetSeconds = finiteNumber(window.resetsAt, "Codex");
    const weekly = durationMinutes >= 1_440;
    return usageWindow(
      weekly ? "weekly" : "session",
      weekly ? "Weekly" : index === 0 ? formatDuration(durationMinutes) : "Session",
      used,
      new Date(resetSeconds * 1_000).toISOString()
    );
  });
  const credits = optionalObject(rateLimits.credits, "Codex");
  const balance = optionalNumber(credits?.balance ?? credits?.remaining);
  const plan = optionalString(rateLimits.planType);
  return {
    source: "oauth",
    windows,
    identity: plan ? { plan } : null,
    credits: balance === null ? null : { remaining: balance, unit: "credits" },
    analytics: null,
    error: null,
    updatedAt: now.toISOString()
  };
}

async function refreshCodex(
  context: ProviderContext,
  options: CodexAdapterOptions,
  analyticsScanner: AnalyticsScanner
): Promise<Omit<DashboardProvider, "id" | "name" | "enabled">> {
  const analyticsPromise = scanProviderAnalytics(analyticsScanner, "codex", context);
  try {
    const payload = await (options.appServer ?? readCodexRateLimits)(context.signal);
    const remote = parseCodexRateLimits(payload, context.now);
    return { ...remote, analytics: await analyticsPromise };
  } catch (error) {
    return {
      source: "local_sessions",
      windows: [],
      identity: null,
      credits: null,
      analytics: await analyticsPromise,
      error: providerFailure(error, "Codex usage could not be refreshed."),
      updatedAt: context.now.toISOString()
    };
  }
}

export async function readCodexRateLimits(signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderError("timeout", "Codex usage request timed out.", true));
      return;
    }

    const child = spawn("codex", ["app-server"], {
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "ignore"]
    });
    let buffer = "";
    let settled = false;

    const finish = (error?: ProviderError, value?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => finish(new ProviderError("timeout", "Codex usage request timed out.", true));
    signal.addEventListener("abort", abort, { once: true });

    child.on("error", () => finish(new ProviderError(
      "credentials_missing",
      "Codex CLI is not installed. Install Codex and sign in, then refresh."
    )));
    child.on("exit", (code) => {
      if (!settled) finish(new ProviderError(
        "provider_error",
        `Codex app server exited before returning usage${code === null ? "." : ` (code ${code}).`}`,
        true
      ));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > MAXIMUM_MESSAGE_BYTES) {
        finish(new ProviderError("invalid_response", "Codex returned an invalid usage response."));
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0 && !settled) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) handleMessage(
          line,
          (message) => child.stdin.write(JSON.stringify(message) + "\n"),
          finish
        );
        newline = buffer.indexOf("\n");
      }
    });

    child.stdin.write(JSON.stringify({
      method: "initialize",
      id: 0,
      params: { clientInfo: { name: "usageatlas", title: "UsageAtlas", version: DESKTOP_VERSION } }
    }) + "\n");
  });
}

function handleMessage(
  line: string,
  send: (message: Record<string, unknown>) => void,
  finish: (error?: ProviderError, value?: unknown) => void
): void {
  let message: Record<string, unknown>;
  try {
    message = object(JSON.parse(line) as unknown, "Codex");
  } catch {
    finish(new ProviderError("invalid_response", "Codex returned an invalid usage response."));
    return;
  }
  if (message.id !== 0 && message.id !== 1) return;
  const error = optionalObject(message.error, "Codex");
  if (error) {
    const text = optionalString(error.message)?.toLowerCase() ?? "";
    const auth = text.includes("auth") || text.includes("login") || text.includes("sign in");
    finish(new ProviderError(
      auth ? "auth_required" : "provider_error",
      auth
        ? "Codex is signed out. Run codex login, then refresh."
        : "Codex could not return account usage.",
      !auth
    ));
    return;
  }
  if (message.id === 0) {
    send({ method: "initialized", params: {} });
    send({ method: "account/rateLimits/read", id: 1, params: {} });
    return;
  }
  finish(undefined, object(message.result, "Codex"));
}
function formatDuration(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}