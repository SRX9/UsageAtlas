import type { DiscoveryResult } from "../engine/discovery";
import type { ProviderDiscovery } from "../shared/desktop-api";

/** The longest file path shown in Settings; the full path stays in the title. */
const MAX_FILES = 12;

/**
 * Trims the engine's discovery result to what the Settings card can show. The
 * engine already orders files by confidence and recency, so the first one is the
 * route it would actually read.
 */
export function summarizeDiscovery(result: DiscoveryResult): ProviderDiscovery {
  const files = result.files.slice(0, MAX_FILES).map((file) => ({
    path: file.path,
    kind: file.kind,
    confidence: Math.round(file.confidence * 100),
    matches: file.matches,
    reason: file.reason,
    store: file.shape ? `${file.shape.kind} · ${file.shape.location}` : null,
    fields: file.shape?.fields.slice(0, 8) ?? []
  }));
  return {
    provider: result.provider,
    route: result.route,
    files,
    folders: result.scanned.length,
    related: result.related.length,
    entries: result.entries,
    confidence: files[0]?.confidence ?? 0,
    confirmedBy: result.files.length
  };
}
