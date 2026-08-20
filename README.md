# ShowSkip

ShowSkip is a planned standalone Stremio Enhanced plugin for Windows. It provides independent playback rules for each TV series: recap, intro, credits, preview, and next-episode behavior.

This is an Enhanced UI/player plugin, not a normal Stremio addon. It does not modify Stremio Enhanced, Stremio Web, Stremio Service, or `server.js`.

## Project status

Phase 0 contains the completed research and architecture baseline. There is intentionally no production `.plugin.js` in this phase.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for pinned-source findings, the data and lifecycle design, DOM validation, risks, unresolved questions, and the exact Phase 1–4 plan.

## Planned user experience

- One small native-looking launcher in the action row on a series detail page.
- A per-show panel with `Auto`, `Button`, and `Off` rules for recap, intro, credits, and preview.
- Per-show next-episode choices.
- First visit to a show opens the panel; closing it removes the entire panel.
- When closed, the launcher is the only ShowSkip UI left on the series page.
- Segment regions remain visible on the seek bar even when skipping is Off.

## Target environment

Research currently targets:

- Windows
- Stremio Enhanced 1.2.0
- the Stremio Web UI served by `https://web.stremio.com/`
- TheIntroDB API v3

The pinned research date is 2026-08-20. These upstream projects are active, so DOM and runtime assumptions must be revalidated during each implementation phase.

The planned playback integration targets Enhanced's normal built-in HTML-media path. YouTube/cast paths and Enhanced's optional external MPV/VLC mode do not expose the required in-page clock, duration, seek bar, and seek control together, so ShowSkip will fail closed there unless a future constrained host API is verified.

## Local installation (once Phase 1 creates the artifact)

1. Copy `ShowSkip.plugin.js` to:

   ```text
   %APPDATA%\stremio-enhanced\plugins
   ```

2. Restart Stremio Enhanced or press `Ctrl+R`.
3. Open Settings → Enhanced → Plugins.
4. Enable ShowSkip.

Enhanced will store ShowSkip preferences beside the plugin in `ShowSkip.plugin.json`. Do not commit that generated file.

Enhanced does not remove that settings file when the plugin is uninstalled. Preserve it to keep per-show choices, or delete it manually only when intentionally resetting all ShowSkip profiles.

## Local development

Phase 0 has no build step or dependencies. The intended Phase 1 loop is:

1. Edit the standalone plugin source in this repository.
2. Copy it to the Enhanced plugin folder.
3. Reload Enhanced with `Ctrl+R`.
4. Use `Ctrl+Shift+I` for local DOM and console validation.
5. Work through the live validation matrix in `ARCHITECTURE.md`.

Do not test by editing Stremio Enhanced or Stremio source files. Keep all behavior self-contained in the plugin artifact.

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
