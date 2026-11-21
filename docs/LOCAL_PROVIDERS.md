# Antigravity, Pi / OMP, and Muse Code

This phase adds local usage history for three coding tools. They appear in the tool settings and are detected when readable session files exist. Run the tool locally, then reload UsageAtlas. These readers need no provider credentials. Subscription limits, balances, and reset times are not collected in this phase.

The implementation was checked against [CodexBar f795611](https://github.com/steipete/CodexBar/tree/f79561136caa36057d1a743bcb62c5fd43d51089). Keep [the provider audit](provider-audit.md) as the research backlog for subsequent phases.

## Unified statistics

All three adapters emit the existing `CollectedUsageEvent` format. The existing pipeline produces daily and hourly activity, model and session breakdowns, and durable usage-event facts. Pi also supplies project paths. There is no separate database for these providers.

| Stored field | Antigravity | Pi / OMP | Muse Code |
| --- | --- | --- | --- |
| `providerId` | `antigravity` | `pi`, including OMP | `muse` |
| `inputTokens` | System prompt + new input | Recorded fresh input | Input minus cache read and cache write |
| `cachedInputTokens` | Recorded cache read | Recorded cache read | Recorded cache-read subset |
| `cacheCreationInputTokens` | 0, source has no separate counter | Recorded cache write | Recorded cache-write subset, when present |
| `outputTokens` | Text + thinking output | Recorded output | Recorded output, already includes reasoning |
| `totalTokens` | Sum of the four disjoint categories | Same; mismatching source totals are rejected | Input + output |
| `requests` | One validated generation | One validated assistant entry | One inference or automated-review completion |
| Event time | Embedded protobuf timestamp or uniquely linked step timestamp | Assistant timestamp, then entry timestamp | `recorded_at` microseconds |
| Model | Recorded ID, or an unambiguous label mapping within the same session | Recorded ID and normalized pricing ID; backend retained | String ID or review `model.model_id` |
| Session | Database filename stem | Session header ID | Session directory ID |
| Project | Unknown | Session header `cwd` | Unknown |
| Cost | API-price estimate when a rate is known | API-price estimate when a rate is known | Unknown |

Cache and reasoning counters remain in `rawTokens`. Unknown models retain tokens and increment `unpricedTokens`; missing costs stay null. API-price estimates use UsageAtlas's existing pricing catalog and bundled rates, not the tool's subscription charge. Pi's `usage.cost` is itself an estimate and is not treated as billed money. Model routing suffixes in Antigravity may resolve to a base model for pricing while retaining the recorded ID.

Each source uses the `local` account key. A local transcript does not establish which provider account paid for it. The existing persistence layer hashes source event/session IDs and project paths before cloud storage. Prompts, responses, tool output, and raw log contents are never included in collected records. Pi events stay under Pi; the Codex and Claude readers do not scan Pi roots.

Cloud validators are generated alongside the desktop contract. Deploy the updated cloud service before releasing a desktop version with these provider IDs; an older server rejects them. This change does not deploy or publish a release.

## Session locations

Paths are resolved using the current user's home directory on Windows, macOS, and Linux. Overrides must be absolute or start with `~/`. UsageAtlas must inherit the environment variables when it starts.

### Windows Subsystem for Linux

On Windows, UsageAtlas also reads the coding-agent sessions that live inside
installed WSL distributions, so agents run with `codex`, `claude`, `opencode`,
or `pi` inside WSL count alongside their Windows runs. Distribution homes are
discovered from the `\\wsl$\` share (`\\wsl.localhost` as fallback) and merged
with the Windows home; a session copied into both homes counts once. The
Claude sign-in falls back to WSL homes the same way. Discovery is bounded
(16 distributions, 16 users each, 32 homes) and cached for the process
lifetime, so restart the app after installing or removing a distribution.
An explicitly pinned session directory (`PI_CODING_AGENT_SESSION_DIR`,
`MUSE_SESSIONS_DIR`, `CLAUDE_CONFIG_DIR`) keeps its exact single-location
behavior and never fans out.

- `USAGEATLAS_WSL_HOMES` pins the extra homes explicitly, separated like
  `PATH` (`;` on Windows, e.g. `\\wsl$\Ubuntu\home\alice`). Useful for custom
  setups and for testing on other platforms.
- `USAGEATLAS_DISABLE_WSL=1` (also `true`/`yes`) scans only the Windows home
  and wins over the pinned list.

This PR leaves Cursor and live quota APIs untouched: Cursor's state database
and the `codex app-server` quota check already resolve on the Windows side,
so no WSL handling was added for them.

### Antigravity

- `~/.gemini/antigravity-cli/conversations/*.db`
- `~/.gemini/antigravity/*.db`
- `~/.gemini/antigravity/conversations/*.db`
- `GEMINI_CLI_HOME` replaces `~/.gemini`.

Only immediate `.db` files are scanned. An ordinary `gen_metadata` table with stored `idx` and `data` columns is required. Unrelated databases such as `conversation_summaries.db` are skipped. Database access uses Node's read-only SQLite connection and a consistent read transaction. Normal SQLite WAL coordination may create or update sidecars; no source records are written.

Generation identity uses the session filename and row index, so a later response ID does not create another stored event. Matching response IDs still deduplicate repeated generation rows, choosing the lowest row index. Conflicting copies remain incomplete. SQLite access and protobuf decoding run in a separate Node worker; cancellation terminates that worker before the scan returns.

The parser reads `chatModel.#9.#4` seconds/nanos timestamps. A missing timestamp can be recovered through `steps.metadata` by a unique bot ID and matching step UUID, or one generation and one step with that UUID. Reused UUIDs without a unique bot match stay incomplete. File modification time, session start time, opaque timestamp layouts, and positional guesses are not substituted for event time.

This phase does not read IDE-only language-server history, Tokscale's derived JSONL cache, or live quota APIs. A sidecar-less WAL file that the platform cannot open read-only remains unavailable. Model pricing is separate from the local database scan.

The development machine had IDE `.pb` conversations but no recognized CLI databases. That establishes a source-format limitation, not a successful live Antigravity import. Pi / OMP and Muse session directories were absent. Validation for this phase therefore uses source-linked fixtures rather than real account histories.

### Pi / OMP

- Pi: `~/.pi/agent/sessions/**/*.jsonl`.
- OMP: `~/.omp/agent/sessions`, `~/.local/share/omp/sessions`, and the corresponding `profiles/<name>/sessions` or `profiles/<name>/agent/sessions` stores.
- `PI_CODING_AGENT_SESSION_DIR` selects one session root for this provider.
- `PI_CODING_AGENT_DIR` replaces the agent directory.
- `PI_CONFIG_DIR` selects OMP's configuration directory relative to the home directory. Parent traversal is rejected.
- `XDG_DATA_HOME` replaces `~/.local/share`.
- `OMP_PROFILE`, or `PI_PROFILE` when absent, selects an OMP profile. Without a selector, stored named profiles are discovered. Pi's independent default store remains included.

This phase supports the verified `anthropic` and `openai-codex` backend layouts. Other assistant backends make coverage incomplete. Unsupported entries do not appear as measured zero. Matching session and entry IDs deduplicate overlapping roots and copied logs; entries lacking IDs receive a device-scoped file/line identity.

Runtime process discovery, project settings, and process-specific `--session-dir` arguments are not inspected. For a custom session directory, start UsageAtlas with `PI_CODING_AGENT_SESSION_DIR` set to that directory.

### Muse Code

- `$MUSE_SESSIONS_DIR`, or `$XDG_DATA_HOME/muse/sessions`.
- Default: `~/.local/share/muse/sessions/YYYY/MM/DD/<session>/session.jsonl`.

Only schema-v1 `runtime.session` events of kind `model_completed` or `automated_review_completed` count. CPU telemetry, child rollups, and goal attribution are ignored. Events are dated by their own timestamp, not their parent directory date. No pricing download is made for Muse.

The same durable event copied into different session folders counts once. Its containing directory does not make otherwise identical usage contradictory. Session attribution uses the lexically first directory ID among copies found in the same scan. Unknown event kinds carrying any recognized token counter, including `cached_input_tokens`, make coverage incomplete.

## Incomplete history and limits

Malformed JSON or protobuf, unsupported schemas, inconsistent counts, missing timestamps, unreadable sources, and exhausted scan budgets produce partial or unavailable results. An absent source does not establish measured zero. Contradictory copies are withheld and coverage becomes partial. No totals are inferred from quota percentages.

JSONL discovery visits at most 50,000 directory entries. Individual entry failures leave readable siblings eligible for collection. A refresh selects at most 5,000 files, prioritizing the most recently modified session and rotating through the other discovered files. It reads at most 512 MiB of uncached data, 256 MiB per file, and 4 MiB per line, and returns at most 100,000 events. Files exceeding the event allowance contribute their latest events and a rotating page of older events. Parsing starts at the header each time to honor edits and model changes.

File and event cursors last for the scanner's lifetime. Repeated refreshes collect later batches into the existing durable, deduplicated event store; restarting the app restarts the traversal. Scans that omit records remain partial, and the existing daily summaries are lower bounds rather than a sum of overlapping pages. Trees beyond the discovery bound or files beyond the byte bounds remain partial or unavailable. Completed files are cached by identity, size, modification time, change time, and pricing revision. Unfinished trailing lines and files changed during a read stay incomplete. The cache contains only numeric events and is bounded to 100,000 events and 500 files.

Antigravity discovery is bounded to 50,000 directory entries, with up to 500 databases selected per refresh. The scanner includes the most recently modified database and rotates the archive batch. Recent and archive files alternate first priority so either can use the full worker budget without starving the other. The archive cursor advances over files the worker actually attempted, including unreadable files. Each read has a 16 MiB payload bound, 10,000 rows per table, a shared 50,000-row and 128 MiB payload budget, and a ten-second deadline checked between rows. The parent terminates a worker that exceeds fifteen seconds, including startup. Omitted files keep the scan partial. Existing history retention protects saved completed days during incomplete refreshes.

Automated tests use temporary JSONL files and real SQLite databases, including independently specified protobuf bytes. They cover token reconciliation, copied sessions, malformed data, timezone bucketing, read-only access, unpriced usage, and repeated persistence through the shared contract. Live installations on all three operating systems still need release smoke testing.
