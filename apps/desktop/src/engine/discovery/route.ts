import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { nameVariants, namesRelated } from "./names";
import { candidateFileKind, isNoiseDirectory, type CandidateKind } from "./patterns";
import { probeFile, type UsageShape } from "./probe";
import { candidateRoots, dataBases, type RootOptions } from "./roots";

/**
 * Discovery works like planning a route to a destination that only has a name:
 *
 * 1. Try the exact addresses that name implies (`~/.config/<name>`, `%APPDATA%\<name>`,
 *    the `-desktop` and `-cli` spellings, one per platform data folder).
 * 2. If none of them exist, look for the nearest match on the same street: a
 *    sibling folder whose name is clearly the same product (`codefree-desktop`
 *    for `codefree`).
 * 3. Inside those folders, walk a bounded number of entries and pick every file
 *    whose name could hold accounting, then probe the content. Only files where
 *    a numeric token field was actually seen are reported.
 * 4. Remember the winning route, reuse it while it verifies, and plan again as
 *    soon as it stops.
 */

const CACHE_VERSION = 1;
/** A saved route is trusted without re-probing for this long. */
const ROUTE_TTL_MS = 30 * 60_000;
const MAX_SCAN_ENTRIES = 20_000;
const MAX_SCAN_DEPTH = 5;
const MAX_CANDIDATES = 200;
const MAX_RELATED_ROOTS = 24;

export interface DiscoveryOptions extends RootOptions {
  /** An explicit folder beats every guess; scanned first. */
  root?: string;
  /** `null` disables persistence; omit to use the engine's user-data folder. */
  cacheDirectory?: string | null;
  maxEntries?: number;
  maxDepth?: number;
  maxCandidates?: number;
}

export interface DiscoveredFile {
  path: string;
  kind: CandidateKind;
  size: number;
  mtimeMs: number;
  confidence: number;
  matches: number;
  shape?: UsageShape;
  reason: string;
}

export interface DiscoveryResult {
  provider: string;
  slug: string;
  route: "cached" | "discovered";
  resolvedAt: number;
  /** Every address tried, whether or not it existed. */
  roots: string[];
  /** The roots that existed and were walked. */
  scanned: string[];
  /** Folders matched by name rather than by exact address. */
  related: string[];
  directories: number;
  entries: number;
  files: DiscoveredFile[];
}

interface SavedRoute {
  version: number;
  provider: string;
  resolvedAt: number;
  roots: string[];
  scanned: string[];
  related: string[];
  files: DiscoveredFile[];
}

/**
 * Resolves where a provider keeps its usage. `force` ignores the saved route,
 * which callers use when the remembered files no longer parse.
 */
export async function discoverProviderUsage(
  name: string,
  now: Date,
  options: DiscoveryOptions = {},
  signal?: AbortSignal
): Promise<DiscoveryResult> {
  const { slug } = nameVariants(name);
  const environment = options.environment ?? process.env;
  const cacheFile = options.cacheDirectory === null
    ? null
    : path.join(options.cacheDirectory ?? defaultCacheDirectory(environment) ?? ".", `discovered-${slug || "provider"}.json`);
  const roots = options.root
    ? [path.normalize(options.root), ...candidateRoots(name, options).filter(root => path.normalize(root) !== path.normalize(options.root!))]
    : candidateRoots(name, options);

  const saved = cacheFile ? await readSavedRoute(cacheFile) : null;
  if (saved && now.getTime() - saved.resolvedAt < ROUTE_TTL_MS) {
    const confirmed = await confirmRoute(saved, signal);
    if (confirmed.length > 0) {
      // The remembered files still parse. Rather than trusting the first route,
      // drive the block again: the folders that held those files, then their
      // neighbours, looking for usage that appeared since the last visit.
      const hotspots = await scanRoots(hotspotsFor(confirmed), { ...options, maxDepth: 1, maxEntries: 4_000 }, signal);
      const related = saved.related.length > 0
        ? saved.related
        : (await relatedRoots(name, options, signal)).filter((folder) => !roots.includes(folder));
      const relatedScan = related.length > 0
        ? await scanRoots(related, { ...options, maxEntries: 6_000 }, signal)
        : null;
      const files = mergeFiles([...confirmed, ...hotspots.files, ...(relatedScan?.files ?? [])]);
      const scanned = unique([...saved.scanned, ...hotspots.scanned, ...(relatedScan?.scanned ?? [])]);
      const route: SavedRoute = {
        ...saved,
        resolvedAt: now.getTime(),
        related: unique([...saved.related, ...related]),
        scanned,
        files
      };
      await saveRoute(cacheFile, route);
      return toResult(route, "cached", {
        directories: scanned.length,
        entries: hotspots.entries + (relatedScan?.entries ?? 0)
      });
    }
  }

  const scan = await scanRoots(roots, options, signal);
  // Finding one ledger is not proof it is the only one: a sibling folder of the
  // same product can hold a second store, so the neighbours are always checked.
  const related = (await relatedRoots(name, options, signal)).filter((folder) => !roots.includes(folder));
  const relatedScan = related.length > 0 ? await scanRoots(related, { ...options, maxEntries: 6_000 }, signal) : null;
  const files = mergeFiles([...scan.files, ...(relatedScan?.files ?? [])]);
  const scanned = unique([...scan.scanned, ...(relatedScan?.scanned ?? [])]);

  if (files.length > 0) {
    const route: SavedRoute = {
      version: CACHE_VERSION,
      provider: name,
      resolvedAt: now.getTime(),
      roots,
      scanned,
      related,
      files
    };
    await saveRoute(cacheFile, route);
    return toResult(route, "discovered", {
      directories: scanned.length,
      entries: scan.entries + (relatedScan?.entries ?? 0)
    });
  }

  // Nothing new was found; a saved route whose files still parse is better than none.
  const remaining = saved ? await confirmRoute(saved, signal) : [];
  if (saved && remaining.length > 0) {
    const renewed = { ...saved, resolvedAt: now.getTime(), files: remaining };
    await saveRoute(cacheFile, renewed);
    return toResult(renewed, "cached");
  }
  return {
    provider: name,
    slug,
    route: "discovered",
    resolvedAt: now.getTime(),
    roots,
    scanned,
    related,
    directories: scan.directories + (relatedScan?.directories ?? 0),
    entries: scan.entries + (relatedScan?.entries ?? 0),
    files: []
  };
}

/** Where routes are remembered: next to the engine's own data files. */
export function defaultCacheDirectory(environment: NodeJS.ProcessEnv): string | null {
  const history = environment.USAGEATLAS_HISTORY_DB?.trim();
  if (history && path.isAbsolute(history)) return path.dirname(history);
  const configured = environment.USAGEATLAS_DISCOVERY_CACHE?.trim();
  return configured && path.isAbsolute(configured) ? configured : null;
}

async function scanRoots(
  roots: string[],
  options: DiscoveryOptions,
  signal?: AbortSignal
): Promise<{ files: DiscoveredFile[]; scanned: string[]; directories: number; entries: number }> {
  const limit = options.maxEntries ?? MAX_SCAN_ENTRIES;
  const budget = { entries: limit };
  const maxDepth = options.maxDepth ?? MAX_SCAN_DEPTH;
  const maxCandidates = options.maxCandidates ?? MAX_CANDIDATES;
  const scanned: string[] = [];
  const candidates: Array<{ path: string; kind: CandidateKind }> = [];
  const pending = roots.map(root => ({ directory: root, depth: 0 }));
  let directories = 0;

  while (pending.length > 0 && budget.entries > 0 && candidates.length < maxCandidates) {
    signal?.throwIfAborted();
    const { directory, depth } = pending.shift()!;
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    directories += 1;
    if (!scanned.includes(directory)) scanned.push(directory);
    budget.entries -= children.length;
    for (const child of children) {
      if (child.isSymbolicLink()) continue;
      const location = path.join(directory, child.name);
      if (child.isDirectory()) {
        if (depth < maxDepth && !isNoiseDirectory(child.name)) {
          pending.push({ directory: location, depth: depth + 1 });
        }
        continue;
      }
      if (!child.isFile()) continue;
      const kind = candidateFileKind(child.name);
      if (!kind) continue;
      candidates.push({ path: location, kind });
      if (candidates.length >= maxCandidates) break;
    }
  }

  const files: DiscoveredFile[] = [];
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    const probe = await probeFile(candidate.path, candidate.kind);
    if (!probe.usable) continue;
    let info;
    try {
      info = await stat(candidate.path);
    } catch {
      continue;
    }
    files.push({
      path: candidate.path,
      kind: candidate.kind,
      size: info.size,
      mtimeMs: info.mtimeMs,
      confidence: probe.confidence,
      matches: probe.matches,
      shape: probe.shape,
      reason: probe.reason
    });
  }
  return { files: files.sort(compareFiles), scanned, directories, entries: limit - budget.entries };
}

/** The nearest match on the same street: sibling folders of the same product. */
async function relatedRoots(name: string, options: DiscoveryOptions, signal?: AbortSignal): Promise<string[]> {
  const found = new Set<string>();
  for (const base of dataBases(options)) {
    signal?.throwIfAborted();
    let children;
    try {
      children = await readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory() || child.isSymbolicLink() || isNoiseDirectory(child.name)) continue;
      if (!namesRelated(child.name, name)) continue;
      found.add(path.join(base, child.name));
      if (found.size >= MAX_RELATED_ROOTS) return [...found];
    }
  }
  return [...found];
}

function compareFiles(left: DiscoveredFile, right: DiscoveredFile): number {
  return right.confidence - left.confidence || right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path);
}

/**
 * Re-reads every remembered file. A file that still exists but no longer holds
 * token counters (rotated, truncated, replaced by settings) is dropped, so the
 * route is never trusted just because a path resolves.
 */
async function confirmRoute(route: SavedRoute, signal?: AbortSignal): Promise<DiscoveredFile[]> {
  const confirmed: DiscoveredFile[] = [];
  for (const file of route.files) {
    signal?.throwIfAborted();
    const probe = await probeFile(file.path, file.kind);
    if (!probe.usable) continue;
    let info;
    try {
      info = await stat(file.path);
    } catch {
      continue;
    }
    confirmed.push({
      ...file,
      size: info.size,
      mtimeMs: info.mtimeMs,
      confidence: probe.confidence,
      matches: probe.matches,
      shape: probe.shape ?? file.shape,
      reason: probe.reason
    });
  }
  return mergeFiles(confirmed);
}

/** The exact folders that held a file: where to look again first. */
function hotspotsFor(files: DiscoveredFile[]): string[] {
  const folders = new Set<string>();
  for (const file of files) folders.add(path.dirname(file.path));
  return [...folders];
}

/** One row per path, keeping the most confident and most recent evidence. */
function mergeFiles(files: DiscoveredFile[]): DiscoveredFile[] {
  const byPath = new Map<string, DiscoveredFile>();
  for (const file of files) {
    const existing = byPath.get(file.path);
    if (!existing
      || file.confidence > existing.confidence
      || (file.confidence === existing.confidence && file.mtimeMs > existing.mtimeMs)) {
      byPath.set(file.path, file);
    }
  }
  return [...byPath.values()].sort(compareFiles);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function readSavedRoute(cacheFile: string): Promise<SavedRoute | null> {
  let text: string;
  try {
    text = await readFile(cacheFile, "utf8");
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== CACHE_VERSION) return null;
  if (typeof record.resolvedAt !== "number" || !Number.isFinite(record.resolvedAt)) return null;
  if (typeof record.provider !== "string") return null;
  const files = savedFiles(record.files);
  if (!files) return null;
  return {
    version: CACHE_VERSION,
    provider: record.provider,
    resolvedAt: record.resolvedAt,
    roots: absoluteStrings(record.roots) ?? [],
    scanned: absoluteStrings(record.scanned) ?? [],
    related: absoluteStrings(record.related) ?? [],
    files: files.filter(file => path.isAbsolute(file.path))
  };
}

function savedFiles(value: unknown): DiscoveredFile[] | null {
  if (!Array.isArray(value)) return null;
  const files: DiscoveredFile[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string" || typeof record.kind !== "string") return null;
    if (record.kind !== "database" && record.kind !== "document") return null;
    files.push({
      path: record.path,
      kind: record.kind,
      size: typeof record.size === "number" ? record.size : 0,
      mtimeMs: typeof record.mtimeMs === "number" ? record.mtimeMs : 0,
      confidence: typeof record.confidence === "number" ? record.confidence : 0,
      matches: typeof record.matches === "number" ? record.matches : 0,
      shape: record.shape as UsageShape | undefined,
      reason: typeof record.reason === "string" ? record.reason : ""
    });
  }
  return files;
}

function absoluteStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string" && path.isAbsolute(item));
}

async function saveRoute(cacheFile: string | null, route: SavedRoute): Promise<void> {
  if (!cacheFile) return;
  const payload = `${JSON.stringify(route)}\n`;
  const temporary = `${cacheFile}.${process.pid}.tmp`;
  try {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(temporary, payload, "utf8");
    await rename(temporary, cacheFile);
  } catch {
    // A read-only data folder only costs re-planning, never correctness.
    try { await writeFile(cacheFile, payload, "utf8"); } catch { /* keep going */ }
  }
}

function toResult(
  route: SavedRoute,
  kind: DiscoveryResult["route"],
  stats?: { directories: number; entries: number }
): DiscoveryResult {
  return {
    provider: route.provider,
    slug: nameVariants(route.provider).slug,
    route: kind,
    resolvedAt: route.resolvedAt,
    roots: route.roots,
    scanned: route.scanned,
    related: route.related,
    directories: stats?.directories ?? route.scanned.length,
    entries: stats?.entries ?? 0,
    files: route.files
  };
}
