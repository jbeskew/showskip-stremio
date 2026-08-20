# ShowSkip

ShowSkip is a standalone Stremio Enhanced plugin for Windows. Phase 1 provides independent per-series configuration for recap, intro, credits, preview, and next-episode behavior; playback actions are intentionally deferred to later phases.

This is an Enhanced UI/player plugin, not a normal Stremio addon. It does not modify Stremio Enhanced, Stremio Web, Stremio Service, or `server.js`.

## Project status

Phase 0 established the completed research and architecture baseline. Phase 1 now provides the self-contained `ShowSkip.plugin.js`, its per-show configuration UI and storage foundation, focused tests, and safe local install/uninstall scripts. Phase 1.1 gives the owned panel an explicit high-contrast palette after packaged Enhanced exposed unsafe host foreground variables.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for pinned-source findings, the data and lifecycle design, DOM validation, risks, unresolved questions, and the exact Phase 1–4 plan.

## User experience

- One small native-looking launcher in the action row on a series detail page.
- A per-show panel with `Auto`, `Button`, and `Off` rules for recap, intro, credits, and preview.
- Per-show next-episode choices.
- First visit to a show opens the panel; closing it removes the entire panel.
- When closed, the launcher is the only ShowSkip UI left on the series page.
- A later phase will add seek-bar segment regions that remain visible even when skipping is Off.

## Target environment

Research currently targets:

- Windows
- Stremio Enhanced 1.2.0
- the Stremio Web UI served by `https://web.stremio.com/`
- TheIntroDB API v3

The pinned research date is 2026-08-20. These upstream projects are active, so DOM and runtime assumptions must be revalidated during each implementation phase.

The planned playback integration targets Enhanced's normal built-in HTML-media path. YouTube/cast paths and Enhanced's optional external MPV/VLC mode do not expose the required in-page clock, duration, seek bar, and seek control together, so ShowSkip will fail closed there unless a future constrained host API is verified.

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

The Phase 1 local loop is:

1. Edit the standalone plugin source in this repository.
2. Run `scripts\install-local.ps1`.
3. Reload Enhanced with `Ctrl+R`.
4. Use `Ctrl+Shift+I` for local DOM and console validation.
5. Work through the live validation matrix in `ARCHITECTURE.md`.

Do not test by editing Stremio Enhanced or Stremio source files. Keep all behavior self-contained in the plugin artifact.

### Phase 1 testing

Phase 1 uses Node's built-in test runner and has no package dependency. Before installing, run:

```powershell
node --check .\ShowSkip.plugin.js
node --test .\tests\*.test.cjs
```

Then use the install script and manually verify the Phase 1 acceptance cases in `ARCHITECTURE.md`: first visit, full panel removal on close, persisted reopen/revisit behavior, independent show profiles, repeated SPA navigation, and responsive React remounts. Browser-dependent visual checks must be performed inside Stremio Enhanced; the automated suite does not replace them.

### Packaged Enhanced manual checklist

1. Run the installer, reload Enhanced with `Ctrl+R`, enable ShowSkip, and confirm it appears only once with no ShowSkip console error.
2. Open a never-seen series. Confirm one launcher and an open panel whose five row labels—**Recap**, **Intro**, **Credits / Outro**, **Preview**, and **Next Episode**—are all clearly visible. Confirm every selected and unselected option is comfortably readable, with Recap/Intro/Credits/Preview set to **Button** and Next Episode set to **Stremio default**.
3. Change one choice, close the panel, and confirm the entire panel disappears; only the launcher remains.
4. Navigate home and back to the same series. Confirm one launcher, no panel, then click the launcher and confirm the saved choice returns.
5. Open a different never-seen series. Confirm its panel opens with defaults and the first show's profile is unchanged.
6. Navigate show A → show B → home → show A → episode/player → show A. Confirm no duplicate launcher, stale panel, or UI on home/player routes.
7. Resize between desktop and a narrow window and trigger ordinary page remounts (for example, season/back navigation). Confirm the launcher remains aligned and unique and the panel stays usable.
8. Disable ShowSkip. If the current loader does not remove live UI immediately, press `Ctrl+R`; confirm all ShowSkip UI is then gone. Re-enable/reload and confirm exactly one instance returns with saved profiles intact.

## Segment data and attribution

The planned primary timestamp provider is [TheIntroDB](https://theintrodb.org). API access will be direct from the user's client and timestamp responses will be cached only in memory for the session. The project will not mirror, redistribute, or persist provider timestamp data. ShowSkip's eventual code license will apply only to ShowSkip code; it will not grant rights to provider timestamp data.

TheIntroDB's [API reference](https://theintrodb.org/docs) and [terms](https://theintrodb.org/docs/terms) should be rechecked before release. The reviewed terms limit the data to client-side, non-commercial use unless a separate agreement is obtained.

## Repository policy

- Commit after each completed implementation phase.
- Keep the production deliverable self-contained.
- Keep `@updateUrl none`; releases are installed explicitly unless the user later approves a host-managed remote-update exception.
- Do not include remote executable code, analytics, or arbitrary third-party scripts.
- Do not commit generated plugin settings, logs, build output, or local test artifacts.
- Select and document the project's own license before public release.
