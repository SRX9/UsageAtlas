# CodexBar provider audit for UsageAtlas

Researched 27 September 2026 against [upstream commit f795611](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/). The provider overview lists 87 IDs. Inspected fetchers, local readers, plugin parsers, capability declarations and selected fixture tests. This was source research, not authenticated live-account testing; the Swift suite was not run. Ratings are my engineering judgment.

At the time of this research, UsageAtlas registered Codex, Claude, Cursor and OpenCode. The research itself changed no application code. Phase 1 implementation is recorded at the end of this document.

A historical pipeline provides timestamped usage events or explicit daily aggregates. A quota pipeline provides current allowance, use, balance and reset. Polling snapshots cannot reconstruct missing request counts, models, token history or activity while the tracker was closed. Balance changes alone are not spend because top-ups, refunds and expiry also affect them.

My preferred history candidates are Antigravity, Pi/OMP and Muse Code. Mistral is useful for account-level history. OpenRouter is a strong separate billing backend. Copilot, Kimi Code, Kilo, Factory/Droid, Amp, Augment, Codebuff, ClinePass and Warp are useful quota additions.

## Coding tools

| Provider | Data class | Source | Available statistics | Limitation |
| --- | --- | --- | --- | --- |
| [Antigravity](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/antigravity.md) | History + quota | Local conversation SQLite/protobuf; local APIs or agy usage JSON. | Timestamped token classes, models, requests, sessions and estimated costs; live quota. | Internal schema and CLI versions require maintenance. Local history is not authenticated account billing. |
| [Pi / OMP](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/pi.md) | History | Local assistant-session JSONL. | Tokens, model/session activity and API-price estimates. | CodexBar currently supports openai-codex and anthropic backends. No quota; deduplicate mirrored traffic. |
| [Muse Code](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/muse.md) | History + quota | Local session.jsonl; existing CLI device login and quota API. | Input/output/cache/reasoning tokens, daily/model history; reported subscription windows. | Dollar cost unavailable. Some logins omit quota; optional browser-team enrichment. Platform-specific credential discovery. |
| [Mistral / Vibe Code](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/mistral.md) | Account history + quota | Browser session to billing usage and allowance APIs. | Daily tokens, spend, API/Vibe allowances, credits. | Includes API, Le Chat and Vibe activity. Current-month billing is not Vibe-only project history. |
| [GitHub Copilot](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/copilot.md) | Quota | GitHub device OAuth; /copilot_internal/user. | Premium/chat allowance, credits used, plan; reset when returned. | Internal endpoint; token-billed seats can lack a published allowance. No request-token history. |
| [Kimi Code](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/kimi.md) | Quota | Coding API key or supported local CLI login; /coding/v1/usages. | Five-hour/weekly/monthly pools and older request limits. | Region-specific auth. No detailed token ledger in this adapter. |
| [Kilo Code](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/kilo.md) | Credits + quota | API key or kilo/auth.json; tRPC and REST fallback. | Credits, Kilo Pass pools/bonus/reset, organization scopes. | Aggregate counters, not historical requests. |
| [Factory / Droid](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/factory.md) | Quota | Factory API key to billing/limits; browser/WorkOS fallback. | Five-hour/weekly/monthly limits; legacy Standard/Premium token usage. | Billing generations differ. No native Droid token-history scanner. |
| [Amp](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/amp.md) | Credits + quota | amp usage; access-token API; browser fallback. | Free allowance, monthly Agent/Orb pools, personal/workspace balances. | CLI parsing; money and Orb hours are separate units. No event history. |
| [Augment / Auggie](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/augment.md) | Credits + quota | auggie account status; credits/subscription web APIs. | Billing-cycle credit use, limits and plan. | CLI text or web session, not a historical token ledger. |
| [Kiro](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/kiro.md) | Credits + quota | kiro-cli chat --no-interactive /usage; GetUsageLimits enrichment. | Monthly/bonus/overage credits and reset. | Some reports contain only plan metadata. CLI availability, process handling and Windows paths need validation. |
| [Codebuff](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/codebuff.md) | Credits + quota | API key or manicode/credentials.json; usage/subscription API. | Credit usage/balance; weekly limit and tier with CLI session. | API keys get less subscription detail than CLI sessions. No token history. |
| [ClinePass](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/clinepass.md) | Quota | API key or cline auth providers.json; usage-limits API. | Five-hour/weekly/monthly percentages and resets. | Subscription only, not Cline PAYG or generic Cline task history. |
| [Warp](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/warp.md) | Credits + quota | API key; GetRequestLimitInfo GraphQL. | Monthly/add-on credit pools and resets. | Request-named fields mean credits, not raw model-call counts. |
| [JetBrains AI](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/jetbrains.md) | Quota | IDE AIAssistantQuotaManager2.xml. | Current quota and refill date. | IDE-cached state and internal format; validate Windows discovery. Not independent Junie request history. |
| [Windsurf](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/windsurf.md) | Quota | Browser localStorage session; GetPlanStatus protobuf; local state.vscdb fallback. | Daily/weekly limits and resets; legacy message/flow-action counts. | Four-part browser auth; stale local cache; no token-event history. |
| [Devin](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/devin.md) | Quota | Browser localStorage or manual bearer plus organization. | Daily/weekly included quota. | Session/organization handling. No session ACU or token ledger in this adapter. |
| [Qoder](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/qoder.md) | Credits + quota | Browser/manual cookies; big_model_credits API. | Used/total/shared credits and reset. | Global/China session differences; no token-cost history. |
| [Zed](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/zed.md) | Quota + aggregate spend | Editor login to users/me; optional browser billing API. | Edit predictions, plan/cycle; browser token spend and limit. | Keychain-specific editor auth; undocumented browser endpoint. BYOK/external agents bill elsewhere. |
| [IBM Bob](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/ibm-bob.md) | Credits + quota | API key; profile and regional team-budget APIs. | Monthly Bobcoins used/budget and refresh. | Aggregates visible teams; no token history. |
| [v0](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/v0.md) | Billing + quota | Platform API key; user/billing and rate-limits. | Native-unit billing balance, on-demand balance, request quota. | Do not infer dollars or token-cost history. |
| [CodeRabbit](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/coderabbit.md) | Review counts | coderabbit usage; CLI owns login. | Reviews, billing state, organization and period reset. | No quota denominator, token counts or spend. Hosted login only. |
| [GitKraken AI](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/gitkraken.md) | Quota | Account session access token; /v1/ai-tasks/usage. | Personal/shared weekly credits and reset. | Manual token renewal in CodexBar; no history scanner. |
| [Gemini CLI / Code Assist](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/gemini.md) | Restricted-audience quota | Existing CLI OAuth; retrieveUserQuota and loadCodeAssist. | Model quota, reset and plan. | Consumer OAuth discontinued June 18, 2026; Standard/Enterprise remain. API-key/Vertex auth is outside this adapter. |

## Extend existing OpenCode

[OpenCode Go](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/opencodego.md) uses `https://opencode.ai/zen/go/v1/usage` and workspace console endpoints for Go status and prepaid balance. It can add reported five-hour, weekly and monthly windows. Its local SQLite source overlaps with UsageAtlas's existing OpenCode reader, so quota/balance is an extension and must not duplicate the local usage events.

## Coding subscription and gateway backends

These may bill activity already counted under a coding tool. Keep tool attribution and billing attribution separate to avoid double counting.

| Provider | What is usable |
| --- | --- |
| [OpenRouter](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/openrouter.md) | Strong account-history option: key spend/cap and optional balance; Management key provides 30 completed UTC days of tokens, requests, models and spend. No local project attribution. |
| [z.ai / GLM](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/zai.md) | API-key Coding Plan/MCP quota plus optional hourly model analytics. Separate global/China and personal/team scopes. |
| [MiniMax Coding Plan](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/minimax.md) | API key or web quota. Web billing enrichment can add 30-day token/model/method history; do not promise it from a key alone. |
| [Synthetic](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/synthetic.md) | API-key five-hour, weekly-token and search-hourly quotas. No cost history. |
| [Alibaba Coding Plan](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/alibaba-coding-plan.md) | Console-session RPC is the supported baseline; API-key mode can still require console login. |
| [Alibaba Token Plan](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/alibaba-token-plan.md) | Signed-in Bailian CLI or console session for token-plan credits; separate from Coding Plan. |
| [Qwen Cloud](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/qwen-cloud.md) | Cookie-based individual Token Plan windows and credit limits. Not generic Qwen Code local telemetry. |
| [StepFun](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/stepfun.md) | Oasis session/login for five-hour/weekly limits or plan credit pools. |
| [Ollama Cloud](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/ollama.md) | Browser session exposes Cloud quota. API-key validation and local inference do not establish history. |
| [ZenMux](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/zenmux.md) | Management API key for five-hour/seven-day windows and PAYG balance. |
| [Chutes](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/chutes.md) | API-key subscription/PAYG usage and rolling/monthly quota. |
| [Helmcode](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/helmcode.md) | Dashboard session for tenant/model quotas and Cloud prepaid balance. |
| [Nous Portal / Hermes](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/nous.md) | Existing Hermes login for Portal credits. Optional externally produced OpenCodex ledger is session/model aggregates, not native per-request scanning. |
| [DevPass](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/devpass.md) | Gateway key for plan credits, weekly premium usage and key spend. |
| [Sakana AI](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/sakana.md) | Manual cookie and billing-page parsing for quota; higher maintenance than a direct JSON API. |

## Broader infrastructure candidates

CodexBar also collects meaningful account/team usage or spend for OpenAI Admin, Claude Admin, AWS Bedrock, Vertex AI, xAI, Fireworks, DeepInfra, Groq and ai&. These can need admin/management keys, cloud permissions or console sessions. They are not automatically coding-session analytics; Vertex's local cost path can reuse Claude logs rather than represent new traffic.

Self-hosted gateway options include LiteLLM, Bifrost, LLM Proxy, ClawRouter, sub2api and Aixy. Budgets, spend and sometimes requests/tokens are useful when the user's traffic passes through that gateway. See the [complete provider catalog](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/providers.md).

## Defer or keep limited

- [Grok Build](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/grok.md): quota exists, but the documented ACP billing method was unavailable in a tested CLI version. Local signals add context and pre-compaction token counters; they are not a complete input/output/cache request ledger. The [scanner](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/Sources/CodexBarCore/Providers/Grok/GrokLocalSessionScanner.swift) therefore does not meet my bar for full usage analytics.
- [TypeSafe](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/typesafe.md): spend/balance exist, but collection discovers a changing Next.js server-action ID and parses its response. Higher maintenance.
- [Charm Hyper](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/docs/hyper.md): HC balance only; no used total, quota/reset or history. Upstream says live account parity was not verified.
- DeepSeek, Moonshot, Atlas Cloud, Vercel AI Gateway and similar balance-first providers are suitable for balance widgets, not full coding analytics by themselves.
- Azure OpenAI's listed adapter validates deployment/access; Doubao probes request limits; llmman reports loaded-model memory. These are not recorded usage-history sources.
- Cline local task history, Roo Code, Continue, Aider, Trae and Tabnine need separate investigation of their own repositories. ClinePass does not establish full Cline support.
- General-chat, voice and other non-coding products are outside this shortlist.

## Code and test evidence

Historical readers inspected include [Antigravity SQLite](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/Sources/CodexBarCore/Providers/Antigravity/AntigravityLocalSQLite.swift), [Pi scanner](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/Sources/CodexBarCore/PiSessionCostScanner.swift), [Muse local events](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/Sources/CodexBarCore/Providers/Muse/MuseLocalUsageReader.swift), [Mistral fetcher](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/Sources/CodexBarCore/Providers/Mistral/MistralUsageFetcher.swift) and [OpenRouter plugin](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/Sources/CodexBarCore/Resources/Plugins/openrouter.js).

Quota implementations inspected include CopilotUsageFetcher, KiloUsageFetcher, FactoryStatusProbe, AmpCLIProbe, AuggieCLIProbe, KiroStatusProbe, CodebuffUsageFetcher, WarpUsageFetcher, WindsurfWebFetcher, JetBrainsStatusProbe, DevinUsageFetcher, KimiUsageFetcher, IBMBobUsageFetcher, GeminiStatusProbe, and the ClinePass, Qoder, Zed, GitKraken and v0 plugins. All belong to the pinned [provider source tree](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/Sources/CodexBarCore/Providers) or [plugin source tree](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/Sources/CodexBarCore/Resources/Plugins).

Selected inspected tests include [Antigravity independent token/time fixtures](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/Tests/CodexBarTests/AntigravityLocalReaderTests.swift), [schema and partial-history handling](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/Tests/CodexBarTests/AntigravityLocalIntegrityTests.swift), [Pi reliability](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/Tests/CodexBarTests/PiSessionCostReliabilityTests.swift), [Copilot billing edge cases](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/Tests/CodexBarTests/CopilotUsageFetcherTests.swift), [ClinePass authentication and quota fixtures](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/Tests/CodexBarTests/ClinePassPluginTests.swift) and [Codebuff credential-specific behavior](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/Tests/CodexBarTests/CodebuffUsageFetcherTests.swift). Existing tests are evidence of intentional handling, not live verification for our users.

The flag `supportsTokenCost` alone is misleading: Muse has tokens but no dollars; Grok has coarse context counters; MiniMax and z.ai expose optional chart data despite not advertising native cost support. Judge the actual data reader.

CodexBar's browser imports, Keychain readers, process probes and paths often target macOS/Linux. UsageAtlas needs independent Windows/macOS/Linux validation. API-key and plain JSON/SQLite sources are generally easier to port than browser-session imports.

Google confirms the consumer Gemini CLI/Code Assist OAuth shutdown and the continuing Standard/Enterprise service in its [official deprecation notice](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals).


## Phase 1 implementation, 27 September 2026

Selected Antigravity, Pi / OMP, and Muse Code. The desktop adapters now collect local historical usage through the existing event, daily/hourly, model, session, and cloud contract pipeline. Pi also maps projects. Detailed mappings, supported roots, and explicit limits are in [LOCAL_PROVIDERS.md](LOCAL_PROVIDERS.md).

This first phase implements historical usage. Subscription quota APIs, account attribution, and browser or credential access remain separate future work. Antigravity uses verified SQLite layouts; Pi supports the verified Anthropic and OpenAI Codex layouts; Muse costs remain unknown. The original research snapshot above describes CodexBar capabilities, which are broader than the implemented UsageAtlas scope.

### Review fixes

The follow-up review reproduced issues with changing Antigravity response IDs, Muse events copied across folders, broken links during discovery, scan limits repeatedly excluding later records, synchronous Antigravity parsing, and Muse's `cached_input_tokens` schema-drift check. These now have regression tests and fixes. Antigravity parsing runs in a bundled Node worker. Pi and Muse prioritize recent usage and rotate older files and event pages while retaining partial coverage when a scan omits data. Exact bounds and remaining live-validation work are documented in [LOCAL_PROVIDERS.md](LOCAL_PROVIDERS.md).

Validation after the fixes: 399 desktop tests and six tooling tests passed, along with lint, type checking, and build. The Windows package built successfully. An Electron utility process loaded the worker from the packaged ASAR archive and collected the expected 198 tokens from the independent SQLite fixture. Live provider histories still need smoke testing.

## Phase 2 implementation, 28 September 2026

Selected Warp, Kimi Code, Kilo Code, GitHub Copilot, Factory / Droid, Amp, and Qoder. These seven now have quota collectors and Settings connection forms. Detailed authentication, native units, endpoint scope and limitations are in [QUOTA_PROVIDERS.md](QUOTA_PROVIDERS.md).

| Provider | Implemented pipeline | Follow-up scope |
| --- | --- | --- |
| Warp | API key → GraphQL credit pools → capacity and native credit counters | Live account comparison, including workspace and unlimited plans. |
| Kimi Code | Region-bound Coding API key → current ratio pools or supported legacy request counters | Local CLI OAuth and live checks in both regions. |
| Kilo Code | Saved/environment key or local CLI auth → tRPC credit blocks and Pass → USD capacity | REST fallback, organization discovery and simultaneous scopes. One selected scope is supported now. |
| GitHub Copilot | Supplied OAuth token → internal user endpoint → explicit quotas or seat-credit counter | Device OAuth and Enterprise custom hosts. No guessed allowance for token-billed seats. |
| Factory / Droid | API key → billing limits, or explicit legacy billing flow → independent Standard/Core pools | Browser/WorkOS login. Ambiguous legacy ratios and unlimited sentinel allowances stay unknown. |
| Amp | Access token → internal display-balance API → Free, Agent, Orb and independent balances | Local CLI and browser fallback. Rounded legacy renewal durations are not exact resets. |
| Qoder | Region-bound manual cookie → credit usage API → personal and shared pools | Browser cookie import and live parity in both regions. |

All seven use capacity snapshots and the existing cloud capacity pipeline. `quotaMetrics` preserves native units and unknown values. They do not produce daily token rows, usage events, project history, or estimated spend. Credentials are encrypted locally and excluded from history, logs and cloud payloads.

Review covered body limits, cancellation, authentication failures, credit conversion, separate shared pools, missing denominators, credential changes, outages, storage and restore. A failed credential replacement cannot restore the previous account's limits. A successful balance-only or unlimited response clears obsolete meters. The existing seven providers remain in the regression suite.

Implementation and fixtures were checked against the same pinned CodexBar commit as the original audit. Live authenticated comparisons remain pending. The updated cloud contract must ship before releasing desktop sync for the new providers.

Validation: 449 desktop tests, six tooling tests, and 128 cloud tests passed. Desktop lint, type checking and production build passed, as did cloud type checking. The Windows x64 package built and its isolated renderer/preload/engine smoke test exited successfully. Browser checks exercised masked credential entry, saving, clearing and removal, regional options, real provider marks, quota meters and native-unit counters using synthetic data.

### Review fixes, 29 September 2026

Fixed all seven reproduced findings from the uncommitted-change review:

- Capacity restoration now filters by the selected credential fingerprint after cache invalidation, cloud account changes and restart. Same-account saved quota remains available during an outage.
- Saved credential read or decryption failures block automatic account fallback and show a connection error. Other providers continue collecting, and removing or replacing the damaged connection permits recovery.
- Copilot preserves overage from negative remaining counts and percentages.
- Copilot uses chat seat credits when premium credits are absent or invalid, without adding duplicate shared pools or replacing an explicit zero.
- Factory's legacy organization usage request accepts authentication responses without a user profile. A returned user ID remains attached to the request.
- Antigravity rotates archive files beyond the first 500 and alternates recent/archive priority within the existing worker limits. Cursor advancement follows attempted files.
- Public profile tool charts and model rankings include Antigravity, Pi / OMP and Muse Code names and logos. Chart legends follow actual usage, with a fallback for unknown tool names.

Regression checks cover each failure, including SQLite restore, locked keyrings, malformed saved credentials, scan byte exhaustion, and server-rendered profile charts. Live authenticated comparisons remain pending.

Validation after these fixes: 461 desktop tests, six tooling tests and 132 cloud tests passed. Desktop and web lint, desktop and cloud type checks, and desktop and web production builds passed. The web build also generated the public profile hydration bundle. Cloud tests passed with two workers after two database tests exceeded their five-second timeout while competing with concurrent builds.

### Release readiness, 30 September 2026

The Windows x64 candidate passed local release checks. Tests and packaging ran on 29 September; artifact verification finished on 30 September. The checked desktop source and contracts did not change between those steps. The local package retains version `0.2.13`; no release was published.

The release dependency audit initially failed on two high-severity `fast-uri` advisories. Updated the desktop override and lockfile from `3.1.6` to `3.1.7`, the patched version listed for [authority injection](https://github.com/advisories/GHSA-qw65-cvwx-89v3) and [host confusion](https://github.com/advisories/GHSA-58mr-gqgx-xq4g). No other dependency versions changed. The audit then passed with the release workflow's existing exclusions unchanged.

| Check | Result |
| --- | --- |
| Fresh `bun run check` after the dependency update, with Turbo caching bypassed | 461 desktop tests, six tooling tests, lint, both workspace type checks and production renderer build passed. |
| Cloud sync regression suite and type check | 132 tests passed with two workers; TypeScript passed. All six copied usage/statistics contract files match the desktop copies byte for byte. |
| Windows x64 `desktop:make` | Installer, full Squirrel update package, `RELEASES` manifest and ZIP built successfully. |
| Packaged application smoke test | Exit 0. Renderer, preload IPC and utility engine initialized with temporary app data, providers disabled, telemetry disabled and updates disabled. |
| Packaged Antigravity worker | Exit 0. The Electron utility process loaded the worker from ASAR and collected the expected 198 tokens from the synthetic SQLite fixture. |
| Distribution integrity | Required main, preload, engine, worker and renderer entries present. Squirrel manifest size and SHA-1 verified. ZIP and update package contain the exact ASAR tested above. SHA-256 recorded for all four current-version artifacts. |
| Working tree whitespace | `git diff --check` passed. |

The tool sandbox blocked network downloads and Electron's Windows encryption/GPU services on the first attempts. Authorized runs outside that restriction completed successfully. The Windows installer is unsigned, as permitted by the existing release workflow. Generated icon changes from the packaging prerequisite were reverted after building; provider work was preserved.

Local evidence is under `tmp/release-readiness-*`. The current installer is `apps/desktop/out/make/squirrel.windows/x64/UsageAtlas-0.2.13 Setup.exe`; the ZIP is `apps/desktop/out/make/zip/win32/x64/UsageAtlas-win32-x64-0.2.13.zip`. An older `0.2.11` ZIP in that output directory is excluded from this run's checksum manifest.

Before publishing, deploy the updated cloud contracts. Their production deployment has not been verified. macOS and Linux builds, signing/notarization and native smoke tests still need the release CI runners. Live authenticated comparisons for the new providers and an installed-app upgrade from the previous published version remain unverified. The packaged startup test does not establish those results.
