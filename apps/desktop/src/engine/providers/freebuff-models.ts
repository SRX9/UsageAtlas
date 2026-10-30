/**
 * Freebuff hides the model behind an opaque id: its per-project database stores
 * `threads.model` as `m-<digest>` (`m-096e75164d`), which no pricing catalog can
 * resolve. The digest is a fixed, dependency-free hash of the routing id the row
 * was written with, and Freebuff itself keeps the same table to reverse its own
 * legacy rows, so the mapping can be rebuilt offline from the ids it ships.
 *
 * Table read from Freebuff Desktop 0.0.192
 * (`resources/orchestrator/orchestrator.js`, `SUPPORTED_FREEBUFF_MODELS` and
 * `freebuffLegacyModelDigest`). `freebuff.ts` verifies the algorithm against the
 * database it reads: an unknown id stays opaque rather than being guessed.
 */
const LEGACY_PREFIX = "freebuff-legacy-model:";

/** Digest of the routing id → routing id. Keys are the part after `m-`. */
export const FREEBBUFF_MODEL_IDS: Readonly<Record<string, string>> = {
  "03bb9890d0": "moonshotai/kimi-k3",
  "04841c1c04": "openai/gpt-6-astra",
  "096e75164d": "deepseek/deepseek-v4-flash",
  "0a6f9dd646": "openai/gpt-5.6-luna",
  "0bcbacf062": "z-ai/glm-5.3",
  "0ccbae8306": "z-ai/glm-5.2",
  "0cf00255cb": "anthropic/claude-opus-4.6",
  "0ef0057b35": "anthropic/claude-opus-4.8",
  "127314bb39": "deepseek/deepseek-v4-flash-fast",
  "16f62b825b": "qwen/qwen3.6-plus",
  "1b657a7ff3": "qwen/qwen3.7-plus",
  "1cdf56ea69": "openai/gpt-6-astra-pro",
  "1d12c5c3d5": "anthropic/claude-opus-5.5",
  "20dc1d2c04": "openai/gpt-5.6-sol-pro",
  "21d5a7c27b": "z-ai/glm-5-turbo",
  "22ff70c712": "stealth/space-bunny-alpha",
  "259d0da813": "meta-llama/llama-4-maverick",
  "26ec2061ae": "openai/gpt-5.4-pro",
  "2acc20333d": "qwen/qwen3.7-max",
  "2d15555d19": "openai/gpt-6-sol-pro",
  "3b095d8b43": "crof/kimi-k3-eco",
  "4436bf737b": "google/gemini-3.1-flash-lite",
  "4d64c2beaf": "anthropic/claude-sonnet-5",
  "4df5e7bb9d": "x-ai/grok-4.20",
  "4f3631c1f1": "qwen/qwen3.6-max-preview",
  "540f50d039": "google/gemini-3.1-pro-preview",
  "5a5d0e255e": "openai/gpt-6-luna",
  "5b00c2224e": "google/gemini-3.7-flash",
  "5dafce7f08": "google/gemini-3.8-flash",
  "6268259fc5": "deepseek/deepseek-v4-pro",
  "6413200c75": "anthropic/claude-fable-5.1",
  "66b398e248": "anthropic/claude-opus-5",
  "6adcd6d671": "openai/gpt-6.1-sol",
  "7364fb9c4c": "x-ai/grok-4.5",
  "7564fec204": "x-ai/grok-4.7",
  "76650055a8": "x-ai/grok-4.6",
  "79033aedfe": "openai/gpt-5.6-luna-es",
  "79293c5b7d": "fbc/claude-haiku-5.5",
  "7df701c1a2": "anthropic/claude-sonnet-4.6",
  "7e20df6765": "z-ai/glm-5.3-flash",
  "828ba9bff7": "google/gemini-3.5-flash-lite",
  "83e1e10590": "stealth/ox-alpha",
  "85002ff2d1": "mistralai/mistral-large",
  "896c12aeb5": "openai/o3-pro",
  "89bff0e46b": "openai/gpt-5.6-luna-pro",
  "8ba83cffa0": "openai/gpt-6-sol",
  "8d7d6a4f67": "qwen/qwen3.8-27b",
  "909965b46d": "google/gemini-3.5-flash",
  "94d83cc7e6": "google/gemini-4-argon",
  "9af0db6100": "google/gemini-3.6-flash",
  "a1a7868cd9": "qwen/qwen3.8-max-0902",
  "a24d1e7e8c": "openai/gpt-5.6-sol",
  "acbf3dcde1": "z-ai/glm-5.3-flashx",
  "b745ddc3dd": "openai/gpt-6-luna-pro",
  "b95190aa00": "z-ai/glm-5.3-prime",
  "b9b7c21b7e": "anthropic/claude-haiku-4.5",
  "bdea5c2092": "qwen/qwen3.8-max-prime",
  "c2bb94903f": "openai/gpt-5.6-terra-pro",
  "c54e1831dc": "minimax/minimax-m3",
  "ca0bc0de4f": "openai/gpt-5.5-pro",
  "d5d778300c": "openai/gpt-5.5",
  "dc7e2b5384": "deepseek/deepseek-v4.1-flash",
  "e2f6bf3127": "mistralai/codestral-2508",
  "ebfd054ebc": "qwen/qwen3.8-flash",
  "eead5e02c2": "openai/gpt-5.6-terra",
  "f8d6ac83f8": "meta/muse-spark-1.2-contributor",
  "ffcbc2bcf3": "meta/muse-spark-1.3-contributor",
};

export interface FreebuffModel {
  /** Routing id as Freebuff sends it, e.g. `z-ai/glm-5.3-flash`. */
  readonly id: string;
  /** Vendor prefix, used to look the model up in the pricing catalog. */
  readonly vendor: string | null;
  /** Model id without its vendor prefix, e.g. `glm-5.3-flash`. */
  readonly model: string;
}

/**
 * Freebuff's own legacy digest: two FNV-1-style passes over a fixed prefix.
 * Kept bit-for-bit compatible, because the ids already stored use it.
 */
export function freebuffLegacyModelDigest(value: string): string {
  const input = `${LEGACY_PREFIX}${value}`;
  let left = 2166136261;
  let right = 1523705862;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    left = Math.imul(left ^ code, 16777619) >>> 0;
    right = Math.imul(right ^ code, 1540483477) >>> 0;
  }
  return left.toString(16).padStart(8, "0") + right.toString(16).padStart(8, "0");
}

/** The id Freebuff stores for a routing id, as `threads.model`. */
export function freebuffLegacyModelId(routingId: string): string {
  return `m-${freebuffLegacyModelDigest(`key:${routingId}`).slice(0, 10)}`;
}

/**
 * Turns whatever the database holds into a named model. An opaque id that is not
 * in the table, or a name this build does not recognize, keeps its own text so
 * the row is still counted and simply stays unpriced.
 */
export function resolveFreebuffModel(value: string): FreebuffModel {
  const raw = value.trim();
  const routing = /^m-[0-9a-f]{10}$/u.test(raw) ? FREEBBUFF_MODEL_IDS[raw.slice(2)] ?? null : raw;
  const slash = routing?.indexOf("/") ?? -1;
  if (!routing || slash <= 0 || slash === routing.length - 1) {
    return { id: routing ?? raw, vendor: null, model: routing ?? raw };
  }
  return { id: routing, vendor: routing.slice(0, slash), model: routing.slice(slash + 1) };
}
