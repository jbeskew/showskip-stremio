# ShowSkip

ShowSkip is a finished local Stremio Enhanced plugin for Windows. Version `1.0.0` adds per-series recap, intro, credits, and preview controls to Stremio's show and player pages. It retrieves validated timestamp data from TheIntroDB, displays behavior-independent timeline markers, and can offer a button or automatically seek past a segment.

This is an Enhanced UI/player plugin, not a normal Stremio addon. It does not modify Stremio Enhanced, Stremio Web, normal Stremio, Stremio Service, or `server.js`.

## Quick install (Windows)

You need Stremio Enhanced installed and opened at least once. ShowSkip needs no API key, account, or login: it only reads public timestamps from TheIntroDB.

1. Download this repo (green **Code** button, then **Download ZIP**, or use `git clone`).
2. Open PowerShell in the folder and run:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-local.ps1
   ```

   Or copy `ShowSkip.plugin.js` by hand into `%APPDATA%\stremio-enhanced\plugins\`.
3. In Stremio Enhanced press `Ctrl+R`, open **Settings → Enhanced → Plugins**, and enable **ShowSkip**.
4. Open any series. Click the ShowSkip button on the show page to choose **Auto**, **Button**, or **Off** for Recap, Intro, Credits, and Preview.

### Install with Claude Code

Paste this into Claude Code:

> Clone this repo, run `scripts/install-local.ps1`, then run `node --test tests/*.test.cjs` and tell me whether it passed. Afterwards remind me to press Ctrl+R in Stremio Enhanced and enable ShowSkip under Settings → Enhanced → Plugins.

### Update or remove

To update, pull or re-download the repo and run the install script again. To remove it, run `scripts\uninstall-local.ps1` (add `-RemoveSettings` to also delete saved preferences).

### Keep your keys out of the repo

There are no secrets in this repo and none are needed. Never commit debrid or API keys, `.env` files, or the generated `ShowSkip.plugin.json` settings file. `.gitignore` already blocks them.

## Features

- One ShowSkip launcher on supported series detail pages.
- Persistent per-show `Auto`, `Button`, and `Off` choices for Recap, Intro, Credits / Outro, and Preview.
- Timeline markers for every valid provider segment, including types configured as **Off**.
- One accessible context button in **Button** mode.
- Conservative once-per-pass seeking in **Auto** mode.
- Manual-seek and resume-inside-segment suppression, overlap arbitration, backward rearming, stale-context rejection, bounded seeking, and complete owned cleanup.
- Direct anonymous TheIntroDB requests with strict response validation, exact-duration session caching, bounded retry/timeout behavior, and no persisted provider data.

**Outro Next Episode button.** When a show's Credits / Outro is set to `Button` and Stremio reports a next episode, a `Next Episode` button appears directly above `Skip Credits` while the outro plays (never during recap, intro, or preview, and not with Credits set to `Auto`/`Off`). It starts the next episode on the same stream source: ShowSkip asks the same addon that served the current stream for the next episode's streams and picks the first one with the same `bingeGroup` (the rule Stremio itself uses for binge-watching). If no stream can be matched with confidence (no `bingeGroup`, no match, addon error), it opens that episode's stream list instead of guessing. Native Stremio autoplay and the Next popup are untouched. Existing `nextEpisode` values in `state_v1` are preserved but remain inert.

## Segment modes

- **Auto:** On a validated natural forward entry, seek once to the segment's validated end.
- **Button:** While playback is inside the segment, show one appropriately labelled skip button; activation uses the same validated seek path.
- **Off:** Perform no ShowSkip playback action. Valid timeline markers still render.

Recap, Intro, Credits / Outro, and Preview use the same behavior contract. Overlapping provider regions remain distinct markers, while action arbitration chooses at most one candidate by earliest end, stable type order, then ID. A substantial manual backward seek can rearm a previously fired region; small playback jitter cannot.

## Supported playback

ShowSkip targets Stremio Enhanced's normal built-in HTML-video path. Playback action requires all of the following:

- an eligible series episode route;
- episode identity confirmed by both route and current Stremio core state;
- exactly one connected visible video in the active player;
- unchanged route, episode, media, video, source, and rounded duration;
- a finite forward target inside the video's current seekable ranges;
- completion evidence within the bounded seek timeout.

Trailer/YouTube, casting, external MPV/VLC, shell/no-video, route-only identity, ambiguous media, stale routes, and invalid duration/source paths fail closed.

## Playback safety

The final local v1 artifact contains one internal production capability literal:

```javascript
const PHASE3_PLAYBACK_ACTIONS_ENABLED = true;
```

It is intentionally enabled for this final local release. It is not a setting and cannot be changed through storage, environment variables, the URL, DOM, or network data.

`HtmlMediaAdapter.seekToMs()` owns the only production playback-position assignment. Before writing, it revalidates the exact action context, active video, source, duration, forward distance, and `TimeRanges`. Completion must be observed through `seeked` or `timeupdate`; timeout, abort, replacement, invalidation, wrong position, or stale context fails closed. ShowSkip does not simulate progress-bar input or issue guessed core seek actions.

## Local installation

From the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-local.ps1
```

The script copies only `ShowSkip.plugin.js` to `%APPDATA%\stremio-enhanced\plugins\ShowSkip.plugin.js`. It may create the plugin directory and overwrite an earlier ShowSkip plugin file, but it does not touch other plugins, Stremio configuration, Stremio Service, or `server.js`.

After installation, reload Stremio Enhanced with `Ctrl+R`, open Settings → Enhanced → Plugins, and enable ShowSkip.

Enhanced stores ShowSkip preferences beside the plugin in `ShowSkip.plugin.json`. That generated settings file must not be committed.

### Local uninstallation

Remove only the installed plugin while preserving saved ShowSkip profiles:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-local.ps1
```

To explicitly remove ShowSkip's settings as well:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-local.ps1 -RemoveSettings
```

The uninstall script supports `-WhatIf`, uses exact non-recursive paths, and never removes the plugin directory or unrelated files.

## Verification

ShowSkip has no package dependency. Run:

```powershell
node --check .\ShowSkip.plugin.js
node --test .\tests\*.test.cjs
```

The suite covers per-show UI and persistence, strict panel collapse, route and identity checks, provider validation and network policy, cache/retry/abort behavior, seek-bar targeting, accessible markers, `Auto`/`Button`/`Off`, natural-entry inference, manual-seek suppression, ShowSkip-seek recognition, once-only behavior, rearming, overlap arbitration, stale action rejection, action-button lifecycle, teardown, final gate policy, and the absence of a production next-episode driver.

## Provider and privacy

Timestamp data comes from [TheIntroDB](https://theintrodb.org). ShowSkip sends only direct anonymous client-side GET requests to `https://api.theintrodb.org/v3/media`; it sends no API key or ShowSkip account data. For anime-style catalogs that number episodes without a season (for example Kitsu), it also makes one anonymous, credential-free HTTPS GET per show per session to the metadata addon you already use, only to read that addon's IMDb season/episode mapping; nothing from it is stored. Valid positive and explicit no-data responses use a small exact-duration-aware in-memory session cache. Response bodies and timestamps are never written to `state_v1`, files, logs, or a persistent database.

TheIntroDB's [API reference](https://theintrodb.org/docs), [OpenAPI specification](https://theintrodb.org/openapi.yaml), and [terms](https://theintrodb.org/docs/terms) were reviewed on 2026-08-20. The reviewed terms limit timestamp use to direct client-side non-commercial end-user applications unless separately agreed, permit temporary session caching, and prohibit database reconstruction, persistence, mirroring, or redistribution. After TheIntroDB data actually renders for a show, ShowSkip provides voluntary in-panel attribution for that session.

ShowSkip contains no telemetry, analytics, API-key collection, remote executable code, or remote assets. `@updateUrl none` keeps remote self-updates disabled.

## Troubleshooting missing markers

Markers need TheIntroDB data for the exact episode, so some shows (anime in particular) legitimately have none. To see why a context was skipped, run `localStorage.setItem("showskip.debug", "1")` in the app console (if your Stremio Enhanced build exposes one) and reload; ShowSkip then logs short reason codes such as `identity:no-provider-id`, `mapping:episode-missing`, or `provider:no-data`. The log never contains URLs, IDs, or titles and is off by default. Remove the key with `localStorage.removeItem("showskip.debug")`.

## Known limitation

The final local v1 release activates segment seeking based on the completed automated and controlled-harness coverage. Direct seeking was not manually validated inside packaged Stremio Enhanced before activation, so native progress, resume, history, and library bookkeeping retain accepted residual risk. The plugin's conservative context checks and fail-closed behavior limit that risk, but do not replace that missing runtime observation.

Provider coverage and timestamp accuracy vary by episode and media cut. ShowSkip does not fabricate missing regions. Unsupported playback implementations receive no ShowSkip actions.

## Project status

ShowSkip `1.0.0` is finalized as a local production plugin. The project is closed at this feature set: per-show segment rules, TheIntroDB timeline markers, and conservative segment skipping, with native Stremio next-episode behavior left untouched.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the pinned research record, component boundaries, validation contracts, historical phase records, and final v1 decision record.
