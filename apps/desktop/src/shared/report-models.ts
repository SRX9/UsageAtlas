import { PUBLIC_MODELS } from "@usageatlas/contracts/usage";
import { OFFICIAL_PROVIDERS, type OfficialProvider } from "./report-plans";

/**
 * Models a relabelled upload may name, per official provider, so the picker in
 * Attribution offers what the provider actually runs instead of a blank field.
 *
 * The server only displays model keys it knows, so every entry here is filtered
 * against the reviewed public catalog (`PUBLIC_MODELS`); a key that catalog does
 * not carry is dropped rather than offered. Routing agents (opencode, pi, warp,
 * kilo, copilot, factory, amp, qoder) forward other providers' models, so they
 * are offered that shared set.
 */
const ROUTED_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6",
  "gpt-5.5",
  "gpt-5.3-codex",
  "claude-opus-5",
  "claude-sonnet-4-6",
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "kimi-k3-max",
  "grok-4.7",
  "grok-4.6",
  "grok-4.5",
  "composer-2.5"
] as const;

const CATALOG: Record<OfficialProvider, readonly string[]> = {
  codex: [
    "gpt-5.6-sol",
    "gpt-5.6",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5-codex",
    "gpt-5.1",
    "gpt-5",
    "gpt-4.1",
    "gpt-4o",
    "o3",
    "o4-mini",
    "codex-auto-review",
    "auto",
    "other"
  ],
  claude: [
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-6",
    "claude-opus-4-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-fable-5",
    "auto",
    "other"
  ],
  cursor: [
    "composer-2.5",
    "composer-2",
    "composer-1.5",
    "cursor-grok-4.6-high",
    "cursor-grok-4.5-high",
    "auto",
    "other"
  ],
  antigravity: ["gemini-3.5-flash", "gemini-3.1-pro", "gemini-2.5-flash", "auto", "other"],
  kimi: ["kimi-k3-max", "kimi-k3", "kimi-k3-high", "auto", "other"],
  muse: ["muse-spark-1.3-contributor-free", "muse-spark-1.2-contributor-free", "auto", "other"],
  opencode: ROUTED_MODELS,
  pi: ROUTED_MODELS,
  warp: ROUTED_MODELS,
  kilo: ROUTED_MODELS,
  copilot: ROUTED_MODELS,
  factory: ROUTED_MODELS,
  amp: ROUTED_MODELS,
  qoder: ROUTED_MODELS
};

export const REPORTED_MODELS = OFFICIAL_PROVIDERS.reduce(
  (catalog, provider) => {
    catalog[provider] = CATALOG[provider].filter(model => PUBLIC_MODELS.has(model));
    return catalog;
  },
  {} as Record<OfficialProvider, readonly string[]>
);

export function reportedModels(provider: OfficialProvider): readonly string[] {
  return REPORTED_MODELS[provider] ?? [];
}

/** First offered model for a provider, used when a rule changes provider. */
export function defaultReportedModel(provider: OfficialProvider): string {
  return reportedModels(provider)[0] ?? "";
}

/** Keeps a saved rule's model selectable even when the catalog does not list it. */
export function modelOptions(provider: OfficialProvider, saved: string): readonly string[] {
  const models = reportedModels(provider);
  const trimmed = saved.trim();
  return trimmed && !models.includes(trimmed) ? [trimmed, ...models] : models;
}
