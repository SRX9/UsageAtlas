# Changelog

All notable UsageAtlas desktop changes are recorded here.

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
