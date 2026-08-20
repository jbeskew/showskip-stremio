"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadHooks() {
    const source = fs.readFileSync(path.join(__dirname, "..", "ShowSkip.plugin.js"), "utf8");
    const context = vm.createContext({
        TextEncoder,
        clearTimeout,
        console,
        setTimeout,
        __SHOWSKIP_TEST_MODE__: true,
    });
    vm.runInContext(source, context, { filename: "ShowSkip.plugin.js" });
    return context.__SHOWSKIP_TEST_HOOKS__;
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function createLogger() {
    const messages = [];
    return {
        messages,
        info(message) {
            messages.push(["info", message]);
        },
        warn(message) {
            messages.push(["warn", message]);
        },
        error(message) {
            messages.push(["error", message]);
        },
    };
}

const hooks = loadHooks();
const {
    LIMITS,
    PANEL_PALETTE,
    PANEL_ROWS,
    ProfileStore,
    CoalescedScheduler,
    ShowPageController,
    canonicalShowKey,
    createDefaultProfile,
    createStyles,
    ensureSingleOwnedNode,
    inspectJsonValue,
    normalizeState,
    parseRoute,
    resolveActiveActionRow,
    selectReconcileProfile,
} = hooks;

const EXPECTED_PANEL_ROWS = Object.freeze([
    { field: "recap", label: "Recap", values: ["auto", "button", "none"], labels: ["Auto", "Button", "Off"], selected: "button" },
    { field: "intro", label: "Intro", values: ["auto", "button", "none"], labels: ["Auto", "Button", "Off"], selected: "button" },
    { field: "credits", label: "Credits / Outro", values: ["auto", "button", "none"], labels: ["Auto", "Button", "Off"], selected: "button" },
    { field: "preview", label: "Preview", values: ["auto", "button", "none"], labels: ["Auto", "Button", "Off"], selected: "button" },
    {
        field: "nextEpisode",
        label: "Next Episode",
        values: ["atCredits", "afterCredits", "button", "stremio", "never"],
        labels: ["At credits", "After credits", "Button", "Stremio default", "Never"],
        selected: "stremio",
    },
]);

function createUiElement(tagName) {
    return {
        tagName: tagName.toUpperCase(),
        attributes: Object.create(null),
        children: [],
        className: "",
        textContent: "",
        append(...nodes) {
            this.children.push(...nodes);
        },
        appendChild(node) {
            this.children.push(node);
            return node;
        },
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attributes, name)
                ? this.attributes[name]
                : null;
        },
        hasAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attributes, name);
        },
    };
}

function renderChoiceRows(profile) {
    const documentObject = { createElement: createUiElement };
    const controller = new ShowPageController({}, documentObject, {}, () => undefined);
    controller.profile = profile;
    return Array.from(PANEL_ROWS, (row) => controller._createChoiceRow(row, "fixture"));
}

function cssRuleBody(css, selector) {
    const marker = `${selector} {`;
    const start = css.indexOf(marker);
    assert.notEqual(start, -1, `missing CSS rule: ${selector}`);
    const bodyStart = start + marker.length;
    const end = css.indexOf("}", bodyStart);
    assert.notEqual(end, -1, `unterminated CSS rule: ${selector}`);
    return css.slice(bodyStart, end);
}

function cssValue(body, property) {
    const escaped = property.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = body.match(new RegExp(`(?:^|[;\\n])\\s*${escaped}\\s*:\\s*([^;]+);`, "u"));
    assert.ok(match, `missing CSS property: ${property}`);
    return match[1].trim();
}

function relativeLuminance(hex) {
    const channels = hex.slice(1).match(/.{2}/gu).map((part) => Number.parseInt(part, 16) / 255);
    const linear = channels.map((value) => (value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4));
    return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrastRatio(first, second) {
    const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
    const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
    return (lighter + 0.05) / (darker + 0.05);
}

test("panel renders every required row and option label exactly once", () => {
    assert.equal(PANEL_ROWS.length, 5);
    assert.deepEqual(
        plain(PANEL_ROWS).map(({ field, label, values, labels }) => ({ field, label, values, labels })),
        EXPECTED_PANEL_ROWS.map(({ field, label, values, labels }) => ({ field, label, values, labels })),
    );
    assert.equal(new Set(Array.from(PANEL_ROWS, ({ field }) => field)).size, PANEL_ROWS.length);

    const rendered = renderChoiceRows(createDefaultProfile("imdb:tt0903747"));
    rendered.forEach((fieldset, rowIndex) => {
        const spec = EXPECTED_PANEL_ROWS[rowIndex];
        const [legend, group] = fieldset.children;
        const inputs = group.children.filter((_node, index) => index % 2 === 0);
        const labels = group.children.filter((_node, index) => index % 2 === 1);

        assert.equal(fieldset.getAttribute("data-showskip-setting-row"), spec.field);
        assert.equal(legend.textContent, spec.label);
        assert.equal(legend.getAttribute("data-showskip-row-label"), spec.field);
        assert.deepEqual(labels.map(({ textContent }) => textContent), spec.labels);
        assert.equal(inputs.length, labels.length);
        assert.deepEqual(inputs.map(({ value }) => value), spec.values);
        assert.equal(new Set(inputs.map(({ value }) => value)).size, inputs.length);
        inputs.forEach((input, optionIndex) => {
            assert.equal(input.getAttribute("data-showskip-field"), spec.field);
            assert.equal(labels[optionIndex].htmlFor, input.id);
            assert.equal(labels[optionIndex].getAttribute("data-showskip-option-label"), input.value);
        });
        assert.deepEqual(inputs.filter(({ checked }) => checked).map(({ value }) => value), [spec.selected]);
        assert.deepEqual(
            labels.filter((_label, optionIndex) => inputs[optionIndex].checked).map(({ textContent }) => textContent),
            [spec.labels[spec.values.indexOf(spec.selected)]],
        );
    });
});

test("panel choice rendering preserves non-default selected states", () => {
    const profile = {
        ...createDefaultProfile("imdb:tt0903747"),
        recap: "auto",
        intro: "none",
        credits: "button",
        preview: "auto",
        nextEpisode: "never",
    };
    const expectedValues = ["auto", "none", "button", "auto", "never"];
    const expectedLabels = ["Auto", "Off", "Button", "Auto", "Never"];
    const rendered = renderChoiceRows(profile);

    assert.deepEqual(rendered.map((fieldset) => {
        const group = fieldset.children[1];
        return group.children
            .filter((_node, index) => index % 2 === 0 && group.children[index].checked)
            .map(({ value }) => value)[0];
    }), expectedValues);
    assert.deepEqual(rendered.map((fieldset) => {
        const group = fieldset.children[1];
        const inputs = group.children.filter((_node, index) => index % 2 === 0);
        const labels = group.children.filter((_node, index) => index % 2 === 1);
        return labels.find((_label, index) => inputs[index].checked).textContent;
    }), expectedLabels);
});

test("panel CSS owns readable foregrounds for every control state", () => {
    const css = createStyles({ createElement: createUiElement }).textContent;
    const panel = cssRuleBody(css, "[data-showskip-panel]");
    const title = cssRuleBody(css, "[data-showskip-panel] .showskip-title");
    const close = cssRuleBody(css, "[data-showskip-panel] .showskip-close");
    const rowTitle = cssRuleBody(css, "[data-showskip-panel] .showskip-row-title");
    const group = cssRuleBody(css, "[data-showskip-panel] .showskip-choice-group");
    const option = cssRuleBody(css, "[data-showskip-panel] .showskip-choice-label");
    const optionHover = cssRuleBody(css, "[data-showskip-panel] .showskip-choice-input:not(:checked):not(:disabled) + .showskip-choice-label:hover");
    const selected = cssRuleBody(css, "[data-showskip-panel] .showskip-choice-input:checked + .showskip-choice-label");
    const selectedHover = cssRuleBody(css, "[data-showskip-panel] .showskip-choice-input:checked:not(:disabled) + .showskip-choice-label:hover");
    const disabled = cssRuleBody(css, "[data-showskip-panel] .showskip-choice-input:disabled + .showskip-choice-label");
    const disabledSelected = cssRuleBody(css, "[data-showskip-panel] .showskip-choice-input:checked:disabled + .showskip-choice-label");
    const choiceFocus = cssRuleBody(css, "[data-showskip-panel] .showskip-choice-input:focus-visible + .showskip-choice-label");
    const closeFocus = cssRuleBody(css, "[data-showskip-panel] .showskip-close:focus-visible");

    const emittedPalette = Object.create(null);
    for (const [property, key] of [
        ["--showskip-surface", "surface"],
        ["--showskip-primary-text", "primaryText"],
        ["--showskip-secondary-text", "secondaryText"],
        ["--showskip-option-text", "optionText"],
        ["--showskip-selected-text", "selectedText"],
        ["--showskip-selected-surface", "selectedSurface"],
        ["--showskip-disabled-text", "disabledText"],
        ["--showskip-disabled-selected-surface", "disabledSelectedSurface"],
        ["--showskip-control-surface", "controlSurface"],
        ["--showskip-control-hover", "controlHover"],
        ["--showskip-selected-hover", "selectedHover"],
        ["--showskip-focus-ring", "focusRing"],
    ]) {
        emittedPalette[key] = cssValue(panel, property);
        assert.equal(emittedPalette[key], PANEL_PALETTE[key]);
    }

    assert.equal(cssValue(panel, "background"), "var(--showskip-surface)");
    assert.equal(cssValue(panel, "color"), "var(--showskip-primary-text)");
    assert.equal(cssValue(title, "color"), "var(--showskip-primary-text)");
    assert.equal(cssValue(close, "color"), "var(--showskip-primary-text)");
    assert.equal(cssValue(rowTitle, "color"), "var(--showskip-secondary-text)");
    assert.equal(cssValue(group, "background"), "var(--showskip-control-surface)");
    assert.equal(cssValue(option, "color"), "var(--showskip-option-text)");
    assert.equal(cssValue(optionHover, "background"), "var(--showskip-control-hover)");
    assert.equal(cssValue(selected, "color"), "var(--showskip-selected-text)");
    assert.equal(cssValue(selected, "background"), "var(--showskip-selected-surface)");
    assert.equal(cssValue(selectedHover, "background"), "var(--showskip-selected-hover)");
    assert.equal(cssValue(disabled, "color"), "var(--showskip-disabled-text)");
    assert.equal(cssValue(disabledSelected, "background"), "var(--showskip-disabled-selected-surface)");
    assert.equal(cssValue(choiceFocus, "outline"), "2px solid var(--showskip-primary-text)");
    assert.equal(cssValue(choiceFocus, "outline-offset"), "-2px");
    assert.equal(cssValue(closeFocus, "outline"), "2px solid var(--showskip-focus-ring)");

    const criticalRules = [panel, title, close, rowTitle, option, selected, disabled].join("\n");
    assert.doesNotMatch(criticalRules, /--(?:primary|secondary)-foreground-color/u);

    for (const [foreground, background] of [
        [emittedPalette.primaryText, emittedPalette.surface],
        [emittedPalette.secondaryText, emittedPalette.surface],
        [emittedPalette.optionText, emittedPalette.controlSurface],
        [emittedPalette.optionText, emittedPalette.controlHover],
        [emittedPalette.selectedText, emittedPalette.selectedSurface],
        [emittedPalette.selectedText, emittedPalette.selectedHover],
        [emittedPalette.disabledText, emittedPalette.controlSurface],
        [emittedPalette.disabledText, emittedPalette.disabledSelectedSurface],
        [emittedPalette.focusRing, emittedPalette.surface],
        [emittedPalette.primaryText, emittedPalette.controlSurface],
        [emittedPalette.primaryText, emittedPalette.selectedSurface],
    ]) {
        assert.ok(
            contrastRatio(foreground, background) >= 4.5,
            `${foreground} on ${background} must meet 4.5:1 contrast`,
        );
    }
});

test("route parsing accepts only active series detail shapes", () => {
    assert.deepEqual(plain(parseRoute("#/detail/series/tt0903747")), {
        kind: "seriesDetail",
        routeName: "detail",
        type: "series",
        metaId: "tt0903747",
        videoId: null,
        showKey: "imdb:tt0903747",
        signature: JSON.stringify(["detail", "series", "tt0903747", null]),
    });

    assert.deepEqual(plain(parseRoute("#/metadetails/series/kitsu%3A42/kitsu%3A42%3A1%3A2?season=1")), {
        kind: "seriesDetail",
        routeName: "metadetails",
        type: "series",
        metaId: "kitsu:42",
        videoId: "kitsu:42:1:2",
        showKey: "stremio:series:kitsu%3A42",
        signature: JSON.stringify(["metadetails", "series", "kitsu:42", "kitsu:42:1:2"]),
    });

    for (const hash of [
        "#/detail/movie/tt0111161",
        "#/player/stream/url/meta/series/tt0903747",
        "#/detail/series/%E0%A4%A",
        "#/detail/series/tt0903747/episode/extra",
        "#/detail//tt0903747",
        "#/detail/series/",
        "#/home",
    ]) {
        assert.equal(parseRoute(hash).kind, "other", hash);
    }

    const delimiterInMeta = parseRoute("#/detail/series/a%7Cb");
    const delimiterInVideo = parseRoute("#/detail/series/a/b%7C");
    assert.notEqual(delimiterInMeta.signature, delimiterInVideo.signature);
});

test("canonical keys prefer IMDb and preserve exact namespaced IDs", () => {
    assert.equal(canonicalShowKey("TT1234567"), "imdb:tt1234567");
    assert.equal(canonicalShowKey("tt123456789"), "imdb:tt123456789");
    assert.equal(canonicalShowKey("kitsu:123/a"), "stremio:series:kitsu%3A123%2Fa");
    assert.equal(canonicalShowKey(""), null);
    assert.equal(canonicalShowKey(`catalog:${"x".repeat(LIMITS.maxMetaIdChars)}`), null);
});

test("default profiles are exact and isolated", () => {
    const first = createDefaultProfile("imdb:tt0903747");
    const second = createDefaultProfile("imdb:tt9288030");
    assert.deepEqual(plain(first), {
        version: 1,
        showId: "imdb:tt0903747",
        recap: "button",
        intro: "button",
        credits: "button",
        preview: "button",
        nextEpisode: "stremio",
        panelOpen: true,
    });
    first.intro = "auto";
    assert.equal(second.intro, "button");
});

test("state validation repairs individual fields and retains bounded unknown data", () => {
    const result = normalizeState({
        schemaVersion: 1,
        futureTopLevel: { enabled: true },
        profiles: {
            "imdb:tt0903747": {
                version: 1,
                showId: "wrong",
                recap: "auto",
                intro: "invalid",
                credits: "none",
                preview: "button",
                nextEpisode: "never",
                panelOpen: false,
                futureProfileField: { mode: "kept" },
            },
        },
        corrections: {},
    });

    assert.equal(result.writable, true);
    const state = plain(result.state);
    assert.deepEqual(state.futureTopLevel, { enabled: true });
    assert.equal(state.profiles["imdb:tt0903747"].recap, "auto");
    assert.equal(state.profiles["imdb:tt0903747"].intro, "button");
    assert.equal(state.profiles["imdb:tt0903747"].panelOpen, false);
    assert.equal(state.profiles["imdb:tt0903747"].showId, "imdb:tt0903747");
    assert.deepEqual(state.profiles["imdb:tt0903747"].futureProfileField, { mode: "kept" });
});

test("only explicit schema v0 migrates and future versions fail closed", () => {
    const migrated = normalizeState({
        schemaVersion: 0,
        profiles: {
            "imdb:tt0903747": {
                intro: "auto",
                panelOpen: false,
            },
        },
        corrections: {},
    });
    assert.equal(migrated.writable, true);
    assert.equal(migrated.migrated, true);
    assert.equal(migrated.state.schemaVersion, 1);
    assert.equal(migrated.state.profiles["imdb:tt0903747"].version, 1);
    assert.equal(migrated.state.profiles["imdb:tt0903747"].panelOpen, false);

    assert.equal(normalizeState({ profiles: {}, corrections: {} }).writable, false);
    assert.equal(normalizeState({ schemaVersion: 2, profiles: {}, corrections: {} }).writable, false);
    assert.equal(normalizeState({
        schemaVersion: 1,
        profiles: { "imdb:tt0903747": { version: 2 } },
        corrections: {},
    }).writable, false);
});

test("structural and size limits reject unsafe state without traversal failure", () => {
    const cyclic = { schemaVersion: 1, profiles: {}, corrections: {} };
    cyclic.self = cyclic;
    assert.equal(inspectJsonValue(cyclic), false);
    assert.equal(normalizeState(cyclic).writable, false);
    assert.equal(normalizeState("corrupt").writable, false);
    assert.equal(normalizeState([], LIMITS).writable, false);

    const tinyLimits = { ...plain(LIMITS), maxStateBytes: 100 };
    assert.equal(normalizeState({
        schemaVersion: 1,
        profiles: {},
        corrections: {},
        padding: "x".repeat(200),
    }, tinyLimits).writable, false);

    let indexedReads = 0;
    const hugeArray = new Proxy(new Array(50000), {
        get(target, property, receiver) {
            if (typeof property === "string" && /^[0-9]+$/u.test(property)) {
                indexedReads += 1;
            }
            return Reflect.get(target, property, receiver);
        },
    });
    const tinyNodeLimits = { ...plain(LIMITS), maxJsonNodes: 10 };
    assert.equal(inspectJsonValue(hugeArray, tinyNodeLimits), false);
    assert.equal(indexedReads, 0, "oversized arrays are rejected before their elements are read");

    const objectKeys = Array.from({ length: 50000 }, (_value, index) => `key${index}`);
    let descriptorReads = 0;
    let objectValueReads = 0;
    const hugeObject = new Proxy({}, {
        ownKeys() {
            return objectKeys;
        },
        getOwnPropertyDescriptor() {
            descriptorReads += 1;
            return { configurable: true, enumerable: true, value: null, writable: true };
        },
        get(target, property, receiver) {
            if (typeof property === "string") {
                objectValueReads += 1;
            }
            return Reflect.get(target, property, receiver);
        },
    });
    assert.equal(inspectJsonValue(hugeObject, tinyNodeLimits), false);
    assert.ok(descriptorReads <= tinyNodeLimits.maxJsonNodes * 2, `descriptor reads were ${descriptorReads}`);
    assert.equal(objectValueReads, 0, "oversized objects are rejected before their values are read");
});

test("schema and profile fields ignore inherited page-world values", () => {
    const inherited = {
        schemaVersion: 1,
        profiles: {},
        corrections: {},
        panelOpen: false,
        intro: "auto",
    };
    const originals = new Map();
    try {
        for (const [key, value] of Object.entries(inherited)) {
            originals.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
            Object.defineProperty(Object.prototype, key, {
                configurable: true,
                enumerable: false,
                value,
                writable: false,
            });
        }

        assert.equal(normalizeState({}).writable, false, "inherited schema fields are ignored");
        const result = normalizeState({
            schemaVersion: 1,
            profiles: { "imdb:tt0903747": {} },
            corrections: {},
        });
        assert.equal(result.writable, true);
        assert.equal(result.migrated, true);
        assert.equal(result.state.profiles["imdb:tt0903747"].intro, "button");
        assert.equal(result.state.profiles["imdb:tt0903747"].panelOpen, true);
    } finally {
        for (const [key, descriptor] of originals) {
            if (descriptor) {
                Object.defineProperty(Object.prototype, key, descriptor);
            } else {
                delete Object.prototype[key];
            }
        }
    }
});

test("profile-level repairs persist once on first access", async () => {
    const saves = [];
    const store = new ProfileStore({
        async getSetting() {
            return {
                schemaVersion: 1,
                profiles: {
                    "imdb:tt0903747": {
                        version: 0,
                        showId: "wrong",
                        recap: "button",
                        intro: "invalid",
                        credits: "button",
                        preview: "button",
                        nextEpisode: "stremio",
                        panelOpen: false,
                    },
                },
                corrections: {},
            };
        },
        async saveSetting(_key, value) {
            saves.push(plain(value));
        },
    }, createLogger());

    await store.initialize();
    assert.equal(saves.length, 0);
    const result = await store.getOrCreateProfile("imdb:tt0903747");
    assert.equal(result.profile.version, 1);
    assert.equal(result.profile.showId, "imdb:tt0903747");
    assert.equal(result.profile.intro, "button");
    assert.equal(result.profile.panelOpen, false);
    assert.equal(saves.length, 1);
    await store.getOrCreateProfile("imdb:tt0903747");
    assert.equal(saves.length, 1);
});

test("first settings rejection retries once, then creates one persisted default", async () => {
    let reads = 0;
    const saves = [];
    const logger = createLogger();
    const store = new ProfileStore({
        async getSetting(key) {
            assert.equal(key, "state_v1");
            reads += 1;
            if (reads === 1) {
                throw new Error("missing file");
            }
            return null;
        },
        async saveSetting(key, value) {
            saves.push({ key, value: plain(value) });
        },
    }, logger);

    await store.initialize();
    const created = await store.getOrCreateProfile("imdb:tt0903747");
    assert.equal(reads, 2);
    assert.equal(created.profile.panelOpen, true);
    assert.equal(created.persisted, true);
    assert.equal(saves.length, 1);
    assert.deepEqual(Object.keys(saves[0].value.profiles), ["imdb:tt0903747"]);

    await store.getOrCreateProfile("imdb:tt0903747");
    assert.equal(saves.length, 1, "existing profiles are not redundantly saved");
    assert.equal(logger.messages.length, 0);
});

test("two read failures switch to memory-only without overwriting settings", async () => {
    let reads = 0;
    let saves = 0;
    const logger = createLogger();
    const store = new ProfileStore({
        async getSetting() {
            reads += 1;
            throw new Error("unreadable");
        },
        async saveSetting() {
            saves += 1;
        },
    }, logger);

    await store.initialize();
    const created = await store.getOrCreateProfile("imdb:tt0903747");
    const updated = await store.patchProfile("imdb:tt0903747", { panelOpen: false });
    assert.equal(reads, 2);
    assert.equal(saves, 0);
    assert.equal(created.mode, "memory-only");
    assert.equal(updated.profile.panelOpen, false);
    assert.equal(logger.messages.filter(([level]) => level === "warn").length, 1);
});

test("corrupt stored state remains memory-only and is never replaced", async () => {
    let saves = 0;
    const logger = createLogger();
    const store = new ProfileStore({
        async getSetting() {
            return "not-an-object";
        },
        async saveSetting() {
            saves += 1;
        },
    }, logger);

    await store.initialize();
    const result = await store.getOrCreateProfile("imdb:tt0903747");
    assert.equal(result.profile.intro, "button");
    assert.equal(result.mode, "memory-only");
    assert.equal(saves, 0);
});

test("queued rapid updates never overlap and persist immutable ordered snapshots", async () => {
    let phase = "initial";
    let active = 0;
    let maxActive = 0;
    const snapshots = [];
    const store = new ProfileStore({
        async getSetting() {
            return null;
        },
        async saveSetting(_key, value) {
            if (phase === "initial") {
                return;
            }
            active += 1;
            maxActive = Math.max(maxActive, active);
            snapshots.push(plain(value));
            await new Promise((resolve) => setTimeout(resolve, 12));
            active -= 1;
        },
    }, createLogger());

    await store.getOrCreateProfile("imdb:tt0903747");
    phase = "patches";
    await Promise.all([
        store.patchProfile("imdb:tt0903747", { intro: "auto" }),
        store.patchProfile("imdb:tt0903747", { credits: "none" }),
    ]);

    assert.equal(maxActive, 1);
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].profiles["imdb:tt0903747"].intro, "auto");
    assert.equal(snapshots[0].profiles["imdb:tt0903747"].credits, "button");
    assert.equal(snapshots[1].profiles["imdb:tt0903747"].intro, "auto");
    assert.equal(snapshots[1].profiles["imdb:tt0903747"].credits, "none");
});

test("per-show choices and panel state remain independent", async () => {
    const saves = [];
    const store = new ProfileStore({
        async getSetting() {
            return null;
        },
        async saveSetting(_key, value) {
            saves.push(plain(value));
        },
    }, createLogger());

    await store.getOrCreateProfile("imdb:tt0903747");
    await store.patchProfile("imdb:tt0903747", { intro: "auto", panelOpen: false });
    await store.getOrCreateProfile("imdb:tt9288030");
    await store.patchProfile("imdb:tt9288030", { recap: "none" });

    const showA = await store.getOrCreateProfile("imdb:tt0903747");
    const showB = await store.getOrCreateProfile("imdb:tt9288030");
    assert.equal(showA.profile.intro, "auto");
    assert.equal(showA.profile.panelOpen, false);
    assert.equal(showA.profile.recap, "button");
    assert.equal(showB.profile.intro, "button");
    assert.equal(showB.profile.panelOpen, true);
    assert.equal(showB.profile.recap, "none");
    assert.equal(Object.keys(saves.at(-1).profiles).length, 2);
});

test("rapid close then reopen persists false followed by true", async () => {
    const values = [];
    const store = new ProfileStore({
        async getSetting() {
            return null;
        },
        async saveSetting(_key, value) {
            const profile = value.profiles["imdb:tt0903747"];
            if (profile) {
                values.push(profile.panelOpen);
            }
        },
    }, createLogger());

    await store.getOrCreateProfile("imdb:tt0903747");
    values.length = 0;
    await Promise.all([
        store.patchProfile("imdb:tt0903747", { panelOpen: false }),
        store.patchProfile("imdb:tt0903747", { panelOpen: true }),
    ]);
    assert.deepEqual(values, [false, true]);
    const result = await store.getOrCreateProfile("imdb:tt0903747");
    assert.equal(result.profile.panelOpen, true);
});

test("save failure keeps the latest profile in memory and stops later writes", async () => {
    let saves = 0;
    const logger = createLogger();
    const store = new ProfileStore({
        async getSetting() {
            return null;
        },
        async saveSetting() {
            saves += 1;
            throw new Error("disk failure");
        },
    }, logger);

    const created = await store.getOrCreateProfile("imdb:tt0903747");
    assert.equal(created.persisted, false);
    await store.patchProfile("imdb:tt0903747", { preview: "auto" });
    assert.equal(saves, 1);
    const current = await store.getOrCreateProfile("imdb:tt0903747");
    assert.equal(current.profile.preview, "auto");
    assert.equal(current.mode, "memory-only");
    assert.equal(logger.messages.filter(([level]) => level === "warn").length, 1);
});

test("returned profile mutation cannot alter store state", async () => {
    const store = new ProfileStore({
        async getSetting() {
            return null;
        },
        async saveSetting() {},
    }, createLogger());
    const first = await store.getOrCreateProfile("imdb:tt0903747");
    first.profile.intro = "none";
    const second = await store.getOrCreateProfile("imdb:tt0903747");
    assert.equal(second.profile.intro, "button");
});

test("projected byte and profile ceilings disable persistence without eviction", async () => {
    let tinySaves = 0;
    const tinyLimits = { ...plain(LIMITS), maxStateBytes: 100 };
    const tinyStore = new ProfileStore({
        async getSetting() {
            return null;
        },
        async saveSetting() {
            tinySaves += 1;
        },
    }, createLogger(), tinyLimits);
    const tinyResult = await tinyStore.getOrCreateProfile("imdb:tt0903747");
    assert.equal(tinyResult.mode, "memory-only");
    assert.equal(tinySaves, 0);

    let cappedSaves = 0;
    const cappedLimits = { ...plain(LIMITS), maxProfiles: 1 };
    const cappedStore = new ProfileStore({
        async getSetting() {
            return null;
        },
        async saveSetting() {
            cappedSaves += 1;
        },
    }, createLogger(), cappedLimits);
    await cappedStore.getOrCreateProfile("imdb:tt0903747");
    const second = await cappedStore.getOrCreateProfile("imdb:tt9288030");
    assert.equal(second.mode, "memory-only");
    assert.equal(second.profile.showId, "imdb:tt9288030");
    assert.equal(cappedSaves, 1);
    assert.deepEqual(Object.keys(plain(cappedStore.getStateForTests()).profiles), ["imdb:tt0903747"]);
});

test("invalid programmatic patches are rejected without poisoning later work", async () => {
    const store = new ProfileStore({
        async getSetting() {
            return null;
        },
        async saveSetting() {},
    }, createLogger());
    await store.getOrCreateProfile("imdb:tt0903747");
    await assert.rejects(store.patchProfile("imdb:tt0903747", { intro: "sometimes" }), /Invalid profile field/u);
    const valid = await store.patchProfile("imdb:tt0903747", { intro: "auto" });
    assert.equal(valid.profile.intro, "auto");
});

test("coalesced scheduler deduplicates work and cancels pending cleanup", async () => {
    const callbacks = new Map();
    let nextId = 1;
    let executions = 0;
    const scheduler = new CoalescedScheduler(
        (callback) => {
            const id = nextId;
            nextId += 1;
            callbacks.set(id, callback);
            return id;
        },
        (id) => callbacks.delete(id),
        () => {
            executions += 1;
        },
    );

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    assert.equal(callbacks.size, 1);
    const [id, callback] = callbacks.entries().next().value;
    callbacks.delete(id);
    callback();
    await scheduler.flush();
    assert.equal(executions, 1);

    scheduler.schedule();
    assert.equal(callbacks.size, 1);
    scheduler.destroy();
    assert.equal(callbacks.size, 0);
    scheduler.schedule();
    assert.equal(callbacks.size, 0);
});

test("coalesced scheduler allows at most one rerun during async work", async () => {
    const callbacks = new Map();
    let nextId = 1;
    let executions = 0;
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
        releaseFirst = resolve;
    });
    const scheduler = new CoalescedScheduler(
        (callback) => {
            const id = nextId;
            nextId += 1;
            callbacks.set(id, callback);
            return id;
        },
        (id) => callbacks.delete(id),
        async () => {
            executions += 1;
            if (executions === 1) {
                await firstGate;
            }
        },
    );

    scheduler.schedule();
    const [id, callback] = callbacks.entries().next().value;
    callbacks.delete(id);
    callback();
    await Promise.resolve();
    assert.equal(executions, 1);

    for (let index = 0; index < 100; index += 1) {
        scheduler.schedule();
    }
    assert.equal(callbacks.size, 0, "running work keeps only a dirty bit, not a frame backlog");

    releaseFirst();
    await scheduler.flush();
    assert.equal(executions, 2);
    scheduler.destroy();
});

test("reconciliation preserves a newer optimistic profile while storage is queued", () => {
    const context = parseRoute("#/detail/series/tt0903747");
    const controller = {
        context,
        mutationRevision: 2,
        profile: {
            ...createDefaultProfile(context.showKey),
            intro: "auto",
            panelOpen: false,
        },
    };
    const staleStored = createDefaultProfile(context.showKey);
    const selected = selectReconcileProfile(controller, context, 1, staleStored);
    assert.equal(selected.intro, "auto");
    assert.equal(selected.panelOpen, false);
    selected.intro = "none";
    assert.equal(controller.profile.intro, "auto", "the optimistic profile is cloned");

    assert.equal(selectReconcileProfile(controller, context, 2, staleStored), staleStored);
    const otherContext = parseRoute("#/detail/series/tt9288030");
    assert.equal(selectReconcileProfile(controller, otherContext, 1, staleStored), staleStored);
});

function createFakeOwnedNode(name) {
    return {
        name,
        isConnected: true,
        parentNode: null,
        removed: false,
        remove() {
            this.removed = true;
            this.isConnected = false;
            if (this.parentNode) {
                const index = this.parentNode.children.indexOf(this);
                if (index >= 0) {
                    this.parentNode.children.splice(index, 1);
                }
                this.parentNode = null;
            }
        },
    };
}

function createFakeParent() {
    return {
        children: [],
        get lastElementChild() {
            return this.children.at(-1) || null;
        },
        appendChild(node) {
            if (node.parentNode) {
                const previousIndex = node.parentNode.children.indexOf(node);
                if (previousIndex >= 0) {
                    node.parentNode.children.splice(previousIndex, 1);
                }
            }
            node.parentNode = this;
            node.isConnected = true;
            this.children.push(node);
        },
    };
}

test("owned launcher reconciliation removes duplicates and keeps one final child", () => {
    const parent = createFakeParent();
    const current = createFakeOwnedNode("current");
    const native = createFakeOwnedNode("native");
    const duplicate = createFakeOwnedNode("duplicate");
    parent.appendChild(current);
    parent.appendChild(native);
    parent.appendChild(duplicate);

    const result = ensureSingleOwnedNode(parent, [current, duplicate], current, () => {
        throw new Error("must not create");
    });
    assert.equal(result.created, false);
    assert.equal(result.node, current);
    assert.equal(duplicate.removed, true);
    assert.equal(parent.lastElementChild, current);

    current.isConnected = false;
    const replacement = createFakeOwnedNode("replacement");
    const replaced = ensureSingleOwnedNode(parent, [current], current, () => replacement);
    assert.equal(replaced.created, true);
    assert.equal(replaced.node, replacement);
    assert.equal(parent.lastElementChild, replacement);
});

class FakeClassList {
    constructor(tokens) {
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
    constructor(...classes) {
        this.classList = new FakeClassList(classes);
        this.children = [];
    }
    append(...children) {
        this.children.push(...children);
    }
    querySelectorAll(selector) {
        const match = selector.match(/^\[class\*="(.+)"\]$/u);
        const expected = match ? match[1] : null;
        const found = [];
        function visit(element) {
            for (const child of element.children) {
                if (expected && Array.from(child.classList).some((token) => token.includes(expected))) {
                    found.push(child);
                }
                visit(child);
            }
        }
        visit(this);
        return found;
    }
}

test("active action row resolution ignores retained earlier routes and fails on ambiguity", () => {
    const router = new FakeElement("routes-container");
    const retained = new FakeElement("route-container");
    retained.append(new FakeElement("route-content"));

    const active = new FakeElement("route-container");
    const routeContent = new FakeElement("route-content");
    const metaDetails = new FakeElement("metadetails-container-hash");
    const wrapper = new FakeElement("content-hash");
    const preview = new FakeElement("meta-preview-container-hash");
    const actionRow = new FakeElement("action-buttons-container-hash");
    preview.append(actionRow);
    wrapper.append(preview);
    metaDetails.append(wrapper);
    routeContent.append(metaDetails);
    active.append(routeContent);
    router.append(retained, active);

    const documentObject = {
        querySelectorAll(selector) {
            return selector === ".routes-container" ? [router] : [];
        },
    };
    assert.equal(resolveActiveActionRow(documentObject), actionRow);

    preview.append(new FakeElement("action-buttons-container-other"));
    assert.equal(resolveActiveActionRow(documentObject), null);
});
