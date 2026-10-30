# Provider discovery

UsageAtlas can report a tool's usage only if it knows where that tool keeps it.
Historically every provider needed a hand-written adapter. Discovery turns that
around: give the engine a **name** and it plans a route to the files that hold
token counts, then proves the route by reading the files.

This is the same shape as the Freebuff planner ([freebuff-paths.ts](../apps/desktop/src/engine/providers/freebuff-paths.ts)):
try the known addresses, verify by content, remember what worked, and plan again
when it stops working.

## Running it

```bash
bun run discover -- codefree
bun run discover -- z.ai --root "C:\Users\me\AppData\Roaming\zai"
bun run discover -- freebuff claude --json
bun run discover -- --catalog          # every seeded name, one line each
```

The command bundles [discover-provider.ts](../tooling/discover-provider.ts) with
`bun build` and runs it under Node, so it uses the same `node:sqlite` binding the
desktop engine uses.

## How a route is planned

1. **Spellings.** `CodeFree`, `code-free`, `codefree-desktop`, `CodeFree Studio`
   are the same destination. Names are normalised to a slug and expanded with
   product suffixes (`-desktop`, `-cli`, `-app`, `-client`, `-companion`).
2. **Addresses.** Every spelling is joined to each per-user data folder:
   `~/.config`, `~/.local/share`, `~/.local/state`, `%APPDATA%`, `%LOCALAPPDATA%`,
   `~/Library/Application Support`, `XDG_*` overrides and the home folder itself.
3. **Nearest match.** If none of those folders exist, sibling folders whose names
   are the same product plus a product suffix are scanned instead — `codefree`
   finds `CodeFree Studio`, but `code` is *not* considered related to `codefree`.
4. **Candidates by name.** Inside those folders a bounded walk picks files whose
   name could hold accounting (`usage`, `metrics`, `quota`, `credits`, `tokens`,
   `sessions`, `history`, `cost`, …) plus every SQLite database and every
   `.jsonl`/`.ndjson` event log.
5. **Proof by content.** Nothing is reported as usable until the probe has seen a
   numeric token counter:
   - SQLite: token columns (`prompt_tokens`, `inputTokens`, `total_tokens`, …) or
     a JSON blob column whose rows parse to a `usage` object.
   - JSON: an object (or list of objects) with token counters, at any depth.
   - JSONL: event lines that carry their own counters.
   A file that merely has a promising name is rejected.
6. **Memory.** The winning route is saved as `discovered-<slug>.json` next to the
   engine's own data files, reused while every file still exists (30-minute
   trust window), and planned again as soon as one disappears.

## Bounds

Discovery is deliberately cheap and never writes outside its cache: 20 000
directory entries per plan, depth 5, 200 candidate files, 24 related folders.
Symlinks are skipped, and caches, `node_modules`, logs and package folders are
never entered. Documents larger than 8 MB are not parsed; event logs are read
only from their first 2 MB.

## Status

The engine and its command line are in place and tested (see
[discovery.test.ts](../apps/desktop/src/engine/discovery/discovery.test.ts)).
It is **not yet wired into the desktop application**: providers still come from
[registry.ts](../apps/desktop/src/engine/providers/registry.ts), so a discovered
file is reported by `bun run discover` but not yet shown as a provider card.
Wiring it in means registering discovered sources as providers, and teaching the
contracts and the Sources settings page about runtime-defined provider ids.
