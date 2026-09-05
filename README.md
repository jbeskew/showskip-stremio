# ShowSkip

ShowSkip is a standalone Stremio Enhanced plugin for Windows. Phase 3 adds conservative manual/automatic segment-action machinery around the Phase 2 episode timeline. **Playback mutation is still disabled in the installed artifact by an internal release gate.** Per-series choices can be configured and saved, and provider-driven timeline regions remain active, but the production build does not seek, show action buttons, or advance episodes until a later packaged-validation/activation step.

This is an Enhanced UI/player plugin, not a normal Stremio addon. It does not modify Stremio Enhanced, Stremio Web, Stremio Service, or `server.js`.

## Project status

Phase 0 established the research and architecture baseline. Phase 1 provides the self-contained plugin, per-show configuration and storage, tests, and safe local install/uninstall scripts. Phase 1.1 added the high-contrast panel palette. Phase 2 added the provider-neutral episode timeline. Phase 3 advances the artifact to version `0.3.0` with a context-bound seek adapter, playback-session state machine, action renderer, and fail-closed next-episode boundary. The `state_v1` profile schema is unchanged.

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
- The Phase 3 code can implement `Auto`, `Button`, and `Off` semantics in controlled tests, but its production gate is false. The installed build therefore presents no skip/next buttons and performs no ShowSkip seek or transition.
- Timeline regions remain visible independently of both saved behavior and the Phase 3 gate.

## Target environment

Research currently targets:

- Windows
- Stremio Enhanced 1.2.0
- the Stremio Web UI served by `https://web.stremio.com/`
- TheIntroDB API v3

The provider/seek-bar baseline was pinned on 2026-08-20; current next-episode sources were rechecked on 2026-08-29 and the public trailer DOM on 2026-09-05. These upstream projects are active, so DOM and runtime assumptions must be revalidated for activation.

Phase 2 observation targets Enhanced's normal built-in HTML-media path. Phase 3 mutation additionally requires the gate, a `route+core` identity, exact route/episode/media tokens, the same active video/source/duration, a finite forward target in current seekable ranges, and bounded completion evidence. YouTube/trailer, cast, external MPV/VLC, shell/no-video, disconnected, retained-route, ambiguous, or route-only identity paths fail closed.

## Phase 3 safety gate

`ShowSkip.plugin.js` contains one production literal near its top:

```javascript
const PHASE3_PLAYBACK_ACTIONS_ENABLED = false;
```

It is not a setting and is never read from storage, the environment, DOM, URL, or network. The same false value is passed independently to the action coordinator, action renderer, `HtmlMediaAdapter`, and production `NextEpisodeAdapter`. Gate-off behavior does not modify or erase saved `Auto`/`Button`/`Off` or next-episode choices, and it does not disable Phase 1 configuration or Phase 2 requests/markers.

Later activation is a deliberate release procedure, not a normal preference:

1. Start a dedicated validation branch from this completed Phase 3 commit and confirm the installed gate-off artifact hash.
2. For a temporary local validation build, change only the literal above to `true`, rerun the complete suite/static audits, install the exact file, and perform the consolidated packaged checklist below. Do not distribute that temporary build.
3. Validate direct HTML-media seeking, native UI/resume bookkeeping, action-button placement, every lifecycle case, and failure behavior on real Enhanced streams.
4. Keep next-episode actions unavailable until a complete core-aware host transition driver has separately been implemented and proven; toggling the gate alone does not create one.
5. If all applicable checks pass, make a separate reviewed activation commit that intentionally changes the literal, rerun every check, reinstall, verify hashes, and record the exact Enhanced/Web/backend versions. Otherwise restore `false` and keep failing paths unavailable.

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

The dependency-free suite contains 83 tests. It preserves the Phase 1/1.1 UI/persistence and Phase 2 identity/provider/timeline regressions, then exercises gate-off and controlled gate-on behavior, seekable-range and completion checks, stale media rejection, natural entry, manual-seek suppression, ShowSkip-seek recognition, overlap arbitration, rearming, accessible one-button lifecycle, all saved modes, terminal-credit proof, unavailable/failing next actions, session replacement, and source-level security invariants. Browser-dependent checks inside packaged Stremio Enhanced remain deliberately deferred.

### Phase 3 runtime model

`HtmlMediaAdapter.seekToMs()` is the only production playback-position mutation path. It independently rechecks the gate, exact current action-context object, eligible active route, `route+core` episode identity, episode/media tokens, video reference, source, rounded duration, finite forward target, and current `TimeRanges`. A target may clamp only to a seekable edge within 500 ms. The adapter installs completion/invalidation listeners before its sole `video.currentTime` assignment, accepts only `seeked`/`timeupdate` evidence within 750 ms, and aborts or fails after a bounded 1.5 seconds.

Each exact episode/video/source/duration session tracks fired, pending, and blocked segment IDs; previous media and monotonic wall time; native and ShowSkip seeking; manual/ShowSkip suppression windows; next-action state; and the current context tokens. The first sample only seeds state. Natural entry requires an ordinary forward `timeupdate`, a plausible wall-time/playback-rate delta, active non-seeking playback, and crossing within the 1-second start grace while still away from the end. Starting/resuming inside, native seek events, inferred discontinuous jumps, pauses/long gaps, and ShowSkip's own completion cannot qualify.

Native/manual seeking starts 1.5 seconds of auto suppression but still permits a configured manual button after seeking finishes. A ShowSkip seek is marked before assignment, reserved single-flight, verified before becoming fired, and blocked until exit on failure. A fired region rearms only after a non-ShowSkip backward move of at least 10 seconds from near/past its end to at/before its start grace; a later natural traversal is still required. Small jitter never rearms it.

Overlaps remain separate provider segments and separate timeline markers. Only one action is selected: a valid next action first, otherwise the earliest segment end, then stable type order `recap → intro → credits → preview`, then ID. The same policy yields at most one context button. `Auto` acts only on natural entry, `Button` is exact current membership, and `Off` has no action; all three retain markers.

Current source research found no stable plugin-scoped compound next-episode API. Stremio Web's native handler performs both core `Player/NextVideo` bookkeeping and React-router navigation from validated `nextVideo.deepLinks`; raw dispatch is only half the transition. Enhanced's scoped plugin API exposes neither that compound action nor navigation, and the native DOM control has only private generated classes/localized title. Production `NextEpisodeAdapter` therefore has no availability reader or transition driver and always fails closed. Controlled tests inject a fake driver. `atCredits` requires natural credits entry, `afterCredits` additionally requires an actual ended event and terminal credits sentinel, `button` requires current credits plus verified availability, and `stremio`/`never` perform no ShowSkip action.

### Packaged Enhanced Phase 1 regression checklist

1. Run the installer, reload Enhanced with `Ctrl+R`, enable ShowSkip, and confirm it appears only once with no ShowSkip console error.
2. Open a never-seen series. Confirm one launcher and an open panel whose five row labels—**Recap**, **Intro**, **Credits / Outro**, **Preview**, and **Next Episode**—are all clearly visible. Confirm every selected and unselected option is comfortably readable, with Recap/Intro/Credits/Preview set to **Button** and Next Episode set to **Stremio default**.
3. Change one choice, close the panel, and confirm the entire panel disappears; only the launcher remains.
4. Navigate home and back to the same series. Confirm one launcher, no panel, then click the launcher and confirm the saved choice returns.
5. Open a different never-seen series. Confirm its panel opens with defaults and the first show's profile is unchanged.
6. Navigate show A → show B → home → show A → episode/player → show A. Confirm no duplicate launcher, stale panel, or UI on home/player routes.
7. Resize between desktop and a narrow window and trigger ordinary page remounts (for example, season/back navigation). Confirm the launcher remains aligned and unique and the panel stays usable.
8. Disable ShowSkip. If the current loader does not remove live UI immediately, press `Ctrl+R`; confirm all ShowSkip UI is then gone. Re-enable/reload and confirm exactly one instance returns with saved profiles intact.

### Consolidated deferred packaged Enhanced Phase 2 + Phase 3 checklist

Use a normal built-in series stream for a known episode with TheIntroDB data, such as *Breaking Bad* S1E1 (`tt0903747:1:1`). Keep DevTools Network and Elements open.

1. Record Enhanced, deployed Stremio Web, and streaming-backend versions; confirm the installed source hash matches the repository artifact.
2. With the production literal still `false`, confirm the intended series/episode route and title, then verify Phase 1 launcher/panel choices remain editable and persistent.
3. Filter Network for `api.theintrodb.org/v3/media`. Confirm one bounded anonymous request sequence for the stable media duration with the exact IMDb ID, season, episode, and integer `duration_ms`; only an eligible transient failure may cause the single retry.
4. Confirm every accepted recap, intro, credits, and preview range appears on the playback seek bar, including a type saved as **Off**. Confirm no marker attaches to volume, a retained route, or inactive controls.
5. Drag/click the native timeline across regions. Confirm markers do not obstruct native seeking and hover/keyboard focus exposes the right type and time range.
6. Hide/show controls and remount the control bar. Confirm markers reattach without duplicates or an unnecessary refetch. Move episode A → B and change streams; confirm A's request, cache entry, marker, and action state cannot affect B/new media.
7. Exit the route, reload/disable the plugin, and test trailer, cast, external-player, and no-video paths. Confirm owned markers/tooltips/action roots are removed and unsupported paths fail closed.
8. Still gate-off, walk through, resume in, and manually seek through every marked region. Confirm there is no ShowSkip `currentTime` write, skip/next button, automatic skip, or ShowSkip episode transition, while markers and saved choices remain intact.
9. On a dedicated temporary local validation branch only, set `PHASE3_PLAYBACK_ACTIONS_ENABLED` to `true`, rerun all automated/static/security checks, install the exact temporary artifact, and reconfirm its hash. Do not publish it.
10. For each segment type in **Button**, enter naturally and by manual seek. Confirm exactly one correctly labelled native `<button>` appears only inside the region, supports focus/Enter/Space, does not obstruct controls, invokes exactly one forward seek, and disappears on exit, click, remount, episode/media/source change, route exit, reload, and teardown.
11. For each segment type in **Auto**, begin before the region and cross its start naturally. Confirm one seek to the validated end, accurate native timeline/UI position, and correct resume/history bookkeeping. Confirm first load/resume inside, manual seek into/across, paused/long-gap observations, and boundary jitter do not auto-skip.
12. Confirm one action per traversal, no boundary loop, no overlap chain, and deterministic earliest-end/type/ID arbitration for recap+intro, credits+preview, and same-start duplicates while every marker/type stays distinct.
13. After one successful auto action, scrub less than 10 seconds backward and confirm it stays fired. Then seek at least 10 seconds backward from near/past the end to at/before its start grace, watch forward again, and confirm exactly one second-pass action.
14. During a pending seek, change route, episode, video, source, or duration and disconnect/remount the media. Confirm immediate cancellation, no late write/action, no stale button, and no retry hammer after failure, wrong position, timeout, or unseekable target.
15. Set each segment type to **Off** and confirm no skip action/button while its marker remains. Switch among shows and reconfirm each saved profile is respected without schema or value changes.
16. Confirm `nextEpisode: Stremio default` and `Never` cause no ShowSkip transition or button and do not interfere with native autoplay.
17. Do not enable `At credits`, `After credits`, or next-button transitions until a complete host driver is implemented. After that separate code exists, prove authoritative next availability and one validated compound transition; test missing next, unavailable/failed driver, stale context, and once-only behavior.
18. For that future driver, verify **At credits** triggers only on natural credits entry; **After credits** requires an actual `ended` event plus terminal `credits end_ms: null` normalized to the live duration; finite credits and terminal preview alone must do nothing; **Button** appears only during credits with proven availability.
19. Verify no raw `Player/NextVideo`-only dispatch, guessed route/deep link, title-only DOM click, synthetic `Shift+N`, or arbitrary keyboard event occurs in any mode.
20. If any direct-seek, native bookkeeping, placement, identity, lifecycle, or transition check fails, restore the literal to `false`, reinstall the gate-off artifact, verify its hash, and leave the failed capability unavailable.

No packaged Enhanced Phase 2 or Phase 3 playback validation is claimed by this repository. The committed and installed Phase 3 artifact intentionally remains gate-off.

## Segment data and attribution

The timestamp provider remains [TheIntroDB](https://theintrodb.org). ShowSkip sends only direct anonymous client-side GET requests to `https://api.theintrodb.org/v3/media`; it sends no API key or ShowSkip account data. Validated positive and explicit no-data results use a small exact-duration-aware in-memory session cache. Provider timestamps and response bodies are never written to `state_v1`, files, logs, or a persistent database, and the cache disappears on plugin teardown/reload.

TheIntroDB's [API reference](https://theintrodb.org/docs), [OpenAPI specification](https://theintrodb.org/openapi.yaml), and [terms](https://theintrodb.org/docs/terms) were rechecked on 2026-08-20. The reviewed terms limit timestamp use to client-side, non-commercial end-user applications unless a separate agreement is obtained, permit temporary session caching, and prohibit database reconstruction, persistence, mirroring, or redistribution. Attribution is requested rather than required by default; after at least one TheIntroDB marker actually renders for a show, the open per-show panel voluntarily shows “Timestamp data by TheIntroDB” using the exact `.com` destination named by the terms. This per-show fact is remembered only for the current plugin session, is not persisted, and is absent for shows whose data has never rendered a marker. Recheck the terms and their `.com`/official `.org` link discrepancy before release.

## Known Phase 3 limitations

- The current identity path requests TheIntroDB only for validated 7- or 8-digit IMDb series IDs. It never guesses that an arbitrary Stremio ID is TMDB/TVDB identity.
- Route identity is accepted only for the exact series-player shape and anchored `<series-id>:<positive-season>:<positive-episode>` video IDs, then revalidated against any available current Stremio core state. Contradictory or stale state fails closed.
- Only exactly one connected visible built-in HTML video is supported. YouTube/trailer, cast, external MPV/VLC, shell/no-video, missing source/duration, multiple-video, and disconnected/retained-route paths fail closed. Changed or ambiguous Stremio player/seek-slider structure likewise produces no guessed attachment.
- Phase 3 mutation is compiled but disabled. No real packaged Enhanced seek, button placement, resume/history propagation, or next transition is claimed yet.
- The production next adapter intentionally has no driver. A gate toggle alone enables controlled segment action paths but still cannot advance an episode; a separately verified compound host driver is required.
- Public Stremio Web trailer inspection on 2026-09-05 again showed three retained route containers, one active player/control/seek bar, two sliders, one iframe, and zero top-level videos, so the unsupported path correctly has no usable HTML-media target. A real built-in stream and local backend still require the consolidated packaged checklist.
- Provider coverage and community timestamps vary by episode and media cut. Exact rounded duration is part of each lookup/cache key, at most two distinct durations issue per media-source/context token, and validated results/attribution are session-only; ShowSkip does not fabricate missing data or render invalid ranges.

## Repository policy

- Commit after each completed implementation phase.
- Keep the production deliverable self-contained.
- Keep `@updateUrl none`; releases are installed explicitly unless the user later approves a host-managed remote-update exception.
- Do not include remote executable code, analytics, or arbitrary third-party scripts.
- Do not commit generated plugin settings, logs, build output, or local test artifacts.
- Select and document the project's own license before public release.
