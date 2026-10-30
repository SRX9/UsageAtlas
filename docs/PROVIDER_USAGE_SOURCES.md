# Where AI tools record token usage

This is the survey behind the provider readers: every tool exposes usage somewhere different, and a
reader is only added when the source is documented and the numbers can be verified. Nothing here
uploads prompts, file paths or tool output — parsers keep token counts, model ids and timestamps.

## Implemented in this fork

| Source | How it knows usage | What the reader reads |
| --- | --- | --- |
| **Gemini CLI** | Per-message `tokens` object written to the session transcript | `~/.gemini/tmp/<project>/chats/session-*.jsonl` (`%USERPROFILE%\.gemini\tmp\...` on Windows). Each `type: "gemini"` record carries `tokens.{input, output, cached, thoughts, tool, total}`. `total` is authoritative; cached prompt tokens are split out so they are not counted twice. |
| **Qwen Code** | Gemini-style `usageMetadata` on assistant chat records | `~/.qwen/projects/<project>/chats/*.jsonl` (or `$QWEN_HOME`). `usageMetadata.{promptTokenCount, candidatesTokenCount, cachedContentTokenCount, totalTokenCount}`; a mismatched total rejects the row instead of guessing. |
| **Cline** | `api_req_started` UI messages in each task transcript | `<editor>/User/globalStorage/saoudrizwan.claude-dev/tasks/<id>/ui_messages.json`. `text` is a JSON string with `tokensIn`, `tokensOut`, `cacheWrites`, `cacheReads`, `cost`; `ts` is epoch ms, `modelInfo.modelId` is the model. |
| **Roo Code** | Same transcript lineage as Cline | `<editor>/User/globalStorage/rooveterinaryinc.roo-cline/tasks/<id>/ui_messages.json`. Roo's history summary differs, so the reader only accepts fields it can verify. |
| Codex | Local session events plus the account's rate-limit endpoint | `~/.codex/sessions/**/*.jsonl` token-count events and OAuth quota. |
| Claude Code | Local project transcripts plus the OAuth usage endpoint | `~/.claude/projects/**/*.jsonl` and `api.anthropic.com/api/oauth/usage`. |
| Cursor | Local editor state database plus the dashboard API | `state.vscdb` under the Cursor data directory. |
| OpenCode | Its own local database | OpenCode's SQLite store. |
| Antigravity, Pi/OMP, Muse | Local session files | JSON/JSONL transcripts under each tool's data directory. |
| Freebuff | Desktop database and CLI transcripts | `desktop-v2.db` (`messages.metrics_json`), located by the path planner; CLI chat files as a fallback. |
| Warp, Copilot, Factory, Amp, Qoder, Kimi, Kilo, z.ai | Provider API quota | Account endpoints (five-hour/weekly windows, credits or plan usage). |

The VS Code family reader looks in `Code`, `Code - Insiders`, `VSCodium`, `Cursor` and `Windsurf`
under `%APPDATA%`, `~/Library/Application Support` or `~/.config`. `CLINE_GLOBAL_STORAGE`,
`ROO_GLOBAL_STORAGE`, `GEMINI_DIR` and `QWEN_HOME` override the roots.

## Researched, not implemented yet

| Source | What exists | Why it is not wired up |
| --- | --- | --- |
| **Continue** | `~/.continue/sessions/<id>.json` with `usage.promptTokens` / `usage.completionTokens`, sometimes per assistant message | The session file also carries a *cumulative* session `usage`, so a naive reader double-counts. Model ids are not guaranteed: `chatModelTitle` is a display label. Needs a parser that takes per-message usage only and skips unnamed models. |
| **Kilo Code (extension)** | Pre-migration `tasks/<id>/` folders, then a SQLite store at `~/.local/share/kilo/kilo.db` | The current store is SQLite with OpenCode-derived tables; it needs a schema probe like Freebuff's rather than a JSON reader. Kilo quota is already tracked through its API. |
| **Aider** | `.aider.chat.history.md` and optional analytics logs | There is no token ledger by default; the Markdown history has no structured usage. |
| **Windsurf / Trae / Kiro** | Editor-private storage | No documented usage schema; numbers would have to be guessed. |
| **Zed** | `threads.db` SQLite | Token columns exist but are version-specific; needs a verified schema probe. |
| **LM Studio / Ollama / vLLM** | Server logs | Logs show requests, not per-request token accounting in a stable format. |

## Publishing to the cloud

The hosted service only models the official providers. A source it does not model — Freebuff, z.ai,
Gemini CLI, Qwen, Cline, Roo and anything added later — stays local under its own real name unless
the user explicitly adds a rule on the Attribution page. A rule reports that source as one or more
official providers with a share each; the choice is shown in the app, applies only to the uploaded
copy, and is deterministic per request so retries keep the same label.

## Sources

- Gemini CLI session storage and the token object: <https://seanthegeek.net/doubleagent/research/gemini-cli.html>, <https://geminicli.com/docs/cli/session-management/>
- Qwen Code chat records and `usageMetadata`: <https://seanthegeek.net/doubleagent/research/qwen-code.html>
- Cline task files and message fields: <https://seanthegeek.net/doubleagent/research/cline.html>, <https://github.com/cline/cline/blob/main/apps/vscode/src/shared/ExtensionMessage.ts>
- Roo Code history schema: <https://seanthegeek.net/doubleagent/research/roo-code.html>
- Kilo Code session store: <https://kilo.ai/docs/code-with-ai/agents/session-history>
- Continue paths and types: <https://github.com/continuedev/continue/blob/main/core/util/paths.ts>, <https://github.com/continuedev/continue/blob/main/core/index.d.ts>
