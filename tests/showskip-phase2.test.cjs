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
    CoreStateReader,
    DurationStabilizer,
    EpisodeIdentityProvider,
    HtmlMediaAdapter,
    PlayerController,
    PROVIDER_LIMITS,
    SessionSegmentCache,
    TheIntroDBProvider,
    TimelineRenderer,
    buildTheIntroDbUrl,
    classifyCorePlayerState,
    computeMarkerGeometry,
    createEpisodeIdentity,
    createStyles,
    normalizeDurationMs,
    normalizeProviderSegment,
    parseEpisodeVideoId,
    parseRoute,
    providerCacheKey,
    resolveActiveHtmlVideo,
    resolveActiveSeekTarget,
    segmentAccessibleLabel,
    validateTheIntroDbResponse,
} = hooks;

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
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

class FakeClassList {
    constructor(tokens = []) {
        this.tokens = tokens;
    }
    contains(value) {
        return this.tokens.includes(value);
    }
    [Symbol.iterator]() {
        return this.tokens[Symbol.iterator]();
    }
}

class FakeElement {
    constructor(tagName = "div", classes = []) {
        this.tagName = tagName.toUpperCase();
        this.classList = new FakeClassList(classes);
        this.className = classes.join(" ");
        this.children = [];
        this.parentNode = null;
        this.parentElement = null;
        this.attributes = Object.create(null);
        this.listeners = new Map();
        this.style = Object.create(null);
        this.isConnected = true;
        this.hidden = false;
        this.textContent = "";
        this.tabIndex = -1;
        this.rect = { left: 0, top: 0, width: 100, height: 35, right: 100, bottom: 35 };
    }
    get lastElementChild() {
        return this.children[this.children.length - 1] || null;
    }
    get nextSibling() {
        if (!this.parentNode) {
            return null;
        }
        const index = this.parentNode.children.indexOf(this);
        return this.parentNode.children[index + 1] || null;
    }
    append(...nodes) {
        for (const node of nodes) {
            this.appendChild(node);
        }
    }
    appendChild(node) {
        return this.insertBefore(node, null);
    }
    insertBefore(node, reference) {
        if (node.parentNode) {
            const oldIndex = node.parentNode.children.indexOf(node);
            if (oldIndex >= 0) {
                node.parentNode.children.splice(oldIndex, 1);
            }
        }
        const index = reference === null ? this.children.length : this.children.indexOf(reference);
        assert.notEqual(index, -1, "reference node must be a child");
        this.children.splice(index, 0, node);
        node.parentNode = this;
        node.parentElement = this;
        node._setConnected(this.isConnected);
        return node;
    }
    remove() {
        if (this.parentNode) {
            const index = this.parentNode.children.indexOf(this);
            if (index >= 0) {
                this.parentNode.children.splice(index, 1);
            }
        }
        this.parentNode = null;
        this.parentElement = null;
        this._setConnected(false);
    }
    _setConnected(value) {
        this.isConnected = value;
        for (const child of this.children) {
            child._setConnected(value);
        }
    }
    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }
    getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    }
    hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name);
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
    dispatch(type, event = {}) {
        for (const handler of this.listeners.get(type) || []) {
            handler({ type, target: this, ...event });
        }
    }
    getBoundingClientRect() {
        return this.rect;
    }
    querySelectorAll(selector) {
        const found = [];
        const classContains = /^\[class\*="(.+)"\]$/u.exec(selector);
        const attribute = /^\[([^\]]+)\]$/u.exec(selector);
        const visit = (node) => {
            for (const child of node.children) {
                const matches = selector === "[class]"
                    ? child.classList.tokens.length > 0
                    : selector === "video"
                        ? child.tagName === "VIDEO"
                        : classContains
                            ? child.classList.tokens.some((token) => token.includes(classContains[1]))
                            : attribute
                                ? child.hasAttribute(attribute[1])
                                : false;
                if (matches) {
                    found.push(child);
                }
                visit(child);
            }
        };
        visit(this);
        return found;
    }
}

function nativeSlider(classes = ["slider-container-fixture"]) {
    const slider = new FakeElement("div", classes);
    for (const childClass of ["track-fixture", "track-before-fixture", "track-after-fixture", "thumb-fixture"]) {
        const layer = new FakeElement("div", ["layer-fixture"]);
        layer.append(new FakeElement("div", [childClass]));
        slider.append(layer);
    }
    return slider;
}

function createPlayerDom({ wrapper = false, videoCount = 1, retainedPlayer = false } = {}) {
    const router = new FakeElement("div", ["routes-container"]);
    if (retainedPlayer) {
        const retained = new FakeElement("div", ["route-container"]);
        const retainedContent = new FakeElement("div", ["route-content"]);
        retainedContent.append(new FakeElement("div", ["player-container-retained"]));
        retained.append(retainedContent);
        router.append(retained);
    }
    const route = new FakeElement("div", ["route-container"]);
    const content = new FakeElement("div", ["route-content"]);
    const player = new FakeElement("div", ["player-container-active"]);
    const videoContainer = new FakeElement("div", ["video-container-active"]);
    const videos = [];
    for (let index = 0; index < videoCount; index += 1) {
        const video = new FakeElement("video");
        video.currentTime = 12;
        video.duration = 3600;
        video.readyState = 4;
        video.currentSrc = `https://stream.invalid/${index}`;
        video.src = "";
        videos.push(video);
        videoContainer.append(video);
    }
    const control = new FakeElement("div", ["layer-fixture", "control-bar-layer-fixture", "control-bar-container-active"]);
    const seek = new FakeElement("div", ["seek-bar-container-active"]);
    const seekSlider = nativeSlider();
    if (wrapper) {
        const sliderWrapper = new FakeElement("div", ["slider-wrapper-active"]);
        sliderWrapper.append(seekSlider);
        seek.append(sliderWrapper);
    } else {
        seek.append(seekSlider);
    }
    const buttons = new FakeElement("div", ["control-bar-buttons-container-active"]);
    const volume = nativeSlider(["volume-slider-one", "volume-slider-two", "slider-container-fixture"]);
    buttons.append(volume);
    control.append(seek, buttons);
    player.append(videoContainer, control);
    content.append(player);
    route.append(content);
    router.append(route);
    const documentObject = {
        createElement(tagName) {
            return new FakeElement(tagName);
        },
        querySelectorAll(selector) {
            return selector === ".routes-container" ? [router] : router.querySelectorAll(selector);
        },
    };
    const windowObject = {
        AbortController,
        clearTimeout,
        setTimeout,
        getComputedStyle(element) {
            return { display: element.display || "block", visibility: element.visibility || "visible" };
        },
    };
    return { router, route, content, player, videoContainer, videos, control, seek, seekSlider, volume, documentObject, windowObject };
}

function routeFixture(metaId = "tt0903747", season = 1, episode = 2) {
    return parseRoute(`#/player/stream///series/${metaId}/${encodeURIComponent(`${metaId}:${season}:${episode}`)}`);
}

function matchingCoreState(route) {
    return {
        metaItem: { content: { type: "series", id: route.metaId } },
        seriesInfo: { season: route.season, episode: route.episode },
        selected: {
            metaRequest: { path: { type: "series", id: route.metaId } },
            streamRequest: { path: { type: "series", id: route.videoId } },
        },
        libraryItem: { state: { video_id: route.videoId } },
    };
}

function identityFixture(overrides = {}) {
    return {
        showKey: "imdb:tt0903747",
        episodeKey: "imdb:tt0903747|s1|e1|tt0903747%3A1%3A1",
        season: 1,
        episode: 1,
        imdbId: "tt0903747",
        providerMediaId: { scheme: "imdb", value: "tt0903747" },
        ...overrides,
    };
}

function response(status, body = null, headers = {}) {
    const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
    return {
        status,
        headers: { get(name) { return normalized[name.toLowerCase()] ?? null; } },
        async json() {
            if (body instanceof Error) {
                throw body;
            }
            return body;
        },
    };
}

function validBody() {
    return {
        tmdb_id: 1396,
        type: "tv",
        season: 1,
        episode: 1,
        intro: [{ start_ms: null, end_ms: 60_000 }],
        recap: [{ start_ms: 70_000, end_ms: 100_000 }],
        credits: [{ start_ms: 3_500_000, end_ms: null }],
        preview: [{ start_ms: 200_000, end_ms: 260_000 }],
    };
}

test("player routes require the full validated series episode shape", () => {
    const route = routeFixture("kitsu:42", 3, 9);
    assert.equal(route.kind, "player");
    assert.equal(route.eligible, true);
    assert.equal(route.metaId, "kitsu:42");
    assert.equal(route.videoId, "kitsu:42:3:9");
    assert.equal(route.season, 3);
    assert.equal(route.episode, 9);
    assert.equal(parseRoute("#/player/trailer").eligible, false);
    assert.equal(parseRoute("#/player/stream///series/tt0903747/other%3A1%3A2").eligible, false);
    assert.equal(parseRoute("#/player/stream///series/tt0903747/tt0903747%3A0%3A2").eligible, false);
    assert.equal(parseRoute("#/player/stream///series/%E0%A4%A/episode").kind, "other");
    assert.deepEqual(plain(parseEpisodeVideoId("a:b", "a:b:12:34")), { season: 12, episode: 34 });
    assert.equal(parseEpisodeVideoId("a", "other:12:34"), null);
});

test("episode identity accepts a core match, rejects contradictions, and never invents provider IDs", () => {
    const route = routeFixture();
    const matched = createEpisodeIdentity(route, [matchingCoreState(route)]);
    assert.equal(matched.identitySource, "route+core");
    assert.equal(matched.imdbId, "tt0903747");
    assert.deepEqual(plain(matched.providerMediaId), { scheme: "imdb", value: "tt0903747" });
    assert.equal(classifyCorePlayerState(matchingCoreState(route), route).kind, "match");

    const conflict = matchingCoreState(route);
    conflict.seriesInfo.episode = 3;
    assert.equal(classifyCorePlayerState(conflict, route).kind, "conflict");
    assert.equal(createEpisodeIdentity(route, [conflict]), null);
    assert.equal(createEpisodeIdentity(route, [conflict, matchingCoreState(route)]), null);

    const namespaced = createEpisodeIdentity(routeFixture("kitsu:42"), []);
    assert.equal(namespaced.identitySource, "route");
    assert.equal(namespaced.imdbId, null);
    assert.equal(namespaced.tmdbId, null);
    assert.equal(namespaced.providerMediaId, null);
    assert.equal(createEpisodeIdentity(routeFixture("tt123456789"), []).providerMediaId, null);
});

test("bound core readers survive disappearing globals and stale identity work is rejected", async () => {
    const route = routeFixture();
    const owner = {
        state: matchingCoreState(route),
        getState(name) {
            assert.equal(this, owner);
            assert.equal(name, "player");
            return this.state;
        },
    };
    const windowObject = { core: owner, services: null, setTimeout, clearTimeout };
    const reader = new CoreStateReader(windowObject, { timeoutMs: 20 });
    windowObject.core = null;
    assert.equal((await reader.read())[0], owner.state);

    const stateRead = deferred();
    let current = route;
    const identityProvider = new EpisodeIdentityProvider(
        { current: () => current },
        { read: () => stateRead.promise },
    );
    const pending = identityProvider.resolve(route, new AbortController().signal);
    current = routeFixture("tt9288030", 1, 1);
    stateRead.resolve([matchingCoreState(route)]);
    assert.equal(await pending, null);
});

test("current core state outranks retained readers and Loadable transitions fail closed", async () => {
    const route = routeFixture();
    const staleOwner = { getState: () => matchingCoreState(route) };
    const windowObject = { core: staleOwner, services: null, setTimeout, clearTimeout };
    const reader = new CoreStateReader(windowObject, { timeoutMs: 20 });
    const currentConflict = matchingCoreState(route);
    currentConflict.seriesInfo.episode += 1;
    windowObject.core = { getState: () => currentConflict };
    const states = await reader.read();
    assert.equal(states.length, 1);
    assert.equal(states[0], currentConflict);
    assert.equal(createEpisodeIdentity(route, states), null);

    const loading = matchingCoreState(route);
    loading.metaItem.type = "Loading";
    assert.equal(classifyCorePlayerState(loading, route).kind, "unavailable");
    assert.equal(classifyCorePlayerState({ metaItem: { type: "Ready" } }, route).kind, "conflict");
});

test("successful core reads clear their timeout immediately", async () => {
    const route = routeFixture();
    const clock = new FakeClock();
    const setTimeoutFn = clock.setTimeout.bind(clock);
    const clearTimeoutFn = clock.clearTimeout.bind(clock);
    const windowObject = {
        core: { getState: async () => matchingCoreState(route) },
        services: null,
        setTimeout: setTimeoutFn,
        clearTimeout: clearTimeoutFn,
    };
    const reader = new CoreStateReader(windowObject, {
        setTimeout: setTimeoutFn,
        clearTimeout: clearTimeoutFn,
        timeoutMs: 800,
    });
    assert.equal((await reader.read(new AbortController().signal)).length, 1);
    assert.equal(clock.tasks.size, 0);
});

test("active HTML media selection is last-route scoped and fails closed on ambiguity", () => {
    const fixture = createPlayerDom({ retainedPlayer: true });
    assert.equal(resolveActiveHtmlVideo(fixture.documentObject, fixture.windowObject), fixture.videos[0]);
    fixture.videos[0].isConnected = false;
    assert.equal(resolveActiveHtmlVideo(fixture.documentObject, fixture.windowObject), null);

    const empty = createPlayerDom({ videoCount: 0 });
    assert.equal(resolveActiveHtmlVideo(empty.documentObject, empty.windowObject), null);
    const multiple = createPlayerDom({ videoCount: 2 });
    assert.equal(resolveActiveHtmlVideo(multiple.documentObject, multiple.windowObject), null);
    multiple.videos[1].display = "none";
    assert.equal(resolveActiveHtmlVideo(multiple.documentObject, multiple.windowObject), multiple.videos[0]);
});

test("HtmlMediaAdapter remains read-only unless its explicit action capability is enabled", () => {
    const video = new FakeElement("video");
    let writes = 0;
    let currentTime = 12.345;
    Object.defineProperties(video, {
        currentTime: { get: () => currentTime, set: () => { writes += 1; } },
        duration: { get: () => 100.0004, set: () => { writes += 1; } },
        readyState: { get: () => 4, set: () => { writes += 1; } },
        currentSrc: { get: () => "https://stream.invalid/video", set: () => { writes += 1; } },
        src: { get: () => "", set: () => { writes += 1; } },
    });
    const adapter = new HtmlMediaAdapter({}, video);
    const events = [];
    adapter.subscribe((event) => events.push(event.type));
    assert.deepEqual(plain(adapter.capabilities), { canObserveTime: true, canObserveDuration: true, canSeek: false });
    assert.deepEqual(plain(adapter.getSnapshot()), {
        connected: true,
        currentTimeMs: 12345,
        durationMs: 100000,
        readyState: 4,
        source: "https://stream.invalid/video",
        paused: null,
        seeking: null,
        ended: null,
        playbackRate: null,
    });
    video.dispatch("durationchange");
    video.dispatch("timeupdate");
    assert.deepEqual(events, ["durationchange", "timeupdate"]);
    assert.equal(writes, 0);
    adapter.destroy();
    video.dispatch("durationchange");
    assert.deepEqual(events, ["durationchange", "timeupdate"]);
    currentTime = 20;
    assert.equal(writes, 0);
});

test("duration normalization and stabilization enforce quiet time, jitter reset, source reset, and two keys", () => {
    assert.equal(normalizeDurationMs(Number.NaN), null);
    assert.equal(normalizeDurationMs(Number.POSITIVE_INFINITY), null);
    assert.equal(normalizeDurationMs(0), null);
    assert.equal(normalizeDurationMs(10.0005), 10001);

    const clock = new FakeClock();
    const stable = [];
    const limited = [];
    const stabilizer = new DurationStabilizer({
        setTimeout: clock.setTimeout.bind(clock),
        clearTimeout: clock.clearTimeout.bind(clock),
        onStable: (value) => stable.push(value),
        onLimit: (value) => limited.push(value),
    });
    stabilizer.update("source-a", 1000);
    clock.tick(749);
    assert.equal(stable.length, 0);
    stabilizer.update("source-a", 1001);
    clock.tick(749);
    assert.equal(stable.length, 0);
    clock.tick(1);
    assert.equal(stable[0].durationMs, 1001);
    stabilizer.update("source-a", 1002);
    clock.tick(750);
    assert.equal(stable[1].durationMs, 1002);
    stabilizer.update("source-a", 1003);
    clock.tick(750);
    assert.equal(limited[0].durationMs, 1003);
    stabilizer.update("source-b", 2000);
    clock.tick(750);
    assert.equal(stable[2].durationMs, 2000);
});

test("TheIntroDB URL and cache keys include only verified identity and exact duration", () => {
    const identity = identityFixture();
    assert.equal(
        buildTheIntroDbUrl(identity, 3_600_001),
        "https://api.theintrodb.org/v3/media?imdb_id=tt0903747&season=1&episode=1&duration_ms=3600001",
    );
    assert.equal(providerCacheKey(identity, 3_600_001), `${identity.episodeKey}|duration=3600001`.replace(
        identity.episodeKey,
        `theintrodb|anonymous|${identity.episodeKey}`,
    ));
    assert.equal(buildTheIntroDbUrl(identityFixture({ providerMediaId: null }), 10), null);
    assert.equal(buildTheIntroDbUrl(identityFixture({ providerMediaId: { scheme: "tmdb", value: 1396 } }), 10),
        "https://api.theintrodb.org/v3/media?tmdb_id=1396&season=1&episode=1&duration_ms=10");
});

test("provider fails closed when abort support is unavailable", async () => {
    let calls = 0;
    const provider = new TheIntroDBProvider({
        fetch: async () => { calls += 1; return response(200, validBody()); },
        AbortController: null,
    });
    const result = await provider.fetchEpisode(identityFixture(), 3_600_000);
    assert.deepEqual(plain(result), { kind: "unavailable", reason: "abort-unsupported" });
    assert.equal(calls, 0);
});

test("provider response validation preserves four types, raw sentinels, duplicates, and overlaps", () => {
    const identity = identityFixture();
    const body = validBody();
    body.intro.push({ start_ms: 0, end_ms: 60_000 });
    body.intro.push({ start_ms: null, end_ms: 0 });
    body.recap.push({ start_ms: null, end_ms: 30_000 });
    body.credits.push({ start_ms: 0, end_ms: null }, { start_ms: 3_000_000, end_ms: 0 });
    body.preview.push({ start_ms: 220_000, end_ms: 280_000 });
    const result = validateTheIntroDbResponse(body, identity, 3_600_000);
    assert.equal(result.ok, true);
    assert.deepEqual(plain(result.segments.map((segment) => segment.type)), ["recap", "intro", "recap", "preview", "preview", "credits"]);
    assert.equal(result.segments.filter((segment) => segment.type === "intro").length, 1);
    assert.equal(result.segments.find((segment) => segment.type === "credits").endsAtMediaEnd, true);
    assert.equal(result.segments.find((segment) => segment.type === "credits").endMs, 3_600_000);
});

test("provider validation rejects identity mismatch, malformed envelopes, unsafe ranges, and duration violations", () => {
    const identity = identityFixture({ providerMediaId: { scheme: "tmdb", value: 1396 } });
    assert.equal(validateTheIntroDbResponse({ ...validBody(), tmdb_id: 1 }, identity, 3_600_000).ok, false);
    assert.equal(validateTheIntroDbResponse({ ...validBody(), season: 2 }, identity, 3_600_000).ok, false);
    assert.equal(validateTheIntroDbResponse({ ...validBody(), intro: null }, identity, 3_600_000).ok, false);
    assert.equal(validateTheIntroDbResponse(null, identity, 3_600_000).ok, false);

    assert.equal(normalizeProviderSegment("intro", { start_ms: 0, end_ms: 4_999 }, 100_000), null);
    assert.equal(normalizeProviderSegment("intro", { start_ms: 0, end_ms: 5_000 }, 100_000).endMs, 5_000);
    assert.equal(normalizeProviderSegment("recap", { start_ms: -1, end_ms: 20_000 }, 100_000), null);
    assert.equal(normalizeProviderSegment("credits", { start_ms: 90_000, end_ms: 80_000 }, 100_000), null);
    assert.equal(normalizeProviderSegment("preview", { start_ms: 90_000, end_ms: 120_000 }, 100_000), null);
    assert.equal(normalizeProviderSegment("credits", { start_ms: 21_600_001, end_ms: null }, 22_000_000), null);
    assert.equal(normalizeProviderSegment("preview", { start_ms: 10_000, end_ms: 10_000 }, 100_000), null);
});

test("provider performs hardened anonymous GET and caches validated success", async () => {
    const calls = [];
    const provider = new TheIntroDBProvider({
        fetch: async (url, options) => {
            calls.push({ url, options });
            return response(200, validBody());
        },
        AbortController,
        timeoutMs: 100,
    });
    const identity = identityFixture();
    const first = await provider.fetchEpisode(identity, 3_600_000, new AbortController().signal);
    const second = await provider.fetchEpisode(identity, 3_600_000, new AbortController().signal);
    assert.equal(first.kind, "segments");
    assert.equal(second, first);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, buildTheIntroDbUrl(identity, 3_600_000));
    assert.deepEqual(plain(calls[0].options.headers), { Accept: "application/json" });
    assert.equal(calls[0].options.credentials, "omit");
    assert.equal(calls[0].options.cache, "no-store");
    assert.equal(calls[0].options.redirect, "error");
    assert.equal(calls[0].options.referrerPolicy, "no-referrer");
    assert.equal("Authorization" in calls[0].options.headers, false);
    provider.destroy();
});

test("provider validates the browser streamed-body path and enforces its byte ceiling", async () => {
    const encoded = new TextEncoder().encode(JSON.stringify(validBody()));
    let index = 0;
    const streamedProvider = new TheIntroDBProvider({
        fetch: async () => ({
            status: 200,
            headers: { get: () => null },
            body: {
                getReader() {
                    return {
                        async read() {
                            if (index > 0) {
                                return { done: true, value: undefined };
                            }
                            index += 1;
                            return { done: false, value: encoded };
                        },
                        releaseLock() {},
                    };
                },
            },
        }),
        AbortController,
        timeoutMs: 100,
    });
    assert.equal((await streamedProvider.fetchEpisode(
        identityFixture(),
        3_600_000,
        new AbortController().signal,
    )).kind, "segments");

    let oversizedCalls = 0;
    let canceled = 0;
    const oversizedProvider = new TheIntroDBProvider({
        fetch: async () => {
            oversizedCalls += 1;
            let sent = false;
            return {
                status: 200,
                headers: { get: () => null },
                body: {
                    getReader() {
                        return {
                            async read() {
                                if (sent) {
                                    return { done: true, value: undefined };
                                }
                                sent = true;
                                return {
                                    done: false,
                                    value: new Uint8Array(PROVIDER_LIMITS.maxResponseBytes + 1),
                                };
                            },
                            async cancel() { canceled += 1; },
                            releaseLock() {},
                        };
                    },
                },
            };
        },
        AbortController,
        timeoutMs: 100,
    });
    assert.equal((await oversizedProvider.fetchEpisode(
        identityFixture(),
        3_600_000,
        new AbortController().signal,
    )).reason, "malformed");
    assert.equal((await oversizedProvider.fetchEpisode(
        identityFixture(),
        3_600_000,
        new AbortController().signal,
    )).reason, "malformed");
    assert.equal(oversizedCalls, 2);
    assert.equal(canceled, 2);
    streamedProvider.destroy();
    oversizedProvider.destroy();
});

test("in-flight requests dedupe and exact durations remain cache-separated", async () => {
    const gate = deferred();
    let calls = 0;
    const provider = new TheIntroDBProvider({
        fetch: async () => {
            calls += 1;
            await gate.promise;
            return response(200, validBody());
        },
        AbortController,
        timeoutMs: 200,
    });
    const signal = new AbortController().signal;
    const first = provider.fetchEpisode(identityFixture(), 3_600_000, signal);
    const second = provider.fetchEpisode(identityFixture(), 3_600_000, signal);
    await Promise.resolve();
    assert.equal(calls, 1);
    gate.resolve();
    assert.equal((await first).kind, "segments");
    assert.equal((await second).kind, "segments");
    await provider.fetchEpisode(identityFixture(), 3_600_001, signal);
    assert.equal(calls, 2);
    provider.destroy();
});

test("404 and legacy 204 are negative-cached while malformed responses are not", async () => {
    for (const status of [404, 204]) {
        let calls = 0;
        const provider = new TheIntroDBProvider({
            fetch: async () => { calls += 1; return response(status); }, AbortController, timeoutMs: 100,
        });
        assert.equal((await provider.fetchEpisode(identityFixture(), 1000, new AbortController().signal)).kind, "empty");
        await provider.fetchEpisode(identityFixture(), 1000, new AbortController().signal);
        assert.equal(calls, 1);
        provider.destroy();
    }
    let malformedCalls = 0;
    const malformed = new TheIntroDBProvider({
        fetch: async () => { malformedCalls += 1; return response(200, new Error("bad json")); }, AbortController, timeoutMs: 100,
    });
    await malformed.fetchEpisode(identityFixture(), 1000, new AbortController().signal);
    await malformed.fetchEpisode(identityFixture(), 1000, new AbortController().signal);
    assert.equal(malformedCalls, 2);
    malformed.destroy();
});

test("transient 429 and 5xx retry once; daily usage exhaustion terminates the session", async () => {
    let rateCalls = 0;
    const rateProvider = new TheIntroDBProvider({
        fetch: async () => {
            rateCalls += 1;
            return rateCalls === 1
                ? response(429, { error: "slow down", retry_after: "8.4 hours" }, { "X-RateLimit-Reset": "0" })
                : response(200, validBody());
        },
        AbortController,
        timeoutMs: 100,
    });
    assert.equal((await rateProvider.fetchEpisode(identityFixture(), 3_600_000, new AbortController().signal)).kind, "segments");
    assert.equal(rateCalls, 2);

    let serverCalls = 0;
    const serverProvider = new TheIntroDBProvider({
        fetch: async () => { serverCalls += 1; return response(500); },
        AbortController,
        timeoutMs: 100,
        retryDelayMs: 1,
    });
    assert.equal((await serverProvider.fetchEpisode(identityFixture(), 3_600_000, new AbortController().signal)).kind, "unavailable");
    assert.equal(serverCalls, 2);

    let dailyCalls = 0;
    const dailyProvider = new TheIntroDBProvider({
        fetch: async () => { dailyCalls += 1; return response(429, { code: "usage_limit_exceeded", retry_after: "8.4 hours" }); },
        AbortController,
        timeoutMs: 100,
    });
    assert.equal((await dailyProvider.fetchEpisode(identityFixture(), 1000, new AbortController().signal)).reason, "daily-limit");
    assert.equal((await dailyProvider.fetchEpisode(identityFixture(), 1001, new AbortController().signal)).reason, "daily-limit");
    assert.equal(dailyCalls, 1);
    rateProvider.destroy();
    serverProvider.destroy();
    dailyProvider.destroy();
});

test("network timeout is bounded and caller abort propagates", async () => {
    let calls = 0;
    const timeoutProvider = new TheIntroDBProvider({
        fetch: (_url, options) => new Promise((_resolve, reject) => {
            calls += 1;
            options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        }),
        AbortController,
        timeoutMs: 5,
        retryDelayMs: 1,
    });
    const timedOut = await timeoutProvider.fetchEpisode(identityFixture(), 1000, new AbortController().signal);
    assert.equal(timedOut.kind, "unavailable");
    assert.equal(calls, 2);

    const abortProvider = new TheIntroDBProvider({
        fetch: (_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        }),
        AbortController,
        timeoutMs: 100,
    });
    const controller = new AbortController();
    const pending = abortProvider.fetchEpisode(identityFixture(), 1000, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    timeoutProvider.destroy();
    abortProvider.destroy();
});

test("timeouts and aborts remain active while response bodies are being consumed", async () => {
    for (const status of [200, 429]) {
        let calls = 0;
        const provider = new TheIntroDBProvider({
            fetch: async () => {
                calls += 1;
                return response(status, null);
            },
            AbortController,
            timeoutMs: 5,
            retryDelayMs: 1,
        });
        const hangingJson = () => new Promise(() => undefined);
        provider.fetch = async () => {
            calls += 1;
            return { status, headers: { get: () => null }, json: hangingJson };
        };
        const result = await provider.fetchEpisode(identityFixture(), 1000, new AbortController().signal);
        assert.equal(result.kind, "unavailable");
        assert.equal(calls, 2);
        assert.equal(provider.inFlight.size, 0);
        provider.destroy();
    }

    const provider = new TheIntroDBProvider({
        fetch: async () => ({ status: 200, headers: { get: () => null }, json: () => new Promise(() => undefined) }),
        AbortController,
        timeoutMs: 100,
    });
    const controller = new AbortController();
    const pending = provider.fetchEpisode(identityFixture(), 1000, controller.signal);
    await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await Promise.resolve();
    assert.equal(provider.inFlight.size, 0);
    provider.destroy();
});

test("destroy cancels retry backoff and cached data survives a later daily-limit response", async () => {
    let calls = 0;
    const destroyed = new TheIntroDBProvider({
        fetch: async () => { calls += 1; return response(500); },
        AbortController,
        timeoutMs: 100,
        retryDelayMs: 30,
    });
    const pending = destroyed.fetchEpisode(identityFixture(), 1000, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    destroyed.destroy();
    await assert.rejects(pending, { name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(calls, 1);

    let sequence = 0;
    const provider = new TheIntroDBProvider({
        fetch: async () => {
            sequence += 1;
            return sequence === 1
                ? response(200, validBody())
                : response(429, { code: "usage_limit_exceeded" });
        },
        AbortController,
        timeoutMs: 100,
    });
    const cached = await provider.fetchEpisode(identityFixture(), 3_600_000, new AbortController().signal);
    assert.equal(cached.kind, "segments");
    assert.equal((await provider.fetchEpisode(identityFixture(), 3_600_001, new AbortController().signal)).reason, "daily-limit");
    assert.equal(await provider.fetchEpisode(identityFixture(), 3_600_000, new AbortController().signal), cached);
    assert.equal(sequence, 2);
    provider.destroy();
});

test("malformed segment items are never cached but documented sentinels may be", async () => {
    let malformedCalls = 0;
    const malformed = new TheIntroDBProvider({
        fetch: async () => {
            malformedCalls += 1;
            return response(200, { tmdb_id: 1396, type: "tv", intro: [{ start_ms: "bad", end_ms: 9000 }] });
        },
        AbortController,
        timeoutMs: 100,
    });
    await malformed.fetchEpisode(identityFixture(), 100_000, new AbortController().signal);
    await malformed.fetchEpisode(identityFixture(), 100_000, new AbortController().signal);
    assert.equal(malformedCalls, 2);

    let sentinelCalls = 0;
    const sentinel = new TheIntroDBProvider({
        fetch: async () => {
            sentinelCalls += 1;
            return response(200, { tmdb_id: 1396, type: "tv", intro: [{ start_ms: null, end_ms: 0 }] });
        },
        AbortController,
        timeoutMs: 100,
    });
    assert.equal((await sentinel.fetchEpisode(identityFixture(), 100_000, new AbortController().signal)).kind, "empty");
    await sentinel.fetchEpisode(identityFixture(), 100_000, new AbortController().signal);
    assert.equal(sentinelCalls, 1);
    malformed.destroy();
    sentinel.destroy();
});

test("deduplicated callers cancel independently", async () => {
    const gate = deferred();
    let calls = 0;
    const provider = new TheIntroDBProvider({
        fetch: async () => { calls += 1; await gate.promise; return response(200, validBody()); },
        AbortController,
        timeoutMs: 100,
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = provider.fetchEpisode(identityFixture(), 3_600_000, firstController.signal);
    const second = provider.fetchEpisode(identityFixture(), 3_600_000, secondController.signal);
    firstController.abort();
    await assert.rejects(first, { name: "AbortError" });
    gate.resolve();
    assert.equal((await second).kind, "segments");
    assert.equal(calls, 1);
    provider.destroy();
});

test("a new caller replaces an already-aborted in-flight request", async () => {
    let calls = 0;
    const provider = new TheIntroDBProvider({
        fetch: async (_url, options) => {
            calls += 1;
            if (calls === 1) {
                return new Promise((_resolve, reject) => {
                    options.signal.addEventListener("abort", () => reject(
                        Object.assign(new Error("aborted"), { name: "AbortError" }),
                    ), { once: true });
                });
            }
            return response(200, validBody());
        },
        AbortController,
        timeoutMs: 100,
    });
    const firstController = new AbortController();
    const first = provider.fetchEpisode(identityFixture(), 3_600_000, firstController.signal);
    await Promise.resolve();
    firstController.abort();
    const second = provider.fetchEpisode(
        identityFixture(),
        3_600_000,
        new AbortController().signal,
    );
    await assert.rejects(first, { name: "AbortError" });
    assert.equal((await second).kind, "segments");
    assert.equal(calls, 2);
    provider.destroy();
});

test("session cache is bounded LRU and never touches profile storage", () => {
    const cache = new SessionSegmentCache(2);
    cache.set("a", { value: 1 });
    cache.set("b", { value: 2 });
    assert.equal(cache.get("a").value, 1);
    cache.set("c", { value: 3 });
    assert.equal(cache.get("b"), null);
    assert.equal(cache.get("a").value, 1);
    assert.equal(cache.get("c").value, 3);
});

test("seek target resolution distinguishes timeline from volume and supports wrapper remounts", () => {
    for (const wrapper of [false, true]) {
        const fixture = createPlayerDom({ wrapper, retainedPlayer: true });
        const target = resolveActiveSeekTarget(fixture.documentObject);
        assert.equal(target.slider, fixture.seekSlider);
        assert.notEqual(target.slider, fixture.volume);
        assert.equal(target.thumbLayer, fixture.seekSlider.children[3]);
    }
    const ambiguous = createPlayerDom();
    ambiguous.seek.append(nativeSlider());
    assert.equal(resolveActiveSeekTarget(ambiguous.documentObject), null);
    const volumeOnly = createPlayerDom();
    volumeOnly.seekSlider.classList.tokens.push("volume-slider-bad");
    assert.equal(resolveActiveSeekTarget(volumeOnly.documentObject), null);
});

test("marker geometry preserves types and rejects malformed or out-of-duration regions", () => {
    const segments = [
        { type: "intro", startMs: 1000, endMs: 2000, id: "intro" },
        { type: "preview", startMs: 9000, endMs: 10_000, id: "preview" },
        { type: "credits", startMs: -1, endMs: 500, id: "bad" },
        { type: "recap", startMs: 2000, endMs: 11_000, id: "past" },
    ];
    const geometry = computeMarkerGeometry(segments, 10_000);
    assert.deepEqual(plain(geometry.map((item) => item.segment.type)), ["intro", "preview"]);
    assert.equal(geometry[0].leftPercent, 10);
    assert.equal(geometry[0].widthPercent, 10);
    assert.equal(geometry[1].leftPercent, 90);
    assert.equal(geometry[1].widthPercent, 10);
    assert.equal(computeMarkerGeometry(segments, 0).length, 0);
    assert.equal(segmentAccessibleLabel({ type: "intro", startMs: 74_000, endMs: 157_000 }), "Intro, 01:14 to 02:37");
});

test("TimelineRenderer owns one non-blocking accessible layer and reattaches cleanly", () => {
    const fixture = createPlayerDom();
    const renderer = new TimelineRenderer(fixture.documentObject);
    const bundle = {
        segments: [
            { id: "recap:0:10000", type: "recap", startMs: 0, endMs: 10_000 },
            { id: "intro:10000:20000", type: "intro", startMs: 10_000, endMs: 20_000 },
            { id: "credits:90000:100000", type: "credits", startMs: 90_000, endMs: 100_000 },
            { id: "preview:80000:90000", type: "preview", startMs: 80_000, endMs: 90_000 },
        ],
    };
    assert.equal(renderer.render(bundle, 100_000, "episode-a"), 4);
    const layer = renderer.layer;
    assert.equal(layer.nextSibling, fixture.seekSlider.children[fixture.seekSlider.children.length - 1]);
    assert.equal(layer.getAttribute("data-showskip-owned"), "timeline");
    assert.equal(layer.getAttribute("role"), "group");
    const markers = layer.querySelectorAll("[data-showskip-timeline-marker]");
    assert.equal(markers.length, 4);
    assert.ok(markers.every((marker) => marker.tabIndex === 0 && marker.getAttribute("role") === "img"));
    assert.equal(fixture.volume.querySelectorAll("[data-showskip-timeline-layer]").length, 0);
    assert.equal(renderer.render(bundle, 100_000, "episode-a"), 4);
    assert.equal(renderer.layer, layer);
    assert.equal(fixture.seekSlider.querySelectorAll("[data-showskip-timeline-layer]").length, 1);

    fixture.seekSlider.rect = { left: 0, top: 0, width: 100, height: 35, right: 100, bottom: 35 };
    fixture.seekSlider.dispatch("pointermove", { clientX: 15 });
    assert.equal(renderer.tooltip.hidden, false);
    assert.match(renderer.tooltip.textContent, /^Intro/u);
    renderer.clear();
    assert.equal(fixture.seekSlider.querySelectorAll("[data-showskip-timeline-layer]").length, 0);
    assert.equal(fixture.seekSlider.listeners.get("pointermove").size, 0);
});

test("timeline CSS stays below the native thumb and hides keyboard stops with controls", () => {
    const style = createStyles({
        createElement() {
            return { setAttribute() {}, textContent: "" };
        },
    }).textContent;
    const layerRule = /\[data-showskip-timeline-layer\] \{([^}]+)\}/u.exec(style)[1];
    const markerRule = /\[data-showskip-timeline-marker\] \{([^}]+)\}/u.exec(style)[1];
    assert.match(layerRule, /z-index:\s*0;/u);
    assert.match(layerRule, /pointer-events:\s*none;/u);
    assert.match(markerRule, /height:\s*var\(--track-size, 0\.3rem\);/u);
    assert.match(style, /overlayHidden-[^}]+visibility:\s*hidden;/su);
});

test("focused marker tooltip survives pointer movement and repeated display is idempotent", () => {
    const fixture = createPlayerDom();
    const renderer = new TimelineRenderer(fixture.documentObject);
    const bundle = { segments: [{ id: "intro", type: "intro", startMs: 10_000, endMs: 20_000 }] };
    renderer.render(bundle, 100_000, "episode-a");
    const marker = renderer.layer.querySelectorAll("[data-showskip-timeline-marker]")[0];
    renderer.layer.dispatch("focusin", { target: marker });
    const text = renderer.tooltip.textContent;
    const key = renderer.displayedTooltipKey;
    assert.equal(renderer.tooltip.hidden, false);
    fixture.seekSlider.dispatch("pointerleave");
    fixture.seekSlider.dispatch("pointermove", { clientX: 90 });
    assert.equal(renderer.tooltip.hidden, false);
    assert.equal(renderer.tooltip.textContent, text);
    assert.equal(renderer.displayedTooltipKey, key);
    renderer.layer.dispatch("focusout", { target: marker });
    assert.equal(renderer.tooltip.hidden, true);
    renderer.destroy();
});

test("renderer removes stale owned layers globally and malformed native sliders fail closed", () => {
    const fixture = createPlayerDom();
    const stale = new FakeElement("div");
    stale.setAttribute("data-showskip-owned", "timeline");
    stale.setAttribute("data-showskip-timeline-layer", "");
    fixture.volume.append(stale);
    const renderer = new TimelineRenderer(fixture.documentObject);
    renderer.render({ segments: [{ id: "intro", type: "intro", startMs: 10, endMs: 20 }] }, 100, "a");
    assert.equal(stale.isConnected, false);
    assert.equal(fixture.volume.querySelectorAll("[data-showskip-timeline-layer]").length, 0);
    renderer.destroy();

    const missingThumb = createPlayerDom();
    missingThumb.seekSlider.children[3].remove();
    assert.equal(resolveActiveSeekTarget(missingThumb.documentObject), null);
    const twoRouters = createPlayerDom();
    const originalQuery = twoRouters.documentObject.querySelectorAll;
    twoRouters.documentObject.querySelectorAll = (selector) => selector === ".routes-container"
        ? [twoRouters.router, new FakeElement("div", ["routes-container"])]
        : originalQuery(selector);
    assert.equal(resolveActiveSeekTarget(twoRouters.documentObject), null);
});

test("TimelineRenderer removes episode A on target remount and never consults behavior settings", () => {
    const first = createPlayerDom();
    const renderer = new TimelineRenderer(first.documentObject);
    const bundle = { segments: [{ id: "intro", type: "intro", startMs: 10, endMs: 20 }] };
    assert.equal(renderer.render(bundle, 100, "a"), 1);
    const oldLayer = renderer.layer;
    const second = createPlayerDom({ wrapper: true });
    renderer.document = second.documentObject;
    assert.equal(renderer.render(bundle, 100, "a"), 1);
    assert.equal(oldLayer.isConnected, false);
    assert.equal(second.seekSlider.querySelectorAll("[data-showskip-timeline-layer]").length, 1);
    renderer.destroy();
    assert.equal(second.seekSlider.querySelectorAll("[data-showskip-timeline-layer]").length, 0);
});

test("route-only identity is revalidated, conflicts clear work, and late matches promote it", async () => {
    const route = routeFixture("tt0903747", 1, 1);
    const routeIdentity = createEpisodeIdentity(route, []);
    const coreIdentity = { ...routeIdentity, identitySource: "route+core" };

    for (const secondIdentity of [null, coreIdentity]) {
        const fixture = createPlayerDom();
        const gate = deferred();
        let identityCalls = 0;
        let providerCalls = 0;
        let renders = 0;
        const controller = new PlayerController({
            windowObject: fixture.windowObject,
            documentObject: fixture.documentObject,
            identityProvider: {
                resolve: async () => {
                    identityCalls += 1;
                    return identityCalls === 1 ? routeIdentity : secondIdentity;
                },
            },
            provider: {
                fetchEpisode() { providerCalls += 1; return gate.promise; },
                destroy() {},
            },
            timeline: { clear() {}, destroy() {}, render() { renders += 1; return 1; } },
            onSchedule() {},
            onProviderUsed() {},
            AbortController,
        });
        controller.durationStabilizer.quietMs = 1;
        assert.equal(await controller.reconcile(route), false);
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(providerCalls, 1);
        assert.equal(await controller.reconcile(route), secondIdentity !== null);
        if (secondIdentity) {
            assert.equal(controller.identity.identitySource, "route+core");
        } else {
            assert.equal(controller.identity, null);
        }
        gate.resolve({ kind: "segments", bundle: { segments: [{ id: "intro", type: "intro", startMs: 10, endMs: 20 }] } });
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(renders, secondIdentity ? 1 : 0);
        controller.destroy();
    }
});

test("provider completion rechecks live duration, source, connection, and video identity", async () => {
    for (const change of ["duration", "source", "disconnect", "replace"]) {
        const fixture = createPlayerDom();
        const route = routeFixture("tt0903747", 1, 1);
        const identity = { ...createEpisodeIdentity(route, []), identitySource: "route+core" };
        const gate = deferred();
        let renders = 0;
        const controller = new PlayerController({
            windowObject: fixture.windowObject,
            documentObject: fixture.documentObject,
            identityProvider: { resolve: async () => identity },
            provider: { fetchEpisode: () => gate.promise, destroy() {} },
            timeline: { clear() {}, destroy() {}, render() { renders += 1; return 1; } },
            onSchedule() {},
            onProviderUsed() {},
            AbortController,
        });
        controller.durationStabilizer.quietMs = 1;
        assert.equal(await controller.reconcile(route), true);
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (change === "duration") {
            fixture.videos[0].duration = 3601;
        } else if (change === "source") {
            fixture.videos[0].currentSrc = "https://stream.invalid/replacement";
        } else if (change === "disconnect") {
            fixture.videos[0].isConnected = false;
        } else {
            fixture.videos[0].remove();
            const replacement = new FakeElement("video");
            replacement.currentTime = 0;
            replacement.duration = 3600;
            replacement.readyState = 4;
            replacement.currentSrc = "https://stream.invalid/0";
            replacement.src = "";
            fixture.videoContainer.append(replacement);
        }
        gate.resolve({ kind: "segments", bundle: { segments: [{ id: "intro", type: "intro", startMs: 10, endMs: 20 }] } });
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(renders, 0, change);
        controller.destroy();
    }
});

test("PlayerController ignores a provider result after episode teardown", async () => {
    const fixture = createPlayerDom();
    const route = routeFixture("tt0903747", 1, 1);
    const identity = { ...createEpisodeIdentity(route, []), identitySource: "route+core" };
    const gate = deferred();
    let providerCalls = 0;
    let renders = 0;
    const timeline = {
        clear() {},
        destroy() {},
        render() { renders += 1; return 1; },
    };
    const provider = {
        fetchEpisode() { providerCalls += 1; return gate.promise; },
        destroy() {},
    };
    const controller = new PlayerController({
        windowObject: fixture.windowObject,
        documentObject: fixture.documentObject,
        identityProvider: { resolve: async () => identity },
        provider,
        timeline,
        onSchedule() {},
        onProviderUsed() {},
        AbortController,
    });
    controller.durationStabilizer.quietMs = 1;
    assert.equal(await controller.reconcile(route), true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(providerCalls, 1);
    controller.deactivate();
    gate.resolve({
        kind: "segments",
        bundle: { segments: [{ id: "intro", type: "intro", startMs: 10, endMs: 20 }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(renders, 0);
    controller.destroy();
});

test("production v1 enables Phase 3 actions and confines its sole media write to HtmlMediaAdapter", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "ShowSkip.plugin.js"), "utf8");
    assert.match(source, /const PHASE3_PLAYBACK_ACTIONS_ENABLED = true;/u);
    assert.match(source, /\* @version 1\.0\.0/u);
    const writes = [...source.matchAll(/\.currentTime\s*=/gu)];
    assert.equal(writes.length, 1);
    assert.ok(writes[0].index > source.indexOf("class HtmlMediaAdapter"));
    assert.ok(writes[0].index < source.indexOf("class NextEpisodeAdapter"));
    assert.doesNotMatch(source, /dispatchEvent\s*\(\s*new\s+KeyboardEvent/u);
    assert.doesNotMatch(source, /Player\/NextVideo|Shift\+N|mpv-set-prop/u);
    assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\b/u);
    assert.match(source, /https:\/\/api\.theintrodb\.org\/v3\/media/u);
    assert.equal(PROVIDER_LIMITS.durationQuietMs, 750);
});

test("a lone Stremio Plus stand-in mounted outside the player container is still found", () => {
    const empty = createPlayerDom({ videoCount: 0 });
    const standIn = { isConnected: true, getBoundingClientRect: () => ({ width: 10, height: 10 }) };
    const original = empty.documentObject.querySelectorAll.bind(empty.documentObject);
    empty.documentObject.querySelectorAll = (selector) => (
        selector === "video[data-splus-video]" ? [standIn] : original(selector)
    );
    assert.equal(resolveActiveHtmlVideo(empty.documentObject, empty.windowObject), standIn);
    empty.documentObject.querySelectorAll = (selector) => (
        selector === "video[data-splus-video]" ? [standIn, { ...standIn }] : original(selector)
    );
    assert.equal(resolveActiveHtmlVideo(empty.documentObject, empty.windowObject), null);
});
