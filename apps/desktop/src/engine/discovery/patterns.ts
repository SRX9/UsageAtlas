/**
 * Which file names could carry token accounting. Nothing here knows a provider:
 * the guess comes from how products name their bookkeeping (`usage.json`,
 * `metrics.csv`, `history.sqlite`, `chat-messages.json`), and the content probe
 * decides whether a candidate really holds usage.
 */

const USAGE_WORD = /(^|[-_. ])(usage|usages|metrics|stats|statistics|quota|quotas|limits|credits|tokens?|token-usage|billing|entitlements?|subscriptions?|account|accounts|sessions?|history|transcripts?|conversations?|chats?|messages|telemetry|analytics|spend|costs?)([-_. ]|$)/i;

const DATABASE_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3", ".db3", ".sql"]);
const DOCUMENT_EXTENSIONS = new Set([".json", ".jsonl", ".ndjson"]);


export type CandidateKind = "database" | "document";

/**
 * Files worth probing. Databases are matched by extension alone because the
 * interesting ones are often named after the product (`desktop-v2.db`); smaller
 * documents have to earn the scan through their name.
 */
export function candidateFileKind(fileName: string): CandidateKind | null {
  const lower = fileName.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const extension = dot === -1 ? "" : lower.slice(dot);
  if (DATABASE_EXTENSIONS.has(extension)) return "database";
  if (!DOCUMENT_EXTENSIONS.has(extension)) return null;
  // Event logs are named after the session, not the content: Claude Code writes
  // `<uuid>.jsonl`, so only the probe can decide. Config files stay filtered by name.
  if (extension === ".jsonl" || extension === ".ndjson") return "document";
  if (lower.startsWith("chat-messages")) return "document";
  return USAGE_WORD.test(lower) ? "document" : null;
}

/** Names that almost never carry usage and are expensive to read anyway. */
export function isNoiseDirectory(name: string): boolean {
  return /^(node_modules|\.git|\.cache|cache|caches|gpucache|code cache|blob_storage|crashpad|logs?|tmp|temp|backups?|crash|service worker|partitioned|shadercache|dawncache)$/i.test(name);
}
