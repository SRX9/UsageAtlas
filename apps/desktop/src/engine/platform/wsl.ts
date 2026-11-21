import { readdir as fsReaddir } from "node:fs/promises";
import path from "node:path";

export interface WslHomeOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readdir?: (directory: string) => Promise<Array<{ name: string; isDirectory(): boolean }>>;
}

/** Windows UNC roots that expose installed WSL distributions as files. */
const UNC_ROOTS = ["\\\\wsl$", "\\\\wsl.localhost"];
const MAX_DISTROS = 16;
const MAX_USERS_PER_DISTRO = 16;
const MAX_HOMES = 32;

const cache = new Map<string, Promise<string[]>>();

export function resetWslHomeCache(): void {
  cache.clear();
}

function disabledBy(environment: NodeJS.ProcessEnv): boolean {
  const value = environment.USAGEATLAS_DISABLE_WSL?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function explicitHomes(environment: NodeJS.ProcessEnv): string[] | null {
  const raw = environment.USAGEATLAS_WSL_HOMES;
  if (raw === undefined) return null;
  return dedupeHomes(
    raw.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean).map((entry) => path.normalize(entry))
  );
}

function dedupeHomes(paths: string[]): string[] {
  // Exact match only: WSL distro/user names live on case-sensitive Linux
  // filesystems. A case-only duplicate just rescans the same files, which the
  // downstream event-key dedup already collapses.
  return [...new Set(paths)];
}

/**
 * Extra home directories owned by WSL distributions on a Windows machine.
 *
 * Coding agents usually run inside WSL while UsageAtlas runs on Windows, so
 * their sessions live under `\\wsl$\<distro>\home\<user>` instead of the
 * Windows home. Auto-detection runs on Windows only and never throws: when
 * WSL is absent or unreadable the result is empty and the Windows home scan
 * is unaffected. At most 16 distributions, 16 users per distribution, and 32
 * homes overall are returned; the first UNC root with usable homes wins.
 * Successful filesystem results are cached for the process lifetime, so
 * installing or removing a distribution mid-session needs an app restart
 * (or a pinned `USAGEATLAS_WSL_HOMES`). `USAGEATLAS_WSL_HOMES` (delimited
 * like `PATH`) pins the list explicitly on any platform;
 * `USAGEATLAS_DISABLE_WSL=1` (also `true`/`yes`) opts out and wins over
 * the pinned list.
 */
export async function listWslHomes(options: WslHomeOptions = {}): Promise<string[]> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  if (disabledBy(environment)) return [];
  const explicit = explicitHomes(environment);
  if (explicit !== null) return explicit;
  if (platform !== "win32") return [];
  // Injected directory readers belong to tests; only cache real filesystem results.
  if (options.readdir) return discoverWslHomes(options.readdir);
  const key = `${platform}|${environment.USAGEATLAS_DISABLE_WSL ?? ""}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = discoverWslHomes((directory) => fsReaddir(directory, { withFileTypes: true }));
  cache.set(key, pending);
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}

/** The primary home plus every readable WSL home, deduplicated. */
export async function resolveScanHomes(homeDirectory: string, options: WslHomeOptions = {}): Promise<string[]> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const extra = await listWslHomes({ environment, platform, readdir: options.readdir });
  return dedupeHomes([homeDirectory, ...extra]);
}

async function discoverWslHomes(
  readdir: (directory: string) => Promise<Array<{ name: string; isDirectory(): boolean }>>
): Promise<string[]> {
  for (const unc of UNC_ROOTS) {
    let distros;
    try {
      distros = await readdir(unc);
    } catch {
      continue;
    }
    const homes: string[] = [];
    for (const distro of distros.filter((entry) => entry.isDirectory()).slice(0, MAX_DISTROS)) {
      if (homes.length >= MAX_HOMES) break;
      const distroRoot = `${unc}\\${distro.name}`;
      let users: Array<{ name: string; isDirectory(): boolean }>;
      try {
        users = await readdir(`${distroRoot}\\home`);
      } catch {
        users = [];
      }
      for (const user of users.filter((entry) => entry.isDirectory()).slice(0, MAX_USERS_PER_DISTRO)) {
        homes.push(`${distroRoot}\\home\\${user.name}`);
        if (homes.length >= MAX_HOMES) break;
      }
      if (homes.length >= MAX_HOMES) break;
      try {
        await readdir(`${distroRoot}\\root`);
        homes.push(`${distroRoot}\\root`);
      } catch {
        // Distributions without a readable root home add nothing.
      }
    }
    // A readable share with no usable homes may just be the wrong alias;
    // fall through to the next UNC root before giving up.
    if (homes.length > 0) return dedupeHomes(homes.slice(0, MAX_HOMES));
  }
  return [];
}
