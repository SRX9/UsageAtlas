# Changelog

All notable UsageAtlas desktop changes are recorded here. This build starts from the open-source
UsageAtlas app; see [README.md](README.md) for what it adds and what it is not.

## Unreleased — 0.4.7

### Added

- **Light, dark or system.** Settings → Appearance pins the palette instead of following Windows
  forever; the whole window, the mini window and the native controls switch together.
- **Four more bundled families.** Outfit, Sora, Newsreader and Fraunces join the font picker, including
  two editorial serifs for anyone who does not want a geometric sans everywhere.
- **Six 4K vector wallpapers.** Sierra, Aurora, Dunes, Tide, Orchid and Solstice keep the layered
  macOS-gradient look, render sharp at any panel size and add a few kilobytes to the installer rather
  than megabytes.
- **Three mini-window layouts.** Minimal is the bare token figure, Balanced adds the source, Detailed
  adds cost, burn rate and the tightest quota with its reset countdown. New windows open in the
  bottom-left corner, where Windows keeps nothing else.

### Fixed

- **Cloud save no longer reports a false dead end.** A record the server answered about at the same
  revision was silently ignored, so the next pass found it unchanged and stopped every other upload
  with `Cloud save made no progress`. That copy now becomes a conflict the user can resolve, and the
  rest of the save finishes.
- **Empty days stay on this computer.** A day with no usage was uploaded as a saved day without data,
  which the public profile reported as incomplete. It is still kept locally as proof the day was
  checked, but it is never sent.
- **Closed days are rewritten once a day.** A day first uploaded while it was still open is re-sent
  with its complete version, so the profile stops calling a finished day incomplete.
- **The mini window stopped clipping when shrunk.** The main window's 320 px minimum width was
  inherited by the card, so below that width its content was cut instead of moving the corners.
- **Attribution follows the chosen percentages.** The wheel now allocates token mass rather than request
  count, so a few huge requests can no longer drag the profile's tool split away from the rule.

## 0.4.6 — 2026-10-30

### Added

- **Settings → Providers.** The whole catalog in one searchable screen: 305 tools, 20 with a real
  reader, real brand marks where a logo exists, filters for trackable / on / installed, and the
  folders found on this computer. Scanning is passive; **Enable** is the only switch, and a tool
  without a reader says so and offers a local probe instead of pretending.
- **A provider directory with honest states.** Every card states whether the app can read the tool,
  whether it is already installed, and whether it is on. The catalog was rebuilt without the duplicate
  "… desktop" spellings and without names that were concepts rather than products.
- **Discovery remembers the route and keeps looking.** Remembered files are re-probed instead of
  trusted because a path resolves; the folder that held them is walked again for new ledgers, and
  sibling folders of the same product are always checked. Results merge per path, so a provider found
  in two stores is confirmed by both, and the screen reports "confirmed by N files".

### Changed

- **Hidden windows give their renderer back.** With power saving on, a window that stays in the tray
  for 30 seconds is destroyed and rebuilt at the same route and size when shown. The mini window is
  released the same way, and hidden rendering drops to one frame per second until then.
- **Background checks follow the user.** A visible window keeps the dashboard cadence; a hidden one
  checks every 15 minutes, and 30 minutes on battery. `powerSaving` now actually changes behaviour.
- **The catalog is curated.** 305 real tools and APIs replace 657 spellings, most of which were
  duplicate `… desktop` variants or non-products. The 0.5.0 target of 300+ verified readers remains
  open.

## 0.4.5 — 2026-10-29

### Fixed

- **The mini window stopped showing the page behind it.** The card was painted at 78 % opacity over a
  28 px backdrop blur, so whatever sat under the window — Settings, another app, the desktop — read
  through the glass as ghost rows. It is a near-opaque surface now, and only the 8 px inset around it
  is transparent, so the corners stay round without a square edge.
- **The mini window can actually be resized.** Windows gives a transparent frameless window no resize
  border, which is why dragging its edge did nothing. The card draws eight handles and the main
  process follows the real cursor: 180 × 104 up to 640 × 400, always inside the display, remembered
  between launches.
- **The cloud copy is the day itself.** A record whose model names are already public is uploaded
  unchanged — same totals, same hours, same model rows. Only a private model name (`m-…`) is reported
  under the plan's public model, because the server validates every model key against its catalog.
- **A source without its own rule is uploaded through the first saved mix** instead of staying on the
  computer, so Freebuff, Cline or Roo history reaches the cloud as soon as one plan exists.
- **Day details are plain JSON again.** 0.4.1 deflated them to save space; the next launch rewrites
  every deflated row back to readable JSON, which is the shape the old database and outside readers
  expect, and no new row is compressed.
- **One stable icon path.** `app.ico` beside the `app-<version>` folders is refreshed on every launch
  and by `refresh-install.ps1`. A shortcut can no longer point into a build folder that an update is
  about to delete, and Explorer is asked to drop its icon cache after every install.

### Added

- **Installed tools, found without reading a file.** Settings → Find a provider scans each data folder
  once, lists the catalog tools that actually have one, and probes the one you pick in a single click.
  First slice of the 0.5.0 discovery goal.
- **A hidden window does no work.** The mini window stops its 30 s snapshot poll and the renderer parks
  every animation while the window is hidden or minimized. First slice of the 0.5.0 idle goal.

## 0.4.4 — 2026-10-29

### Added

- **Find a provider, inside the app.** Settings → General now probes any tool name against its local
  stores and reports the route it would read, a confidence score, the folders and entries scanned,
  and every matching file with its store and token fields. The 63 seeded names are offered as
  suggestions. The scan is local-only: no network request is made. This is the first slice of the
  0.5.0 discovery goal.
- **A restart badge that cannot go stale.** When a newer `app-<version>` folder exists while an older
  window is still running, the top-bar badge says **Restart to finish update** and the update state
  re-reads the install root instead of trusting a previously reported “latest”.

### Changed

- **The mini window shows one thing: today's tokens.** The quota and budget dials are gone, along
  with the burn-rate, session-cost and reset rows that depended on them. It now uses the full width
  for one figure across every enabled tool, switches to a short unit (`12.4M`) below 300 px, and can
  be resized down to 180 × 104.
- **The mini window is a rounded glass card again.** The Windows acrylic sheet that painted a square
  around the card is removed, the native shadow no longer follows the window rectangle, and the card
  is inset inside a transparent window so its corners stay round.
- **Rollback survives an update.** `refresh-install.ps1` now keeps the newest build and its immediate
  predecessor (plus the folder the running window came from) instead of deleting every older build.
  The 0.5.0 trusted-build acceptance now names two folders instead of zero.

## 0.4.3 — 2026-10-29

### Added

- **A blended cost estimate that matches a real bill.** Provider logs often name a private model whose
  catalog price has nothing to do with the invoice, so the total read **$5.53 for 774 M tokens**.
  Settings → Data now prices every token at one blended rate, on by default at **$0.54 per million
  tokens** — the same order as the public leaderboard (42.29 B tokens for roughly $23 k). Applying the
  rate rewrites every stored day and observation as well as new requests, so a measured 762 M-token
  profile moves from **$82.88 to $411.46** with every token count unchanged.
- **Active tool capacity for tools without quota windows.** Today's capacity card used to be empty
  when a provider reported tokens but no metered limit, which is what Freebuff and Claude do locally.
  It now lists every enabled tool with today's tokens, estimated cost and plan when known, while
  keeping the existing dials for tools that do report limits.

### Changed

- **The repository carries only the current release.** Roughly 1.2 GB of superseded installers,
  build output, diagnostic scripts and logs were removed; source, tests and the current release
  artifacts remain.
- The discovery catalog is documented as its real size (63 seeded names), with 300+ verified
  providers moved to the larger 0.5.0 contract instead of being claimed early. The 0.5.0 section now
  carries seven acceptance-tested outcomes, including a year of history on three machines, bill-exact
  cost and one million requests that stay instant.

## 0.4.2 — 2026-10-29

### Fixed

- **An update now ends on the new build, with its icon.** Squirrel installs a new `app-<version>`
  folder while the previous build keeps running, and that older process holds the single-instance
  lock — so launching the new build only refocused the old one and kept its taskbar artwork. A newer
  copy now asks the running one to step aside, and `refresh-install.ps1` stops other builds, deletes
  their folders and refreshes Explorer's icon cache on every launch. Start Menu and pinned
  shortcuts are rewritten with the current mark.
- **Settings → Widget preview** is styled like the floating window again: separate title and model
  lines, ring gauges with captions, and three labelled stats instead of run-together text.
- **Provider colour rows** are real chips: the logo is 18px, the name truncates, and the swatch and
  reset button keep their places instead of overlapping the text.
- **Number fields** hide Chromium's Windows spinners and right-align their value; selects use a
  consistent chevron.
- **The mini window's budget gauge** shows an em dash when no budget is set, so the label no longer
  spills out of the ring.

## 0.4.1 — 2026-10-29

### Added

- **The settings the reference spec lists.** The compact always-on-top widget gets its own page
  beside the window controls, and Settings gains opt-in controls that were only constants before:
  extra log roots and ignored project fragments, burn-rate and quota-reset alerts with sounds and a
  do-not-disturb switch, per-provider colours, window opacity and blur, density, model price
  overrides, currency and tax, project redaction, a retention window, and scheduled exports.
- **Attribution is back while the provider PR is unmerged.** A source the hosted service does not
  model can again be reported as one or more official providers with a share each. Local history is
  never rewritten; only the uploaded copy is. Each request keeps the target it first spun, so a
  retried save cannot change its label.

### Changed

- **The local file is smaller again.** Day display details are stored deflated and read back
  unchanged; collection and capacity snapshots are deleted once the server has acknowledged them; an
  attribution label is now a column on the fact or day it describes instead of a settings row keyed
  by its id; two indexes no query filtered on are dropped; and a saved request keeps its payload
  for a week rather than a month. The one-time rewrite could not run before while the background
  writer held the file, so it now opens on the first batch instead and the `VACUUM` succeeds. On a
  current profile: 1,380,352 bytes → 704,512 bytes (49 % smaller), 606 → 278 fact rows, 723 → 0
  label settings rows, with all 20 day records, every token, cost, hour and model total intact.

## 0.4.0 — 2026-10-29

### Changed

- **Cloud saves report the real provider.** The attribution page and its weighted wheel are removed.
  A source the hosted service does not model is kept on this computer and named in Settings; nothing
  is uploaded under another provider's name.
- **The local ledger is compact.** Saved request rows older than 30 days keep only a content
  fingerprint, superseded scan and quota snapshots collapse to their newest copy, the write-only
  archive is dropped, and one `VACUUM` returns the pages. On a real profile: 4.61 MB / 2,856 rows →
  0.856 MB / 285 rows, with day totals, hours, models and costs unchanged. Restore no longer copies
  the cloud ledger into SQLite.
- **The README is rebuilt from the upstream document**, with the 0.4.0 measurements, the added
  readers, the storage contract and the 0.4.0 → 0.5.0 timeline.

### Added

- **A 63-provider discovery seed catalog.** The offline engine now has names for agents, editors,
  gateways and local runtimes; an unknown name returns empty in under two seconds with no network.
- **A notification inbox.** The last 50 alerts are kept with their arrival time in the Notifications
  tab, survive a restart, and can be cleared; the toast title carries the UsageAtlas name.
- **A taskbar and toast identity.** The Start Menu shortcut matching the process's AppUserModelID is
  written on every launch, including development runs, with the chosen ICO before the first window.
- **One-click rollback.** Settings relaunches the newest older Squirrel build with local history
  untouched.

### Removed

- The Attribution page, its wheel and the report-plan settings that rewrote uploaded providers.

## 0.3.9 — 2026-10-28

### Fixed

- **The cloud counter no longer includes usage the server refuses.** Cline and Roo observations have
  no reader on the hosted service and no attribution rule, so they stayed pending forever and made
  `Save to cloud` look broken. The page counts only what a save can send, names the held-back sources
  with their own total, and reads *Everything the server accepts is saved to cloud* when nothing is
  left. The hourly timer ignores held-back rows instead of waking for them.
- **One copy of the app runs at a time.** Squirrel leaves the previous build running after an update,
  so several versions shared this profile, competed for `history.sqlite`, and the taskbar group kept
  the first build's icon. A single-instance lock focuses the open window instead of starting another.
- **Windows draws the app's ICO, not the Electron atom.** The window is created with the chosen
  mark's ICO; a stale second instance can no longer keep the default artwork in front.

### Changed

- **The local archive is bounded.** `usage_record_history` was write-only and had grown to 4.2 MB of
  an 8 MB database after two days. It keeps the newest 20 versions per record on write and on open,
  then vacuums the freed pages: 7.91 MiB → 3.99 MiB measured on a copy of a real profile.
- **README documents the 0.4.0 storage budget.** One document per provider and day, merged
  additively, with a fake-data measurement (30.1 MB of observations → 0.29 MB of day documents,
  1.0 % of today's payload) and the provider list the discovery work targets.

## 0.3.8 — 2026-10-28

### Fixed

- **A cloud save now uploads every pending change in one run.** The hosted service stores at most 40
  observations per request, but the client sent its store's 250-fact page and expected all 250 to be
  acknowledged: it threw `Incomplete statistics acknowledgement` after the first 40, so the counter
  came down 40 at a time. Each request is capped at 40 and the loop continues until nothing is left,
  with a regression test against a server that acknowledges only the first 40.
- **The Settings tab bar sits on the same column as its cards.** It was an inline-level box, so the
  auto margins that centre every other page block did nothing and the segmented control started at
  the page gutter while the cards started 116 px further right.
- **The chosen app mark reaches the Windows taskbar and the Start Menu shortcut.** Setting the window
  icon alone left an AppUserModelID app showing the shortcut's artwork; the window now also publishes
  its icon through `setAppDetails`, rewrites the Start Menu shortcut's icon, and asks Explorer to
  refresh its icon cache.
- **Alerts are visible even when Windows hides the toast.** Every system notification is mirrored as
  an in-app banner with the same message, a link to the right page and a dismiss button, so Focus
  assist or a per-app notification switch cannot swallow it.

### Added

- **A visual timeline in the README.** `docs/timeline.svg` draws every shipped 0.3 release and the
  seven 0.4.0 goals in the app's own dark glass language, each goal carrying its acceptance test.

## 0.3.7 — 2026-10-28

### Added

- **Four more appearance settings.** Settings → Appearance now also offers the number style, an
  accent tint for buttons and focus rings (theme, ink, cobalt, violet, rose, forest, amber), glass or
  solid card surfaces, and a switch that turns interface motion off while leaving progress spinners
  working. Each choice applies immediately, is saved locally and is validated before it reaches the
  preference file.
- **Full figures by default.** Every total, card and table prints all its digits — `1,284,930`
  instead of `1.3M` — with `Short units` one click away. Chart axes stay compact in both modes, and
  currency follows the same choice.
- **A restart prompt when the installed build is newer.** An update applied while an older window is
  still open now shows up as *Version X is installed*, and updating relaunches through the Squirrel
  stub so the window ends up on the build that is actually on disk.

### Changed

- The Appearance preview reads its figure from the same formatter as the dashboard, so it shows the
  real digit style rather than a fixed sample.
- README gained a checkable 0.4.0 plan (provider discovery, compact cloud saves, deeper appearance,
  per-model attribution, trusted updates, complete translation, cheaper idle).

### Fixed

- A stale window could claim *You're on the latest version* while a newer release was already
  unpacked next to it: Squirrel compares against the package on disk, so the older build now reports
  the waiting version instead.

## 0.3.6 — 2026-10-28

### Added

- **The rail highlight slides between pages.** The active-page pill is a single element moved
  between rail buttons, so going from Today to Profile — or from Profile to Usage alerts — glides
  down the rail instead of the highlight jumping from one item to the next. It is measured from the
  real buttons, so it stays aligned when the window or the type scale changes, and it is placed
  without animation under reduced motion.

### Changed

- **The appearance pickers are translated too.** The font, app-icon and ink descriptions in
  Settings → Appearance no longer stay in English inside a French, Spanish, Chinese or Hindi page,
  and neither does the *Custom* background label.
- **The chosen app mark reaches the Windows taskbar.** Each mark now ships a multi-size ICO beside
  its PNG and the window icon is set from it, so the taskbar and Alt-Tab artwork follow the picker
  instead of only the title bar and the tray. Windows keeps the icon of the installed shortcut
  itself; only the running window can change it.
- French uses the domain word *tokens* rather than translating it to *jetons*.

## 0.3.5 — 2026-10-28

### Added

- **Five interface languages.** Settings → General → Language offers *System*, English, Français,
  Español, 中文 and हिन्दी. The app shell, window controls, Settings and the usage alerts page read
  from a typed catalog, so a missing translation fails the build instead of falling back silently;
  numbers and dates keep their English formatting so a figure reads the same in every language.
- **Gemini CLI, Qwen Code, Cline and Roo Code readers.** Each tool writes its own transcript; the new
  readers parse the token objects in place (`tokens.{input,output,cached,thoughts,total}`, Gemini-style
  `usageMetadata`, and Cline/Roo `api_req_started` request info) and keep only numeric usage. The
  survey behind the readers, including sources that are not wired up, is in
  [docs/PROVIDER_USAGE_SOURCES.md](docs/PROVIDER_USAGE_SOURCES.md).
- **Settings → Appearance.** A tab inside Settings chooses a bundled variable font (System, Inter,
  Manrope, Figtree, Jakarta, Geist), the type scale (85–130 %), the ink colour, the background and
  the app mark. The mark is applied to the title bar, the window and the tray without a restart;
  *Datamosh*, *Classic* and *Duotone* are generated by `node tooling/generate-app-marks.mjs`.
- **Daily token alerts.** Usage alerts gain a per-day token threshold. Every enabled source is
  watched, so the alert works for private providers with no quota window, and the notification names
  the exact count (`You used 128,400 tokens on Freebuff today.`). A test button sends a real one.
- **Page motion.** Routes glide in from the side they were reached from, and the home selectors grow
  under the pointer with a springy return. Both are skipped under reduced motion.

### Changed

- **Window controls are rounder.** The self-drawn minimize, maximize and close buttons are circular,
  with rounded 1.5 px strokes, a soft hover fill and a scale response that matches the rest of the
  chrome.
- The update source picker names its options *Unofficial fork* and *Official app* instead of *This
  fork* and *Upstream*.

### Fixed

- **“Local history import was interrupted” no longer appears for an import that is not running.** A
  source marker left by an earlier run was reported as a permanent error, and a cloud save waited on
  it forever. Markers now only steer the next backfill; a save proceeds from the facts already stored.

## 0.3.4 — 2026-10-27

### Fixed

- **Cloud save no longer reports an error and leaves the dashboard at zero.** Three separate defects chained together. A day the server already held under another label came back as a conflict, and the local copy stored for comparison mixed the server's totals with this machine's model breakdown, which contradicts itself (`Breakdowns exceed daily usage`); the record then failed to decode, was dropped from analytics — so today's usage read as `0` — and was flagged `Invalid local usage record`, which blocked every later save. A comparison copy now keeps its own numbers, an unreadable copy is dropped instead of blocking the record, and records an earlier build flagged are repaired when the app opens.
- **A record keeps the label it was first reported under.** Re-weighting an Attribution rule between runs made the wheel land the same day on another provider, and the server refuses a record it already holds under a different one — the save then stopped with `Cloud save made no progress`. Each record and observation now stores its provider and model on first upload and reuses it, and a copy the server already holds supplies that label when the local database has none. Saving proceeds from the revision the server reached instead of stalling.
- The stored label is separated by `|` rather than a NUL byte: the SQLite binding truncates strings at NUL, which silently dropped the model and made the server answer `400 Invalid usage records`.

## 0.3.3 — 2026-10-27

### Added

- **Weighted attribution.** An Attribution rule now lists several official targets with a share each (30 % Codex, 20 % ChatGPT, 50 % Claude), and every request draws one of them like a wheel. The draw is a hash of the request's own identity rather than a counter or a random number: the shares hold over time, the same target can come up several times in a row, and a retried or interrupted save keeps the target it already had. Daily records spin on their own id, so one day lands on one target between saves instead of changing label mid-upload. The page shows each target's effective share and explains the round trip.
- **Update source can be chosen — and it now works.** Settings → App updates accepts *This fork*, *Upstream* and *Another repository* (any GitHub `owner/name`). The previous picker wrote `updateChannel` through `updatePreferences`, which the main process rejected as an unknown key, so the choice silently failed; `updateChannel` and the new `updateRepository` are validated and accepted, and changing either re-checks against the new publisher immediately. An empty repository keeps reading this fork's releases.
- **Freebuff brand mark.** Freebuff usage now carries Freebuff's published icon (byte-identical to `https://freebuff.com/favicon.svg`, hash recorded in the assets README) instead of a generated letter, and the model names it reports are the resolved ones rather than `m-<digest>`.
- **A glitched app icon.** The application icon is the original artwork deliberately datamoshed — split channels, displaced bands, torn scanlines — so this fork cannot be mistaken for the official build at a glance. The marks are applied inside the icon pipeline (`node tooling/generate-desktop-icons.mjs`), so `usageatlas.png`, `usageatlas.ico` (16–256 px) and the macOS `usageatlas.icns` all carry them and a rebuild reproduces the same bytes; the branding artwork and the website's copies keep the original mark.
- **Freebuff-style window controls.** Windows and Linux draw their own minimize, maximize/restore and close buttons in the title bar (hover highlight, red close) instead of the native title-bar overlay; the maximize glyph reflects the window state. macOS keeps its traffic lights.

### Changed

- Local refreshes are cheaper. A provider's availability probe is trusted for a minute instead of running on every dashboard snapshot, and the Freebuff route verification remembers its schema probe per file identity: on a real installation the cached route check went from 22 ms to 3.6 ms and a warm Freebuff refresh from ~90 ms to ~70 ms. A forced refresh still re-probes everything.
- Numbers are formatted in English (`48.8M`, `$9.4K`) rather than in the operating system's locale, matching the English copy around them and making the figures identical on every machine. The locale-dependent test failures on a French Windows install are gone with it.

### Fixed

- Cloud saves no longer fail with `Cloud request failed (400)` once an Attribution rule exists. An observation's id is the hash of its content, so the relabelled copy the server received no longer matched the id it was uploaded under and was rejected as tampered with. Renamed observations are now renumbered before they leave the machine and the server's acknowledgement is translated back to the row stored locally, so the save completes and nothing is uploaded twice.
- A source the server does not model no longer fails the whole save. Freebuff or z.ai usage stays on this computer, the rest of the history still saves, and Settings → Cloud save names the held-back sources with a pointer to the Attribution page.
- Freebuff usage is priced. Every turn reports `costUsd: 0` because Freebuff is a subscription, so the dashboard's API-rate estimate read `0,00 $` for hundreds of millions of tokens. The tool stores its model as an opaque `m-<digest>` id (`m-096e75164d` is `deepseek/deepseek-v4-flash` for example); that id is now reversed offline for all 67 models Freebuff Desktop 0.0.192 ships, and the turn is priced at the resolved model's API rates through the pricing catalog. A real installation went from `$0.00` to `$3.14` over 394.9M tokens.
- Vendor prefixes now resolve against the pricing catalog the way the providers publish them (`z-ai` → `zhipuai`, `mistralai` → `mistral`, `x-ai` → `xai`, `qwen` → `alibaba`), so a privately routed model is priced instead of counted as unpriced tokens.

## 0.3.2 — 2026-10-27

### Changed

- The repository is now `Artleboss2/UsageAtlas-Unofficial`, and the app says so: Settings carries an unaffiliated-build notice, the documentation button and the bug-report link open this fork's repository, and the updater reads its releases from the new name. Installing an upstream build still replaces the fork's private providers.
- Packaging metadata (deb/rpm homepage, installer authors, setup icon URL) points at this fork instead of the original project's site.

## 0.3.1 — 2026-10-27

### Fixed

- Freebuff history can be stored again. Freebuff reports cached tokens inside its input count, and the stored day payloads kept them overlapping, so every generated record and observation failed the usage contract: local history reported that it could not be stored, Freebuff days were missing from the dashboard, and a cloud save hid the rows it could not read. Cached tokens are now moved out of input at the edge, so the categories add up to the day's total, and a regression test feeds the collector's own facts through the store that rejected them.

### Added

- **Publisher choice for updates.** Settings → App updates now switches between *My fork* (this build's GitHub releases) and *Upstream* (the official UsageAtlas update mirror). GitHub-hosted releases carry the Squirrel `RELEASES` feed and `.nupkg`, so Windows installs update in place from either publisher; the choice applies to the next check without a restart.
- **Model picker in Attribution.** A reporting rule now offers the models the reported provider runs (filtered against the server's reviewed public catalog) instead of a free-text field, keeps a rule's own model selectable, and picks a valid model when the provider changes.

## 0.3.0 — 2026-10-26

### Added

- Local provider readers for Freebuff and z.ai, including the dynamic path planner that finds Freebuff's `desktop-v2.db` wherever it lives.
- Cloud attribution: a source the server does not model yet can be saved under an official provider with a model of your choice, without rewriting local history.

## 0.2.2 — 2026-07-19

### Fixed

- Stopped macOS builds from reinstalling the version they are already running: the installed version is now part of the update feed path, and the update service reports that there is nothing to install.
- Downloaded updates are now actually installed. The app offers a restart when one is staged and keeps a tray entry until it happens, which is the only way Squirrel.Mac applies an update.
- Linux AppImage builds, which have no in-app installer, now report a newer published release and link to the download page.

### Changed

- Replaced the orange visual language with a graphite-first Cursor-style palette and made graphite the default appearance.
- Restored the real UsageAtlas artwork inside the custom title bar and sidebar.
- Reduced card and control corners to a 2–6 px radius scale and disabled native rounded window corners.
- Unified all interface, metric, table, and diagnostic typography on one CursorGothic-first sans stack.

## 0.2.1 — 2026-07-19

### Changed

- Rebuilt the full desktop interface around a Cursor-inspired design system with warm cream surfaces, warm ink, Cursor Orange actions, compact geometry, and hairline-only depth.
- Integrated the native window controls into a theme-aware custom title bar and synchronized its appearance with System, Light, and Dark preferences.
- Restyled the dashboard, providers, analytics, settings, diagnostics, tables, charts, loading states, and error states.

## 0.2.0 — 2026-07-18

### Added

- Cross-platform Electron application with a sandboxed React renderer and typed preload API.
- Tested Codex and Claude adapters using existing local OAuth credentials.
- Quota windows, reset times, plan details, credits, and structured provider errors.
- Local 7/30/90-day token, request, project, session, model, and estimated-cost analytics.
- Tray behavior, launch-at-login preferences, themes, diagnostics, and automatic updates.
- Signed release pipelines, packaged smoke tests, explicit Electron fuses, dependency auditing, and checksums.

### Changed

- Refined the dashboard, settings, diagnostics, empty states, and interaction feedback for the desktop launch.
- Consolidated product documentation around the maintained application and its supported providers.
