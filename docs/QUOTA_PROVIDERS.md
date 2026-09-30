# Quota providers

Added September 28, 2026. Warp, Kimi Code, Kilo Code, GitHub Copilot, Factory / Droid, Amp, and Qoder report current allowances or balances. They appear in Settings, capacity meters, the tray, and usage alerts when an allowance is known. The Limits page also shows their native counters.

These integrations do not collect per-request token, project, model, session, or dollar-spend history. A remaining dollar balance is not money spent. No zero-token history rows are created to fill that gap.

## Connect a provider

Open **Settings → Sources**, expand **Connect** under the tool, enter its credential, then choose **Save and check**. Saving enables the source and refreshes it. The connection status above the form reports success or an error. Removing a saved credential turns the source off.

Saved credentials use Electron `safeStorage` and the operating system's encryption service. They are kept separately from preferences and history, excluded from cloud saves, and never returned to the renderer after saving. On Linux, an unavailable keyring or the `basic_text` backend prevents saving.

Environment credentials are read from the process that started UsageAtlas. Restart the app after changing them. A saved credential takes precedence over the environment, which takes precedence over supported local credential files. An invalid selected credential does not silently switch to a different account.

| Tool | Credential or local discovery | Data collected |
| --- | --- | --- |
| Warp | API key from Warp Settings → Platform → API Keys. `WARP_API_KEY`, with `WARP_TOKEN` as an alias. | Monthly credits used and limit, reported reset, personal add-on credits, and separate workspace add-on pools. Unlimited plans retain the used counter without inventing a limit. |
| Kimi Code | Coding API key. `KIMI_CODE_API_KEY`, with `KIMI_REGION=china` or `global`. Select the matching region in Settings. China is the default. | Five-hour, seven-day, and monthly percentage pools; older request-based windows where reported. Matching legacy counters can replace known zero placeholders. |
| Kilo Code | API key or `KILO_API_KEY`; otherwise `kilo.access` in `$XDG_DATA_HOME/kilo/auth.json` or `~/.local/share/kilo/auth.json`. `kilo auth login` creates the local session. | Active credit blocks and balance in USD, plus Kilo Pass use, base and bonus allowance, and renewal when returned. Choose one personal or organization scope using the optional ID or `KILO_ORGANIZATION_ID`. |
| GitHub Copilot | A Copilot-authorized GitHub OAuth token or `COPILOT_GITHUB_TOKEN`. | Reported premium interactions, chat and completion allowances, plan, seat credits used, and reset. Generic fine-grained PATs may not have access to the internal endpoint. |
| Factory / Droid | Factory API key or `FACTORY_API_KEY`; otherwise `FACTORY_API_KEY` in `~/.factory/.env`. | Independent Standard and Core five-hour, weekly and monthly windows, extra balance in USD, or supported legacy Standard/Premium billing counters. |
| Amp | Access token created in Amp settings, or `AMP_API_KEY`. | Free allowance, Agent dollars, Orb hours, individual balance and separate workspace balances. Legacy percentage subscription output is also supported. |
| Qoder | The Cookie header value from the account usage request, or `QODER_COOKIE`. `QODER_REGION=global` or `china`; global is the default. | Personal and shared credits used, allowance, remaining balance and reported reset. Credentials go only to the selected `qoder.com` or `qoder.com.cn` site. |

Settings accepts only a key, token, or Cookie header value. It does not accept a cURL command or request URL. Copilot device OAuth, browser cookie import, Amp CLI execution, Kimi CLI OAuth, Factory browser/WorkOS login, and Kilo organization discovery are not implemented in this phase.

## Measurement rules

- Warp's request-named API fields contain credits. They are never counted as model requests. Expiring bonus grants are excluded; expiry is not treated as a reset.
- Kimi ratios become percentages. Request counts are retained only for response fields that actually report counts. Global and China credentials are never retried against the other region.
- Kilo `amount_mUsd`, `balance_mUsd`, and `totalBalance_mUsd` are divided by one million to produce USD. Expired and future credit blocks are excluded. A balance without its original allowance remains balance-only. Kilo Pass and credit blocks stay separate because they can overlap.
- Copilot uses a denominator only when the API supplies one. Zero placeholder quotas and unlimited pools do not generate invented meters. Negative remaining counts or percentages preserve overage in the used counter, with remaining clamped to zero. `credits_used` comes from premium interactions, falling back to chat when absent or invalid, and is recorded once.
- Factory cents become USD. User tokens are not divided by an organization allowance. Legacy out-of-range `usedRatio` values have an ambiguous scale, so explicit counters take precedence in that case. Allowances above one trillion are treated as upstream unlimited sentinels and withheld. No reference-token percentage is invented.
- Amp calculates Tier usage from dollar and hour balances, not rounded percentages. Orb hours stay separate from dollars. Date-only Tier periods use UTC day boundaries and are approximate within a day. Daily Free resets follow 8 PM New York time. Rounded legacy renewal durations and hourly replenishment estimates are not used for reset alerts.
- Qoder shared credits are a separate pool and are not added to the personal total.

Meters clamp to 0–100%. Native counters retain reported overage where available. Unknown values remain `null`, not zero. Missing or unrecognized pools are omitted; an entirely unrecognized response becomes a provider error.

## Storage and failure handling

`quotaMetrics` stores each pool's ID, label, unit, used, limit, remaining, and optional reset. It travels with both local capacity snapshots and the cloud capacity contract. No schema migration or usage-event backfill is needed. The updated cloud service must be deployed before a released desktop app can sync the new provider IDs and fields.

Account scope uses an opaque hash of the provider, credential, region and organization. Credential rotation creates a new source even for the same account. No secret, workspace name, or raw API response is persisted. This supports current capacity; it is not a historical spend ledger.

Requests have a 15-second timeout, follow no redirects, and limit JSON bodies to 1 MiB. Authentication errors request reconnection. HTTP 429 and server/network failures remain retryable. Errors omit response bodies and credentials. A provider failure leaves other providers collecting normally. Saved stale capacity carries an error and is excluded from active quota details and alerts.

Changing saved credentials clears the prior account's cached values before checking the replacement. History restoration and refresh failure fallback both filter saved capacity by the selected credential fingerprint, including after cloud sign-in or cache invalidation. An unreadable saved credential blocks environment and local-file fallback and shows a connection error. Replacing or removing it allows collection to resume. Successful unlimited or balance-only responses clear previous meters. Local credential files are bounded to 64 KiB.

## Verification and limits

Implementation was checked against [CodexBar's provider source at commit f795611](https://github.com/steipete/CodexBar/tree/f79561136caa36057d1a743bcb62c5fd43d51089/Sources/CodexBarCore/Providers) and its [Qoder plugin](https://github.com/steipete/CodexBar/blob/f79561136caa36057d1a743bcb62c5fd43d51089/Sources/CodexBarCore/Resources/Plugins/qoder.js).

Automated checks cover provider response formats, units, missing fields, reset rules, credential scope, transport failures, encrypted-store behavior, SQLite persistence, cloud validation and restore, and absence of fabricated usage history. Existing provider tests remain part of the full suite.

Live authenticated parity has not been verified for these seven accounts. Several endpoints are internal and can change. A changed response format must produce an error or omit an unknown field instead of guessing a usable allowance. The provider audit records future follow-up work.
