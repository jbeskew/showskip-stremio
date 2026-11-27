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
        URL,
        Uint8Array,
        clearTimeout,
        console,
        setTimeout,
        __SHOWSKIP_TEST_MODE__: true,
    });
    vm.runInContext(source, context, { filename: "ShowSkip.plugin.js" });
    return context.__SHOWSKIP_TEST_HOOKS__;
}

const {
    AddonMetaMappingReader,
    EpisodeIdentityProvider,
    buildAddonMetaUrl,
    buildTheIntroDbUrl,
    classifyCorePlayerState,
    createDebugReporter,
    createEpisodeIdentity,
    extractAddonMappings,
    parseEpisodeVideoId,
    parseRoute,
    parseSingleEpisodeVideoId,
} = loadHooks();

const TRANSPORT = "https://addon.example.test/manifest.json";

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function kitsuRoute(videoId = "kitsu:7442:17", transport = TRANSPORT, metaId = "kitsu:7442") {
    return parseRoute(
        `#/player/stream//${encodeURIComponent(transport)}/series/${encodeURIComponent(metaId)}/${encodeURIComponent(videoId)}`,
    );
}

function coreState(route, season = 1) {
    return {
        metaItem: { content: { type: "series", id: route.metaId } },
        seriesInfo: { season, episode: route.episode },
        selected: {
            metaRequest: { path: { type: "series", id: route.metaId } },
            streamRequest: { path: { type: "series", id: route.videoId } },
        },
        libraryItem: { state: { video_id: route.videoId } },
    };
}

function metaBody(overrides = {}) {
    return {
        meta: {
            id: "kitsu:7442",
            type: "series",
            imdb_id: "tt2560140",
            videos: [
                { id: "kitsu:7442:16", season: 1, episode: 16, imdb_id: "tt2560140", imdbSeason: 1, imdbEpisode: 16 },
                { id: "kitsu:7442:17", season: 1, episode: 17, imdb_id: "tt2560140", imdbSeason: 2, imdbEpisode: 5 },
            ],
            ...overrides,
        },
    };
}

function jsonResponse(body, status = 200) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { status, headers: { get: () => null }, text: async () => text };
}

test("single-number episode ids parse only with an exact series prefix", () => {
    assert.deepEqual(plain(parseSingleEpisodeVideoId("kitsu:7442", "kitsu:7442:17")), { episode: 17 });
    for (const bad of ["kitsu:7442:0", "kitsu:7442:17x", "kitsu:7442:1:2", "kitsu:744:17", "other:7442:17", "kitsu:7442:"]) {
        assert.equal(parseSingleEpisodeVideoId("kitsu:7442", bad), null, bad);
    }
    assert.deepEqual(plain(parseEpisodeVideoId("kitsu:7442", "kitsu:7442:1:2")), { season: 1, episode: 2 });
    assert.equal(parseEpisodeVideoId("kitsu:7442", "kitsu:7442:17"), null);
});

test("kitsu player routes are eligible with a decoded transport; IMDb single-number ids stay ineligible", () => {
    const route = kitsuRoute();
    assert.equal(route.eligible, true);
    assert.equal(route.episodeFormat, "single");
    assert.equal(route.season, null);
    assert.equal(route.episode, 17);
    assert.equal(route.metaTransportUrl, TRANSPORT);
    assert.equal(kitsuRoute("kitsu:7442:1:2").episodeFormat, "season-episode");
    assert.equal(kitsuRoute("tt0903747:5", TRANSPORT, "tt0903747").eligible, false);
    assert.equal(parseRoute("#/player/stream//%E0%A4%A/series/kitsu%3A7442/kitsu%3A7442%3A17").metaTransportUrl, null);
    assert.equal(kitsuRoute("kitsu:7442:17", "").eligible, true);
});

test("addon meta URLs are https-only, credential-free and manifest-relative", () => {
    assert.equal(
        buildAddonMetaUrl(kitsuRoute()),
        "https://addon.example.test/meta/series/kitsu%3A7442.json",
    );
    assert.equal(
        buildAddonMetaUrl(kitsuRoute("kitsu:7442:17", "https://addon.example.test/cfg/manifest.json")),
        "https://addon.example.test/cfg/meta/series/kitsu%3A7442.json",
    );
    for (const bad of [
        "http://addon.example.test/manifest.json",
        "https://user:pw@addon.example.test/manifest.json",
        "https://addon.example.test/other.json",
        "https://addon.example.test/manifest.json?token=1",
        "not a url",
    ]) {
        assert.equal(buildAddonMetaUrl(kitsuRoute("kitsu:7442:17", bad)), null, bad);
    }
    assert.equal(buildAddonMetaUrl(kitsuRoute("kitsu:7442:17", "")), null);
});

test("addon meta extraction keeps only unambiguous, validated mappings", () => {
    const mappings = extractAddonMappings(metaBody(), "kitsu:7442");
    assert.deepEqual(plain(mappings.get("kitsu:7442:17")), { imdbId: "tt2560140", season: 2, episode: 5 });
    assert.equal(extractAddonMappings(metaBody({ id: "kitsu:1" }), "kitsu:7442"), null);
    assert.equal(extractAddonMappings(metaBody({ type: "movie" }), "kitsu:7442"), null);
    assert.equal(extractAddonMappings(metaBody({ videos: "x" }), "kitsu:7442"), null);

    const duplicate = metaBody();
    duplicate.meta.videos.push({ ...duplicate.meta.videos[1] });
    assert.equal(extractAddonMappings(duplicate, "kitsu:7442").has("kitsu:7442:17"), false);

    const missingSeason = metaBody();
    delete missingSeason.meta.videos[1].imdbSeason;
    assert.equal(extractAddonMappings(missingSeason, "kitsu:7442").has("kitsu:7442:17"), false);

    const mismatch = metaBody();
    mismatch.meta.videos[1].imdb_id = "tt0000001";
    const mismatched = extractAddonMappings(mismatch, "kitsu:7442");
    assert.equal(mismatched.has("kitsu:7442:17"), false);
    assert.equal(mismatched.has("kitsu:7442:16"), true);

    const badImdb = metaBody();
    badImdb.meta.videos[1].imdb_id = "kitsu:1";
    assert.equal(extractAddonMappings(badImdb, "kitsu:7442").has("kitsu:7442:17"), false);
});

test("mapping reader fetches once per show, with hardened request options", async () => {
    const calls = [];
    const reader = new AddonMetaMappingReader({
        fetch: async (url, init) => {
            calls.push({ url, init });
            return jsonResponse(metaBody());
        },
    });
    const route = kitsuRoute();
    const [first, second] = await Promise.all([reader.resolve(route), reader.resolve(route)]);
    const third = await reader.resolve(kitsuRoute("kitsu:7442:16"));
    assert.deepEqual(plain(first), { imdbId: "tt2560140", season: 2, episode: 5 });
    assert.deepEqual(plain(second), plain(first));
    assert.equal(third.season, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.credentials, "omit");
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(calls[0].init.referrerPolicy, "no-referrer");
    assert.equal(calls[0].init.method, "GET");
    reader.destroy();
});

test("mapping reader fails closed on bad transport, HTTP errors, oversized and invalid bodies", async () => {
    let fetches = 0;
    const make = (respond) => new AddonMetaMappingReader({
        fetch: async () => {
            fetches += 1;
            return respond();
        },
    });
    assert.equal(await make(() => jsonResponse(metaBody())).resolve(kitsuRoute("kitsu:7442:17", "http://a.test/manifest.json")), null);
    assert.equal(fetches, 0);
    assert.equal(await make(() => jsonResponse(metaBody(), 500)).resolve(kitsuRoute()), null);
    assert.equal(await make(() => jsonResponse("not json")).resolve(kitsuRoute()), null);
    assert.equal(await make(() => jsonResponse(metaBody({ id: "kitsu:9" }))).resolve(kitsuRoute()), null);
    const huge = { status: 200, headers: { get: (name) => (/content-length/iu.test(name) ? String(5 * 1024 * 1024) : null) }, text: async () => "{}" };
    assert.equal(await make(() => huge).resolve(kitsuRoute()), null);
    assert.equal(await make(() => jsonResponse(metaBody())).resolve(kitsuRoute("kitsu:7442:99")), null);
    const throwing = make(() => {
        throw new Error("redirect");
    });
    assert.equal(await throwing.resolve(kitsuRoute()), null);
});

test("failed mapping lookups are cached briefly instead of refetching every reconcile", async () => {
    let now = 0;
    let fetches = 0;
    const reader = new AddonMetaMappingReader({
        now: () => now,
        fetch: async () => {
            fetches += 1;
            return jsonResponse("", 503);
        },
    });
    await reader.resolve(kitsuRoute());
    await reader.resolve(kitsuRoute());
    assert.equal(fetches, 1);
    now = 31_000;
    await reader.resolve(kitsuRoute());
    assert.equal(fetches, 2);
});

test("aborted callers reject without poisoning the shared lookup", async () => {
    const reader = new AddonMetaMappingReader({ fetch: async () => jsonResponse(metaBody()) });
    const controller = new AbortController();
    const pending = reader.resolve(kitsuRoute(), controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal((await reader.resolve(kitsuRoute())).season, 2);
});

test("mapped identity uses provider numbering and requires core agreement for actions", () => {
    const route = kitsuRoute();
    const mapping = { imdbId: "tt2560140", season: 2, episode: 5 };
    assert.equal(createEpisodeIdentity(route, [], null), null);
    assert.equal(createEpisodeIdentity(route, [], { imdbId: "bad", season: 1, episode: 1 }), null);

    const routeOnly = createEpisodeIdentity(route, [], mapping);
    assert.equal(routeOnly.identitySource, "route");
    assert.equal(routeOnly.mappingSource, "addon-meta");
    assert.equal(routeOnly.season, 2);
    assert.equal(routeOnly.episode, 5);
    assert.equal(routeOnly.showKey, "stremio:series:kitsu%3A7442");
    assert.deepEqual(plain(routeOnly.providerMediaId), { scheme: "imdb", value: "tt2560140" });
    assert.match(routeOnly.episodeKey, /\|s2\|e5\|/u);

    const matched = createEpisodeIdentity(route, [coreState(route)], mapping);
    assert.equal(matched.identitySource, "route+core");

    const wrongEpisode = coreState(route);
    wrongEpisode.seriesInfo.episode = 18;
    assert.equal(classifyCorePlayerState(wrongEpisode, route).kind, "conflict");
    assert.equal(createEpisodeIdentity(route, [wrongEpisode], mapping), null);
    const badSeason = coreState(route, 0);
    assert.equal(classifyCorePlayerState(badSeason, route).kind, "conflict");

    assert.equal(
        buildTheIntroDbUrl(routeOnly, 1_440_000),
        "https://api.theintrodb.org/v3/media?imdb_id=tt2560140&season=2&episode=5&duration_ms=1440000",
    );
});

test("tmdb ids map directly; unknown namespaces stay without provider identity", () => {
    const tmdb = parseRoute("#/player/stream///series/tmdb%3A1396/tmdb%3A1396%3A1%3A2");
    const identity = createEpisodeIdentity(tmdb, []);
    assert.deepEqual(plain(identity.providerMediaId), { scheme: "tmdb", value: 1396 });
    assert.equal(identity.season, 1);
    assert.equal(identity.episode, 2);
    assert.match(buildTheIntroDbUrl(identity, 1000), /tmdb_id=1396&season=1&episode=2/u);

    const unknown = createEpisodeIdentity(parseRoute("#/player/stream///series/foo%3A1/foo%3A1%3A1%3A1"), []);
    assert.equal(unknown.providerMediaId, null);
    const bigTmdb = createEpisodeIdentity(parseRoute("#/player/stream///series/tmdb%3A99999999/tmdb%3A99999999%3A1%3A1"), []);
    assert.equal(bigTmdb.providerMediaId, null);
});

test("identity provider resolves single-number routes through the mapping reader and rechecks the route", async () => {
    const route = kitsuRoute();
    const reader = new AddonMetaMappingReader({ fetch: async () => jsonResponse(metaBody()) });
    let current = route;
    const provider = new EpisodeIdentityProvider(
        { current: () => current },
        { read: async () => [coreState(route)] },
        reader,
    );
    const identity = await provider.resolve(route, new AbortController().signal);
    assert.equal(identity.identitySource, "route+core");
    assert.equal(identity.season, 2);

    const stale = provider.resolve(route, new AbortController().signal);
    current = kitsuRoute("kitsu:7442:16");
    assert.equal(await stale, null);

    const noReader = new EpisodeIdentityProvider({ current: () => route }, { read: async () => [] });
    assert.equal(await noReader.resolve(route, new AbortController().signal), null);
});

test("debug log is silent by default, deduplicated, and emits only fixed codes", () => {
    const lines = [];
    const sink = { debug: (line) => lines.push(line) };
    const store = {};
    const windowObject = { localStorage: { getItem: (key) => (key in store ? store[key] : null) } };
    const reporter = createDebugReporter(windowObject, { console: sink });
    reporter.report("scope", "identity:no-provider-id");
    assert.deepEqual(lines, []);

    store["showskip.debug"] = "1";
    reporter.report("scope", "identity:no-provider-id");
    reporter.report("scope", "identity:no-provider-id");
    reporter.scoped("other")("identity:no-provider-id");
    reporter.report("scope", "https://secret.example/path");
    assert.deepEqual(lines, ["[ShowSkip] identity:no-provider-id", "[ShowSkip] identity:no-provider-id"]);

    const throwing = createDebugReporter({
        localStorage: { getItem: () => { throw new Error("blocked"); } },
    }, { console: sink });
    throwing.report("s", "media:unsupported");
    assert.equal(lines.length, 2);
});

test("mapping failures report fixed codes without leaking the URL or ids", async () => {
    const lines = [];
    const reporter = createDebugReporter(
        { localStorage: { getItem: () => "1" } },
        { console: { debug: (line) => lines.push(line) } },
    );
    const reader = new AddonMetaMappingReader({ fetch: async () => jsonResponse("", 500), debug: reporter });
    await reader.resolve(kitsuRoute());
    await reader.resolve(kitsuRoute("kitsu:7442:17", "http://insecure.test/manifest.json"));
    assert.deepEqual(lines, ["[ShowSkip] mapping:fetch-failed", "[ShowSkip] mapping:transport-unsupported"]);
    for (const line of lines) {
        assert.doesNotMatch(line, /example|insecure|kitsu|7442|http/u);
    }
});

test("Stremio Plus stand-in video is accepted only when it is the single visible candidate", () => {
    const { resolveShellVideoStandIn } = loadHooks();
    const video = (extra = {}) => ({ isConnected: true, getBoundingClientRect: () => ({ width: 10, height: 10 }), ...extra });
    const windowObject = { getComputedStyle: (el) => ({ display: el.display || "block", visibility: el.visibility || "visible" }) };
    const player = (videos) => ({ querySelectorAll: (selector) => (selector === "video[data-splus-video]" ? videos : []) });
    const one = video();
    assert.equal(resolveShellVideoStandIn(player([one]), windowObject), one);
    assert.equal(resolveShellVideoStandIn(player([one, video()]), windowObject), null);
    assert.equal(resolveShellVideoStandIn(player([video({ display: "none" })]), windowObject), null);
    assert.equal(resolveShellVideoStandIn(player([]), windowObject), null);
    assert.equal(resolveShellVideoStandIn(null, windowObject), null);
});
