# ShowSkip

ShowSkip is a standalone Stremio Enhanced plugin for Windows. Phase 2 adds defensive episode detection, direct anonymous TheIntroDB lookups, and read-only recap, intro, credits, and preview regions on the native seek bar. The independent per-series playback choices remain configuration for a later phase: ShowSkip does not seek, skip, or advance episodes yet.

This is an Enhanced UI/player plugin, not a normal Stremio addon. It does not modify Stremio Enhanced, Stremio Web, Stremio Service, or `server.js`.

## Project status

Phase 0 established the research and architecture baseline. Phase 1 provides the self-contained `ShowSkip.plugin.js`, per-show configuration and storage, tests, and safe local install/uninstall scripts. Phase 1.1 added a ShowSkip-owned high-contrast panel palette. Phase 2 advances the artifact to version `0.2.0` with a provider-neutral episode timeline pipeline and preserves the `state_v1` profile format.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for pinned-source findings, the data and lifecycle design, DOM validation, risks, unresolved questions, and the exact Phase 1–4 plan.

## User experience

- One small native-looking launcher in the action row on a series detail page.
- A per-show panel with `Auto`, `Button`, and `Off` rules for recap, intro, credits, and preview.
- Per-show next-episode choices.
- First visit to a show opens the panel; closing it removes the entire panel.
- When closed, the launcher is the only ShowSkip UI left on the series page.
- Subtle recap, intro, credits, and preview regions on the actual native seek bar when the active episode, HTML video, duration, provider response, and player controls all validate.
- Timeline regions are independent of the saved rule, so they remain visible when a type is set to **Off**.
- Keyboard-focusable regions have accessible time-range labels; hover or focus reveals a temporary tooltip without blocking native seek-bar interaction.
- No skip buttons, automatic seeking, playback mutation, or next-episode action in Phase 2.

## Target environment

Research currently targets:

- Windows
- Stremio Enhanced 1.2.0
- the Stremio Web UI served by `https://web.stremio.com/`
- TheIntroDB API v3

The pinned research date is 2026-08-20. These upstream projects are active, so DOM and runtime assumptions must be revalidated during each implementation phase.

The Phase 2 playback integration targets Enhanced's normal built-in HTML-media path and is deliberately read-only. It requires exactly one connected, visible `<video>` under the active player route plus one structurally validated seek slider. YouTube/trailer, cast, external MPV/VLC, shell/no-video, disconnected, retained-route, and ambiguous media paths fail closed. A valid finite duration is required before any provider request.

## Local installation

From the repository root, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-local.ps1
```

The script requires the repository's completed `ShowSkip.plugin.js`, creates the Enhanced plugin directory when needed, and copies only that file to `%APPDATA%\stremio-enhanced\plugins\ShowSkip.plugin.js`. It overwrites only an earlier ShowSkip plugin file and prints the exact destination on success. It does not change other plugins, Stremio Service, Enhanced server configuration, normal Stremio, or `server.js`.

After installation:

1. Restart Stremio Enhanced or press `Ctrl+R`.
2. Open Settings → Enhanced → Plugins.
3. Enable ShowSkip.

Enhanced will store ShowSkip preferences beside the plugin in `ShowSkip.plugin.json`. Do not commit that generated file.

Enhanced does not remove that settings file when the plugin is uninstalled. Preserve it to keep per-show choices, or reset ShowSkip intentionally with the explicit uninstall option below.

### Local uninstallation

Remove only the locally installed plugin file and preserve all saved per-show settings:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-local.ps1
```

To also remove `%APPDATA%\stremio-enhanced\plugins\ShowSkip.plugin.json` and permanently reset all local ShowSkip profiles, opt in explicitly:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-local.ps1 -RemoveSettings
```

The uninstall script accepts PowerShell's `-WhatIf` switch for a dry run. It uses exact filenames and non-recursive removal; it never deletes the plugin directory or unrelated plugin files and settings.

## Local development

The local development loop is:

1. Edit the standalone plugin source in this repository.
2. Run `scripts\install-local.ps1`.
3. Reload Enhanced with `Ctrl+R`.
4. Use `Ctrl+Shift+I` for local DOM and console validation.
5. Work through the live validation matrix in `ARCHITECTURE.md`.

Do not test by editing Stremio Enhanced or Stremio source files. Keep all behavior self-contained in the plugin artifact.

### Automated testing

ShowSkip uses Node's built-in test runner and has no package dependency. Before installing, run:

```powershell
node --check .\ShowSkip.plugin.js
node --test .\tests\*.test.cjs
```

The suite covers the Phase 1/1.1 profile UI and lifecycle plus Phase 2 routes and identity, read-only media selection, duration stabilization, provider validation/network policy, exact-duration caching, retry/abort behavior, seek-versus-volume targeting, marker accessibility, remounts, stale-result rejection, and the absence of Phase 3 media writes or synthetic player actions. Browser-dependent checks inside packaged Stremio Enhanced remain a separate manual gate.

### Packaged Enhanced Phase 1 regression checklist

1. Run the installer, reload Enhanced with `Ctrl+R`, enable ShowSkip, and confirm it appears only once with no ShowSkip console error.
2. Open a never-seen series. Confirm one launcher and an open panel whose five row labels—**Recap**, **Intro**, **Credits / Outro**, **Preview**, and **Next Episode**—are all clearly visible. Confirm every selected and unselected option is comfortably readable, with Recap/Intro/Credits/Preview set to **Button** and Next Episode set to **Stremio default**.
3. Change one choice, close the panel, and confirm the entire panel disappears; only the launcher remains.
4. Navigate home and back to the same series. Confirm one launcher, no panel, then click the launcher and confirm the saved choice returns.
5. Open a different never-seen series. Confirm its panel opens with defaults and the first show's profile is unchanged.
6. Navigate show A → show B → home → show A → episode/player → show A. Confirm no duplicate launcher, stale panel, or UI on home/player routes.
7. Resize between desktop and a narrow window and trigger ordinary page remounts (for example, season/back navigation). Confirm the launcher remains aligned and unique and the panel stays usable.
8. Disable ShowSkip. If the current loader does not remove live UI immediately, press `Ctrl+R`; confirm all ShowSkip UI is then gone. Re-enable/reload and confirm exactly one instance returns with saved profiles intact.

### Packaged Enhanced Phase 2 manual checklist

Use a normal built-in series stream for a known episode with TheIntroDB data, such as *Breaking Bad* S1E1 (`tt0903747:1:1`). Keep DevTools Network and Elements open.

1. Confirm the player route and displayed title identify the intended episode before judging its timestamps.
2. Filter Network for `api.theintrodb.org/v3/media`. Confirm one bounded request sequence for the stable media duration, with `imdb_id`, season, episode, and exact integer `duration_ms`; a single retry is possible only after an eligible transient failure.
3. Confirm every returned valid recap, intro, credits, and preview range appears on the playback seek bar, including a type whose saved setting is **Off**.
4. Confirm no ShowSkip marker appears on the volume slider or any retained/inactive control.
5. Drag and click the native timeline across marker regions. Confirm seeking remains native and unobstructed, and hover/keyboard focus exposes the correct type and time range.
6. Let controls hide and show, then trigger an ordinary control-bar remount. Confirm the markers disappear and return with the native seek bar without duplicates or a refetch for already-valid session data.
7. Change from episode A to episode B without reloading. Confirm A's request/work and markers cannot affect B, and B receives only its own markers.
8. Exit the player. Confirm all marker and tooltip DOM is removed. Test a trailer or external-player path and confirm it receives no markers or ShowSkip playback action.
9. Watch through or seek across every marked region. Confirm ShowSkip never changes `currentTime`, skips content, shows a skip/next button, or advances the episode.

Packaged Enhanced Phase 2 playback has not been claimed as automated or completed by this repository; this checklist is still required after installing the exact final artifact.

## Segment data and attribution

The Phase 2 timestamp provider is [TheIntroDB](https://theintrodb.org). ShowSkip sends only direct anonymous client-side GET requests to `https://api.theintrodb.org/v3/media`; it sends no API key or ShowSkip account data. Validated positive and explicit no-data results use a small exact-duration-aware in-memory session cache. Provider timestamps and response bodies are never written to `state_v1`, files, logs, or a persistent database, and the cache disappears on plugin teardown/reload.

TheIntroDB's [API reference](https://theintrodb.org/docs), [OpenAPI specification](https://theintrodb.org/openapi.yaml), and [terms](https://theintrodb.org/docs/terms) were rechecked on 2026-08-20. The reviewed terms limit timestamp use to client-side, non-commercial end-user applications unless a separate agreement is obtained, permit temporary session caching, and prohibit database reconstruction, persistence, mirroring, or redistribution. Attribution is requested rather than required by default; after at least one TheIntroDB marker actually renders for a show, the open per-show panel voluntarily shows “Timestamp data by TheIntroDB” using the exact `.com` destination named by the terms. This per-show fact is remembered only for the current plugin session, is not persisted, and is absent for shows whose data has never rendered a marker. Recheck the terms and their `.com`/official `.org` link discrepancy before release.

## Known Phase 2 limitations

- The current identity path requests TheIntroDB only for validated 7- or 8-digit IMDb series IDs. It never guesses that an arbitrary Stremio ID is TMDB/TVDB identity.
- Route identity is accepted only for the exact series-player shape and anchored `<series-id>:<positive-season>:<positive-episode>` video IDs, then revalidated against any available current Stremio core state. Contradictory or stale state fails closed.
- Only exactly one connected visible built-in HTML video is supported. YouTube/trailer, cast, external MPV/VLC, shell/no-video, missing source/duration, multiple-video, and disconnected/retained-route paths fail closed. Changed or ambiguous Stremio player/seek-slider structure likewise produces no request or marker rather than a guessed attachment.
- Current public Stremio Web DOM and trailer behavior have been inspected, but the complete Phase 2 path still needs the packaged Enhanced checklist above with a real series stream and local backend.
- Provider coverage and community timestamps vary by episode and media cut. Exact rounded duration is part of each lookup/cache key, at most two distinct durations issue per media-source/context token, and validated results/attribution are session-only; ShowSkip does not fabricate missing data or render invalid ranges.

## Repository policy

- Commit after each completed implementation phase.
- Keep the production deliverable self-contained.
- Keep `@updateUrl none`; releases are installed explicitly unless the user later approves a host-managed remote-update exception.
- Do not include remote executable code, analytics, or arbitrary third-party scripts.
- Do not commit generated plugin settings, logs, build output, or local test artifacts.
- Select and document the project's own license before public release.
