import { readdir } from "node:fs/promises";
import path from "node:path";
import { CATALOG, type CatalogEntry } from "./catalog";
import { compactName, nameVariants } from "./names";
import { dataBases, type RootOptions } from "./roots";

export interface InstalledTool {
  /** The catalog name, which is what the discovery field expects. */
  name: string;
  /** The folder that made it a hit. */
  folder: string;
  kind: CatalogEntry["kind"];
}

/**
 * Finds the tools this computer actually has, without reading a single file.
 *
 * Listing each data folder once and matching the names against the catalog is
 * what keeps this fast: one `readdir` per base instead of a `stat` for every
 * spelling of every product, which on a cold Windows profile took seconds. The
 * scan stays on local disks and opens no file, so it cannot read a prompt, a
 * token or a log line — a hit is only a lead the user still has to probe.
 */
export async function scanInstalledTools(options: RootOptions = {}): Promise<InstalledTool[]> {
  const catalogBySpelling = catalogSpellings();
  const found = new Map<string, InstalledTool>();
  for (const base of dataBases(options)) {
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      // Most data folders do not exist; that is the normal answer.
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = catalogBySpelling.get(compactName(entry.name));
      if (!match || found.has(match.name)) continue;
      found.set(match.name, { name: match.name, folder: path.join(base, entry.name), kind: match.kind });
    }
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Every folder spelling that belongs to a catalog entry, keyed by its compact form. */
function catalogSpellings(): Map<string, CatalogEntry> {
  const spellings = new Map<string, CatalogEntry>();
  for (const entry of CATALOG) {
    for (const name of [entry.name, ...(entry.aliases ?? [])]) {
      spellings.set(compactName(name), entry);
      for (const variant of nameVariants(name).variants) spellings.set(compactName(variant), entry);
    }
  }
  return spellings;
}
