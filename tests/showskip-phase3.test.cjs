"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadHooks() {
    const source = fs.readFileSync(path.join(__dirname, "..", "ShowSkip.plugin.js"), "utf8");
    const context = vm.createContext({
        AbortController,
        TextDecoder,
        TextEncoder,
        Uint8Array,
        clearTimeout,
        console,
        setTimeout,
        __SHOWSKIP_TEST_MODE__: true,
    });
    vm.runInContext(source, context, { filename: "ShowSkip.plugin.js" });
    return context.__SHOWSKIP_TEST_HOOKS__;
}

const hooks = loadHooks();
const {
    HtmlMediaAdapter,
    NextEpisodeAdapter,
    PHASE3_PLAYBACK_ACTIONS_ENABLED,
    PLAYBACK_ACTION_LIMITS,
    PlaybackActionStateMachine,
    PlayerActionRenderer,
    TimelineRenderer,
} = hooks;

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

class FakeClock {
    constructor() {
        this.now = 0;
        this.nextId = 1;
        this.tasks = new Map();
    }
    setTimeout(callback, delay) {
        const id = this.nextId;
        this.nextId += 1;
        this.tasks.set(id, { at: this.now + delay, callback });
        return id;
    }
    clearTimeout(id) {
        this.tasks.delete(id);
    }
    tick(milliseconds) {
        const end = this.now + milliseconds;
        while (true) {
            const next = [...this.tasks.entries()]
                .filter(([, task]) => task.at <= end)
                .sort((first, second) => first[1].at - second[1].at || first[0] - second[0])[0];
            if (!next) {
                break;
            }
            this.tasks.delete(next[0]);
            this.now = next[1].at;
            next[1].callback();
        }
        this.now = end;
    }
}

class FakeVideo {
    constructor() {
        this.isConnected = true;
        this.duration = 100;
        this.readyState = 4;
        this.currentSrc = "https://stream.invalid/a";
        this.src = "";
        this.paused = false;
        this.seeking = false;
        this.ended = false;
        this.playbackRate = 1;
        this.seekable = {
            length: 1,
            start: () => 0,
            end: () => 100,
        };
        this.listeners = new Map();
        this.writes = 0;
        this._currentTime = 5;
        this.onWrite = null;
    }
    get currentTime() {
        return this._currentTime;
    }
    set currentTime(value) {
        this.writes += 1;
        if (this.onWrite) {
            this.onWrite(value);
        } else {
            this._currentTime = value;
        }
    }
    setObservedTime(seconds) {
        this._currentTime = seconds;
    }
    addEventListener(type, handler) {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, new Set());
        }
        this.listeners.get(type).add(handler);
    }
    removeEventListener(type, handler) {
        if (this.listeners.has(type)) {
            this.listeners.get(type).delete(handler);
        }
    }
    dispatch(type) {
        for (const handler of [...(this.listeners.get(type) || [])]) {
            handler({ type, target: this });
        }
    }
}

function seekHarness({ enabled = true, ranges = [[0, 100]], timeoutMs = 100 } = {}) {
    const clock = new FakeClock();
    const video = new FakeVideo();
    video.seekable = {
        length: ranges.length,
        start: (index) => ranges[index][0],
        end: (index) => ranges[index][1],
    };
    const context = Object.freeze({ source: video.currentSrc, durationMs: 100_000, episodeToken: 1, mediaToken: 1 });
    let liveContext = context;
    let activeVideo = video;
    const starts = [];
    const finishes = [];
    const adapter = new HtmlMediaAdapter({ setTimeout, clearTimeout }, video, {
        actionsEnabled: enabled,
        resolveActiveVideo: () => activeVideo,
        validateContext: (candidate) => candidate === liveContext,
        onShowSkipSeekStart: (_candidate, targetMs) => starts.push(targetMs),
        onShowSkipSeekFinish: (_candidate, result) => finishes.push(result),
        setTimeout: clock.setTimeout.bind(clock),
        clearTimeout: clock.clearTimeout.bind(clock),
        seekTimeoutMs: timeoutMs,
    });
    return {
        adapter,
        clock,
        context,
        finishes,
        starts,
        video,
        replaceVideo(replacement) { activeVideo = replacement; },
        stale() { liveContext = null; },
    };
}

test("production Phase 3 gate is a literal disabled capability", async () => {
    assert.equal(PHASE3_PLAYBACK_ACTIONS_ENABLED, false);
    const harness = seekHarness({ enabled: false });
    const result = await harness.adapter.seekToMs(20_000, harness.context, new AbortController().signal);
    assert.deepEqual(plain(result), { ok: false, reason: "gate-disabled", reachedMs: null });
    assert.equal(harness.video.writes, 0);
    assert.equal(harness.adapter.capabilities.canSeek, false);
});

test("enabled controlled adapter performs one validated seek and verifies seeked completion", async () => {
    const harness = seekHarness();
    harness.video.onWrite = (seconds) => {
        harness.video.setObservedTime(seconds);
        harness.video.dispatch("seeked");
    };
    const result = await harness.adapter.seekToMs(20_000, harness.context, new AbortController().signal);
    assert.deepEqual(plain(result), { ok: true, reason: "reached", reachedMs: 20_000 });
    assert.equal(harness.video.writes, 1);
    assert.deepEqual(harness.starts, [20_000]);
    assert.equal(harness.finishes.length, 1);
    assert.equal(harness.clock.tasks.size, 0);
});

test("adapter accepts bounded seekable-edge tolerance but rejects gaps and invalid targets", async () => {
    const edge = seekHarness({ ranges: [[10, 20]] });
    edge.video.onWrite = (seconds) => {
        edge.video.setObservedTime(seconds);
        edge.video.dispatch("timeupdate");
    };
    assert.equal((await edge.adapter.seekToMs(20_400, edge.context)).ok, true);
    assert.equal(edge.video.currentTime, 20);

    for (const target of [4_000, 30_000, Number.NaN, Number.POSITIVE_INFINITY, -1, 100_001]) {
        const rejected = seekHarness({ ranges: [[0, 10], [40, 100]] });
        const result = await rejected.adapter.seekToMs(target, rejected.context);
        assert.equal(result.ok, false, String(target));
        assert.equal(rejected.video.writes, 0, String(target));
    }
});

test("adapter refuses stale episode/media proof, changed source, replacement, disconnect, and invalid duration", async () => {
    const stale = seekHarness();
    stale.stale();
    assert.equal((await stale.adapter.seekToMs(20_000, stale.context)).reason, "stale-context");

    const replaced = seekHarness();
    replaced.replaceVideo(new FakeVideo());
    assert.equal((await replaced.adapter.seekToMs(20_000, replaced.context)).reason, "stale-context");

    const disconnected = seekHarness();
    disconnected.video.isConnected = false;
    assert.equal((await disconnected.adapter.seekToMs(20_000, disconnected.context)).reason, "stale-context");

    const duration = seekHarness();
    duration.video.duration = Number.NaN;
    assert.equal((await duration.adapter.seekToMs(20_000, duration.context)).reason, "invalid-media");

    const source = seekHarness();
    source.video.onWrite = (seconds) => source.video.setObservedTime(seconds);
    const pending = source.adapter.seekToMs(20_000, source.context);
    source.video.currentSrc = "https://stream.invalid/b";
    source.video.dispatch("timeupdate");
    assert.equal((await pending).reason, "stale-media");

    for (const eventType of ["loadstart", "emptied", "durationchange"]) {
        const invalidated = seekHarness();
        invalidated.video.onWrite = (seconds) => invalidated.video.setObservedTime(seconds);
        const invalidatedPending = invalidated.adapter.seekToMs(20_000, invalidated.context);
        invalidated.video.dispatch(eventType);
        assert.equal((await invalidatedPending).reason, "media-invalidated", eventType);
    }
});

test("adapter bounds timeout, abort, wrong-position, destroy, and concurrent seeks", async () => {
    const timed = seekHarness();
    timed.video.onWrite = (seconds) => timed.video.setObservedTime(seconds);
    const timeout = timed.adapter.seekToMs(20_000, timed.context);
    timed.clock.tick(100);
    assert.equal((await timeout).reason, "timeout");

    const wrong = seekHarness();
    wrong.video.onWrite = () => wrong.video.dispatch("seeked");
    assert.equal((await wrong.adapter.seekToMs(20_000, wrong.context)).reason, "position-mismatch");

    const aborted = seekHarness();
    aborted.video.onWrite = (seconds) => aborted.video.setObservedTime(seconds);
    const controller = new AbortController();
    const abortPending = aborted.adapter.seekToMs(20_000, aborted.context, controller.signal);
    controller.abort();
    assert.equal((await abortPending).reason, "aborted");

    const destroyed = seekHarness();
    destroyed.video.onWrite = (seconds) => destroyed.video.setObservedTime(seconds);
    const destroyPending = destroyed.adapter.seekToMs(20_000, destroyed.context);
    assert.equal((await destroyed.adapter.seekToMs(30_000, destroyed.context)).reason, "seek-pending");
    destroyed.adapter.destroy();
    assert.equal((await destroyPending).reason, "adapter-destroyed");
});

function segment(type, startMs, endMs, suffix = "", extra = {}) {
    return { id: `${type}:${startMs}:${endMs}${suffix}`, type, startMs, endMs, ...extra };
}

function profile(overrides = {}) {
    return {
        recap: "none",
        intro: "none",
        credits: "none",
        preview: "none",
        nextEpisode: "stremio",
        ...overrides,
    };
}

function observe(machine, {
    positionMs,
    nowMs,
    segments,
    currentProfile,
    eventType = "timeupdate",
    durationMs = 100_000,
    nextAvailable = false,
    paused = false,
    seeking = false,
    ended = false,
    playbackRate = 1,
    sessionKey = "episode-a|media-a|source-a",
}) {
    return machine.observe({
        sessionKey,
        eventType,
        positionMs,
        durationMs,
        nowMs,
        segments,
        profile: currentProfile,
        nextAvailable,
        paused,
        seeking,
        ended,
        playbackRate,
    });
}

test("natural entry seeds first, fires on plausible forward crossing, and respects per-show mode", () => {
    const intro = segment("intro", 10_000, 20_000);
    const machine = new PlaybackActionStateMachine({ actionsEnabled: true });
    assert.equal(observe(machine, { positionMs: 9_000, nowMs: 0, segments: [intro], currentProfile: profile({ intro: "auto" }) }).automaticAction, null);
    const crossed = observe(machine, { positionMs: 10_100, nowMs: 1_000, segments: [intro], currentProfile: profile({ intro: "auto" }) });
    assert.equal(crossed.naturalForward, true);
    assert.equal(crossed.automaticAction.segmentId, intro.id);
    assert.equal(crossed.automaticAction.targetMs, 20_000);

    for (const mode of ["button", "none"]) {
        const other = new PlaybackActionStateMachine({ actionsEnabled: true });
        observe(other, { positionMs: 9_000, nowMs: 0, segments: [intro], currentProfile: profile({ intro: mode }) });
        assert.equal(observe(other, { positionMs: 10_100, nowMs: 1_000, segments: [intro], currentProfile: profile({ intro: mode }) }).automaticAction, null);
    }
});

test("starting/resuming inside and manual seeks into or across a segment never auto-fire", () => {
    const intro = segment("intro", 10_000, 30_000);
    const settings = profile({ intro: "auto" });

    const resumed = new PlaybackActionStateMachine({ actionsEnabled: true });
    observe(resumed, { positionMs: 15_000, nowMs: 0, segments: [intro], currentProfile: settings, eventType: "play" });
    assert.equal(observe(resumed, { positionMs: 16_000, nowMs: 1_000, segments: [intro], currentProfile: settings }).automaticAction, null);

    const soughtInside = new PlaybackActionStateMachine({ actionsEnabled: true });
    observe(soughtInside, { positionMs: 5_000, nowMs: 0, segments: [intro], currentProfile: settings });
    observe(soughtInside, { positionMs: 15_000, nowMs: 100, segments: [intro], currentProfile: settings, eventType: "seeking", seeking: true });
    observe(soughtInside, { positionMs: 15_000, nowMs: 200, segments: [intro], currentProfile: settings, eventType: "seeked" });
    assert.equal(observe(soughtInside, { positionMs: 16_000, nowMs: 2_000, segments: [intro], currentProfile: settings }).automaticAction, null);

    const jumpedAcross = new PlaybackActionStateMachine({ actionsEnabled: true });
    observe(jumpedAcross, { positionMs: 9_000, nowMs: 0, segments: [intro], currentProfile: settings });
    const jump = observe(jumpedAcross, { positionMs: 31_000, nowMs: 500, segments: [intro], currentProfile: settings });
    assert.equal(jump.naturalForward, false);
    assert.equal(jump.automaticAction, null);
});

test("zero-start playback works only from the opening grace and long gaps/paused/seeking samples fail closed", () => {
    const recap = segment("recap", 0, 20_000);
    const settings = profile({ recap: "auto" });
    const opening = new PlaybackActionStateMachine({ actionsEnabled: true });
    observe(opening, { positionMs: 200, nowMs: 0, segments: [recap], currentProfile: settings });
    assert.equal(observe(opening, { positionMs: 1_000, nowMs: 800, segments: [recap], currentProfile: settings }).automaticAction.segmentId, recap.id);

    for (const variant of [
        { positionMs: 13_000, nowMs: 1_000 },
        { positionMs: 10_100, nowMs: 4_000 },
        { positionMs: 10_100, nowMs: 1_000, paused: true },
        { positionMs: 10_100, nowMs: 1_000, seeking: true },
    ]) {
        const machine = new PlaybackActionStateMachine({ actionsEnabled: true });
        const intro = segment("intro", 10_000, 20_000);
        observe(machine, { positionMs: variant.positionMs === 13_000 ? 12_000 : 9_000, nowMs: 0, segments: [intro], currentProfile: profile({ intro: "auto" }) });
        assert.equal(observe(machine, { ...variant, segments: [intro], currentProfile: profile({ intro: "auto" }) }).automaticAction, null);
    }
});

test("ShowSkip-originated seek is recognized, fires once, and does not loop or look like a user seek", () => {
    const intro = segment("intro", 10_000, 30_000);
    const settings = profile({ intro: "auto" });
    const machine = new PlaybackActionStateMachine({ actionsEnabled: true });
    observe(machine, { positionMs: 9_000, nowMs: 0, segments: [intro], currentProfile: settings });
    const action = observe(machine, { positionMs: 10_100, nowMs: 1_000, segments: [intro], currentProfile: settings }).automaticAction;
    assert.equal(machine.reserve(action), true);
    machine.beginShowSkipSeek(action, 30_000);
    observe(machine, { positionMs: 30_000, nowMs: 1_050, segments: [intro], currentProfile: settings, eventType: "seeked" });
    assert.equal(machine.debugState().suppressUntilWallMs, 0);
    machine.complete(action, true, 1_050);
    assert.deepEqual(plain(machine.debugState().firedSegmentIds), [intro.id]);
    assert.equal(observe(machine, { positionMs: 30_100, nowMs: 1_200, segments: [intro], currentProfile: settings }).automaticAction, null);
    assert.equal(machine.reserve(action), false);
});

test("substantial user backward seek rearms one segment; tiny jitter does not", () => {
    const intro = segment("intro", 10_000, 30_000);
    const settings = profile({ intro: "auto" });
    const machine = new PlaybackActionStateMachine({ actionsEnabled: true });
    observe(machine, { positionMs: 9_000, nowMs: 0, segments: [intro], currentProfile: settings });
    const first = observe(machine, { positionMs: 10_100, nowMs: 1_000, segments: [intro], currentProfile: settings }).automaticAction;
    machine.reserve(first);
    machine.beginShowSkipSeek(first, 30_000);
    observe(machine, { positionMs: 30_000, nowMs: 1_050, segments: [intro], currentProfile: settings, eventType: "seeked" });
    machine.complete(first, true, 1_050);

    observe(machine, { positionMs: 29_800, nowMs: 1_200, segments: [intro], currentProfile: settings });
    assert.deepEqual(plain(machine.debugState().firedSegmentIds), [intro.id]);
    observe(machine, { positionMs: 5_000, nowMs: 1_300, segments: [intro], currentProfile: settings, eventType: "seeked" });
    assert.deepEqual(plain(machine.debugState().firedSegmentIds), []);
    observe(machine, { positionMs: 6_000, nowMs: 3_000, segments: [intro], currentProfile: settings });
    observe(machine, { positionMs: 7_000, nowMs: 4_000, segments: [intro], currentProfile: settings });
    observe(machine, { positionMs: 8_000, nowMs: 5_000, segments: [intro], currentProfile: settings });
    const second = observe(machine, { positionMs: 9_000, nowMs: 6_000, segments: [intro], currentProfile: settings });
    assert.equal(second.automaticAction.segmentId, intro.id);
    assert.equal(PLAYBACK_ACTION_LIMITS.backwardRearmMs, 10_000);
});

test("overlap arbitration is deterministic, single-flight, and retains type identity", () => {
    const recap = segment("recap", 10_000, 18_000);
    const intro = segment("intro", 10_000, 20_000);
    const machine = new PlaybackActionStateMachine({ actionsEnabled: true });
    const settings = profile({ recap: "auto", intro: "auto" });
    observe(machine, { positionMs: 9_000, nowMs: 0, segments: [intro, recap], currentProfile: settings });
    const selected = observe(machine, { positionMs: 10_100, nowMs: 1_000, segments: [intro, recap], currentProfile: settings }).automaticAction;
    assert.equal(selected.segmentId, recap.id);
    assert.equal(selected.segmentType, "recap");
    assert.equal(machine.reserve(selected), true);
    assert.equal(machine.reserve({ kind: "segment", segmentId: intro.id }), false);

    const tiedRecap = segment("recap", 10_000, 20_000, ":b");
    const tiedIntro = segment("intro", 10_000, 20_000, ":a");
    const tie = new PlaybackActionStateMachine({ actionsEnabled: true });
    observe(tie, { positionMs: 9_000, nowMs: 0, segments: [tiedIntro, tiedRecap], currentProfile: settings });
    assert.equal(observe(tie, { positionMs: 10_100, nowMs: 1_000, segments: [tiedIntro, tiedRecap], currentProfile: settings }).automaticAction.segmentType, "recap");

    const credits = segment("credits", 80_000, 90_000);
    const preview = segment("preview", 80_000, 95_000);
    const late = new PlaybackActionStateMachine({ actionsEnabled: true });
    observe(late, { positionMs: 79_000, nowMs: 0, segments: [preview, credits], currentProfile: profile({ credits: "auto", preview: "auto" }) });
    assert.equal(observe(late, { positionMs: 80_100, nowMs: 1_000, segments: [preview, credits], currentProfile: profile({ credits: "auto", preview: "auto" }) }).automaticAction.segmentType, "credits");
});

test("button mode is membership-based after manual seek, while gate/off suppress it", () => {
    const intro = segment("intro", 10_000, 30_000);
    const enabled = new PlaybackActionStateMachine({ actionsEnabled: true });
    observe(enabled, { positionMs: 5_000, nowMs: 0, segments: [intro], currentProfile: profile({ intro: "button" }) });
    observe(enabled, { positionMs: 15_000, nowMs: 100, segments: [intro], currentProfile: profile({ intro: "button" }), eventType: "seeking", seeking: true });
    observe(enabled, { positionMs: 15_000, nowMs: 200, segments: [intro], currentProfile: profile({ intro: "button" }), eventType: "seeked" });
    const inside = observe(enabled, { positionMs: 15_100, nowMs: 300, segments: [intro], currentProfile: profile({ intro: "button" }) });
    assert.equal(inside.automaticAction, null);
    assert.equal(inside.buttonAction.label, "Skip Intro");
    assert.equal(observe(enabled, { positionMs: 31_000, nowMs: 400, segments: [intro], currentProfile: profile({ intro: "button" }) }).buttonAction, null);
    assert.equal(observe(new PlaybackActionStateMachine({ actionsEnabled: false }), { positionMs: 15_000, nowMs: 0, segments: [intro], currentProfile: profile({ intro: "button" }) }).buttonAction, null);
    assert.equal(observe(new PlaybackActionStateMachine({ actionsEnabled: true }), { positionMs: 15_000, nowMs: 0, segments: [intro], currentProfile: profile({ intro: "none" }) }).buttonAction, null);
});

test("next stremio/never do nothing; atCredits requires natural entry and verified availability once", () => {
    const credits = segment("credits", 80_000, 100_000, "", { endsAtMediaEnd: true });
    for (const mode of ["stremio", "never"]) {
        const machine = new PlaybackActionStateMachine({ actionsEnabled: true });
        observe(machine, { positionMs: 79_000, nowMs: 0, segments: [credits], currentProfile: profile({ nextEpisode: mode }) });
        assert.equal(observe(machine, { positionMs: 80_100, nowMs: 1_000, segments: [credits], currentProfile: profile({ nextEpisode: mode }), nextAvailable: true }).automaticAction, null);
    }

    const unavailable = new PlaybackActionStateMachine({ actionsEnabled: true });
    observe(unavailable, { positionMs: 79_000, nowMs: 0, segments: [credits], currentProfile: profile({ nextEpisode: "atCredits" }) });
    assert.equal(observe(unavailable, { positionMs: 80_100, nowMs: 1_000, segments: [credits], currentProfile: profile({ nextEpisode: "atCredits" }) }).automaticAction, null);

    const machine = new PlaybackActionStateMachine({ actionsEnabled: true });
    observe(machine, { positionMs: 79_000, nowMs: 0, segments: [credits], currentProfile: profile({ nextEpisode: "atCredits" }) });
    const action = observe(machine, { positionMs: 80_100, nowMs: 1_000, segments: [credits], currentProfile: profile({ nextEpisode: "atCredits" }), nextAvailable: true }).automaticAction;
    assert.equal(action.kind, "next");
    assert.equal(action.mode, "atCredits");
    assert.equal(machine.reserve(action), true);
    machine.complete(action, true, 1_000);
    assert.equal(machine.debugState().nextFired, true);
    assert.equal(machine.reserve(action), false);
});

test("manual credits seek is suppressed and afterCredits requires ended plus terminal credits proof", () => {
    const finite = segment("credits", 80_000, 95_000, ":finite", { endsAtMediaEnd: false });
    const terminal = segment("credits", 80_000, 100_000, ":terminal", { endsAtMediaEnd: true });
    const preview = segment("preview", 90_000, 100_000, ":terminal", { endsAtMediaEnd: true });

    const manual = new PlaybackActionStateMachine({ actionsEnabled: true });
    observe(manual, { positionMs: 70_000, nowMs: 0, segments: [terminal], currentProfile: profile({ nextEpisode: "atCredits" }) });
    observe(manual, { positionMs: 85_000, nowMs: 100, segments: [terminal], currentProfile: profile({ nextEpisode: "atCredits" }), nextAvailable: true, eventType: "seeked" });
    assert.equal(observe(manual, { positionMs: 86_000, nowMs: 2_000, segments: [terminal], currentProfile: profile({ nextEpisode: "atCredits" }), nextAvailable: true }).automaticAction, null);

    for (const regions of [[finite], [preview]]) {
        const machine = new PlaybackActionStateMachine({ actionsEnabled: true });
        observe(machine, { positionMs: 98_000, nowMs: 0, segments: regions, currentProfile: profile({ nextEpisode: "afterCredits" }), nextAvailable: true });
        observe(machine, { positionMs: 99_000, nowMs: 1_000, segments: regions, currentProfile: profile({ nextEpisode: "afterCredits" }), nextAvailable: true });
        assert.equal(observe(machine, { positionMs: 100_000, nowMs: 1_500, segments: regions, currentProfile: profile({ nextEpisode: "afterCredits" }), nextAvailable: true, eventType: "ended", ended: true }).automaticAction, null);
    }

    const proven = new PlaybackActionStateMachine({ actionsEnabled: true });
    observe(proven, { positionMs: 98_000, nowMs: 0, segments: [terminal], currentProfile: profile({ nextEpisode: "afterCredits" }), nextAvailable: true });
    observe(proven, { positionMs: 99_000, nowMs: 1_000, segments: [terminal], currentProfile: profile({ nextEpisode: "afterCredits" }), nextAvailable: true });
    const ended = observe(proven, { positionMs: 100_000, nowMs: 1_500, segments: [terminal], currentProfile: profile({ nextEpisode: "afterCredits" }), nextAvailable: true, eventType: "ended", ended: true });
    assert.equal(ended.automaticAction.mode, "afterCredits");
});

test("next button requires credits, availability, mechanism gate, and failure blocks repeat", () => {
    const credits = segment("credits", 80_000, 95_000);
    const machine = new PlaybackActionStateMachine({ actionsEnabled: true });
    const button = observe(machine, { positionMs: 85_000, nowMs: 0, segments: [credits], currentProfile: profile({ nextEpisode: "button" }), nextAvailable: true }).buttonAction;
    assert.equal(button.kind, "next");
    assert.equal(button.label, "Next Episode");
    assert.equal(machine.reserve(button), true);
    machine.complete(button, false, 0);
    assert.equal(observe(machine, { positionMs: 85_100, nowMs: 100, segments: [credits], currentProfile: profile({ nextEpisode: "button" }), nextAvailable: true }).buttonAction, null);
    assert.equal(observe(new PlaybackActionStateMachine({ actionsEnabled: true }), { positionMs: 85_000, nowMs: 0, segments: [credits], currentProfile: profile({ nextEpisode: "button" }), nextAvailable: false }).buttonAction, null);
});

test("NextEpisodeAdapter is unavailable in production shape and controlled transitions revalidate", async () => {
    const context = Object.freeze({ episodeToken: 1 });
    const unavailable = new NextEpisodeAdapter({ actionsEnabled: false });
    assert.deepEqual(plain(unavailable.getAvailability(context)), { known: false, available: false, reason: "gate-disabled" });
    assert.equal((await unavailable.advance(context)).reason, "gate-disabled");

    let live = true;
    let transitions = 0;
    const controlled = new NextEpisodeAdapter({
        actionsEnabled: true,
        validateContext: (candidate) => live && candidate === context,
        readAvailability: () => ({ known: true, available: true }),
        transition: async () => { transitions += 1; return true; },
    });
    assert.equal(controlled.getAvailability(context).available, true);
    assert.equal((await controlled.advance(context)).ok, true);
    assert.equal(transitions, 1);
    live = false;
    assert.equal((await controlled.advance(context)).reason, "mechanism-unavailable");

    let finishTransition;
    live = true;
    const staleDuringTransition = new NextEpisodeAdapter({
        actionsEnabled: true,
        validateContext: (candidate) => live && candidate === context,
        readAvailability: () => ({ known: true, available: true }),
        transition: () => new Promise((resolve) => { finishTransition = resolve; }),
    });
    const pendingTransition = staleDuringTransition.advance(context);
    live = false;
    finishTransition(true);
    assert.equal((await pendingTransition).reason, "stale-context");

    const failed = new NextEpisodeAdapter({
        actionsEnabled: true,
        validateContext: () => true,
        readAvailability: () => ({ known: true, available: true }),
        transition: async () => false,
    });
    assert.equal((await failed.advance(context)).reason, "transition-failed");
});

class FakeClassList {
    constructor(tokens = []) { this.tokens = tokens; }
    contains(value) { return this.tokens.includes(value); }
    [Symbol.iterator]() { return this.tokens[Symbol.iterator](); }
}

class FakeElement {
    constructor(tagName = "div", classes = []) {
        this.tagName = tagName.toUpperCase();
        this.classList = new FakeClassList(classes);
        this.children = [];
        this.parentNode = null;
        this.parentElement = null;
        this.attributes = Object.create(null);
        this.listeners = new Map();
        this.isConnected = true;
        this.style = Object.create(null);
        this.textContent = "";
        this.disabled = false;
    }
    get lastElementChild() { return this.children[this.children.length - 1] || null; }
    get nextSibling() {
        if (!this.parentNode) return null;
        return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null;
    }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    appendChild(node) {
        if (node.parentNode) node.remove();
        this.children.push(node);
        node.parentNode = this;
        node.parentElement = this;
        node._setConnected(this.isConnected);
        return node;
    }
    insertBefore(node, reference) {
        if (node.parentNode) node.remove();
        const index = reference === null ? this.children.length : this.children.indexOf(reference);
        this.children.splice(index, 0, node);
        node.parentNode = this;
        node.parentElement = this;
        node._setConnected(this.isConnected);
        return node;
    }
    remove() {
        if (this.parentNode) {
            const index = this.parentNode.children.indexOf(this);
            if (index >= 0) this.parentNode.children.splice(index, 1);
        }
        this.parentNode = null;
        this.parentElement = null;
        this._setConnected(false);
    }
    _setConnected(value) {
        this.isConnected = value;
        for (const child of this.children) child._setConnected(value);
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); }
    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(handler);
    }
    removeEventListener(type, handler) { if (this.listeners.has(type)) this.listeners.get(type).delete(handler); }
    dispatch(type) { for (const handler of [...(this.listeners.get(type) || [])]) handler({ type, target: this }); }
    querySelectorAll(selector) {
        const found = [];
        const classContains = /^\[class\*="(.+)"\]$/u.exec(selector);
        const attribute = /^\[([^\]=]+)(?:="([^"]*)")?\]$/u.exec(selector);
        const visit = (node) => {
            for (const child of node.children) {
                const matches = selector === "[class]"
                    ? child.classList.tokens.length > 0
                    : classContains
                        ? child.classList.tokens.some((token) => token.includes(classContains[1]))
                        : attribute
                            ? child.hasAttribute(attribute[1])
                                && (attribute[2] === undefined || child.getAttribute(attribute[1]) === attribute[2])
                            : false;
                if (matches) found.push(child);
                visit(child);
            }
        };
        visit(this);
        return found;
    }
}

function nativeSlider() {
    const slider = new FakeElement("div", ["slider-container-test"]);
    for (const kind of ["track", "track-before", "track-after", "thumb"]) {
        const layer = new FakeElement("div", ["layer-test"]);
        layer.append(new FakeElement("div", [`${kind}-test`]));
        slider.append(layer);
    }
    return slider;
}

function playerDom() {
    const router = new FakeElement("div", ["routes-container"]);
    const route = new FakeElement("div", ["route-container"]);
    const content = new FakeElement("div", ["route-content"]);
    const player = new FakeElement("div", ["player-container-test"]);
    const control = new FakeElement("div", ["control-bar-container-test"]);
    const seek = new FakeElement("div", ["seek-bar-container-test"]);
    const slider = nativeSlider();
    seek.append(slider);
    control.append(seek);
    player.append(control);
    content.append(player);
    route.append(content);
    router.append(route);
    const documentObject = {
        createElement: (tagName) => new FakeElement(tagName),
        querySelectorAll(selector) {
            return selector === ".routes-container" ? [router] : router.querySelectorAll(selector);
        },
    };
    return { content, control, documentObject, player, router, seek, slider };
}

test("PlayerActionRenderer owns one accessible native button and stale controls cannot act", async () => {
    const fixture = playerDom();
    const marker = new FakeElement("span");
    marker.setAttribute("data-showskip-timeline-marker", "");
    fixture.slider.append(marker);
    let calls = 0;
    let live = true;
    const renderer = new PlayerActionRenderer(fixture.documentObject, { actionsEnabled: true });
    const action = { kind: "segment", mode: "button", id: "intro:1", segmentType: "intro", label: "Skip Intro" };
    assert.equal(renderer.render(action, "context-a", async () => { calls += 1; }, () => live), true);
    const firstRoot = renderer.root;
    const firstButton = renderer.button;
    assert.equal(firstButton.tagName, "BUTTON");
    assert.equal(firstButton.getAttribute("type"), "button");
    assert.equal(firstButton.getAttribute("aria-label"), "Skip Intro");
    assert.equal(firstButton.textContent, "Skip Intro");
    assert.equal(firstRoot.parentNode, fixture.player);
    assert.equal(fixture.documentObject.querySelectorAll("[data-showskip-playback-action-root]").length, 1);
    assert.equal(renderer.render(action, "context-a", async () => { calls += 1; }, () => live), true);
    assert.equal(renderer.root, firstRoot);
    firstButton.dispatch("click");
    firstButton.dispatch("click");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(fixture.documentObject.querySelectorAll("[data-showskip-playback-action-root]").length, 0);
    assert.equal(fixture.documentObject.querySelectorAll("[data-showskip-timeline-marker]").length, 1);
    firstButton.dispatch("click");
    assert.equal(calls, 1);

    renderer.render(action, "context-b", async () => { calls += 1; }, () => live);
    const staleButton = renderer.button;
    live = false;
    staleButton.dispatch("click");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    renderer.destroy();
    assert.equal(fixture.documentObject.querySelectorAll("[data-showskip-playback-action-root]").length, 0);
});

test("renderer suppresses every real control while gate is disabled and cleans duplicate/remounted roots", () => {
    const fixture = playerDom();
    const disabled = new PlayerActionRenderer(fixture.documentObject, { actionsEnabled: false });
    assert.equal(disabled.render({ kind: "next", mode: "button", id: "next", label: "Next Episode" }, "a", () => undefined, () => true), false);
    assert.equal(fixture.documentObject.querySelectorAll("[data-showskip-playback-action-root]").length, 0);

    const stale = new FakeElement("div");
    stale.setAttribute("data-showskip-playback-action-root", "");
    fixture.player.append(stale);
    const enabled = new PlayerActionRenderer(fixture.documentObject, { actionsEnabled: true });
    enabled.render({ kind: "next", mode: "button", id: "next", label: "Next Episode" }, "a", () => undefined, () => true);
    assert.equal(stale.isConnected, false);
    assert.equal(fixture.documentObject.querySelectorAll("[data-showskip-playback-action-root]").length, 1);
    fixture.player.remove();
    enabled.clear();
    assert.equal(enabled.root, null);
});

test("action renderer survives a control remount and moves cleanly to one replacement player", () => {
    const fixture = playerDom();
    const renderer = new PlayerActionRenderer(fixture.documentObject, { actionsEnabled: true });
    const action = { kind: "segment", mode: "button", id: "intro:1", segmentType: "intro", label: "Skip Intro" };
    renderer.render(action, "context-a", () => undefined, () => true);
    const originalRoot = renderer.root;

    fixture.control.remove();
    const replacementControl = new FakeElement("div", ["control-bar-container-remount"]);
    const replacementSeek = new FakeElement("div", ["seek-bar-container-remount"]);
    replacementSeek.append(nativeSlider());
    replacementControl.append(replacementSeek);
    fixture.player.append(replacementControl);
    assert.equal(renderer.render(action, "context-a", () => undefined, () => true), true);
    assert.equal(renderer.root, originalRoot);
    assert.equal(renderer.root.parentNode, fixture.player);
    assert.equal(fixture.documentObject.querySelectorAll("[data-showskip-playback-action-root]").length, 1);

    const staleButton = renderer.button;
    fixture.player.remove();
    const replacementPlayer = new FakeElement("div", ["player-container-replacement"]);
    const nextControl = new FakeElement("div", ["control-bar-container-replacement"]);
    const nextSeek = new FakeElement("div", ["seek-bar-container-replacement"]);
    nextSeek.append(nativeSlider());
    nextControl.append(nextSeek);
    replacementPlayer.append(nextControl);
    fixture.content.append(replacementPlayer);
    assert.equal(renderer.render(action, "context-a", () => undefined, () => true), true);
    assert.equal(originalRoot.isConnected, false);
    assert.equal(renderer.root.parentNode, replacementPlayer);
    assert.equal(fixture.documentObject.querySelectorAll("[data-showskip-playback-action-root]").length, 1);
    staleButton.dispatch("click");
    renderer.destroy();
});

test("Phase 2 marker rendering remains behavior-independent with Phase 3 compiled gate-off", () => {
    const fixture = playerDom();
    const renderer = new TimelineRenderer(fixture.documentObject);
    const bundle = { segments: [segment("intro", 10_000, 20_000)] };
    assert.equal(renderer.render(bundle, 100_000, "episode-a"), 1);
    assert.equal(fixture.documentObject.querySelectorAll("[data-showskip-timeline-marker]").length, 1);
    const actions = new PlaybackActionStateMachine({ actionsEnabled: PHASE3_PLAYBACK_ACTIONS_ENABLED });
    assert.equal(observe(actions, { positionMs: 15_000, nowMs: 0, segments: bundle.segments, currentProfile: profile({ intro: "button" }) }).buttonAction, null);
    assert.equal(fixture.documentObject.querySelectorAll("[data-showskip-timeline-marker]").length, 1);
});

test("session replacement and teardown clear fired, pending, seeking, and next state", () => {
    const intro = segment("intro", 10_000, 30_000);
    const machine = new PlaybackActionStateMachine({ actionsEnabled: true });
    observe(machine, { positionMs: 9_000, nowMs: 0, segments: [intro], currentProfile: profile({ intro: "auto" }) });
    const action = observe(machine, { positionMs: 10_100, nowMs: 1_000, segments: [intro], currentProfile: profile({ intro: "auto" }) }).automaticAction;
    machine.reserve(action);
    machine.beginShowSkipSeek(action, 30_000);
    assert.equal(machine.debugState().pendingSegmentIds.length, 1);
    observe(machine, { positionMs: 0, nowMs: 2_000, segments: [intro], currentProfile: profile({ intro: "auto" }), sessionKey: "episode-b|media-b|source-b" });
    const state = machine.debugState();
    assert.equal(state.sessionKey, "episode-b|media-b|source-b");
    assert.deepEqual(plain(state.pendingSegmentIds), []);
    assert.deepEqual(plain(state.firedSegmentIds), []);
    assert.equal(state.showSkipSeek, null);
    assert.equal(state.nextPending, false);
});

test("source has exactly one playback write, no guessed navigation, and gate is not stored or remotely controlled", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "ShowSkip.plugin.js"), "utf8");
    assert.equal([...source.matchAll(/\.currentTime\s*=/gu)].length, 1);
    assert.doesNotMatch(source, /Player\s*\/\s*NextVideo|Shift\+N|KeyboardEvent|deepLinks|location\.hash\s*=/u);
    assert.match(source, /const PHASE3_PLAYBACK_ACTIONS_ENABLED = false;/u);
    assert.doesNotMatch(source, /PHASE3_PLAYBACK_ACTIONS_ENABLED\s*[:=].*(?:getSetting|fetch|localStorage|process\.env)/u);
});
