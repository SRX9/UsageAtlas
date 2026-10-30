/**
 * Command line front end for the discovery engine: give it a provider name and
 * it plans a route to that provider's usage files.
 *
 *   bun run discover -- codefree
 *   bun run discover -- z.ai --root "C:\\Users\\me\\AppData\\Roaming\\zai"
 *   bun run discover -- --catalog
 *
 * Bundled with `bun build` and executed by Node so `node:sqlite` stays the real
 * SQLite binding the desktop engine uses.
 */
import { tmpdir } from "node:os";
import path from "node:path";
import { CATALOG, discoverProviderUsage, type DiscoveryResult } from "../apps/desktop/src/engine/discovery/index";

interface Options {
  root?: string;
  json: boolean;
  cache: boolean;
  catalog: boolean;
  quiet: boolean;
}

function parse(argv: string[]): { names: string[]; options: Options } {
  const options: Options = { json: false, cache: true, catalog: false, quiet: false };
  const names: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--root") options.root = argv[++index];
    else if (arg === "--json") options.json = true;
    else if (arg === "--no-cache") options.cache = false;
    else if (arg === "--catalog") options.catalog = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    else names.push(arg);
  }
  return { names, options };
}

function cacheDirectory(environment: NodeJS.ProcessEnv): string {
  const configured = environment.USAGEATLAS_DISCOVERY_CACHE?.trim();
  if (configured && path.isAbsolute(configured)) return configured;
  return path.join(tmpdir(), "usageatlas-discovery");
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(bytes < 1_048_576 ? 2 : 1)} MB`;
}

function report(result: DiscoveryResult): void {
  const slug = result.slug || "provider";
  console.log(`${result.provider}  (slug: ${slug})`);
  console.log(`  route     ${result.route}  ·  ${result.files.length} usable file(s)  ·  ${result.directories} folder(s) scanned  ·  ${result.entries} entries examined`);
  if (result.related.length > 0) console.log(`  related   ${result.related.join(", ")}`);
  if (result.files.length === 0) {
    console.log("  no file carried token counters");
    const tried = result.roots.slice(0, 6);
    console.log(`  tried     ${tried.join(", ")}${result.roots.length > tried.length ? ` (+${result.roots.length - tried.length} more)` : ""}`);
    return;
  }
  for (const file of result.files) {
    const shape = file.shape ? `${file.shape.kind} · ${file.shape.location}` : file.kind;
    console.log(`  ${file.confidence.toFixed(2)}  ${file.path}`);
    console.log(`        ${shape} · ${file.matches} sample(s) · ${file.reason} · ${megabytes(file.size)}`);
  }
}

async function main(): Promise<number> {
  const { names, options } = parse(process.argv.slice(2));
  const cache = options.cache ? cacheDirectory(process.env) : null;

  if (options.catalog) {
    const started = Date.now();
    let scanned = 0;
    let hits = 0;
    for (const entry of CATALOG) {
      const result = await discoverProviderUsage(entry.name, new Date(), { cacheDirectory: cache, maxEntries: 4_000 });
      scanned += 1;
      if (result.files.length > 0) {
        hits += 1;
        const best = result.files[0]!;
        console.log(`${entry.name.padEnd(16)} ${String(result.files.length).padStart(2)} file(s)  ${best.path}`);
      } else if (!options.quiet) {
        console.log(`${entry.name.padEnd(16)}  -`);
      }
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`\n${hits} of ${scanned} names resolved in ${seconds}s (cache: ${cache ?? "disabled"})`);
    return hits > 0 ? 0 : 1;
  }

  if (names.length === 0) {
    console.error("usage: bun run discover -- <provider name> [--root <dir>] [--json] [--no-cache] [--catalog]");
    return 2;
  }

  let found = 0;
  for (const name of names) {
    const result = await discoverProviderUsage(name, new Date(), { root: options.root, cacheDirectory: cache });
    if (options.json) console.log(JSON.stringify({ ...result, cache }, null, 2));
    else {
      if (names.length > 1) console.log("");
      report(result);
    }
    found += result.files.length;
  }
  if (!options.json) console.log(`\ncache: ${cache ?? "disabled"}`);
  return found > 0 ? 0 : 1;
}

main().then(
  code => process.exit(code),
  error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
);
