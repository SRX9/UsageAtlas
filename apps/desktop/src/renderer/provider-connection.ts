import type { DashboardProvider, ProviderFailure } from "@usageatlas/contracts";

/**
 * How a tool's sign-in stands right now, separate from the local history it reported.
 * The two axes move independently: a tool can hold a complete local history and still be
 * signed out, in which case the history keeps counting while live limits and account usage
 * stop until the user signs in again with that tool's CLI or app.
 */
export type ConnectionState =
  | "connected"
  | "sign_in_required"
  | "not_connected"
  | "not_reporting"
  | "checking"
  | "disabled";

export interface ProviderConnection {
  state: ConnectionState;
  /** Pill wording. */
  label: string;
  /** What the state means for the numbers. */
  summary: string;
  /** The step that reconnects it, or null when there is nothing for the user to do. */
  action: string | null;
  /** Command that completes the step, shown right after the action. */
  command: string | null;
  /** The user has to act before this tool reports again. */
  needsAttention: boolean;
}

interface ReconnectStep {
  action: string;
  command: string | null;
}

interface ReconnectSteps {
  /** It was connected before and needs a fresh sign-in. */
  signIn: ReconnectStep;
  /** It has never been seen on this computer. */
  setUp: ReconnectStep;
}

const RUN_IN_TERMINAL = "Run this in a terminal, then reload:";

const RECONNECT: Record<string, ReconnectSteps> = {
  claude: {
    signIn: { action: RUN_IN_TERMINAL, command: "claude auth login" },
    setUp: { action: "Install Claude Code, sign in, then reload:", command: "claude auth login" }
  },
  codex: {
    signIn: { action: RUN_IN_TERMINAL, command: "codex login" },
    setUp: { action: "Install Codex, sign in, then reload:", command: "codex login" }
  },
  cursor: {
    signIn: { action: "Sign in to the Cursor desktop app, then reload.", command: null },
    setUp: { action: "Install Cursor and sign in, then reload.", command: null }
  },
  opencode: {
    signIn: { action: RUN_IN_TERMINAL, command: "opencode auth login" },
    setUp: { action: "Use OpenCode once on this computer, then reload.", command: null }
  }
};

const FALLBACK_RECONNECT: ReconnectSteps = {
  signIn: { action: "Sign in with this tool's CLI, then reload.", command: null },
  setUp: { action: "Install this tool and sign in, then reload.", command: null }
};

/** Codes that mean the stored sign-in is gone or no longer accepted. */
const SIGN_IN_CODES = new Set(["auth_required", "credentials_invalid"]);

export function providerConnection(provider: DashboardProvider): ProviderConnection {
  const steps = RECONNECT[provider.id] ?? FALLBACK_RECONNECT;
  if (!provider.enabled) {
    return {
      state: "disabled",
      label: "Off",
      summary: "Turned off. Enable it to include this tool.",
      action: null,
      command: null,
      needsAttention: false
    };
  }
  const failure = provider.error ?? credentialFailure(provider.analytics?.error ?? null);
  if (failure && SIGN_IN_CODES.has(failure.code)) {
    return {
      state: "sign_in_required",
      label: "Sign-in needed",
      summary: "Signed out on this computer. Live limits and account usage stopped updating.",
      action: steps.signIn.action,
      command: steps.signIn.command,
      needsAttention: true
    };
  }
  if (failure?.code === "credentials_missing") {
    return {
      state: "not_connected",
      label: "Not connected",
      summary: "Not detected on this computer yet.",
      action: steps.setUp.action,
      command: steps.setUp.command,
      needsAttention: true
    };
  }
  if (failure?.code === "provider_not_refreshed") {
    return {
      state: "checking",
      label: "Checking",
      summary: "Waiting for the first check of this session.",
      action: null,
      command: null,
      needsAttention: false
    };
  }
  if (failure) {
    return {
      state: "not_reporting",
      label: "Not reporting",
      summary: failure.message,
      action: "Reload to try again.",
      command: null,
      needsAttention: true
    };
  }
  return {
    state: "connected",
    label: "Connected",
    summary: connectedSummary(provider),
    action: null,
    command: null,
    needsAttention: false
  };
}

/** The reconnect step as one plain sentence, for places that cannot render the command chip. */
export function reconnectSentence(connection: ProviderConnection): string | null {
  if (!connection.action) return null;
  return connection.command ? `${connection.action} ${connection.command}` : connection.action;
}

/**
 * A history scan only escalates to the connection when it is a credential problem — a
 * partial or unreadable history is the coverage list's story, not the sign-in's.
 */
function credentialFailure(failure: ProviderFailure | null): ProviderFailure | null {
  if (!failure) return null;
  const credentials = SIGN_IN_CODES.has(failure.code) || failure.code === "credentials_missing";
  return credentials ? failure : null;
}

function connectedSummary(provider: DashboardProvider): string {
  if (provider.source === "cursor_app") {
    return provider.analytics
      ? "Connected through Cursor with detailed dashboard history."
      : "Connected through the Cursor desktop app.";
  }
  if (provider.source === "opencode_local_estimate") return "OpenCode Go with local quota estimates.";
  if (provider.id === "opencode" && provider.analytics) return "Reading local OpenCode activity.";
  const plan = provider.identity?.plan;
  return plan ? `Signed in · ${plan}` : "Signed in and reporting.";
}
