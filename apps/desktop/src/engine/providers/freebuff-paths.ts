import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProviderError } from "../provider";

/**
 * Freebuff keeps its usage on disk in more than one shape, and the exact folder
 * moves whenever the app renames a project or a release switches layout. This
 * module plans a route to the data the way a navigator plans a route to a
 * destination:
 *
 * 1. If a saved route exists, is recent, and still verifies, use it directly.
 * 2. Otherwise scan the known roots for a database that passes a schema probe
 *    (`messages.role`, `messages.ts`, `messages.metrics_json`) or a recent chat
 *    transcript, rank the candidates, and save the winning route.
 * 3. If a saved route stops verifying - the file moved, was deleted, or changed
 *    schema - discard it and plan again. A stale route that still works is kept
 *    when a re-plan comes back empty, so a locked database never erases a
 *    route that is still usable.
 */

/** Freebuff Desktop has shipped both names across releases; either is accepted. */
const DATABASE_NAMES = new Set(["desktop-v2.db", "desktop.db"]);
const CHAT_FILE = "chat-messages.json";
const CACHE_VERSION = 1;
const MAXIMUM_CACHE_BYTES = 1_048_576;
/** A saved route is trusted without re-scanning for this long. */
const ROUTE_TTL_MS = 30 * 60_000;
const MAX_DATABASES = 64;
const MAX_CHAT_FILES = 200;
const MAX_SCAN_ENTRIES = 4_000;
const MAX_SCAN_DEPTH = 4;
const RECENT_CHAT_DAYS = 3;
/** Compiled bundles and caches can hold thousands of files but never usage data. */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules", ".git", ".cache", "Cache", "GPUCache", "Code Cache",
  "blob_storage", "Crashpad", "logs", "tmp"
]);

export interface FreebuffPathOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  /** `null` disables persistence; omit to use the engine's user-data folder. */
  cacheFile?: string | null;
  maxDatabases?: number;
  maxChatFiles?: number;
}

export interface FreebuffSources {
  databases: string[];
  chats: string[];
  roots: string[];
  /** `cached` reuses the saved route; `discovered` comes from a filesystem scan. */
  route: "cached" | "discovered";
  resolvedAt: number;
}

interface SavedEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

interface SavedRoute {
  version: number;
  resolvedAt: number;
  roots: string[];
  databases: SavedEntry[];
  chats: SavedEntry[];
}

/**
 * Resolves the Freebuff usage locations for one refresh. `force` skips the
 * saved route, which the adapter uses when a cached route fails to open.
 */
export async function resolveFreebuffSources(
  options: FreebuffPathOptions,
  now: Date,
  signal?: AbortSignal,
  force = false
): Promise<FreebuffSources> {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const cacheFile = options.cacheFile === null ? null : options.cacheFile ?? defaultFreebuffCacheFile(environment);
  signal?.throwIfAborted();

  const saved = cacheFile && !force ? await readSavedRoute(cacheFile) : null;
  const savedValid = saved ? await routeVerified(saved, signal) : false;
  if (saved && savedValid && now.getTime() - saved.resolvedAt < ROUTE_TTL_MS) {
    return toSources(saved, "cached");
  }

  const discovered = await discoverSources(environment, home, options, now, signal);
  if (discovered.databases.length || discovered.chats.length) {
    const route = await saveRoute(cacheFile, discovered, now);
    return toSources(route, "discovered");
  }

  // Nothing new was found. A saved route that still verifies is better than none,
  // and renewing its timestamp keeps the next refresh from scanning again.
  if (saved && savedValid) {
    const renewed = await saveRoute(
      cacheFile,
      { roots: saved.roots, databases: saved.databases, chats: saved.chats },
      now
    );
    return toSources(renewed, "cached");
  }
  return {
    databases: [], chats: [], route: "discovered", resolvedAt: now.getTime(),
    roots: freebuffDataRoots(environment, home)
  };
}

/** Where a working route is remembered: next to the engine's own data files. */
export function defaultFreebuffCacheFile(environment: NodeJS.ProcessEnv): string | null {
  const configured = environment.USAGEATLAS_FREEBUFF_CACHE?.trim();
  if (configured) return path.isAbsolute(configured) ? path.normalize(configured) : null;
  const history = environment.USAGEATLAS_HISTORY_DB?.trim();
  if (history && path.isAbsolute(history)) return path.join(path.dirname(history), "freebuff-sources.json");
  return null;
}

/** Config roots used by the Freebuff Desktop app and the CLI. */
export function freebuffDataRoots(environment: NodeJS.ProcessEnv, home: string): string[] {
  const configured = environment.FREEBUFF_CONFIG_DIR?.trim();
  if (configured) {
    if (!path.isAbsolute(configured))
      throw new ProviderError("config_invalid", "FREEBUFF_CONFIG_DIR must be an absolute path.");
    return [path.normalize(configured)];
  }
  const roots = [
    path.join(home, ".config", "freebuff-desktop"),
    path.join(home, ".config", "manicode"),
    path.join(home, ".config", "manicode-dev"),
    path.join(home, ".config", "Freebuff"),
    path.join(home, ".config", "Freebuff Desktop"),
    path.join(home, ".local", "share", "freebuff"),
    path.join(home, ".local", "share", "freebuff-desktop"),
    path.join(home, "Library", "Application Support", "freebuff-desktop"),
    path.join(home, "Library", "Application Support", "manicode"),
    path.join(home, "Library", "Application Support", "Freebuff")
  ];
  if (environment.XDG_CONFIG_HOME) roots.push(
    path.join(environment.XDG_CONFIG_HOME, "freebuff-desktop"),
    path.join(environment.XDG_CONFIG_HOME, "manicode"),
    path.join(environment.XDG_CONFIG_HOME, "Freebuff")
  );
  if (environment.XDG_DATA_HOME) roots.push(
    path.join(environment.XDG_DATA_HOME, "freebuff"),
    path.join(environment.XDG_DATA_HOME, "freebuff-desktop")
  );
  if (environment.APPDATA) roots.push(
    path.join(environment.APPDATA, "freebuff-desktop"),
    path.join(environment.APPDATA, "manicode"),
    path.join(environment.APPDATA, "Freebuff"),
    path.join(environment.APPDATA, "freebuff")
  );
  if (environment.LOCALAPPDATA) roots.push(
    path.join(environment.LOCALAPPDATA, "freebuff-desktop"),
    path.join(environment.LOCALAPPDATA, "Freebuff")
  );
  return [...new Set(roots.map(root => path.normalize(root)))];
}

async function discoverSources(
  environment: NodeJS.ProcessEnv,
  home: string,
  options: FreebuffPathOptions,
  now: Date,
  signal?: AbortSignal
): Promise<Omit<SavedRoute, "version" | "resolvedAt">> {
  const roots = freebuffDataRoots(environment, home);
  const maxDatabases = options.maxDatabases ?? MAX_DATABASES;
  const maxChats = options.maxChatFiles ?? MAX_CHAT_FILES;
  const databases = new Map<string, SavedEntry>();
  const chats = new Map<string, SavedEntry>();
  const cutoff = now.getTime() - RECENT_CHAT_DAYS * 86_400_000;
  let budget = MAX_SCAN_ENTRIES;

  // A configured root may point straight at a file instead of a folder.
  for (const root of roots) {
    if (DATABASE_NAMES.has(path.basename(root))) await considerDatabase(root, databases, maxDatabases);
    else if (path.basename(root) === CHAT_FILE) await considerChat(root, chats, maxChats, cutoff);
  }

  const pending: Array<{ directory: string; depth: number }> = roots.map(root => ({ directory: root, depth: 0 }));
  while (pending.length && budget > 0 && (databases.size < maxDatabases || chats.size < maxChats)) {
    signal?.throwIfAborted();
    const { directory, depth } = pending.shift()!;
    let children;
    try { children = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    budget -= children.length;
    for (const child of children) {
      if (child.isSymbolicLink()) continue;
      const location = path.join(directory, child.name);
      if (child.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH && !SKIPPED_DIRECTORIES.has(child.name)) {
          pending.push({ directory: location, depth: depth + 1 });
        }
      } else if (child.isFile() && DATABASE_NAMES.has(child.name)) {
        await considerDatabase(location, databases, maxDatabases);
      } else if (child.isFile() && child.name === CHAT_FILE) {
        await considerChat(location, chats, maxChats, cutoff);
      }
    }
  }
  return { roots, databases: rank(databases), chats: rank(chats) };
}

/** Only a database that still answers the schema probe is worth saving. */
async function considerDatabase(file: string, found: Map<string, SavedEntry>, maximum: number): Promise<void> {
  if (found.size >= maximum || found.has(file)) return;
  const entry = await entryFor(file);
  if (!entry || !databaseUsable(file)) return;
  found.set(file, entry);
}

async function considerChat(file: string, found: Map<string, SavedEntry>, maximum: number, cutoff: number): Promise<void> {
  if (found.size >= maximum || found.has(file)) return;
  const entry = await entryFor(file);
  if (!entry || entry.mtimeMs < cutoff) return;
  found.set(file, entry);
}

function rank(found: Map<string, SavedEntry>): SavedEntry[] {
  return [...found.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

async function entryFor(file: string): Promise<SavedEntry | null> {
  try {
    const info = await stat(file);
    return info.isFile() && info.size > 0 ? { path: file, size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** A saved route verifies only while every file it names is still there and usable. */
async function routeVerified(route: SavedRoute, signal?: AbortSignal): Promise<boolean> {
  if (!route.databases.length && !route.chats.length) return false;
  for (const entry of route.databases) {
    signal?.throwIfAborted();
    const current = await entryFor(entry.path);
    if (!current || !databaseUsableCached(current)) return false;
  }
  for (const entry of route.chats) {
    signal?.throwIfAborted();
    if (!(await entryFor(entry.path))) return false;
  }
  return true;
}

/**
 * Schema probes, keyed by the identity of the file they were answered for.
 *
 * Verifying a six-database route by reopening each file costs about 20 ms, and
 * the engine re-verifies its route on every refresh. A file that keeps its size
 * and mtime cannot have changed its schema, so the answer stands until the file
 * is written again; a replaced or migrated database gets a fresh probe.
 */
const schemaProbes = new Map<string, boolean>();
const MAXIMUM_SCHEMA_PROBES = 256;

function databaseUsableCached(entry: SavedEntry): boolean {
  const key = `${entry.path}\u0000${entry.size}\u0000${Math.round(entry.mtimeMs)}`;
  const known = schemaProbes.get(key);
  if (known !== undefined) return known;
  const usable = databaseUsable(entry.path);
  if (schemaProbes.size >= MAXIMUM_SCHEMA_PROBES) schemaProbes.clear();
  schemaProbes.set(key, usable);
  return usable;
}

/** Opens read-only and requires the columns the reader actually queries. */
function databaseUsable(file: string): boolean {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(file, { readOnly: true, timeout: 500 });
  } catch {
    return false;
  }
  try {
    const columns = database.prepare("PRAGMA table_info(messages)").all() as Array<{ name?: unknown }>;
    const names = new Set(columns.map(column => (typeof column.name === "string" ? column.name : "")));
    return ["role", "ts", "metrics_json"].every(name => names.has(name));
  } catch {
    return false;
  } finally {
    try { database.close(); } catch { /* already closed */ }
  }
}

async function readSavedRoute(cacheFile: string): Promise<SavedRoute | null> {
  let text: string;
  try {
    const info = await stat(cacheFile);
    if (!info.isFile() || info.size > MAXIMUM_CACHE_BYTES) return null;
    text = await readFile(cacheFile, "utf8");
  } catch {
    return null;
  }
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== CACHE_VERSION) return null;
  if (typeof record.resolvedAt !== "number" || !Number.isFinite(record.resolvedAt)) return null;
  const roots = absoluteStrings(record.roots);
  const databases = absoluteEntries(record.databases);
  const chats = absoluteEntries(record.chats);
  if (!roots || !databases || !chats) return null;
  return { version: CACHE_VERSION, resolvedAt: record.resolvedAt, roots, databases, chats };
}

function absoluteStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((item): item is string => typeof item === "string" && path.isAbsolute(item));
  return strings.length === value.length ? strings : null;
}

function absoluteEntries(value: unknown): SavedEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: SavedEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (typeof entry.path !== "string" || !path.isAbsolute(entry.path)) return null;
    if (typeof entry.size !== "number" || !Number.isFinite(entry.size) || entry.size < 0) return null;
    if (typeof entry.mtimeMs !== "number" || !Number.isFinite(entry.mtimeMs)) return null;
    entries.push({ path: entry.path, size: entry.size, mtimeMs: entry.mtimeMs });
  }
  return entries;
}

async function saveRoute(
  cacheFile: string | null,
  discovered: Omit<SavedRoute, "version" | "resolvedAt">,
  now: Date
): Promise<Omit<SavedRoute, "version" | "resolvedAt"> & { version: number; resolvedAt: number }> {
  const route = { version: CACHE_VERSION, resolvedAt: now.getTime(), ...discovered };
  if (!cacheFile) return route;
  const temporary = `${cacheFile}.${process.pid}.tmp`;
  try {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(route)}\n`, "utf8");
    await rename(temporary, cacheFile);
  } catch {
    // A read-only data folder only costs re-planning, never correctness.
    try { await writeFile(cacheFile, `${JSON.stringify(route)}\n`, "utf8"); } catch { /* keep going */ }
  }
  return route;
}

function toSources(
  route: Omit<SavedRoute, "version">,
  kind: FreebuffSources["route"]
): FreebuffSources {
  return {
    databases: route.databases.map(entry => entry.path),
    chats: route.chats.map(entry => entry.path),
    roots: route.roots,
    route: kind,
    resolvedAt: route.resolvedAt
  };
}
