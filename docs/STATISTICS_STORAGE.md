# Statistics storage

UsageAtlas stores private numeric observations separately from daily display summaries. The desktop database is SQLite; the hosted account database is PostgreSQL. Both use the same versioned JSON contract and SHA-256 content validation.

## What is retained

`usage_fact` is an append-only observation ledger, scoped to the signed-in UsageAtlas account. Its three kinds are:

- `usage_event`: the source timestamp in UTC, reporting timezone, original and normalized model identifiers, token categories, numeric source counters, reported and estimated costs, parser/pricing revision, service tier, and opaque session/project identifiers when available.
- `collection`: coverage dates, status, parser/pricing revision, source-file and processed-record counts, and a machine-readable failure reason. A partial collection does not prove that missing days had zero usage.
- `capacity`: timestamped plan, quota windows, reset times, and credit balances. Earlier snapshots remain available.

`usage_record` remains the revisioned daily/capacity projection used by existing screens. `usage_record_history` retains replaced projections. Local history also retains their private detail payloads. Historical daily summaries remain useful when original source events have disappeared; a rescan does not silently reduce previously saved token or request totals.

## Measurements and identity

A source event has an opaque `eventId`. When the tool supplies a durable message/request/step ID, it is hashed with the provider and can deduplicate matching observations from another device. Otherwise the collector uses a source-scoped fingerprint and explicitly records `eventIdentity: "fingerprint"`. Fingerprints cannot guarantee cross-device deduplication or correction matching when the source supplies no durable ID.

A fact's `id` identifies its complete numeric content and provenance. Event observation time is excluded from this hash so repeatedly reading unchanged files does not create duplicate usage. Changed measurements or parser/pricing interpretations are retained as separate versions of the same event when its source identity is stable. A reappearance of an identical version does not create a new version or refresh its first observation time.

Use `usage_event_latest` for the latest observed version of each event; never sum all rows in `usage_fact`. The view includes `observation_versions` so disagreements can be inspected. Equal observation timestamps use the content ID as a deterministic tie break, not as proof of source correctness.

`measurement: "unknown"` has `totals: null`. It is not a zero-token request. Numeric source fields that were present still survive in `rawTokens`. Normalized known totals must equal the sum of input, cached input, cache creation, and output tokens. Reasoning is retained separately where reported; its interpretation depends on the provider and parser revision.

`granularity` distinguishes individual events from session-level fallback measurements. Do not add session fallback totals to detailed events for the same session. Request counts for session-level fallbacks represent observations, not a proven number of API calls. Historical summaries and event facts are alternative representations of overlapping usage, not additive datasets.

Full-precision reported and estimated costs are retained. Integer microdollars remain in display totals. Estimated costs are estimates, not invoices. The pricing revision is retained, but the complete external price catalog is not a financial audit archive.

## Privacy boundary

Cloud sync includes numeric statistics, model labels, and opaque project/session IDs. It excludes prompts, responses, transcript bodies, credentials, email addresses, project names/paths, and session titles. Local detail snapshots may retain project names/paths for desktop screens. The transient collector event list is removed before renderer IPC.

The private contract accepts bounded model identifiers without a public-name allowlist. Public profile aggregation separately applies its approved model catalog. A future or private model name can therefore remain intact privately while displaying as Other publicly.

## Sync and recovery

Daily display summaries are saved before the snapshot returns. Event observations then commit on a dedicated SQLite worker in transactions of at most 250 facts, so the engine can answer requests while storage is busy. Provider scans pause these background batches so disk work cannot consume another provider's scan timeout. The worker also runs idle checkpoints; commits retain FULL durability. The dashboard reports committed records while this work runs. Each import keeps the account owner captured when collection finished; changing accounts cannot redirect its remaining batches.

An unfinished-source marker survives shutdown or a failed batch. The next refresh rescans up to 90 days and deduplicates already committed observations. A collection completion fact is written only after its events. Uncommitted observations still depend on surviving source files or provider history; the marker cannot recover deleted source data. Cloud saves wait for local imports to finish and report import failures.

Local insertion and projection updates are transactional. Facts form a durable outbox and are acknowledged only after the server confirms their exact IDs. Retrying an interrupted upload is idempotent. A restore validates content hashes and saves its cursor in the same local transaction as its facts.

Remote batches are bounded to 250 facts and 512 KiB. All reads and writes use the authenticated account; a payload cannot select a different user. Writes serialize on the account row before sequence allocation, preventing an incremental reader from skipping a later commit with a lower sequence. The remote projection-history trigger also archives direct administrative updates.

The first desktop upgrade creates these tables and repairs recoverable model labels without changing totals. Existing local detail is retained across compatible cloud restores and archived before incompatible replacement. Source rescanning fills the event ledger only from surviving source files or provider history. It cannot reconstruct deleted logs, source fields never reported, or exact event timing from an old daily summary.

## Example queries

Always bind the account parameter. SQLite uses `owner`; PostgreSQL uses `user_id`.

```sql
-- SQLite: known, event-level tokens by provider and model.
SELECT provider, model,
       SUM(json_extract(payload, '$.totals.totalTokens')) AS tokens
FROM usage_event_latest
WHERE owner = ?
  AND json_extract(payload, '$.measurement') = 'known'
  AND json_extract(payload, '$.granularity') = 'event'
GROUP BY provider, model;
```

```sql
-- PostgreSQL: known, event-level tokens by provider and model.
SELECT provider, model,
       SUM((payload #>> '{totals,totalTokens}')::bigint) AS tokens
FROM usage_event_latest
WHERE user_id = $1
  AND payload->>'measurement' = 'known'
  AND payload->>'granularity' = 'event'
GROUP BY provider, model;
```

For calendar reports, convert `occurredAt` to the intended IANA timezone. Existing hourly projections now retain their actual UTC hour start, including repeated daylight-saving hours. Some legacy summaries have no known timezone or UTC hour and must keep that uncertainty.

For reliable insights, return coverage and unknown counts with every aggregate. A complete SQL result is not proof of complete source history. Keep raw-event reports distinct from legacy-summary reports until their coverage has been reconciled per source and day.

## Regression checks

The tests cover exact source/model preservation, malformed and oversized input, unknown measurements, numeric consistency, incomplete rescans, repeated DST hours, private-detail restore, changed observation versions, retry after commit, paginated restore, account isolation, public model privacy, and projection archival. Real-data upgrades should additionally compare every pre-upgrade daily total, SQLite integrity, source-event totals, and matching local/remote fact fingerprints before enabling the updated client.
