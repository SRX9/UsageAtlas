# Freebuff token usage

Freebuff is two surfaces sharing one runtime:

- **Freebuff Desktop** writes provider-reported token counts to a per-project SQLite database.
- **The Freebuff CLI** writes chat transcripts that record charged `credits`, not tokens.

UsageAtlas reads the Desktop database first. Only when no Desktop database exists does it fall back to the CLI's per-message credits.

## Exact location (Desktop)

```
~/.config/freebuff-desktop/
  state.json                         # login/session state
  projects/
    <slug>-<projectId>/
      project.json                   # version, projectId, projectPath, database
      desktop-v2.db                  # SQLite: projects, threads, messages
```

`$FREEBUFF_CONFIG_DIR` replaces `~/.config/freebuff-desktop` when set. The reader rejects a relative path instead of scanning the working directory.

The path is per-user, not per-OS: on Windows it is `%USERPROFILE%\.config\freebuff-desktop`, and on macOS it is `~/.config/freebuff-desktop` (not `~/Library/Application Support`).

## Exact location (tokens)

Tokens live in **`desktop-v2.db`**, table **`messages`**, column **`metrics_json`**:

```sql
SELECT ts, metrics_json
FROM messages
WHERE ts >= <three days ago, epoch ms>;
```

`metrics_json` is a JSON object. Token usage is under `usage`:

```json
{
  "usage": {
    "inputTokens": 12480,
    "cachedInputTokens": 9000,
    "outputTokens": 830,
    "reasoningOutputTokens": 120,
    "totalTokens": 13310
  },
  "context": { "usedTokens": 18200, "windowTokens": 200000 },
  "compactions": []
}
```

- `usage` is the **delta for that assistant turn**, not a running total. Summing the rows gives the thread's cumulative usage.
- `cachedInputTokens` is already inside `inputTokens`; do not add it.
- `reasoningOutputTokens` is already inside `outputTokens`; do not add it.
- `totalTokens` is normally `inputTokens + outputTokens`. When it is absent or zero, UsageAtlas computes that sum.
- `context.usedTokens` is current context occupancy, not cumulative usage. It is not counted.
- `messages.ts` is epoch milliseconds. UsageAtlas buckets rows by the account's reporting time zone and only sums today's rows.

### The model is stored as an opaque id

`threads.model` does not hold a model name. Freebuff writes `m-<digest>` — a real row reads
`m-096e75164d` — where the digest is two FNV-1-style passes over `freebuff-legacy-model:key:<routing id>`,
truncated to ten hex characters. Freebuff keeps the same table to reverse its own older rows, so
the mapping is rebuilt offline in `apps/desktop/src/engine/providers/freebuff-models.ts` for the 67
ids Freebuff Desktop 0.0.192 ships (`m-096e75164d` is `deepseek/deepseek-v4-flash`).

A row is stored under the routing id's model part (`deepseek-v4-flash`) with the vendor as its
provider, and the opaque id is kept as `reportedModel`. An id this build does not know, or a plain
name from an older build, is kept as text: the turn is still counted, it just stays unpriced.

### Pricing

Freebuff is a subscription and reports `costUsd: 0` on every turn, so that number cannot price the
dashboard. A turn is priced here instead, at the resolved model's API rates from the same pricing
catalog the rest of the app uses, and Freebuff's own `costUsd` is kept as the reported cost. A model
whose vendor prefix differs from the catalog's provider key is matched through the alias table in
`models-dev.ts` (`z-ai` → `zhipuai`, `mistralai` → `mistral`, `x-ai` → `xai`, `qwen` → `alibaba`);
a model only resellers publish is left unpriced rather than guessed at.

Measured on a real Freebuff installation: 394,860,398 tokens across five days resolved to
`deepseek-v4-flash` and priced at $3.14 (41 of 41 turns priced, 0 unpriced tokens), where the same
data previously read as $0.00.

UsageAtlas reports three counters in Limits → Reported allowances and balances:

- **Tokens used today** (`usage.totalTokens`)
- **Input tokens today** (`usage.inputTokens`)
- **Output tokens today** (`usage.outputTokens`)

## CLI fallback (credits, not tokens)

The CLI keeps one JSON transcript per chat:

```
~/.config/manicode/projects/<project>/chats/<chatId>/
  chat-messages.json                 # per-message credits
  run-state.json                     # model/context/credits state
  log.jsonl
```

`chat-messages.json` records `credits` on completed assistant messages. It has **no token fields**, and `credits` is `0` in Free Mode. `run-state.json` has `sessionState.mainAgentState.contextTokenCount` (context occupancy, not cumulative tokens) and `creditsUsed`. Therefore the CLI fallback can only show "Credits used today"; it cannot produce token totals.

The reader also looks in `~/.config/manicode-dev`, `~/.config/Freebuff`, `~/.config/Freebuff Desktop`, `~/.local/share/freebuff`, `~/.local/share/freebuff-desktop`, the `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` equivalents, and the macOS Application Support folders.

## What is not stored locally

The **Freebucks** daily allowance, wallet balance, and reset time are server-side. They come from Freebuff's authenticated session endpoint (`/api/v1/freebuff/session`), not from any app-data file. `state.json` holds the login state needed for that request, but no balance. UsageAtlas does not read `state.json` and does not display a Freebucks balance.

## Dynamic path resolution and cache

The folder moves whenever Freebuff renames a project or a release changes its layout, so UsageAtlas plans a route to the data instead of hard-coding one:

1. **Plan** - the known roots are scanned (bounded: depth 4, 4,000 entries, symbolic links skipped) for `desktop-v2.db` / `desktop.db` that pass a schema probe (`messages.role`, `messages.ts`, `messages.metrics_json`), plus `chat-messages.json` files written in the last three days. Candidates are ranked by modification time, newest first, and capped at 64 databases and 200 transcripts.
2. **Save** - the winning route is written to `freebuff-sources.json` next to the engine's `history.sqlite` in the app's user-data folder, so the next refresh verifies a few paths instead of walking the disk.
3. **Reuse** - a saved route is used as-is while every file it names still exists, is not empty, still passes the schema probe, and the route is younger than 30 minutes.
4. **Re-plan** - a saved route is thrown away and planned again as soon as one of its files is missing, empty, or no longer passes the schema probe. If a verified route then fails to open, the adapter forces one immediate re-plan. When a re-plan finds nothing, a route that still verifies is kept and renewed rather than dropped, so a temporarily locked database never erases a working route.

The schema probe is remembered per file identity (path, size, mtime), because opening six databases
to re-read their columns costs about 20 ms and the route is re-verified on every refresh. A file that
keeps its size and mtime cannot have changed its schema; a replaced or migrated database is probed
again. Measured on a real installation, the cached route check went from 22 ms to 3.6 ms and a warm
scan from ~90 ms to ~70 ms.

`USAGEATLAS_FREEBUFF_CACHE` overrides the cache file (absolute paths only), and `cacheFile: null` disables persistence - the planner still works, it just plans on every refresh. A read-only data folder only costs re-planning, never correctness.

`FREEBUFF_CONFIG_DIR` may point at a config root, at a `projects` folder, at a single project folder, or directly at a `desktop-v2.db` or `chat-messages.json` file.

## Read safety and bounds

- The database is opened read-only (`DatabaseSync(..., { readOnly: true })`), so a running Desktop app is not disturbed.
- Discovery never leaves the known roots, skips symbolic links, and never reads a file larger than 8 MiB per transcript (32 MiB per refresh).
- At most 64 project databases and 100,000 metric rows per database are scanned; rows older than three days are excluded in SQL.
- A locked, malformed, or unreadable database is skipped; other projects still count.
- No Freebuff file is written, repaired, or locked.

## Verification

Automated tests cover the opaque model id table (every id it ships is recomputed and checked),
model resolution, pricing against a fixture catalog, token summing from `metrics_json`, day and time-zone bucketing, ignoring cached/reasoning duplicates, malformed or zero rows, the CLI credit fallback, source availability, the absolute config override, and the relative-path rejection. They also cover the path planner: discovery outside the canonical layout, reuse of a saved route, re-planning when a saved file disappears or its schema drifts, recovery from a corrupt or outdated cache file, picking up a project that appeared after the route expired, keeping a working route when a re-plan comes back empty, a config path that points straight at a file, and the rejection of a relative config override. Validation against a real recorded Freebuff Desktop database remains pending: the fixtures reproduce the schema found in Freebuff Desktop 0.0.192, not a user's account history.
