/**
 * @name ShowSkip
 * @description Per-show intro, recap, credits, and preview skipping for Stremio Enhanced.
 * @updateUrl none
 * @version 1.0.0
 * @author ShowSkip contributors
 */

(() => {
    "use strict";

    const PLUGIN_FILENAME = "ShowSkip.plugin.js";
    const GLOBAL_INSTANCE_KEY = "__showSkipPlugin";
    const TEST_MODE_KEY = "__SHOWSKIP_TEST_MODE__";
    const TEST_HOOKS_KEY = "__SHOWSKIP_TEST_HOOKS__";
    const STATE_KEY = "state_v1";
    const SCHEMA_VERSION = 1;
    const PROFILE_VERSION = 1;
    const THEINTRODB_ENDPOINT = "https://api.theintrodb.org/v3/media";
    const THEINTRODB_ATTRIBUTION_URL = "https://theintrodb.com";

    // Final local v1 production capability. Keep this literal internal so playback
    // actions cannot be enabled or disabled by settings, page state, or remote data.
    const PHASE3_PLAYBACK_ACTIONS_ENABLED = true;

    const LIMITS = Object.freeze({
        maxProfiles: 512,
        maxStateBytes: 512 * 1024,
        maxShowKeyChars: 512,
        maxMetaIdChars: 160,
        maxProfileProperties: 32,
        maxJsonDepth: 8,
        maxJsonNodes: 10000,
    });

    const SEGMENT_FIELDS = Object.freeze(["recap", "intro", "credits", "preview"]);
    const SEGMENT_VALUES = Object.freeze(["auto", "button", "none"]);
    const NEXT_VALUES = Object.freeze(["atCredits", "afterCredits", "button", "stremio", "never"]);
    const EDITABLE_FIELDS = Object.freeze([...SEGMENT_FIELDS, "nextEpisode", "panelOpen"]);
    const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

    const DEFAULT_PROFILE_VALUES = Object.freeze({
        recap: "button",
        intro: "button",
        credits: "button",
        preview: "button",
        nextEpisode: "stremio",
        panelOpen: true,
    });

    const PANEL_ROWS = Object.freeze([
        Object.freeze({ field: "recap", label: "Recap", values: SEGMENT_VALUES, labels: ["Auto", "Button", "Off"] }),
        Object.freeze({ field: "intro", label: "Intro", values: SEGMENT_VALUES, labels: ["Auto", "Button", "Off"] }),
        Object.freeze({ field: "credits", label: "Credits / Outro", values: SEGMENT_VALUES, labels: ["Auto", "Button", "Off"] }),
        Object.freeze({ field: "preview", label: "Preview", values: SEGMENT_VALUES, labels: ["Auto", "Button", "Off"] }),
    ]);

    const PANEL_PALETTE = Object.freeze({
        surface: "#12161d",
        primaryText: "#f4f6f8",
        secondaryText: "#c3cad4",
        optionText: "#e6eaef",
        selectedText: "#ffffff",
        selectedSurface: "#0d7a86",
        disabledText: "#aab2bd",
        disabledSelectedSurface: "#2a3b42",
        controlSurface: "#1d232d",
        controlHover: "#28303d",
        selectedHover: "#0a6670",
        focusRing: "#7fe3ec",
    });

    const OWNED_SELECTOR = "[data-showskip-owned]";
    const LAUNCHER_SELECTOR = "[data-showskip-launcher]";
    const PANEL_SELECTOR = "[data-showskip-panel]";
    const TIMELINE_LAYER_SELECTOR = "[data-showskip-timeline-layer]";
    const PROVIDER_TYPES = Object.freeze(["recap", "intro", "credits", "preview"]);
    const PROVIDER_LIMITS = Object.freeze({
        maxTimestampMs: 21_600_000,
        maxSegmentsPerType: 64,
        maxResponseBytes: 256 * 1024,
        cacheEntries: 24,
        timeoutMs: 8_000,
        retryDelayMs: 250,
        maxRateRetryMs: 2_000,
        durationQuietMs: 750,
        maxDurationLookups: 2,
    });
    const SEGMENT_DURATION_LIMITS = Object.freeze({
        intro: Object.freeze({ minimum: 5_000, maximum: 200_000 }),
        recap: Object.freeze({ minimum: 5_000, maximum: 1_200_000 }),
        credits: Object.freeze({ minimum: 5_000, maximum: 1_800_000 }),
        preview: Object.freeze({ minimum: 5_000, maximum: 1_800_000 }),
    });
    const PLAYBACK_ACTION_LIMITS = Object.freeze({
        seekTimeoutMs: 1_500,
        seekableToleranceMs: 500,
        seekResultToleranceMs: 750,
        minimumForwardSeekMs: 250,
        segmentStartGraceMs: 1_000,
        segmentEndToleranceMs: 750,
        naturalForwardSlackMs: 1_500,
        maxNaturalWallDeltaMs: 2_500,
        manualSeekSuppressionMs: 1_500,
        showSkipCompletionSuppressionMs: 500,
        backwardRearmMs: 10_000,
        mediaEndToleranceMs: 1_000,
    });
    const ACTION_BUTTON_ROOT_SELECTOR = "[data-showskip-playback-action-root]";
    const SEGMENT_ACTION_ORDER = Object.freeze(["recap", "intro", "credits", "preview"]);

    function isPlainObject(value) {
        if (value === null || typeof value !== "object" || Object.prototype.toString.call(value) !== "[object Object]") {
            return false;
        }

        const prototype = Object.getPrototypeOf(value);
        return prototype === null
            || (Object.prototype.hasOwnProperty.call(prototype, "constructor")
                && prototype.constructor
                && prototype.constructor.name === "Object");
    }

    function defineSafeProperty(target, key, value) {
        if (BLOCKED_KEYS.has(key)) {
            return;
        }

        Object.defineProperty(target, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value,
        });
    }

    function hasOwn(source, key) {
        return Object.prototype.hasOwnProperty.call(source, key);
    }

    function ownValue(source, key) {
        return hasOwn(source, key) ? source[key] : undefined;
    }

    function copyOwnProperties(source, excludedKeys = new Set()) {
        const target = Object.create(null);
        if (!isPlainObject(source)) {
            return target;
        }

        for (const key of Object.keys(source)) {
            if (!excludedKeys.has(key)) {
                defineSafeProperty(target, key, source[key]);
            }
        }
        return target;
    }

    function jsonStringByteLength(value, limit) {
        if (value.length + 2 > limit) {
            return limit + 1;
        }

        let bytes = 2;
        for (let index = 0; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            if (code === 0x22 || code === 0x5c) {
                bytes += 2;
            } else if (code <= 0x1f) {
                bytes += code === 0x08
                    || code === 0x09
                    || code === 0x0a
                    || code === 0x0c
                    || code === 0x0d
                    ? 2
                    : 6;
            } else if (code <= 0x7f) {
                bytes += 1;
            } else if (code <= 0x7ff) {
                bytes += 2;
            } else if (code >= 0xd800 && code <= 0xdbff) {
                const next = value.charCodeAt(index + 1);
                if (next >= 0xdc00 && next <= 0xdfff) {
                    bytes += 4;
                    index += 1;
                } else {
                    bytes += 6;
                }
            } else if (code >= 0xdc00 && code <= 0xdfff) {
                bytes += 6;
            } else {
                bytes += 3;
            }

            if (bytes > limit) {
                return bytes;
            }
        }
        return bytes;
    }

    function inspectJsonValue(value, limits = LIMITS) {
        const seen = new WeakSet();
        const stack = [{ value, depth: 0 }];
        const maxNodes = Number.isSafeInteger(limits.maxJsonNodes) && limits.maxJsonNodes > 0
            ? limits.maxJsonNodes
            : LIMITS.maxJsonNodes;
        const maxBytes = Number.isSafeInteger(limits.maxStateBytes) && limits.maxStateBytes > 0
            ? limits.maxStateBytes
            : LIMITS.maxStateBytes;
        let discoveredNodes = 1;
        let serializedBytes = 0;

        function addBytes(count) {
            serializedBytes += count;
            return serializedBytes <= maxBytes;
        }

        while (stack.length > 0) {
            const current = stack.pop();
            if (current.depth > limits.maxJsonDepth) {
                return false;
            }

            const item = current.value;
            if (item === null) {
                if (!addBytes(4)) {
                    return false;
                }
                continue;
            }
            if (typeof item === "string") {
                const remaining = maxBytes - serializedBytes;
                if (!addBytes(jsonStringByteLength(item, remaining))) {
                    return false;
                }
                continue;
            }
            if (typeof item === "boolean") {
                if (!addBytes(item ? 4 : 5)) {
                    return false;
                }
                continue;
            }
            if (typeof item === "number") {
                if (!Number.isFinite(item) || !addBytes(String(item).length)) {
                    return false;
                }
                continue;
            }
            if (typeof item !== "object") {
                return false;
            }
            if (seen.has(item)) {
                return false;
            }
            seen.add(item);

            if (Array.isArray(item)) {
                if (discoveredNodes + item.length > maxNodes
                    || !addBytes(2 + Math.max(0, item.length - 1))) {
                    return false;
                }
                discoveredNodes += item.length;
                for (let index = item.length - 1; index >= 0; index -= 1) {
                    stack.push({ value: item[index], depth: current.depth + 1 });
                }
                continue;
            }
            if (!isPlainObject(item)) {
                return false;
            }
            const keys = [];
            for (const key in item) {
                if (!hasOwn(item, key)) {
                    continue;
                }
                if (discoveredNodes + keys.length + 1 > maxNodes) {
                    return false;
                }
                keys.push(key);
            }
            if (!addBytes(2 + Math.max(0, keys.length - 1))) {
                return false;
            }
            discoveredNodes += keys.length;
            for (const key of keys) {
                if (BLOCKED_KEYS.has(key)) {
                    return false;
                }
                const remaining = maxBytes - serializedBytes;
                if (!addBytes(jsonStringByteLength(key, remaining)) || !addBytes(1)) {
                    return false;
                }
                stack.push({ value: item[key], depth: current.depth + 1 });
            }
        }

        return true;
    }

    function serializedByteLength(value) {
        try {
            const json = JSON.stringify(value);
            if (typeof json !== "string") {
                return Number.POSITIVE_INFINITY;
            }
            if (typeof TextEncoder === "function") {
                return new TextEncoder().encode(json).byteLength;
            }
            return json.length * 2;
        } catch (_error) {
            return Number.POSITIVE_INFINITY;
        }
    }

    function cloneJson(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function isSafeMetaId(value, limits = LIMITS) {
        return typeof value === "string"
            && value.length > 0
            && value.length <= limits.maxMetaIdChars
            && !/[\u0000-\u001f\u007f]/u.test(value);
    }

    function canonicalShowKey(metaId, limits = LIMITS) {
        if (!isSafeMetaId(metaId, limits)) {
            return null;
        }

        const key = /^tt[0-9]{7,}$/iu.test(metaId)
            ? `imdb:${metaId.toLowerCase()}`
            : `stremio:series:${encodeURIComponent(metaId)}`;

        return key.length <= limits.maxShowKeyChars ? key : null;
    }

    function isValidShowKey(key, limits = LIMITS) {
        return typeof key === "string"
            && key.length > 0
            && key.length <= limits.maxShowKeyChars
            && (/^imdb:tt[0-9]{7,}$/u.test(key) || /^stremio:series:.+/u.test(key));
    }

    function isPositiveSafeInteger(value) {
        return Number.isSafeInteger(value) && value > 0;
    }

    function parseEpisodeVideoId(metaId, videoId) {
        if (!isSafeMetaId(metaId) || !isSafeMetaId(videoId)) {
            return null;
        }
        const match = /:([1-9][0-9]*):([1-9][0-9]*)$/u.exec(videoId);
        if (!match || videoId.slice(0, match.index) !== metaId) {
            return null;
        }
        const season = Number(match[1]);
        const episode = Number(match[2]);
        return isPositiveSafeInteger(season) && isPositiveSafeInteger(episode)
            ? { season, episode }
            : null;
    }

    function parseRoute(hash, limits = LIMITS) {
        if (typeof hash !== "string" || hash.length > 16_384) {
            return { kind: "other" };
        }

        let value = hash.startsWith("#") ? hash.slice(1) : hash;
        value = value.split("?", 1)[0];
        if (value.startsWith("/")) {
            value = value.slice(1);
        }
        if (value.endsWith("/")) {
            value = value.slice(0, -1);
        }

        if (!value) {
            return { kind: "other" };
        }

        const encodedParts = value.split("/");
        if (encodedParts[0] === "player") {
            if (encodedParts.length === 2 && encodedParts[1].length > 0) {
                return {
                    kind: "player",
                    eligible: false,
                    signature: JSON.stringify(["player", stableHash(value)]),
                };
            }
            if (encodedParts.length !== 7
                || encodedParts[1].length === 0
                || encodedParts[4].length === 0
                || encodedParts[5].length === 0
                || encodedParts[6].length === 0) {
                return { kind: "other" };
            }

            let type;
            let metaId;
            let videoId;
            try {
                type = decodeURIComponent(encodedParts[4]);
                metaId = decodeURIComponent(encodedParts[5]);
                videoId = decodeURIComponent(encodedParts[6]);
            } catch (_error) {
                return { kind: "other" };
            }
            if (type !== "series" || !isSafeMetaId(metaId, limits) || !isSafeMetaId(videoId, limits)) {
                return {
                    kind: "player",
                    eligible: false,
                    signature: JSON.stringify(["player", stableHash(value)]),
                };
            }
            const episodeIdentity = parseEpisodeVideoId(metaId, videoId);
            const showKey = canonicalShowKey(metaId, limits);
            return {
                kind: "player",
                eligible: Boolean(episodeIdentity && showKey),
                type,
                metaId,
                videoId,
                showKey,
                season: episodeIdentity ? episodeIdentity.season : null,
                episode: episodeIdentity ? episodeIdentity.episode : null,
                signature: JSON.stringify(["player", stableHash(value), type, metaId, videoId]),
            };
        }

        if (encodedParts.length < 3 || encodedParts.length > 4 || encodedParts.some((part) => part.length === 0)) {
            return { kind: "other" };
        }

        let parts;
        try {
            parts = encodedParts.map((part) => decodeURIComponent(part));
        } catch (_error) {
            return { kind: "other" };
        }

        const [routeName, type, metaId, videoId = null] = parts;
        if ((routeName !== "detail" && routeName !== "metadetails") || type !== "series") {
            return { kind: "other" };
        }
        if (!isSafeMetaId(metaId, limits) || (videoId !== null && !isSafeMetaId(videoId, limits))) {
            return { kind: "other" };
        }

        const showKey = canonicalShowKey(metaId, limits);
        if (!showKey) {
            return { kind: "other" };
        }

        return {
            kind: "seriesDetail",
            routeName,
            type,
            metaId,
            videoId,
            showKey,
            signature: JSON.stringify([routeName, type, metaId, videoId]),
        };
    }

    function createDefaultProfile(showKey) {
        return {
            version: PROFILE_VERSION,
            showId: showKey,
            recap: DEFAULT_PROFILE_VALUES.recap,
            intro: DEFAULT_PROFILE_VALUES.intro,
            credits: DEFAULT_PROFILE_VALUES.credits,
            preview: DEFAULT_PROFILE_VALUES.preview,
            nextEpisode: DEFAULT_PROFILE_VALUES.nextEpisode,
            panelOpen: DEFAULT_PROFILE_VALUES.panelOpen,
        };
    }

    function isAllowedProfileValue(field, value) {
        if (SEGMENT_FIELDS.includes(field)) {
            return SEGMENT_VALUES.includes(value);
        }
        if (field === "nextEpisode") {
            return NEXT_VALUES.includes(value);
        }
        return field === "panelOpen" && typeof value === "boolean";
    }

    function normalizeProfile(rawProfile, showKey) {
        const profile = copyOwnProperties(rawProfile);
        profile.version = PROFILE_VERSION;
        profile.showId = showKey;

        for (const field of SEGMENT_FIELDS) {
            const value = ownValue(rawProfile, field);
            profile[field] = SEGMENT_VALUES.includes(value)
                ? value
                : DEFAULT_PROFILE_VALUES[field];
        }
        const nextEpisode = ownValue(rawProfile, "nextEpisode");
        profile.nextEpisode = NEXT_VALUES.includes(nextEpisode)
            ? nextEpisode
            : DEFAULT_PROFILE_VALUES.nextEpisode;
        const panelOpen = ownValue(rawProfile, "panelOpen");
        profile.panelOpen = typeof panelOpen === "boolean"
            ? panelOpen
            : DEFAULT_PROFILE_VALUES.panelOpen;

        return profile;
    }

    function createEmptyState() {
        const state = Object.create(null);
        state.schemaVersion = SCHEMA_VERSION;
        state.profiles = Object.create(null);
        state.corrections = Object.create(null);
        return state;
    }

    function memoryOnlyState(reason) {
        return {
            state: createEmptyState(),
            writable: false,
            migrated: false,
            reason,
        };
    }

    function normalizeState(rawState, limits = LIMITS) {
        if (rawState === null || typeof rawState === "undefined") {
            return {
                state: createEmptyState(),
                writable: true,
                migrated: false,
                reason: null,
            };
        }
        if (!isPlainObject(rawState) || !inspectJsonValue(rawState, limits)) {
            return memoryOnlyState("Stored settings are structurally invalid.");
        }
        if (serializedByteLength(rawState) > limits.maxStateBytes) {
            return memoryOnlyState("Stored settings exceed the safe size limit.");
        }

        const sourceVersion = ownValue(rawState, "schemaVersion");
        if (sourceVersion !== 0 && sourceVersion !== SCHEMA_VERSION) {
            return memoryOnlyState("Stored settings use an unsupported schema version.");
        }
        const rawProfiles = ownValue(rawState, "profiles");
        const rawCorrections = ownValue(rawState, "corrections");
        if (typeof rawProfiles !== "undefined" && !isPlainObject(rawProfiles)) {
            return memoryOnlyState("Stored profiles are structurally invalid.");
        }
        if (typeof rawCorrections !== "undefined" && !isPlainObject(rawCorrections)) {
            return memoryOnlyState("Stored corrections are structurally invalid.");
        }

        const sourceProfiles = rawProfiles || {};
        const entries = Object.entries(sourceProfiles);
        if (entries.length > limits.maxProfiles) {
            return memoryOnlyState("Stored settings exceed the profile-count limit.");
        }

        let migrated = sourceVersion === 0
            || !Object.prototype.hasOwnProperty.call(rawState, "profiles")
            || !Object.prototype.hasOwnProperty.call(rawState, "corrections");
        const state = copyOwnProperties(rawState, new Set(["schemaVersion", "profiles", "corrections"]));
        state.schemaVersion = SCHEMA_VERSION;
        state.profiles = Object.create(null);
        state.corrections = isPlainObject(rawCorrections)
            ? cloneJson(rawCorrections)
            : Object.create(null);

        for (const [showKey, rawProfile] of entries) {
            if (!isValidShowKey(showKey, limits)
                || !isPlainObject(rawProfile)
                || Object.keys(rawProfile).length > limits.maxProfileProperties) {
                return memoryOnlyState("A stored profile is structurally invalid.");
            }
            const rawProfileVersion = ownValue(rawProfile, "version");
            if (typeof rawProfileVersion !== "undefined"
                && rawProfileVersion !== 0
                && rawProfileVersion !== PROFILE_VERSION) {
                return memoryOnlyState("A stored profile uses an unsupported version.");
            }
            const profile = normalizeProfile(rawProfile, showKey);
            if (rawProfileVersion !== PROFILE_VERSION
                || ownValue(rawProfile, "showId") !== showKey
                || SEGMENT_FIELDS.some((field) => ownValue(rawProfile, field) !== profile[field])
                || ownValue(rawProfile, "nextEpisode") !== profile.nextEpisode
                || ownValue(rawProfile, "panelOpen") !== profile.panelOpen) {
                migrated = true;
            }
            if (Object.keys(profile).length > limits.maxProfileProperties) {
                return memoryOnlyState("A normalized profile exceeds the property limit.");
            }
            defineSafeProperty(state.profiles, showKey, profile);
        }

        if (!inspectJsonValue(state, limits) || serializedByteLength(state) > limits.maxStateBytes) {
            return memoryOnlyState("Normalized settings exceed safe structural limits.");
        }

        return {
            state,
            writable: true,
            migrated,
            reason: null,
        };
    }

    function createLogger(api) {
        const logger = api && api.logger;
        function write(level, message) {
            try {
                if (logger && typeof logger[level] === "function") {
                    logger[level](message);
                }
            } catch (_error) {
                // Logging must never affect plugin behavior.
            }
        }
        return Object.freeze({
            info: (message) => write("info", message),
            warn: (message) => write("warn", message),
            error: (message) => write("error", message),
        });
    }

    class ProfileStore {
        constructor(api, logger, limits = LIMITS) {
            this.api = api;
            this.logger = logger;
            this.limits = limits;
            this.state = createEmptyState();
            this.sessionProfiles = new Map();
            this.mode = "writable";
            this.reason = null;
            this.loaded = false;
            this.migrationPending = false;
            this.warningSent = false;
            this.tail = Promise.resolve();
        }

        initialize() {
            return this._enqueue(async () => {
                await this._loadIfNeeded();
                return this.getStatus();
            });
        }

        getOrCreateProfile(showKey) {
            if (!isValidShowKey(showKey, this.limits)) {
                return Promise.reject(new TypeError("Invalid canonical show key."));
            }

            return this._enqueue(async () => {
                await this._loadIfNeeded();
                let profile = this._getInternalProfile(showKey);
                let shouldSave = this.migrationPending;

                if (!profile) {
                    profile = createDefaultProfile(showKey);
                    if (Object.keys(this.state.profiles).length >= this.limits.maxProfiles) {
                        this._disablePersistence("The profile-count limit was reached; changes are memory-only.");
                        this.sessionProfiles.set(showKey, profile);
                    } else {
                        defineSafeProperty(this.state.profiles, showKey, profile);
                    }
                    shouldSave = true;
                }

                const persisted = shouldSave ? await this._persistCurrentState() : this.mode === "writable";
                this.migrationPending = false;
                return {
                    profile: cloneJson(profile),
                    persisted,
                    mode: this.mode,
                };
            });
        }

        patchProfile(showKey, patch) {
            if (!isValidShowKey(showKey, this.limits) || !isPlainObject(patch)) {
                return Promise.reject(new TypeError("Invalid profile patch."));
            }

            for (const key of Object.keys(patch)) {
                if (!EDITABLE_FIELDS.includes(key) || !isAllowedProfileValue(key, patch[key])) {
                    return Promise.reject(new TypeError(`Invalid profile field: ${key}`));
                }
            }

            return this._enqueue(async () => {
                await this._loadIfNeeded();
                const current = this._getInternalProfile(showKey) || createDefaultProfile(showKey);
                const next = cloneJson(current);
                for (const key of Object.keys(patch)) {
                    next[key] = patch[key];
                }
                next.version = PROFILE_VERSION;
                next.showId = showKey;

                if (this.sessionProfiles.has(showKey)) {
                    this.sessionProfiles.set(showKey, next);
                } else if (Object.prototype.hasOwnProperty.call(this.state.profiles, showKey)) {
                    defineSafeProperty(this.state.profiles, showKey, next);
                } else if (Object.keys(this.state.profiles).length < this.limits.maxProfiles) {
                    defineSafeProperty(this.state.profiles, showKey, next);
                } else {
                    this._disablePersistence("The profile-count limit was reached; changes are memory-only.");
                    this.sessionProfiles.set(showKey, next);
                }

                const persisted = await this._persistCurrentState();
                return {
                    profile: cloneJson(next),
                    persisted,
                    mode: this.mode,
                };
            });
        }

        flush() {
            return this.tail;
        }

        getStatus() {
            return {
                mode: this.mode,
                reason: this.reason,
            };
        }

        getStateForTests() {
            return cloneJson(this.state);
        }

        _enqueue(operation) {
            const job = this.tail.then(operation);
            this.tail = job.then(
                () => undefined,
                () => undefined,
            );
            return job;
        }

        async _loadIfNeeded() {
            if (this.loaded) {
                return;
            }
            this.loaded = true;

            if (!this.api
                || typeof this.api.getSetting !== "function"
                || typeof this.api.saveSetting !== "function") {
                this._disablePersistence("Enhanced settings are unavailable; changes are memory-only.");
                return;
            }

            let rawState;
            try {
                rawState = await this.api.getSetting(STATE_KEY);
            } catch (_firstError) {
                try {
                    rawState = await this.api.getSetting(STATE_KEY);
                } catch (_secondError) {
                    this._disablePersistence("Enhanced settings could not be read; changes are memory-only.");
                    return;
                }
            }

            const normalized = normalizeState(rawState, this.limits);
            this.state = normalized.state;
            this.migrationPending = normalized.migrated;
            if (!normalized.writable) {
                this._disablePersistence(`${normalized.reason} Changes are memory-only.`);
            }
        }

        _getInternalProfile(showKey) {
            return this.sessionProfiles.get(showKey)
                || (Object.prototype.hasOwnProperty.call(this.state.profiles, showKey)
                    ? this.state.profiles[showKey]
                    : null);
        }

        async _persistCurrentState() {
            if (this.mode !== "writable") {
                return false;
            }

            if (!inspectJsonValue(this.state, this.limits)
                || serializedByteLength(this.state) > this.limits.maxStateBytes) {
                this._disablePersistence("The updated settings exceed safe limits; changes are memory-only.");
                return false;
            }

            const snapshot = cloneJson(this.state);
            try {
                await this.api.saveSetting(STATE_KEY, snapshot);
                return true;
            } catch (_error) {
                this._disablePersistence("Enhanced settings could not be saved; changes are memory-only.");
                return false;
            }
        }

        _disablePersistence(reason) {
            this.mode = "memory-only";
            this.reason = reason;
            if (!this.warningSent) {
                this.warningSent = true;
                this.logger.warn(reason);
            }
        }
    }

    class CoalescedScheduler {
        constructor(requestFrame, cancelFrame, task, onError = () => undefined) {
            this.requestFrame = requestFrame;
            this.cancelFrame = cancelFrame;
            this.task = task;
            this.onError = onError;
            this.handle = null;
            this.running = false;
            this.dirty = false;
            this.destroyed = false;
            this.drainPromise = Promise.resolve();
        }

        schedule() {
            if (this.destroyed) {
                return;
            }
            this.dirty = true;
            if (this.running || this.handle !== null) {
                return;
            }
            this.handle = this.requestFrame(() => {
                this.handle = null;
                if (!this.destroyed) {
                    this.drainPromise = this._drain();
                }
            });
        }

        flush() {
            return this.drainPromise;
        }

        async _drain() {
            if (this.running || this.destroyed) {
                return;
            }
            this.running = true;
            try {
                while (this.dirty && !this.destroyed) {
                    this.dirty = false;
                    try {
                        await this.task();
                    } catch (error) {
                        this.onError(error);
                    }
                }
            } finally {
                this.running = false;
                if (this.dirty && !this.destroyed) {
                    this.schedule();
                }
            }
        }

        destroy() {
            if (this.destroyed) {
                return;
            }
            this.destroyed = true;
            this.dirty = false;
            if (this.handle !== null) {
                this.cancelFrame(this.handle);
                this.handle = null;
            }
        }
    }

    function removeNode(node) {
        if (!node) {
            return;
        }
        if (typeof node.remove === "function") {
            node.remove();
        } else if (node.parentNode && typeof node.parentNode.removeChild === "function") {
            node.parentNode.removeChild(node);
        }
    }

    function ensureSingleOwnedNode(parent, candidates, currentNode, createNode) {
        let node = currentNode
            && currentNode.isConnected
            && currentNode.parentNode === parent
            ? currentNode
            : null;

        for (const candidate of candidates) {
            if (candidate !== node) {
                removeNode(candidate);
            }
        }
        if (!node) {
            node = createNode();
            parent.appendChild(node);
            return { node, created: true };
        }
        if (parent.lastElementChild !== node) {
            parent.appendChild(node);
        }
        return { node, created: false };
    }

    function hasModuleClass(element, baseName) {
        return Boolean(element
            && element.classList
            && Array.from(element.classList).some((token) => token.startsWith(`${baseName}-`)));
    }

    function directChildrenWithClass(element, className) {
        return element
            ? Array.from(element.children).filter((child) => child.classList && child.classList.contains(className))
            : [];
    }

    function descendantsWithModuleClass(element, baseName) {
        if (!element || typeof element.querySelectorAll !== "function") {
            return [];
        }
        return Array.from(element.querySelectorAll(`[class*="${baseName}-"]`))
            .filter((candidate) => hasModuleClass(candidate, baseName));
    }

    function resolveActiveActionRow(documentObject) {
        const routers = Array.from(documentObject.querySelectorAll(".routes-container"));
        if (routers.length !== 1) {
            return null;
        }

        const routeContainers = directChildrenWithClass(routers[0], "route-container");
        if (routeContainers.length === 0) {
            return null;
        }
        const activeContainer = routeContainers[routeContainers.length - 1];
        const routeContents = directChildrenWithClass(activeContainer, "route-content");
        if (routeContents.length !== 1) {
            return null;
        }

        const metaDetails = descendantsWithModuleClass(routeContents[0], "metadetails-container");
        if (metaDetails.length !== 1) {
            return null;
        }
        const previews = descendantsWithModuleClass(metaDetails[0], "meta-preview-container");
        if (previews.length !== 1) {
            return null;
        }
        const actionRows = Array.from(previews[0].children)
            .filter((child) => hasModuleClass(child, "action-buttons-container"));
        return actionRows.length === 1 ? actionRows[0] : null;
    }

    function resolveActiveRouteRoot(documentObject) {
        if (!documentObject || typeof documentObject.querySelectorAll !== "function") {
            return null;
        }
        const routers = Array.from(documentObject.querySelectorAll(".routes-container"));
        if (routers.length !== 1) {
            return null;
        }
        const routeContainers = directChildrenWithClass(routers[0], "route-container");
        if (routeContainers.length === 0) {
            return null;
        }
        const activeContainer = routeContainers[routeContainers.length - 1];
        if (activeContainer.isConnected === false) {
            return null;
        }
        const routeContents = directChildrenWithClass(activeContainer, "route-content");
        return routeContents.length === 1 ? routeContents[0] : null;
    }

    function classifyCorePlayerState(state, route) {
        if (!isPlainObject(state)) {
            return { kind: "unavailable" };
        }
        const metaItem = ownValue(state, "metaItem");
        if (!isPlainObject(metaItem)) {
            return { kind: "unavailable" };
        }
        const loadableType = ownValue(metaItem, "type");
        if (loadableType !== undefined && loadableType !== "Ready") {
            return loadableType === "Loading" || loadableType === "NotRequested"
                ? { kind: "unavailable" }
                : { kind: "conflict" };
        }
        const content = isPlainObject(metaItem) ? ownValue(metaItem, "content") : undefined;
        if (!isPlainObject(content)) {
            return loadableType === "Ready" ? { kind: "conflict" } : { kind: "unavailable" };
        }
        if (ownValue(content, "type") !== "series" || ownValue(content, "id") !== route.metaId) {
            return { kind: "conflict" };
        }
        const seriesInfo = ownValue(state, "seriesInfo");
        if (!isPlainObject(seriesInfo)
            || ownValue(seriesInfo, "season") !== route.season
            || ownValue(seriesInfo, "episode") !== route.episode) {
            return { kind: "conflict" };
        }

        const selected = ownValue(state, "selected");
        if (selected !== undefined && selected !== null) {
            if (!isPlainObject(selected)) {
                return { kind: "conflict" };
            }
            for (const [field, expectedId] of [["metaRequest", route.metaId], ["streamRequest", route.videoId]]) {
                const request = ownValue(selected, field);
                if (request === undefined || request === null) {
                    continue;
                }
                const path = isPlainObject(request) ? ownValue(request, "path") : undefined;
                if (!isPlainObject(path)
                    || ownValue(path, "type") !== "series"
                    || ownValue(path, "id") !== expectedId) {
                    return { kind: "conflict" };
                }
            }
        }

        const libraryItem = ownValue(state, "libraryItem");
        if (libraryItem !== undefined && libraryItem !== null) {
            const libraryState = isPlainObject(libraryItem) ? ownValue(libraryItem, "state") : undefined;
            if (libraryState !== undefined && libraryState !== null) {
                if (!isPlainObject(libraryState)) {
                    return { kind: "conflict" };
                }
                const libraryVideoId = ownValue(libraryState, "video_id");
                if (libraryVideoId !== undefined && libraryVideoId !== null && libraryVideoId !== route.videoId) {
                    return { kind: "conflict" };
                }
            }
        }
        return { kind: "match" };
    }

    function createEpisodeIdentity(route, coreStates = []) {
        if (!route || route.kind !== "player" || route.eligible !== true
            || !isPositiveSafeInteger(route.season) || !isPositiveSafeInteger(route.episode)) {
            return null;
        }
        let matchedCore = false;
        let conflictingCore = false;
        for (const state of coreStates) {
            const classification = classifyCorePlayerState(state, route);
            matchedCore = matchedCore || classification.kind === "match";
            conflictingCore = conflictingCore || classification.kind === "conflict";
        }
        if (conflictingCore) {
            return null;
        }

        const imdbId = /^tt[0-9]{7,8}$/iu.test(route.metaId) ? route.metaId.toLowerCase() : null;
        const episodeKey = `${route.showKey}|s${route.season}|e${route.episode}|${encodeURIComponent(route.videoId)}`;
        return Object.freeze({
            showKey: route.showKey,
            canonicalSeriesId: route.metaId,
            stremioSeriesId: route.metaId,
            stremioVideoId: route.videoId,
            episodeKey,
            season: route.season,
            episode: route.episode,
            imdbId,
            tmdbId: null,
            tvdbId: null,
            providerMediaId: imdbId ? Object.freeze({ scheme: "imdb", value: imdbId }) : null,
            activeRoute: Object.freeze({
                kind: "player",
                type: route.type,
                metaId: route.metaId,
                videoId: route.videoId,
                signature: route.signature,
            }),
            identitySource: matchedCore ? "route+core" : "route",
        });
    }

    function abortError() {
        const error = new Error("Operation aborted");
        error.name = "AbortError";
        return error;
    }

    function waitWithSignal(setTimeoutFn, clearTimeoutFn, delayMs, signal) {
        if (signal && signal.aborted) {
            return Promise.reject(abortError());
        }
        return new Promise((resolve, reject) => {
            const handle = setTimeoutFn(() => {
                if (signal) {
                    signal.removeEventListener("abort", onAbort);
                }
                resolve();
            }, delayMs);
            const onAbort = () => {
                clearTimeoutFn(handle);
                signal.removeEventListener("abort", onAbort);
                reject(abortError());
            };
            if (signal) {
                signal.addEventListener("abort", onAbort, { once: true });
            }
        });
    }

    class CoreStateReader {
        constructor(windowObject, options = {}) {
            this.window = windowObject;
            this.setTimeout = options.setTimeout || windowObject.setTimeout.bind(windowObject);
            this.clearTimeout = options.clearTimeout || windowObject.clearTimeout.bind(windowObject);
            this.timeoutMs = options.timeoutMs || 800;
            this.readers = [];
            this.activeReaders = [];
            this.refresh();
        }

        refresh() {
            const candidates = [];
            try {
                candidates.push(this.window.core);
            } catch (_error) {
                // A page-world getter may throw; that candidate is simply unavailable.
            }
            try {
                candidates.push(this.window.services && this.window.services.core);
                candidates.push(this.window.services && this.window.services.core
                    && this.window.services.core.transport);
            } catch (_error) {
                // Keep previously captured bound readers.
            }
            const activeReaders = [];
            for (const owner of candidates) {
                let method;
                try {
                    method = owner && owner.getState;
                } catch (_error) {
                    method = null;
                }
                if (!owner || typeof method !== "function") {
                    continue;
                }
                let entry = this.readers.find((candidate) => candidate.owner === owner && candidate.method === method);
                if (!entry) {
                    entry = { owner, method, read: method.bind(owner) };
                    this.readers.unshift(entry);
                }
                if (!activeReaders.includes(entry)) {
                    activeReaders.push(entry);
                }
            }
            this.readers = this.readers.slice(0, 6);
            this.activeReaders = activeReaders;
        }

        async read(signal) {
            this.refresh();
            const selectedReaders = this.activeReaders.length > 0 ? this.activeReaders : this.readers;
            const results = await Promise.all(selectedReaders.map(async (entry) => {
                try {
                    const value = await new Promise((resolve, reject) => {
                        let settled = false;
                        let timeout = null;
                        const finish = (callback, result) => {
                            if (settled) {
                                return;
                            }
                            settled = true;
                            if (timeout !== null) {
                                this.clearTimeout(timeout);
                            }
                            if (signal) {
                                signal.removeEventListener("abort", onAbort);
                            }
                            callback(result);
                        };
                        const onAbort = () => finish(reject, abortError());
                        timeout = this.setTimeout(
                            () => finish(reject, new Error("Core state read timed out")),
                            this.timeoutMs,
                        );
                        if (signal) {
                            if (signal.aborted) {
                                onAbort();
                                return;
                            }
                            signal.addEventListener("abort", onAbort, { once: true });
                        }
                        Promise.resolve().then(() => entry.read("player")).then(
                            (result) => finish(resolve, result),
                            (error) => finish(reject, error),
                        );
                    });
                    return { ok: true, value };
                } catch (_error) {
                    return { ok: false };
                }
            }));
            if (signal && signal.aborted) {
                throw abortError();
            }
            return results.filter((result) => result.ok).map((result) => result.value);
        }
    }

    class EpisodeIdentityProvider {
        constructor(contextDetector, coreStateReader) {
            this.contextDetector = contextDetector;
            this.coreStateReader = coreStateReader;
        }

        async resolve(route, signal) {
            if (!route || route.kind !== "player" || route.eligible !== true) {
                return null;
            }
            const states = await this.coreStateReader.read(signal);
            if (signal && signal.aborted) {
                throw abortError();
            }
            const current = this.contextDetector.current();
            if (current.kind !== "player" || current.signature !== route.signature) {
                return null;
            }
            return createEpisodeIdentity(route, states);
        }
    }

    function isVisiblyActiveElement(element, windowObject) {
        if (!element || element.isConnected === false) {
            return false;
        }
        if (typeof element.getBoundingClientRect === "function") {
            const rect = element.getBoundingClientRect();
            if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
                return false;
            }
        }
        if (windowObject && typeof windowObject.getComputedStyle === "function") {
            const style = windowObject.getComputedStyle(element);
            if (style && (style.display === "none" || style.visibility === "hidden")) {
                return false;
            }
        }
        return true;
    }

    function resolveActiveHtmlVideo(documentObject, windowObject) {
        const routeRoot = resolveActiveRouteRoot(documentObject);
        if (!routeRoot) {
            return null;
        }
        const players = descendantsWithModuleClass(routeRoot, "player-container");
        if (players.length !== 1 || !isVisiblyActiveElement(players[0], windowObject)) {
            return null;
        }
        const videoContainers = descendantsWithModuleClass(players[0], "video-container");
        if (videoContainers.length !== 1 || !isVisiblyActiveElement(videoContainers[0], windowObject)) {
            return null;
        }
        const videos = typeof videoContainers[0].querySelectorAll === "function"
            ? Array.from(videoContainers[0].querySelectorAll("video"))
                .filter((video) => isVisiblyActiveElement(video, windowObject))
            : [];
        return videos.length === 1 ? videos[0] : null;
    }

    function normalizeDurationMs(durationSeconds) {
        if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
            return null;
        }
        const durationMs = Math.round(durationSeconds * 1000);
        return isPositiveSafeInteger(durationMs) ? durationMs : null;
    }

    function seekResult(ok, reason, reachedMs = null) {
        return Object.freeze({ ok, reason, reachedMs });
    }

    function resolveSeekableTargetMs(videoElement, requestedMs, durationMs, toleranceMs) {
        if (!videoElement || !Number.isFinite(requestedMs) || requestedMs < 0
            || !isPositiveSafeInteger(durationMs) || requestedMs > durationMs) {
            return null;
        }
        let ranges;
        try {
            ranges = videoElement.seekable;
        } catch (_error) {
            return null;
        }
        if (!ranges || !Number.isSafeInteger(ranges.length) || ranges.length <= 0
            || typeof ranges.start !== "function" || typeof ranges.end !== "function") {
            return null;
        }
        for (let index = 0; index < ranges.length; index += 1) {
            let startSeconds;
            let endSeconds;
            try {
                startSeconds = ranges.start(index);
                endSeconds = ranges.end(index);
            } catch (_error) {
                return null;
            }
            if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)
                || startSeconds < 0 || endSeconds < startSeconds) {
                return null;
            }
            const startMs = Math.round(startSeconds * 1000);
            const endMs = Math.min(durationMs, Math.round(endSeconds * 1000));
            if (requestedMs >= startMs - toleranceMs && requestedMs <= endMs + toleranceMs) {
                return Math.min(endMs, Math.max(startMs, Math.round(requestedMs)));
            }
        }
        return null;
    }

    class HtmlMediaAdapter {
        constructor(windowObject, videoElement, options = {}) {
            this.window = windowObject;
            this.video = videoElement;
            this.listeners = new Set();
            this.eventListeners = [];
            this.destroyed = false;
            this.actionsEnabled = options.actionsEnabled === true;
            this.resolveActiveVideo = typeof options.resolveActiveVideo === "function"
                ? options.resolveActiveVideo
                : () => null;
            this.validateContext = typeof options.validateContext === "function"
                ? options.validateContext
                : () => false;
            this.onShowSkipSeekStart = typeof options.onShowSkipSeekStart === "function"
                ? options.onShowSkipSeekStart
                : () => undefined;
            this.onShowSkipSeekFinish = typeof options.onShowSkipSeekFinish === "function"
                ? options.onShowSkipSeekFinish
                : () => undefined;
            this.setTimeout = options.setTimeout
                || (windowObject && typeof windowObject.setTimeout === "function"
                    ? windowObject.setTimeout.bind(windowObject)
                    : globalThis.setTimeout);
            this.clearTimeout = options.clearTimeout
                || (windowObject && typeof windowObject.clearTimeout === "function"
                    ? windowObject.clearTimeout.bind(windowObject)
                    : globalThis.clearTimeout);
            this.seekTimeoutMs = options.seekTimeoutMs || PLAYBACK_ACTION_LIMITS.seekTimeoutMs;
            this.seekableToleranceMs = options.seekableToleranceMs || PLAYBACK_ACTION_LIMITS.seekableToleranceMs;
            this.seekResultToleranceMs = options.seekResultToleranceMs || PLAYBACK_ACTION_LIMITS.seekResultToleranceMs;
            this.minimumForwardSeekMs = options.minimumForwardSeekMs
                || PLAYBACK_ACTION_LIMITS.minimumForwardSeekMs;
            this.pendingSeek = null;
            this.capabilities = Object.freeze({
                canObserveTime: true,
                canObserveDuration: true,
                canSeek: this.actionsEnabled,
            });
            for (const type of [
                "loadedmetadata",
                "durationchange",
                "loadstart",
                "emptied",
                "timeupdate",
                "seeking",
                "seeked",
                "play",
                "playing",
                "pause",
                "ratechange",
                "ended",
            ]) {
                const handler = () => this._emit(type);
                videoElement.addEventListener(type, handler);
                this.eventListeners.push({ type, handler });
            }
        }

        getSnapshot() {
            if (this.destroyed || !this.video || this.video.isConnected === false) {
                return Object.freeze({
                    connected: false,
                    currentTimeMs: null,
                    durationMs: null,
                    readyState: 0,
                    source: "",
                    paused: null,
                    seeking: null,
                    ended: null,
                    playbackRate: null,
                });
            }
            let currentTime;
            let duration;
            let readyState;
            let source;
            let paused;
            let seeking;
            let ended;
            let playbackRate;
            try {
                currentTime = this.video.currentTime;
                duration = this.video.duration;
                readyState = this.video.readyState;
                source = this.video.currentSrc || this.video.src || "";
                paused = this.video.paused;
                seeking = this.video.seeking;
                ended = this.video.ended;
                playbackRate = this.video.playbackRate;
            } catch (_error) {
                return Object.freeze({
                    connected: false,
                    currentTimeMs: null,
                    durationMs: null,
                    readyState: 0,
                    source: "",
                    paused: null,
                    seeking: null,
                    ended: null,
                    playbackRate: null,
                });
            }
            const currentTimeMs = typeof currentTime === "number" && Number.isFinite(currentTime) && currentTime >= 0
                ? Math.round(currentTime * 1000)
                : null;
            return Object.freeze({
                connected: true,
                currentTimeMs,
                durationMs: normalizeDurationMs(duration),
                readyState: Number.isFinite(readyState) ? readyState : 0,
                source: typeof source === "string" ? source : "",
                paused: typeof paused === "boolean" ? paused : null,
                seeking: typeof seeking === "boolean" ? seeking : null,
                ended: typeof ended === "boolean" ? ended : null,
                playbackRate: typeof playbackRate === "number" && Number.isFinite(playbackRate) && playbackRate > 0
                    ? playbackRate
                    : null,
            });
        }

        async seekToMs(requestedMs, context, signal) {
            if (!this.actionsEnabled || !this.capabilities.canSeek) {
                return seekResult(false, "gate-disabled");
            }
            if (this.destroyed || this.pendingSeek) {
                return seekResult(false, this.destroyed ? "adapter-destroyed" : "seek-pending");
            }
            if (!context || !this._contextIsLive(context)) {
                return seekResult(false, "stale-context");
            }
            const snapshot = this.getSnapshot();
            if (!snapshot.connected || snapshot.source !== context.source
                || snapshot.durationMs !== context.durationMs || !isPositiveSafeInteger(snapshot.durationMs)) {
                return seekResult(false, "invalid-media");
            }
            if (snapshot.currentTimeMs === null || !Number.isFinite(requestedMs)
                || requestedMs < snapshot.currentTimeMs + this.minimumForwardSeekMs) {
                return seekResult(false, "target-not-forward");
            }
            const targetMs = resolveSeekableTargetMs(
                this.video,
                requestedMs,
                snapshot.durationMs,
                this.seekableToleranceMs,
            );
            if (targetMs === null) {
                return seekResult(false, "target-not-seekable");
            }
            if (signal && signal.aborted) {
                return seekResult(false, "aborted");
            }

            return new Promise((resolve) => {
                let settled = false;
                let timeout = null;
                const observed = [];
                const finish = (result) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    if (timeout !== null) {
                        this.clearTimeout(timeout);
                    }
                    for (const { type, handler } of observed) {
                        this.video.removeEventListener(type, handler);
                    }
                    if (signal) {
                        signal.removeEventListener("abort", onAbort);
                    }
                    if (this.pendingSeek === pending) {
                        this.pendingSeek = null;
                    }
                    try {
                        this.onShowSkipSeekFinish(context, result);
                    } catch (_error) {
                        // An observer cannot change the adapter result.
                    }
                    resolve(result);
                };
                const validateProgress = (eventType) => {
                    if (eventType === "loadstart" || eventType === "emptied" || eventType === "durationchange") {
                        finish(seekResult(false, "media-invalidated"));
                        return;
                    }
                    if (!this._contextIsLive(context)) {
                        finish(seekResult(false, "stale-context"));
                        return;
                    }
                    const current = this.getSnapshot();
                    if (!current.connected || current.source !== context.source
                        || current.durationMs !== context.durationMs) {
                        finish(seekResult(false, "stale-media"));
                        return;
                    }
                    if (current.currentTimeMs !== null
                        && Math.abs(current.currentTimeMs - targetMs) <= this.seekResultToleranceMs) {
                        finish(seekResult(true, "reached", current.currentTimeMs));
                    } else if (eventType === "seeked") {
                        finish(seekResult(false, "position-mismatch", current.currentTimeMs));
                    }
                };
                const onAbort = () => finish(seekResult(false, "aborted"));
                const pending = Object.freeze({
                    context,
                    targetMs,
                    abort: () => finish(seekResult(false, "adapter-destroyed")),
                });
                this.pendingSeek = pending;

                for (const type of ["seeked", "timeupdate", "loadstart", "emptied", "durationchange"]) {
                    const handler = () => validateProgress(type);
                    this.video.addEventListener(type, handler);
                    observed.push({ type, handler });
                }
                if (signal) {
                    signal.addEventListener("abort", onAbort, { once: true });
                }
                timeout = this.setTimeout(
                    () => finish(seekResult(false, "timeout", this.getSnapshot().currentTimeMs)),
                    this.seekTimeoutMs,
                );
                try {
                    this.onShowSkipSeekStart(context, targetMs);
                    if (!this._contextIsLive(context)) {
                        finish(seekResult(false, "stale-context"));
                        return;
                    }
                    // The sole production playback-position write is intentionally confined here.
                    this.video.currentTime = targetMs / 1000;
                } catch (_error) {
                    finish(seekResult(false, "write-failed"));
                }
            });
        }

        subscribe(listener) {
            if (typeof listener !== "function" || this.destroyed) {
                return () => undefined;
            }
            this.listeners.add(listener);
            return () => this.listeners.delete(listener);
        }

        destroy() {
            if (this.destroyed) {
                return;
            }
            this.destroyed = true;
            if (this.pendingSeek && typeof this.pendingSeek.abort === "function") {
                this.pendingSeek.abort();
            }
            for (const { type, handler } of this.eventListeners) {
                this.video.removeEventListener(type, handler);
            }
            this.eventListeners = [];
            this.listeners.clear();
        }

        _contextIsLive(context) {
            if (this.destroyed || !this.video || this.video.isConnected === false) {
                return false;
            }
            try {
                return this.resolveActiveVideo() === this.video && this.validateContext(context) === true;
            } catch (_error) {
                return false;
            }
        }

        _emit(type) {
            const snapshot = this.getSnapshot();
            for (const listener of this.listeners) {
                try {
                    listener({ type, snapshot });
                } catch (_error) {
                    // One observer must not break media observation for the plugin.
                }
            }
        }
    }

    function nextAvailability(known, available, reason) {
        return Object.freeze({ known, available, reason });
    }

    class NextEpisodeAdapter {
        constructor(options = {}) {
            this.actionsEnabled = options.actionsEnabled === true;
            this.validateContext = typeof options.validateContext === "function"
                ? options.validateContext
                : () => false;
            this.readAvailability = typeof options.readAvailability === "function"
                ? options.readAvailability
                : null;
            this.transition = typeof options.transition === "function" ? options.transition : null;
            this.capabilities = Object.freeze({
                canVerifyAvailability: this.actionsEnabled && this.readAvailability !== null,
                canAdvance: this.actionsEnabled && this.readAvailability !== null && this.transition !== null,
            });
        }

        getAvailability(context) {
            if (!this.actionsEnabled) {
                return nextAvailability(false, false, "gate-disabled");
            }
            if (!this.capabilities.canVerifyAvailability || !this._contextIsLive(context)) {
                return nextAvailability(false, false, "mechanism-unavailable");
            }
            try {
                const result = this.readAvailability(context);
                return isPlainObject(result) && ownValue(result, "known") === true
                    && typeof ownValue(result, "available") === "boolean"
                    ? nextAvailability(true, result.available, result.available ? "available" : "no-next-episode")
                    : nextAvailability(false, false, "unverified-availability");
            } catch (_error) {
                return nextAvailability(false, false, "availability-failed");
            }
        }

        async advance(context, signal) {
            if (!this.actionsEnabled) {
                return Object.freeze({ ok: false, reason: "gate-disabled" });
            }
            if (!this.capabilities.canAdvance || !this._contextIsLive(context)) {
                return Object.freeze({ ok: false, reason: "mechanism-unavailable" });
            }
            const availability = this.getAvailability(context);
            if (!availability.known || !availability.available) {
                return Object.freeze({ ok: false, reason: availability.reason });
            }
            if (signal && signal.aborted) {
                return Object.freeze({ ok: false, reason: "aborted" });
            }
            try {
                if (!this._contextIsLive(context)) {
                    return Object.freeze({ ok: false, reason: "stale-context" });
                }
                const result = await this.transition(context, signal);
                if (signal && signal.aborted) {
                    return Object.freeze({ ok: false, reason: "aborted" });
                }
                if (!this._contextIsLive(context)) {
                    return Object.freeze({ ok: false, reason: "stale-context" });
                }
                return result === true || (isPlainObject(result) && ownValue(result, "ok") === true)
                    ? Object.freeze({ ok: true, reason: "transition-requested" })
                    : Object.freeze({ ok: false, reason: "transition-failed" });
            } catch (_error) {
                return Object.freeze({
                    ok: false,
                    reason: signal && signal.aborted ? "aborted" : "transition-failed",
                });
            }
        }

        _contextIsLive(context) {
            try {
                return Boolean(context) && this.validateContext(context) === true;
            } catch (_error) {
                return false;
            }
        }
    }

    function actionResult(automaticAction = null, buttonAction = null, naturalForward = false) {
        return Object.freeze({ automaticAction, buttonAction, naturalForward });
    }

    function segmentActionLabel(type) {
        return ({
            recap: "Skip Recap",
            intro: "Skip Intro",
            credits: "Skip Credits",
            preview: "Skip Preview",
        })[type] || "Skip Segment";
    }

    function compareSegmentActions(first, second) {
        if (first.endMs !== second.endMs) {
            return first.endMs - second.endMs;
        }
        const firstType = SEGMENT_ACTION_ORDER.indexOf(first.type);
        const secondType = SEGMENT_ACTION_ORDER.indexOf(second.type);
        if (firstType !== secondType) {
            return firstType - secondType;
        }
        return String(first.id).localeCompare(String(second.id));
    }

    function validActionSegments(segments, durationMs) {
        return Array.isArray(segments) && isPositiveSafeInteger(durationMs)
            ? segments.filter((segment) => isPlainObject(segment)
                && PROVIDER_TYPES.includes(segment.type)
                && typeof segment.id === "string" && segment.id.length > 0
                && Number.isSafeInteger(segment.startMs) && segment.startMs >= 0
                && Number.isSafeInteger(segment.endMs) && segment.endMs > segment.startMs
                && segment.endMs <= durationMs)
            : [];
    }

    class PlaybackActionStateMachine {
        constructor(options = {}) {
            this.actionsEnabled = options.actionsEnabled === true;
            this.limits = options.limits || PLAYBACK_ACTION_LIMITS;
            this.reset();
        }

        reset(sessionKey = null) {
            this.sessionKey = sessionKey;
            this.firedSegmentIds = new Set();
            this.pendingSegmentIds = new Set();
            this.blockedSegmentIds = new Set();
            this.previousPositionMs = null;
            this.previousWallMs = null;
            this.initialPositionMs = null;
            this.nativeSeeking = false;
            this.showSkipSeek = null;
            this.suppressUntilWallMs = 0;
            this.lastNaturalForward = false;
            this.nextPending = false;
            this.nextFired = false;
            this.nextBlocked = false;
        }

        observe(input) {
            if (!this.actionsEnabled || !input || typeof input.sessionKey !== "string") {
                return actionResult();
            }
            if (input.sessionKey !== this.sessionKey) {
                this.reset(input.sessionKey);
            }
            const positionMs = input.positionMs;
            const durationMs = input.durationMs;
            const nowMs = input.nowMs;
            const eventType = typeof input.eventType === "string" ? input.eventType : "sample";
            if (!Number.isSafeInteger(positionMs) || positionMs < 0
                || !isPositiveSafeInteger(durationMs) || positionMs > durationMs
                || !Number.isFinite(nowMs)) {
                return actionResult();
            }
            const segments = validActionSegments(input.segments, durationMs);
            const profile = isPlainObject(input.profile) ? input.profile : DEFAULT_PROFILE_VALUES;
            if (this.initialPositionMs === null) {
                this.initialPositionMs = positionMs;
            }

            for (const segment of segments) {
                if (this.blockedSegmentIds.has(segment.id)
                    && (positionMs < segment.startMs || positionMs >= segment.endMs)) {
                    this.blockedSegmentIds.delete(segment.id);
                }
            }

            const previousPositionMs = this.previousPositionMs;
            const previousWallMs = this.previousWallMs;
            const mediaDeltaMs = previousPositionMs === null ? null : positionMs - previousPositionMs;
            const wallDeltaMs = previousWallMs === null ? null : Math.max(0, nowMs - previousWallMs);
            const showSkipSeeking = this.showSkipSeek !== null;
            const playbackRate = typeof input.playbackRate === "number" && Number.isFinite(input.playbackRate)
                && input.playbackRate > 0
                ? input.playbackRate
                : 1;
            const nativeSeekEvent = eventType === "seeking" || eventType === "seeked";
            const implausibleForward = mediaDeltaMs !== null && wallDeltaMs !== null
                && mediaDeltaMs > (wallDeltaMs * playbackRate) + this.limits.naturalForwardSlackMs;
            const substantialBackward = mediaDeltaMs !== null && mediaDeltaMs <= -this.limits.backwardRearmMs;
            const userDiscontinuity = !showSkipSeeking
                && (nativeSeekEvent || implausibleForward || substantialBackward);

            if (eventType === "seeking" && !showSkipSeeking) {
                this.nativeSeeking = true;
            }
            if (userDiscontinuity) {
                this.suppressUntilWallMs = Math.max(
                    this.suppressUntilWallMs,
                    nowMs + this.limits.manualSeekSuppressionMs,
                );
            }
            if (substantialBackward && !showSkipSeeking && previousPositionMs !== null) {
                for (const segment of segments) {
                    if (this.firedSegmentIds.has(segment.id)
                        && previousPositionMs >= segment.endMs - this.limits.segmentEndToleranceMs
                        && positionMs <= segment.startMs + this.limits.segmentStartGraceMs) {
                        this.firedSegmentIds.delete(segment.id);
                        this.blockedSegmentIds.delete(segment.id);
                    }
                }
                if (positionMs <= this.limits.segmentStartGraceMs) {
                    this.nextFired = false;
                    this.nextBlocked = false;
                }
            }

            const naturalForward = previousPositionMs !== null && previousWallMs !== null
                && eventType === "timeupdate"
                && mediaDeltaMs > 0
                && wallDeltaMs > 0 && wallDeltaMs <= this.limits.maxNaturalWallDeltaMs
                && mediaDeltaMs <= (wallDeltaMs * playbackRate) + this.limits.naturalForwardSlackMs
                && !this.nativeSeeking && !nativeSeekEvent && !showSkipSeeking
                && input.paused !== true && input.seeking !== true && input.ended !== true
                && nowMs >= this.suppressUntilWallMs;
            const naturalEntries = naturalForward
                ? segments.filter((segment) => this._isNaturalEntry(segment, previousPositionMs, positionMs))
                : [];
            const nextAvailable = input.nextAvailable === true;
            let automaticAction = null;

            if (!this.nextPending && !this.nextFired && !this.nextBlocked && nextAvailable) {
                if (ownValue(profile, "nextEpisode") === "atCredits") {
                    const credits = naturalEntries.filter((segment) => segment.type === "credits")
                        .sort(compareSegmentActions)[0];
                    if (credits) {
                        automaticAction = Object.freeze({
                            kind: "next",
                            mode: "atCredits",
                            id: `next:atCredits:${credits.id}`,
                            segmentId: credits.id,
                            label: "Next Episode",
                        });
                    }
                } else if (ownValue(profile, "nextEpisode") === "afterCredits"
                    && eventType === "ended"
                    && input.ended === true
                    && positionMs >= durationMs - this.limits.mediaEndToleranceMs
                    && (naturalForward || this.lastNaturalForward)) {
                    const terminalCredits = segments.find((segment) => segment.type === "credits"
                        && segment.endsAtMediaEnd === true && segment.endMs === durationMs);
                    if (terminalCredits) {
                        automaticAction = Object.freeze({
                            kind: "next",
                            mode: "afterCredits",
                            id: `next:afterCredits:${terminalCredits.id}`,
                            segmentId: terminalCredits.id,
                            label: "Next Episode",
                        });
                    }
                }
            }

            if (!automaticAction) {
                const automaticSegments = naturalEntries
                    .filter((segment) => ownValue(profile, segment.type) === "auto"
                        && !this.firedSegmentIds.has(segment.id)
                        && !this.pendingSegmentIds.has(segment.id)
                        && !this.blockedSegmentIds.has(segment.id))
                    .sort(compareSegmentActions);
                const segment = automaticSegments[0];
                if (segment) {
                    automaticAction = Object.freeze({
                        kind: "segment",
                        mode: "auto",
                        id: segment.id,
                        segmentId: segment.id,
                        segmentType: segment.type,
                        targetMs: segment.endMs,
                        label: segmentActionLabel(segment.type),
                    });
                }
            }

            const insideSegments = segments.filter((segment) => positionMs >= segment.startMs
                && positionMs < segment.endMs - this.limits.segmentEndToleranceMs);
            let buttonAction = null;
            if (!this.nativeSeeking && input.seeking !== true
                && !this.nextPending && !this.nextFired && !this.nextBlocked && nextAvailable
                && ownValue(profile, "nextEpisode") === "button"
                && insideSegments.some((segment) => segment.type === "credits")) {
                const credits = insideSegments.filter((segment) => segment.type === "credits")
                    .sort(compareSegmentActions)[0];
                buttonAction = Object.freeze({
                    kind: "next",
                    mode: "button",
                    id: `next:button:${credits.id}`,
                    segmentId: credits.id,
                    label: "Next Episode",
                });
            }
            if (!buttonAction && !this.nativeSeeking && input.seeking !== true) {
                const buttonSegments = insideSegments
                    .filter((segment) => ownValue(profile, segment.type) === "button"
                        && !this.firedSegmentIds.has(segment.id)
                        && !this.pendingSegmentIds.has(segment.id)
                        && !this.blockedSegmentIds.has(segment.id))
                    .sort(compareSegmentActions);
                const segment = buttonSegments[0];
                if (segment) {
                    buttonAction = Object.freeze({
                        kind: "segment",
                        mode: "button",
                        id: segment.id,
                        segmentId: segment.id,
                        segmentType: segment.type,
                        targetMs: segment.endMs,
                        label: segmentActionLabel(segment.type),
                    });
                }
            }

            if (eventType === "seeked" && !showSkipSeeking) {
                this.nativeSeeking = false;
            }
            this.previousPositionMs = positionMs;
            this.previousWallMs = nowMs;
            this.lastNaturalForward = naturalForward;
            return actionResult(automaticAction, buttonAction, naturalForward);
        }

        reserve(action) {
            if (!this.actionsEnabled || !action) {
                return false;
            }
            if (action.kind === "segment") {
                if (this.pendingSegmentIds.size > 0 || this.nextPending
                    || this.firedSegmentIds.has(action.segmentId)
                    || this.pendingSegmentIds.has(action.segmentId)
                    || this.blockedSegmentIds.has(action.segmentId)) {
                    return false;
                }
                this.pendingSegmentIds.add(action.segmentId);
                return true;
            }
            if (action.kind === "next" && !this.nextPending && !this.nextFired && !this.nextBlocked) {
                this.nextPending = true;
                return true;
            }
            return false;
        }

        beginShowSkipSeek(action, targetMs) {
            if (action && action.kind === "segment" && this.pendingSegmentIds.has(action.segmentId)) {
                this.showSkipSeek = Object.freeze({ segmentId: action.segmentId, targetMs });
            }
        }

        complete(action, succeeded, nowMs) {
            if (!action) {
                return;
            }
            if (action.kind === "segment") {
                this.pendingSegmentIds.delete(action.segmentId);
                if (succeeded) {
                    this.firedSegmentIds.add(action.segmentId);
                    this.suppressUntilWallMs = Math.max(
                        this.suppressUntilWallMs,
                        nowMs + this.limits.showSkipCompletionSuppressionMs,
                    );
                } else {
                    this.blockedSegmentIds.add(action.segmentId);
                }
                if (this.showSkipSeek && this.showSkipSeek.segmentId === action.segmentId) {
                    this.showSkipSeek = null;
                }
            } else if (action.kind === "next") {
                this.nextPending = false;
                this.nextFired = succeeded;
                this.nextBlocked = !succeeded;
            }
        }

        debugState() {
            return Object.freeze({
                sessionKey: this.sessionKey,
                firedSegmentIds: Object.freeze([...this.firedSegmentIds]),
                pendingSegmentIds: Object.freeze([...this.pendingSegmentIds]),
                blockedSegmentIds: Object.freeze([...this.blockedSegmentIds]),
                previousPositionMs: this.previousPositionMs,
                previousWallMs: this.previousWallMs,
                nativeSeeking: this.nativeSeeking,
                showSkipSeek: this.showSkipSeek,
                suppressUntilWallMs: this.suppressUntilWallMs,
                nextPending: this.nextPending,
                nextFired: this.nextFired,
                nextBlocked: this.nextBlocked,
            });
        }

        _isNaturalEntry(segment, previousPositionMs, positionMs) {
            const beforeBoundary = previousPositionMs <= segment.startMs;
            const inEntryWindow = positionMs >= Math.max(0, segment.startMs - this.limits.segmentStartGraceMs)
                && positionMs < segment.endMs - this.limits.segmentEndToleranceMs
                && positionMs <= segment.startMs + this.limits.segmentStartGraceMs;
            if (segment.startMs > 0) {
                return beforeBoundary && inEntryWindow;
            }
            return this.initialPositionMs <= this.limits.segmentStartGraceMs
                && previousPositionMs <= this.limits.segmentStartGraceMs
                && positionMs < segment.endMs - this.limits.segmentEndToleranceMs
                && positionMs <= this.limits.segmentStartGraceMs + this.limits.naturalForwardSlackMs;
        }
    }

    class PlayerActionRenderer {
        constructor(documentObject, options = {}) {
            this.document = documentObject;
            this.actionsEnabled = options.actionsEnabled === true;
            this.root = null;
            this.button = null;
            this.signature = null;
            this.clickHandler = null;
            this.busy = false;
        }

        render(action, contextSignature, onActivate, isLive) {
            if (!this.actionsEnabled || !action || typeof onActivate !== "function" || typeof isLive !== "function") {
                this.clear();
                return false;
            }
            const target = resolveActiveSeekTarget(this.document);
            if (!target) {
                this.clear();
                return false;
            }
            this._removeOtherRoots(this.root);
            const signature = `${contextSignature}|${action.kind}|${action.mode}|${action.id}`;
            if (this.root && this.root.isConnected !== false && this.root.parentNode === target.player
                && this.signature === signature) {
                return true;
            }
            this.clear();
            const root = this.document.createElement("div");
            root.setAttribute("data-showskip-owned", "playback-action");
            root.setAttribute("data-showskip-playback-action-root", "");
            const button = this.document.createElement("button");
            button.setAttribute("type", "button");
            button.setAttribute("data-showskip-playback-action", action.kind);
            button.setAttribute("aria-label", action.label);
            button.setAttribute("data-showskip-action-id", action.id);
            if (action.segmentType) {
                button.setAttribute("data-showskip-segment-type", action.segmentType);
            }
            button.type = "button";
            button.textContent = action.label;
            this.root = root;
            this.button = button;
            this.signature = signature;
            this.busy = false;
            this.clickHandler = () => {
                let live = false;
                try {
                    live = isLive(action, contextSignature) === true;
                } catch (_error) {
                    live = false;
                }
                if (this.busy || !this.actionsEnabled || this.button !== button
                    || this.signature !== signature || root.isConnected === false || !live) {
                    return;
                }
                this.busy = true;
                button.disabled = true;
                button.setAttribute("aria-busy", "true");
                void Promise.resolve().then(() => onActivate(action, contextSignature)).catch(() => undefined).finally(() => {
                    if (this.button === button && this.signature === signature) {
                        this.clear();
                    }
                });
            };
            button.addEventListener("click", this.clickHandler);
            root.appendChild(button);
            target.player.appendChild(root);
            this._removeOtherRoots(root);
            return true;
        }

        clear() {
            if (this.button && this.clickHandler) {
                this.button.removeEventListener("click", this.clickHandler);
            }
            removeNode(this.root);
            this.root = null;
            this.button = null;
            this.signature = null;
            this.clickHandler = null;
            this.busy = false;
            this._removeOtherRoots(null);
        }

        destroy() {
            this.clear();
        }

        _removeOtherRoots(keep) {
            if (!this.document || typeof this.document.querySelectorAll !== "function") {
                return;
            }
            for (const candidate of Array.from(this.document.querySelectorAll(ACTION_BUTTON_ROOT_SELECTOR))) {
                if (candidate !== keep) {
                    removeNode(candidate);
                }
            }
        }
    }

    class DurationStabilizer {
        constructor(options) {
            this.setTimeout = options.setTimeout;
            this.clearTimeout = options.clearTimeout;
            this.quietMs = options.quietMs || PROVIDER_LIMITS.durationQuietMs;
            this.maxDistinct = options.maxDistinct || PROVIDER_LIMITS.maxDurationLookups;
            this.onStable = options.onStable;
            this.onLimit = options.onLimit || (() => undefined);
            this.scopeKey = null;
            this.candidate = null;
            this.timer = null;
            this.issued = new Set();
        }

        update(scopeKey, durationMs) {
            if (scopeKey !== this.scopeKey) {
                this.reset(scopeKey);
            }
            if (!isPositiveSafeInteger(durationMs)) {
                this._clearTimer();
                this.candidate = null;
                return;
            }
            if (this.issued.has(durationMs)) {
                this._clearTimer();
                this.candidate = durationMs;
                return;
            }
            if (this.candidate === durationMs && this.timer !== null) {
                return;
            }
            this._clearTimer();
            this.candidate = durationMs;
            this.timer = this.setTimeout(() => {
                this.timer = null;
                if (this.candidate !== durationMs || this.scopeKey !== scopeKey) {
                    return;
                }
                if (this.issued.size >= this.maxDistinct) {
                    this.onLimit({ scopeKey, durationMs });
                    return;
                }
                this.issued.add(durationMs);
                this.onStable({ scopeKey, durationMs });
            }, this.quietMs);
        }

        reset(scopeKey = null) {
            this._clearTimer();
            this.scopeKey = scopeKey;
            this.candidate = null;
            this.issued = new Set();
        }

        destroy() {
            this.reset(null);
        }

        _clearTimer() {
            if (this.timer !== null) {
                this.clearTimeout(this.timer);
                this.timer = null;
            }
        }
    }

    class SessionSegmentCache {
        constructor(maxEntries = PROVIDER_LIMITS.cacheEntries) {
            this.maxEntries = maxEntries;
            this.entries = new Map();
        }

        get(key) {
            if (!this.entries.has(key)) {
                return null;
            }
            const value = this.entries.get(key);
            this.entries.delete(key);
            this.entries.set(key, value);
            return value;
        }

        set(key, value) {
            this.entries.delete(key);
            this.entries.set(key, value);
            while (this.entries.size > this.maxEntries) {
                const oldest = this.entries.keys().next().value;
                this.entries.delete(oldest);
            }
        }

        clear() {
            this.entries.clear();
        }
    }

    function providerCacheKey(identity, durationMs) {
        if (!identity || typeof identity.episodeKey !== "string" || !isPositiveSafeInteger(durationMs)) {
            return null;
        }
        return `theintrodb|anonymous|${identity.episodeKey}|duration=${durationMs}`;
    }

    function buildTheIntroDbUrl(identity, durationMs) {
        if (!identity || !isPositiveSafeInteger(identity.season)
            || !isPositiveSafeInteger(identity.episode) || !isPositiveSafeInteger(durationMs)) {
            return null;
        }
        const mediaId = identity.providerMediaId;
        let idQuery;
        if (mediaId && mediaId.scheme === "imdb" && /^tt[0-9]{7,8}$/u.test(mediaId.value)) {
            idQuery = `imdb_id=${encodeURIComponent(mediaId.value)}`;
        } else if (mediaId && mediaId.scheme === "tmdb"
            && isPositiveSafeInteger(mediaId.value) && mediaId.value <= 10_000_000) {
            idQuery = `tmdb_id=${mediaId.value}`;
        } else if (mediaId && mediaId.scheme === "tvdb"
            && isPositiveSafeInteger(mediaId.value) && mediaId.value <= 10_000_000) {
            idQuery = `tvdb_id=${mediaId.value}`;
        } else {
            return null;
        }
        return `${THEINTRODB_ENDPOINT}?${idQuery}&season=${identity.season}&episode=${identity.episode}&duration_ms=${durationMs}`;
    }

    function isProviderTimestamp(value) {
        return value === null
            || (Number.isSafeInteger(value) && value >= 0 && value <= PROVIDER_LIMITS.maxTimestampMs);
    }

    function classifyProviderSegment(type, rawSegment, actualDurationMs) {
        if (!PROVIDER_TYPES.includes(type) || !isPlainObject(rawSegment)
            || !hasOwn(rawSegment, "start_ms") || !hasOwn(rawSegment, "end_ms")) {
            return { kind: "malformed" };
        }
        const rawStart = rawSegment.start_ms;
        const rawEnd = rawSegment.end_ms;
        if (!isProviderTimestamp(rawStart) || !isProviderTimestamp(rawEnd)) {
            return { kind: "malformed" };
        }

        let startMs;
        let endMs;
        let endsAtMediaEnd = false;
        if (type === "intro" || type === "recap") {
            if (rawEnd === null) {
                return { kind: "malformed" };
            }
            if (rawEnd === 0) {
                return { kind: "sentinel" };
            }
            startMs = rawStart === null ? 0 : rawStart;
            endMs = rawEnd;
            if (endMs <= startMs) {
                return { kind: "unusable" };
            }
        } else {
            if (rawStart === null) {
                return { kind: "malformed" };
            }
            if (rawStart === 0 || rawEnd === 0) {
                return { kind: "sentinel" };
            }
            startMs = rawStart;
            if (rawEnd === null) {
                endMs = actualDurationMs;
                endsAtMediaEnd = true;
            } else {
                endMs = rawEnd;
                if (endMs <= startMs) {
                    return { kind: "unusable" };
                }
            }
        }

        if (!isPositiveSafeInteger(actualDurationMs)
            || startMs < 0 || startMs >= actualDurationMs
            || !isPositiveSafeInteger(endMs) || endMs > actualDurationMs || endMs <= startMs) {
            return { kind: "unusable" };
        }
        if (!endsAtMediaEnd) {
            const duration = endMs - startMs;
            const limits = SEGMENT_DURATION_LIMITS[type];
            if (duration < limits.minimum || duration > limits.maximum) {
                return { kind: "unusable" };
            }
        }

        return {
            kind: "segment",
            segment: Object.freeze({
                id: `${type}:${startMs}:${endsAtMediaEnd ? "media-end" : endMs}`,
                type,
                startMs,
                endMs,
                endsAtMediaEnd,
                provider: "theintrodb",
                providerSource: "v3/media",
                status: "accepted",
                confidence: null,
            }),
        };
    }

    function normalizeProviderSegment(type, rawSegment, actualDurationMs) {
        const result = classifyProviderSegment(type, rawSegment, actualDurationMs);
        return result.kind === "segment" ? result.segment : null;
    }

    function validateTheIntroDbResponse(body, identity, actualDurationMs) {
        if (!isPlainObject(body)
            || ownValue(body, "type") !== "tv"
            || !isPositiveSafeInteger(ownValue(body, "tmdb_id"))
            || ownValue(body, "tmdb_id") > 10_000_000
            || !isPositiveSafeInteger(actualDurationMs)) {
            return { ok: false, reason: "malformed" };
        }
        if (identity.providerMediaId && identity.providerMediaId.scheme === "tmdb"
            && ownValue(body, "tmdb_id") !== identity.providerMediaId.value) {
            return { ok: false, reason: "identity-mismatch" };
        }
        for (const [field, expected] of [["season", identity.season], ["episode", identity.episode]]) {
            const value = ownValue(body, field);
            if (value !== undefined && value !== null && value !== expected) {
                return { ok: false, reason: "identity-mismatch" };
            }
        }

        const segments = [];
        const seen = new Set();
        for (const type of PROVIDER_TYPES) {
            const collection = ownValue(body, type);
            if (collection === undefined) {
                continue;
            }
            if (!Array.isArray(collection) || collection.length > PROVIDER_LIMITS.maxSegmentsPerType) {
                return { ok: false, reason: "malformed" };
            }
            for (const rawSegment of collection) {
                const normalized = classifyProviderSegment(type, rawSegment, actualDurationMs);
                if (normalized.kind === "malformed") {
                    return { ok: false, reason: "malformed" };
                }
                if (normalized.kind !== "segment") {
                    continue;
                }
                const segment = normalized.segment;
                const key = `${segment.type}|${segment.startMs}|${segment.endMs}|${segment.endsAtMediaEnd}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    segments.push(segment);
                }
            }
        }
        segments.sort((first, second) => first.startMs - second.startMs
            || first.endMs - second.endMs || first.type.localeCompare(second.type));
        return {
            ok: true,
            tmdbId: body.tmdb_id,
            segments: Object.freeze(segments),
        };
    }

    function responseHeader(response, name) {
        try {
            return response && response.headers && typeof response.headers.get === "function"
                ? response.headers.get(name)
                : null;
        } catch (_error) {
            return null;
        }
    }

    function subscribeToInFlight(entry, signal) {
        if (signal && signal.aborted) {
            return Promise.reject(abortError());
        }
        entry.consumers += 1;
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback, value) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (signal) {
                    signal.removeEventListener("abort", onAbort);
                }
                entry.consumers = Math.max(0, entry.consumers - 1);
                callback(value);
            };
            const onAbort = () => {
                finish(reject, abortError());
                if (!entry.settled && entry.consumers === 0) {
                    entry.controller.abort();
                }
            };
            if (signal) {
                signal.addEventListener("abort", onAbort, { once: true });
            }
            entry.promise.then(
                (value) => finish(resolve, value),
                (error) => finish(reject, error),
            );
        });
    }

    class TheIntroDBProvider {
        constructor(options = {}) {
            this.fetch = options.fetch;
            this.setTimeout = options.setTimeout || setTimeout;
            this.clearTimeout = options.clearTimeout || clearTimeout;
            this.AbortController = hasOwn(options, "AbortController")
                ? options.AbortController
                : globalThis.AbortController;
            this.now = options.now || Date.now;
            this.timeoutMs = options.timeoutMs || PROVIDER_LIMITS.timeoutMs;
            this.retryDelayMs = options.retryDelayMs || PROVIDER_LIMITS.retryDelayMs;
            this.maxRateRetryMs = options.maxRateRetryMs || PROVIDER_LIMITS.maxRateRetryMs;
            this.cache = options.cache || new SessionSegmentCache();
            this.inFlight = new Map();
            this.controllers = new Set();
            this.dailyExhausted = false;
            this.destroyed = false;
        }

        async fetchEpisode(identity, durationMs, signal) {
            const url = buildTheIntroDbUrl(identity, durationMs);
            const key = providerCacheKey(identity, durationMs);
            if (!url || !key || typeof this.fetch !== "function" || this.destroyed) {
                return Object.freeze({ kind: "unavailable", reason: "unsupported" });
            }
            if (typeof this.AbortController !== "function") {
                return Object.freeze({ kind: "unavailable", reason: "abort-unsupported" });
            }
            if (signal && signal.aborted) {
                throw abortError();
            }
            const cached = this.cache.get(key);
            if (cached) {
                return cached;
            }
            if (this.dailyExhausted) {
                return Object.freeze({ kind: "unavailable", reason: "daily-limit" });
            }
            const existing = this.inFlight.get(key);
            if (existing && !existing.controller.signal.aborted) {
                return subscribeToInFlight(existing, signal);
            }
            if (existing && this.inFlight.get(key) === existing) {
                this.inFlight.delete(key);
            }

            const entry = {
                controller: new this.AbortController(),
                consumers: 0,
                settled: false,
                promise: null,
            };
            entry.promise = this._perform(url, key, identity, durationMs, entry.controller.signal)
                .finally(() => {
                    entry.settled = true;
                    if (this.inFlight.get(key) === entry) {
                        this.inFlight.delete(key);
                    }
                });
            this.inFlight.set(key, entry);
            return subscribeToInFlight(entry, signal);
        }

        destroy() {
            if (this.destroyed) {
                return;
            }
            this.destroyed = true;
            for (const entry of this.inFlight.values()) {
                entry.controller.abort();
            }
            for (const controller of this.controllers) {
                controller.abort();
            }
            this.controllers.clear();
            this.inFlight.clear();
            this.cache.clear();
        }

        async _perform(url, key, identity, durationMs, signal) {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                if (this.destroyed || (signal && signal.aborted)) {
                    throw abortError();
                }
                const outcome = await this._attempt(url, identity, durationMs, signal);
                if (outcome.kind === "cacheable") {
                    if (this.destroyed || (signal && signal.aborted)) {
                        throw abortError();
                    }
                    this.cache.set(key, outcome.result);
                    return outcome.result;
                }
                if (outcome.kind === "daily-limit") {
                    this.dailyExhausted = true;
                    return Object.freeze({ kind: "unavailable", reason: "daily-limit" });
                }
                if (outcome.kind === "aborted") {
                    throw abortError();
                }
                if (outcome.kind !== "retry" || attempt > 0) {
                    return Object.freeze({ kind: "unavailable", reason: outcome.reason || "request-failed" });
                }
                await waitWithSignal(this.setTimeout, this.clearTimeout, outcome.delayMs, signal);
            }
            return Object.freeze({ kind: "unavailable", reason: "request-failed" });
        }

        async _attempt(url, identity, durationMs, signal) {
            if (typeof this.AbortController !== "function") {
                return { kind: "stop", reason: "abort-unsupported" };
            }
            const controller = new this.AbortController();
            this.controllers.add(controller);
            let timedOut = false;
            let rejectLifetime;
            const lifetime = new Promise((_resolve, reject) => {
                rejectLifetime = reject;
            });
            const onAbort = () => {
                controller.abort();
                rejectLifetime(abortError());
            };
            signal.addEventListener("abort", onAbort, { once: true });
            const timeout = this.setTimeout(() => {
                timedOut = true;
                controller.abort();
                rejectLifetime(new Error("Provider request timed out"));
            }, this.timeoutMs);
            try {
                const work = Promise.resolve().then(async () => {
                    const response = await this.fetch(url, {
                        method: "GET",
                        headers: { Accept: "application/json" },
                        credentials: "omit",
                        cache: "no-store",
                        redirect: "error",
                        referrerPolicy: "no-referrer",
                        signal: controller.signal,
                    });
                    return this._processResponse(response, identity, durationMs);
                });
                return await Promise.race([work, lifetime]);
            } catch (_error) {
                if (signal.aborted || this.destroyed) {
                    return { kind: "aborted" };
                }
                return { kind: "retry", reason: timedOut ? "timeout" : "network", delayMs: this.retryDelayMs };
            } finally {
                this.clearTimeout(timeout);
                signal.removeEventListener("abort", onAbort);
                this.controllers.delete(controller);
            }
        }

        async _processResponse(response, identity, durationMs) {
            if (response.status === 404 || response.status === 204) {
                return {
                    kind: "cacheable",
                    result: Object.freeze({ kind: "empty", reason: response.status === 404 ? "not-found" : "legacy-no-content" }),
                };
            }
            if (response.status === 429) {
                const usageRemaining = responseHeader(response, "X-UsageLimit-Remaining");
                if (typeof usageRemaining === "string" && usageRemaining.trim() === "0") {
                    return { kind: "daily-limit" };
                }
                let body = null;
                try {
                    body = await this._readJson(response);
                } catch (_error) {
                    body = null;
                }
                if (isPlainObject(body) && ownValue(body, "code") === "usage_limit_exceeded") {
                    return { kind: "daily-limit" };
                }
                const reset = responseHeader(response, "X-RateLimit-Reset");
                if (typeof reset === "string" && /^[0-9]+$/u.test(reset.trim())) {
                    const delayMs = Number(reset.trim()) * 1000;
                    if (Number.isSafeInteger(delayMs) && delayMs >= 0 && delayMs <= this.maxRateRetryMs) {
                        return { kind: "retry", reason: "rate-limit", delayMs };
                    }
                }
                return { kind: "stop", reason: "rate-limit" };
            }
            if (response.status >= 500 && response.status <= 599) {
                return { kind: "retry", reason: "server", delayMs: this.retryDelayMs };
            }
            if (response.status !== 200) {
                return { kind: "stop", reason: `http-${response.status}` };
            }

            let body;
            try {
                body = await this._readJson(response);
            } catch (_error) {
                return { kind: "stop", reason: "malformed" };
            }
            const validated = validateTheIntroDbResponse(body, identity, durationMs);
            if (!validated.ok) {
                return { kind: "stop", reason: validated.reason };
            }
            if (validated.segments.length === 0) {
                return {
                    kind: "cacheable",
                    result: Object.freeze({ kind: "empty", reason: "no-valid-segments" }),
                };
            }
            const bundle = Object.freeze({
                provider: "theintrodb",
                providerVersion: "v3",
                media: Object.freeze({
                    episodeKey: identity.episodeKey,
                    showKey: identity.showKey,
                    imdbId: identity.imdbId,
                    tmdbId: validated.tmdbId,
                    season: identity.season,
                    episode: identity.episode,
                }),
                request: Object.freeze({ durationMs, authMode: "anonymous" }),
                fetchedAt: this.now(),
                segments: validated.segments,
            });
            return { kind: "cacheable", result: Object.freeze({ kind: "segments", bundle }) };
        }

        async _readJson(response) {
            const declared = responseHeader(response, "Content-Length");
            if (typeof declared === "string" && /^[0-9]+$/u.test(declared.trim())
                && Number(declared.trim()) > PROVIDER_LIMITS.maxResponseBytes) {
                throw new Error("Provider response is too large");
            }

            let body;
            if (response.body && typeof response.body.getReader === "function") {
                const reader = response.body.getReader();
                const chunks = [];
                let total = 0;
                try {
                    while (true) {
                        const part = await reader.read();
                        if (part.done) {
                            break;
                        }
                        if (!(part.value instanceof Uint8Array)) {
                            throw new Error("Malformed provider body stream");
                        }
                        total += part.value.byteLength;
                        if (total > PROVIDER_LIMITS.maxResponseBytes) {
                            await reader.cancel();
                            throw new Error("Provider response is too large");
                        }
                        chunks.push(part.value);
                    }
                } finally {
                    if (typeof reader.releaseLock === "function") {
                        reader.releaseLock();
                    }
                }
                const bytes = new Uint8Array(total);
                let offset = 0;
                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                body = JSON.parse(new TextDecoder().decode(bytes));
            } else if (typeof response.text === "function") {
                const text = await response.text();
                const bytes = typeof TextEncoder === "function" ? new TextEncoder().encode(text).byteLength : text.length * 2;
                if (bytes > PROVIDER_LIMITS.maxResponseBytes) {
                    throw new Error("Provider response is too large");
                }
                body = JSON.parse(text);
            } else {
                body = await response.json();
            }
            if (serializedByteLength(body) > PROVIDER_LIMITS.maxResponseBytes) {
                throw new Error("Provider response is too large");
            }
            return body;
        }
    }

    function hasOwnedMarker(node) {
        return Boolean(node && typeof node.hasAttribute === "function" && node.hasAttribute("data-showskip-owned"));
    }

    function descendantsWithExactModuleKind(element, kind) {
        if (!element || typeof element.querySelectorAll !== "function") {
            return [];
        }
        return Array.from(element.querySelectorAll("[class]"))
            .filter((candidate) => candidate.classList && Array.from(candidate.classList).some((token) => {
                if (kind === "track") {
                    return token.startsWith("track-")
                        && !token.startsWith("track-before-")
                        && !token.startsWith("track-after-");
                }
                return token.startsWith(`${kind}-`);
            }));
    }

    function hasModuleAncestor(element, baseName, boundary) {
        let current = element && element.parentElement;
        while (current && current !== boundary) {
            if (hasModuleClass(current, baseName)) {
                return true;
            }
            current = current.parentElement;
        }
        return false;
    }

    function resolveActiveSeekTarget(documentObject) {
        const routeRoot = resolveActiveRouteRoot(documentObject);
        if (!routeRoot) {
            return null;
        }
        const players = descendantsWithModuleClass(routeRoot, "player-container");
        if (players.length !== 1 || players[0].isConnected === false) {
            return null;
        }
        const controlBars = descendantsWithModuleClass(players[0], "control-bar-container");
        if (controlBars.length !== 1) {
            return null;
        }
        const seekBars = descendantsWithModuleClass(controlBars[0], "seek-bar-container");
        if (seekBars.length !== 1) {
            return null;
        }
        const sliders = descendantsWithModuleClass(seekBars[0], "slider-container")
            .filter((slider) => !hasModuleClass(slider, "volume-slider")
                && !hasModuleAncestor(slider, "control-bar-buttons-container", controlBars[0]));
        if (sliders.length !== 1) {
            return null;
        }
        const slider = sliders[0];
        const nativeLayers = Array.from(slider.children || [])
            .filter((child) => !hasOwnedMarker(child) && hasModuleClass(child, "layer"));
        const thumbLayers = nativeLayers.filter((layer) => descendantsWithModuleClass(layer, "thumb").length === 1);
        if (thumbLayers.length !== 1
            || descendantsWithExactModuleKind(slider, "track").length !== 1
            || descendantsWithExactModuleKind(slider, "track-before").length !== 1
            || descendantsWithExactModuleKind(slider, "track-after").length !== 1) {
            return null;
        }
        return Object.freeze({
            routeRoot,
            player: players[0],
            controlBar: controlBars[0],
            seekBar: seekBars[0],
            slider,
            thumbLayer: thumbLayers[0],
        });
    }

    function computeMarkerGeometry(segments, durationMs) {
        if (!Array.isArray(segments) || !isPositiveSafeInteger(durationMs)) {
            return [];
        }
        const geometry = [];
        for (const segment of segments) {
            if (!isPlainObject(segment) || !PROVIDER_TYPES.includes(segment.type)
                || !Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs)
                || segment.startMs < 0 || segment.endMs <= segment.startMs || segment.endMs > durationMs) {
                continue;
            }
            const leftPercent = Math.min(100, Math.max(0, (segment.startMs / durationMs) * 100));
            const widthPercent = Math.min(100 - leftPercent, Math.max(0, ((segment.endMs - segment.startMs) / durationMs) * 100));
            if (!(widthPercent > 0)) {
                continue;
            }
            geometry.push(Object.freeze({ segment, leftPercent, widthPercent }));
        }
        return geometry;
    }

    function segmentDisplayName(type) {
        return ({ recap: "Recap", intro: "Intro", credits: "Credits", preview: "Preview" })[type] || "Segment";
    }

    function formatTimelineTime(milliseconds) {
        const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return hours > 0
            ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
            : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    function segmentAccessibleLabel(segment) {
        return `${segmentDisplayName(segment.type)}, ${formatTimelineTime(segment.startMs)} to ${formatTimelineTime(segment.endMs)}`;
    }

    class TimelineRenderer {
        constructor(documentObject) {
            this.document = documentObject;
            this.layer = null;
            this.slider = null;
            this.tooltip = null;
            this.geometry = [];
            this.durationMs = null;
            this.signature = null;
            this.listeners = [];
            this.focusedIndex = null;
            this.displayedTooltipKey = null;
        }

        render(bundle, durationMs, contextToken) {
            const target = resolveActiveSeekTarget(this.document);
            const geometry = bundle && computeMarkerGeometry(bundle.segments, durationMs);
            if (!target || !geometry || geometry.length === 0) {
                this.clear();
                return 0;
            }
            this._removeOwnedLayersExcept(this.layer);
            const signature = JSON.stringify([
                contextToken,
                durationMs,
                ...geometry.map(({ segment }) => [segment.id, segment.type, segment.startMs, segment.endMs]),
            ]);
            if (this.layer && this.layer.isConnected !== false
                && this.slider === target.slider && this.signature === signature) {
                if (this.layer.nextSibling !== target.thumbLayer && typeof target.slider.insertBefore === "function") {
                    target.slider.insertBefore(this.layer, target.thumbLayer);
                }
                return geometry.length;
            }

            this.clear();
            this._removeOwnedLayersExcept(null);
            const layer = this.document.createElement("div");
            layer.setAttribute("data-showskip-owned", "timeline");
            layer.setAttribute("data-showskip-timeline-layer", "");
            layer.setAttribute("role", "group");
            layer.setAttribute("aria-label", "ShowSkip timeline segments");
            for (const [index, item] of geometry.entries()) {
                const marker = this.document.createElement("span");
                marker.setAttribute("data-showskip-timeline-marker", "");
                marker.setAttribute("data-showskip-segment-type", item.segment.type);
                marker.setAttribute("data-showskip-marker-index", String(index));
                marker.setAttribute("role", "img");
                marker.setAttribute("aria-label", segmentAccessibleLabel(item.segment));
                marker.tabIndex = 0;
                marker.style.left = `${item.leftPercent}%`;
                marker.style.width = `${item.widthPercent}%`;
                layer.appendChild(marker);
            }
            const tooltip = this.document.createElement("span");
            tooltip.setAttribute("data-showskip-timeline-tooltip", "");
            tooltip.setAttribute("role", "tooltip");
            tooltip.hidden = true;
            layer.appendChild(tooltip);
            target.slider.insertBefore(layer, target.thumbLayer);

            this.layer = layer;
            this.slider = target.slider;
            this.tooltip = tooltip;
            this.geometry = geometry;
            this.durationMs = durationMs;
            this.signature = signature;
            this._listen(target.slider, "pointermove", (event) => this._handlePointerMove(event), { passive: true });
            this._listen(target.slider, "pointerleave", () => this._restoreFocusedTooltip(), { passive: true });
            this._listen(layer, "focusin", (event) => this._handleFocus(event));
            this._listen(layer, "focusout", () => this._handleFocusOut());
            return geometry.length;
        }

        clear() {
            for (const listener of this.listeners) {
                listener.target.removeEventListener(listener.type, listener.handler, listener.options);
            }
            this.listeners = [];
            this._removeOwnedLayersExcept(null);
            removeNode(this.layer);
            this.layer = null;
            this.slider = null;
            this.tooltip = null;
            this.geometry = [];
            this.durationMs = null;
            this.signature = null;
            this.focusedIndex = null;
            this.displayedTooltipKey = null;
        }

        destroy() {
            this.clear();
        }

        _handlePointerMove(event) {
            if (!this.slider || typeof this.slider.getBoundingClientRect !== "function") {
                return;
            }
            const rect = this.slider.getBoundingClientRect();
            if (!rect || !(rect.width > 0) || typeof event.clientX !== "number") {
                this._hideTooltip();
                return;
            }
            const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
            const timeMs = fraction * this.durationMs;
            const match = this.geometry.find(({ segment }) => timeMs >= segment.startMs && timeMs <= segment.endMs);
            if (this.focusedIndex !== null && this.geometry[this.focusedIndex]) {
                this._showTooltip(this.geometry[this.focusedIndex]);
            } else if (match) {
                this._showTooltip(match);
            } else {
                this._hideTooltip();
            }
        }

        _handleFocus(event) {
            const index = event.target && typeof event.target.getAttribute === "function"
                ? Number(event.target.getAttribute("data-showskip-marker-index"))
                : Number.NaN;
            if (Number.isInteger(index) && this.geometry[index]) {
                this.focusedIndex = index;
                this._showTooltip(this.geometry[index]);
            }
        }

        _handleFocusOut() {
            this.focusedIndex = null;
            this._hideTooltip();
        }

        _restoreFocusedTooltip() {
            if (this.focusedIndex !== null && this.geometry[this.focusedIndex]) {
                this._showTooltip(this.geometry[this.focusedIndex]);
            } else {
                this._hideTooltip();
            }
        }

        _showTooltip(item) {
            if (!this.tooltip) {
                return;
            }
            const segment = item.segment;
            const text = `${segmentDisplayName(segment.type)} · ${formatTimelineTime(segment.startMs)}–${formatTimelineTime(segment.endMs)}`;
            const left = `${item.leftPercent + (item.widthPercent / 2)}%`;
            const key = `${segment.id}|${left}|${text}`;
            if (this.displayedTooltipKey !== key) {
                if (this.tooltip.textContent !== text) {
                    this.tooltip.textContent = text;
                }
                this.displayedTooltipKey = key;
            }
            // Fixed positioning keeps the tooltip from being clipped by the player's overflow rules.
            const layerRect = this.layer && typeof this.layer.getBoundingClientRect === "function"
                ? this.layer.getBoundingClientRect()
                : null;
            if (layerRect && layerRect.width > 0) {
                const anchorX = layerRect.left + (layerRect.width * (item.leftPercent + (item.widthPercent / 2))) / 100;
                this.tooltip.style.left = `${Math.round(anchorX)}px`;
                this.tooltip.style.top = `${Math.round(layerRect.top + (layerRect.height / 2) - 14)}px`;
            } else {
                this.tooltip.style.left = left;
            }
            if (this.tooltip.hidden) {
                this.tooltip.hidden = false;
            }
        }

        _hideTooltip() {
            if (this.tooltip) {
                this.tooltip.hidden = true;
            }
            this.displayedTooltipKey = null;
        }

        _listen(target, type, handler, options) {
            target.addEventListener(type, handler, options);
            this.listeners.push({ target, type, handler, options });
        }

        _removeOwnedLayersExcept(keep) {
            if (!this.document || typeof this.document.querySelectorAll !== "function") {
                return;
            }
            for (const candidate of Array.from(this.document.querySelectorAll(TIMELINE_LAYER_SELECTOR))) {
                if (candidate !== keep) {
                    removeNode(candidate);
                }
            }
        }
    }

    class PlayerController {
        constructor(options) {
            this.window = options.windowObject;
            this.document = options.documentObject;
            this.identityProvider = options.identityProvider;
            this.provider = options.provider;
            this.onSchedule = options.onSchedule;
            this.onProviderUsed = options.onProviderUsed;
            this.timeline = options.timeline || new TimelineRenderer(this.document);
            this.AbortController = options.AbortController || this.window.AbortController || globalThis.AbortController;
            this.actionsEnabled = options.actionsEnabled === true;
            this.getProfile = typeof options.getProfile === "function"
                ? options.getProfile
                : async (showKey) => ({ profile: createDefaultProfile(showKey) });
            this.getCurrentRoute = typeof options.getCurrentRoute === "function"
                ? options.getCurrentRoute
                : () => this.route;
            this.now = typeof options.now === "function"
                ? options.now
                : (this.window.performance && typeof this.window.performance.now === "function"
                    ? this.window.performance.now.bind(this.window.performance)
                    : Date.now);
            this.actionState = options.actionState || new PlaybackActionStateMachine({
                actionsEnabled: this.actionsEnabled,
            });
            this.actionRenderer = options.actionRenderer || new PlayerActionRenderer(this.document, {
                actionsEnabled: this.actionsEnabled,
            });
            this.nextAdapter = options.nextAdapter || new NextEpisodeAdapter({
                actionsEnabled: this.actionsEnabled,
                validateContext: (context) => this._actionContextIsLive(context),
            });
            this.route = null;
            this.identity = null;
            this.identityAbort = null;
            this.identityRevalidationPending = false;
            this.profile = null;
            this.profileShowKey = null;
            this.adapter = null;
            this.unsubscribeMedia = null;
            this.source = "";
            this.episodeToken = 0;
            this.mediaToken = 0;
            this.actionEpoch = 0;
            this.actionContext = null;
            this.actionAbort = null;
            this.pendingAction = null;
            this.requestAbort = null;
            this.requestDurationMs = null;
            this.currentBundle = null;
            this.currentDurationMs = null;
            this.bundlesByDuration = new Map();
            this.destroyed = false;
            this.durationStabilizer = new DurationStabilizer({
                setTimeout: this.window.setTimeout.bind(this.window),
                clearTimeout: this.window.clearTimeout.bind(this.window),
                onStable: ({ scopeKey, durationMs }) => this._lookup(scopeKey, durationMs),
                onLimit: () => {
                    this._resetActions();
                    this._cancelRequest();
                    this.currentBundle = null;
                    this.currentDurationMs = null;
                    this.timeline.clear();
                },
            });
        }

        async reconcile(route) {
            if (this.destroyed || !route || route.kind !== "player" || route.eligible !== true) {
                this.deactivate();
                return false;
            }
            if (typeof this.AbortController !== "function") {
                this.deactivate();
                return false;
            }
            if (!this.route || this.route.signature !== route.signature) {
                this.deactivate();
                this.route = route;
                this.identityAbort = new this.AbortController();
            }
            if (!this.identity || this.identity.identitySource === "route") {
                const episodeToken = this.episodeToken;
                const wasRouteOnly = Boolean(this.identity && this.identity.identitySource === "route");
                this.identityRevalidationPending = wasRouteOnly;
                const identity = await this.identityProvider.resolve(route, this.identityAbort.signal);
                this.identityRevalidationPending = false;
                if (this.destroyed || !this.route || this.route.signature !== route.signature
                    || episodeToken !== this.episodeToken || this.identityAbort.signal.aborted) {
                    return false;
                }
                if (!identity) {
                    if (wasRouteOnly) {
                        this._invalidateIdentity();
                    }
                    return false;
                }
                this.identity = identity;
            }

            if (this.actionsEnabled && this.identity.identitySource === "route+core"
                && (!this.profile || this.profileShowKey !== this.identity.showKey)) {
                const episodeToken = this.episodeToken;
                const routeSignature = this.route.signature;
                const showKey = this.identity.showKey;
                try {
                    const result = await this.getProfile(showKey);
                    if (this.destroyed || episodeToken !== this.episodeToken || !this.route
                        || this.route.signature !== routeSignature || !this.identity
                        || this.identity.showKey !== showKey || this.identity.identitySource !== "route+core") {
                        return false;
                    }
                    this.profile = result && isPlainObject(result.profile) ? result.profile : null;
                    this.profileShowKey = this.profile ? showKey : null;
                } catch (_error) {
                    this.profile = null;
                    this.profileShowKey = null;
                }
            }
            if (this.actionsEnabled && this.identity.identitySource !== "route+core") {
                this._resetActions();
            }

            const video = resolveActiveHtmlVideo(this.document, this.window);
            if (!video) {
                this._detachMedia();
                return false;
            }
            if (!this.adapter || this.adapter.video !== video) {
                this._bindMedia(video);
            }
            const snapshot = this.adapter.getSnapshot();
            if (!snapshot.connected) {
                this._detachMedia();
                return false;
            }
            if (snapshot.source !== this.source) {
                this._changeSource(snapshot.source);
            }
            if (!snapshot.source || !snapshot.durationMs) {
                this._resetActions();
                this.timeline.clear();
                this.durationStabilizer.update(this._scopeKey(), null);
                return this.identity.identitySource !== "route";
            }

            if (this.requestDurationMs !== null && this.requestDurationMs !== snapshot.durationMs) {
                this._cancelRequest();
            }
            if (this.currentDurationMs !== snapshot.durationMs) {
                this._resetActions();
                this.currentBundle = this.bundlesByDuration.get(snapshot.durationMs) || null;
                this.currentDurationMs = this.currentBundle ? snapshot.durationMs : null;
                if (!this.currentBundle) {
                    this.timeline.clear();
                }
            }
            if (this.currentBundle) {
                this._renderCurrent(snapshot.durationMs);
            }
            this.durationStabilizer.update(this._scopeKey(), snapshot.durationMs);
            return this.identity.identitySource !== "route";
        }

        invalidateRoute(route) {
            if (this.route && (!route || route.kind !== "player" || route.signature !== this.route.signature)) {
                this.deactivate();
                return true;
            }
            return false;
        }

        deactivate() {
            this.episodeToken += 1;
            if (this.identityAbort) {
                this.identityAbort.abort();
                this.identityAbort = null;
            }
            this._detachMedia();
            this.route = null;
            this.identity = null;
            this.identityRevalidationPending = false;
            this.profile = null;
            this.profileShowKey = null;
        }

        destroy() {
            if (this.destroyed) {
                return;
            }
            this.destroyed = true;
            this.deactivate();
            this.actionRenderer.destroy();
            this.timeline.destroy();
            this.durationStabilizer.destroy();
            this.provider.destroy();
        }

        _bindMedia(video) {
            this._detachMedia();
            this.adapter = new HtmlMediaAdapter(this.window, video, {
                actionsEnabled: this.actionsEnabled,
                resolveActiveVideo: () => resolveActiveHtmlVideo(this.document, this.window),
                validateContext: (context) => this._actionContextIsLive(context),
                onShowSkipSeekStart: (_context, targetMs) => {
                    if (this.pendingAction) {
                        this.actionState.beginShowSkipSeek(this.pendingAction.action, targetMs);
                    }
                },
            });
            this.mediaToken += 1;
            this.unsubscribeMedia = this.adapter.subscribe((event) => this._handleMediaEvent(event));
        }

        _detachMedia() {
            this._resetActions();
            this._cancelRequest();
            this.durationStabilizer.reset(null);
            this.timeline.clear();
            if (this.unsubscribeMedia) {
                this.unsubscribeMedia();
                this.unsubscribeMedia = null;
            }
            if (this.adapter) {
                this.adapter.destroy();
                this.adapter = null;
            }
            this.source = "";
            this.mediaToken += 1;
            this.currentBundle = null;
            this.currentDurationMs = null;
            this.bundlesByDuration = new Map();
        }

        _changeSource(source) {
            this._resetActions();
            this._cancelRequest();
            this.durationStabilizer.reset(null);
            this.timeline.clear();
            this.source = source;
            this.mediaToken += 1;
            this.currentBundle = null;
            this.currentDurationMs = null;
            this.bundlesByDuration = new Map();
        }

        _scopeKey() {
            return `${this.episodeToken}|${this.mediaToken}|${this.source.length}:${stableHash(this.source)}`;
        }

        _lookup(scopeKey, durationMs) {
            if (this.destroyed || !this.identity || !this.adapter || scopeKey !== this._scopeKey()) {
                return;
            }
            if (!this._liveSnapshot(durationMs)) {
                return;
            }
            if (this.bundlesByDuration.has(durationMs)) {
                this.currentBundle = this.bundlesByDuration.get(durationMs);
                this.currentDurationMs = durationMs;
                this._renderCurrent(durationMs);
                return;
            }
            this._cancelRequest();
            const episodeToken = this.episodeToken;
            const mediaToken = this.mediaToken;
            const routeSignature = this.route.signature;
            const requestAbort = new this.AbortController();
            this.requestAbort = requestAbort;
            this.requestDurationMs = durationMs;
            void this.provider.fetchEpisode(this.identity, durationMs, requestAbort.signal)
                .then((result) => {
                    if (this.destroyed || requestAbort.signal.aborted || episodeToken !== this.episodeToken
                        || mediaToken !== this.mediaToken || !this.route || this.route.signature !== routeSignature
                        || scopeKey !== this._scopeKey() || !this._liveSnapshot(durationMs)) {
                        return;
                    }
                    if (result.kind === "segments") {
                        this.bundlesByDuration.set(durationMs, result.bundle);
                        this.currentBundle = result.bundle;
                        this.currentDurationMs = durationMs;
                        this._renderCurrent(durationMs);
                    } else {
                        this._resetActions();
                        this.currentBundle = null;
                        this.currentDurationMs = null;
                        this.timeline.clear();
                    }
                })
                .catch((error) => {
                    if (!error || error.name !== "AbortError") {
                        this._resetActions();
                        this.timeline.clear();
                    }
                })
                .finally(() => {
                    if (this.requestAbort === requestAbort) {
                        this.requestAbort = null;
                        this.requestDurationMs = null;
                    }
                    this.onSchedule();
                });
        }

        _renderCurrent(durationMs) {
            if (!this.currentBundle || !this.identity || this.identityRevalidationPending
                || this.currentDurationMs !== durationMs || !this._liveSnapshot(durationMs)) {
                return;
            }
            const rendered = this.timeline.render(
                this.currentBundle,
                durationMs,
                `${this.episodeToken}:${this.mediaToken}`,
            );
            if (rendered > 0) {
                this.onProviderUsed(this.identity.showKey);
            }
            const snapshot = this._liveSnapshot(durationMs);
            if (snapshot) {
                this._refreshActionContext(durationMs);
                this._processPlaybackObservation("bundle", snapshot);
            }
        }

        _handleMediaEvent({ type, snapshot }) {
            if (this.destroyed || !this.adapter) {
                return;
            }
            if (type === "loadedmetadata" || type === "durationchange" || type === "loadstart" || type === "emptied") {
                this.onSchedule();
            }
            if (type === "loadstart" || type === "emptied"
                || !snapshot.connected || snapshot.source !== this.source
                || (this.currentDurationMs !== null && snapshot.durationMs !== this.currentDurationMs)) {
                this._resetActions();
                if (snapshot.source !== this.source || snapshot.durationMs !== this.currentDurationMs) {
                    this.onSchedule();
                }
                return;
            }
            if (this.actionsEnabled && this.actionContext) {
                this._processPlaybackObservation(type, snapshot);
            }
        }

        _refreshActionContext(durationMs) {
            if (!this.actionsEnabled || !this.identity || this.identity.identitySource !== "route+core"
                || !this.profile || this.profileShowKey !== this.identity.showKey
                || !this.currentBundle || !this.adapter || !this.route || !this.source
                || this.identityRevalidationPending || this.currentDurationMs !== durationMs) {
                this._resetActions();
                return null;
            }
            if (this.actionContext
                && this.actionContext.routeSignature === this.route.signature
                && this.actionContext.episodeKey === this.identity.episodeKey
                && this.actionContext.episodeToken === this.episodeToken
                && this.actionContext.mediaToken === this.mediaToken
                && this.actionContext.adapter === this.adapter
                && this.actionContext.video === this.adapter.video
                && this.actionContext.source === this.source
                && this.actionContext.durationMs === durationMs) {
                return this.actionContext;
            }
            this._resetActions();
            const context = Object.freeze({
                actionEpoch: this.actionEpoch,
                routeSignature: this.route.signature,
                episodeKey: this.identity.episodeKey,
                episodeToken: this.episodeToken,
                mediaToken: this.mediaToken,
                identitySource: this.identity.identitySource,
                metaId: this.identity.stremioSeriesId,
                videoId: this.identity.stremioVideoId,
                season: this.identity.season,
                episode: this.identity.episode,
                adapter: this.adapter,
                video: this.adapter.video,
                source: this.source,
                durationMs,
            });
            this.actionContext = context;
            this.actionState.reset(this._actionSessionKey(context));
            return context;
        }

        _actionContextIsLive(context) {
            if (!this.actionsEnabled || !context || context !== this.actionContext || this.destroyed
                || !this.route || !this.identity || this.identity.identitySource !== "route+core"
                || this.identityRevalidationPending || !this.profile || !this.currentBundle
                || context.actionEpoch !== this.actionEpoch
                || context.routeSignature !== this.route.signature
                || context.episodeKey !== this.identity.episodeKey
                || context.episodeToken !== this.episodeToken || context.mediaToken !== this.mediaToken
                || context.adapter !== this.adapter || !this.adapter || context.video !== this.adapter.video
                || context.source !== this.source || context.durationMs !== this.currentDurationMs
                || this.currentBundle.request.durationMs !== context.durationMs
                || this.currentBundle.media.episodeKey !== context.episodeKey
                || resolveActiveHtmlVideo(this.document, this.window) !== context.video) {
                return false;
            }
            let currentRoute;
            try {
                currentRoute = this.getCurrentRoute();
            } catch (_error) {
                return false;
            }
            if (!currentRoute || currentRoute.kind !== "player" || currentRoute.eligible !== true
                || currentRoute.signature !== context.routeSignature
                || currentRoute.metaId !== context.metaId || currentRoute.videoId !== context.videoId
                || currentRoute.season !== context.season || currentRoute.episode !== context.episode) {
                return false;
            }
            const snapshot = this.adapter.getSnapshot();
            return snapshot.connected && snapshot.source === context.source
                && snapshot.durationMs === context.durationMs;
        }

        _processPlaybackObservation(eventType, snapshot) {
            const context = this.actionContext;
            if (!this.actionsEnabled || !this._actionContextIsLive(context)
                || !snapshot || snapshot.currentTimeMs === null) {
                this.actionRenderer.clear();
                return;
            }
            let availability = nextAvailability(false, false, "mechanism-unavailable");
            if (this.nextAdapter && typeof this.nextAdapter.getAvailability === "function") {
                availability = this.nextAdapter.getAvailability(context);
            }
            const decision = this.actionState.observe({
                sessionKey: this._actionSessionKey(context),
                eventType,
                positionMs: snapshot.currentTimeMs,
                durationMs: snapshot.durationMs,
                paused: snapshot.paused,
                seeking: snapshot.seeking,
                ended: snapshot.ended,
                playbackRate: snapshot.playbackRate,
                nowMs: this.now(),
                segments: this.currentBundle.segments,
                profile: this.profile,
                nextAvailable: availability.known && availability.available,
            });
            const contextSignature = this._actionSessionKey(context);
            if (decision.automaticAction && !this.pendingAction) {
                this.actionRenderer.clear();
                void this._executeAction(decision.automaticAction, context, contextSignature);
                return;
            }
            if (decision.buttonAction && !this.pendingAction) {
                this.actionRenderer.render(
                    decision.buttonAction,
                    contextSignature,
                    (action, signature) => this._activateButton(action, context, signature),
                    (action, signature) => this._buttonActionIsLive(action, context, signature),
                );
            } else {
                this.actionRenderer.clear();
            }
        }

        _buttonActionIsLive(action, context, contextSignature) {
            if (!this.actionsEnabled || this.pendingAction || contextSignature !== this._actionSessionKey(context)
                || !this._actionContextIsLive(context) || !action || !this.currentBundle) {
                return false;
            }
            const snapshot = this.adapter.getSnapshot();
            if (snapshot.currentTimeMs === null || snapshot.seeking === true) {
                return false;
            }
            const state = this.actionState.debugState();
            const segments = validActionSegments(this.currentBundle.segments, context.durationMs);
            const inside = segments.filter((segment) => snapshot.currentTimeMs >= segment.startMs
                && snapshot.currentTimeMs < segment.endMs - PLAYBACK_ACTION_LIMITS.segmentEndToleranceMs);
            let availability = nextAvailability(false, false, "mechanism-unavailable");
            if (this.nextAdapter && typeof this.nextAdapter.getAvailability === "function") {
                availability = this.nextAdapter.getAvailability(context);
            }
            if (action.kind === "next") {
                return ownValue(this.profile, "nextEpisode") === "button"
                    && availability.known && availability.available
                    && inside.some((segment) => segment.type === "credits" && segment.id === action.segmentId);
            }
            if (action.kind !== "segment" || ownValue(this.profile, action.segmentType) !== "button"
                || state.firedSegmentIds.includes(action.segmentId)
                || state.pendingSegmentIds.includes(action.segmentId)
                || state.blockedSegmentIds.includes(action.segmentId)) {
                return false;
            }
            if (ownValue(this.profile, "nextEpisode") === "button"
                && availability.known && availability.available
                && inside.some((segment) => segment.type === "credits")) {
                return false;
            }
            const candidates = inside.filter((segment) => ownValue(this.profile, segment.type) === "button"
                && !state.firedSegmentIds.includes(segment.id)
                && !state.pendingSegmentIds.includes(segment.id)
                && !state.blockedSegmentIds.includes(segment.id)).sort(compareSegmentActions);
            return Boolean(candidates[0] && candidates[0].id === action.segmentId
                && candidates[0].endMs === action.targetMs && candidates[0].type === action.segmentType);
        }

        _activateButton(action, context, contextSignature) {
            if (!this._buttonActionIsLive(action, context, contextSignature)) {
                return Promise.resolve(false);
            }
            return this._executeAction(action, context, contextSignature);
        }

        async _executeAction(action, context, contextSignature) {
            if (!this.actionsEnabled || this.pendingAction || !this._actionContextIsLive(context)
                || contextSignature !== this._actionSessionKey(context)
                || typeof this.AbortController !== "function") {
                return false;
            }
            const controller = new this.AbortController();
            if (!this.actionState.reserve(action)) {
                return false;
            }
            const pending = Object.freeze({ action, context, contextSignature, controller });
            this.pendingAction = pending;
            this.actionAbort = controller;
            this.actionRenderer.clear();
            let result = Object.freeze({ ok: false, reason: "action-failed" });
            try {
                if (action.kind === "segment") {
                    result = await this.adapter.seekToMs(action.targetMs, context, controller.signal);
                } else if (action.kind === "next" && this.nextAdapter
                    && typeof this.nextAdapter.advance === "function") {
                    result = await this.nextAdapter.advance(context, controller.signal);
                } else {
                    result = Object.freeze({ ok: false, reason: "mechanism-unavailable" });
                }
            } catch (_error) {
                result = Object.freeze({
                    ok: false,
                    reason: controller.signal.aborted ? "aborted" : "action-failed",
                });
            }
            if (this.pendingAction !== pending || this.actionContext !== context) {
                return false;
            }
            this.pendingAction = null;
            this.actionAbort = null;
            this.actionState.complete(action, Boolean(result && result.ok), this.now());
            if (this._actionContextIsLive(context)) {
                this._processPlaybackObservation("action-complete", this.adapter.getSnapshot());
            }
            return Boolean(result && result.ok);
        }

        _actionSessionKey(context) {
            return context
                ? `${context.actionEpoch}|${context.routeSignature}|${context.episodeKey}|${context.episodeToken}`
                    + `|${context.mediaToken}|${context.durationMs}|${stableHash(context.source)}`
                : "";
        }

        _resetActions() {
            if (this.actionAbort) {
                this.actionAbort.abort();
            }
            this.actionAbort = null;
            this.pendingAction = null;
            this.actionContext = null;
            this.actionEpoch += 1;
            this.actionState.reset(null);
            this.actionRenderer.clear();
        }

        _cancelRequest() {
            if (this.requestAbort) {
                this.requestAbort.abort();
                this.requestAbort = null;
            }
            this.requestDurationMs = null;
        }

        _liveSnapshot(durationMs) {
            if (!this.adapter || resolveActiveHtmlVideo(this.document, this.window) !== this.adapter.video) {
                return null;
            }
            const snapshot = this.adapter.getSnapshot();
            return snapshot.connected && snapshot.source === this.source && snapshot.durationMs === durationMs
                ? snapshot
                : null;
        }

        _invalidateIdentity() {
            this.episodeToken += 1;
            if (this.identityAbort) {
                this.identityAbort.abort();
            }
            this._detachMedia();
            this.identity = null;
            this.identityRevalidationPending = false;
            this.identityAbort = new this.AbortController();
        }
    }

    function stableHash(value) {
        let hash = 2166136261;
        for (let index = 0; index < value.length; index += 1) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function createSvgIcon(documentObject) {
        const namespace = "http://www.w3.org/2000/svg";
        const svg = documentObject.createElementNS(namespace, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");

        const playPath = documentObject.createElementNS(namespace, "path");
        playPath.setAttribute("d", "M5.5 5.1v13.8L15.8 12 5.5 5.1Z");
        const skipPath = documentObject.createElementNS(namespace, "path");
        skipPath.setAttribute("d", "M17.2 5.4h1.8v13.2h-1.8z");
        svg.append(playPath, skipPath);
        return svg;
    }

    function createStyles(documentObject) {
        const style = documentObject.createElement("style");
        style.setAttribute("data-showskip-owned", "style");
        style.textContent = `
            [data-showskip-launcher] {
                appearance: none;
                box-sizing: border-box;
                position: fixed;
                left: 0;
                right: 0;
                bottom: max(1.25rem, env(safe-area-inset-bottom));
                z-index: 9999;
                width: fit-content;
                min-height: 44px;
                margin: 0 auto;
                padding: 0.6rem 1.15rem 0.6rem 0.95rem;
                display: inline-flex;
                align-items: center;
                gap: 0.55rem;
                border: 1px solid rgba(127, 227, 236, 0.35);
                border-radius: 999px;
                color: #f4f6f8;
                background: rgba(18, 22, 29, 0.92);
                box-shadow: 0 0.5rem 1.6rem rgba(0, 0, 0, 0.5);
                cursor: pointer;
                font: inherit;
                font-size: 0.9rem;
                font-weight: 650;
                line-height: 1;
                white-space: nowrap;
                transition: background-color 140ms ease, border-color 140ms ease;
                backdrop-filter: blur(12px);
            }
            [data-showskip-launcher]:hover,
            [data-showskip-launcher][aria-expanded="true"] {
                background: #0d7a86;
                border-color: rgba(127, 227, 236, 0.6);
            }
            [data-showskip-launcher]:focus-visible {
                outline: 2px solid var(--primary-accent-color, #9c7cff);
                outline-offset: 3px;
            }
            [data-showskip-panel] .showskip-choice-input:focus-visible + .showskip-choice-label {
                outline: 2px solid var(--showskip-primary-text);
                outline-offset: -2px;
            }
            [data-showskip-panel] .showskip-close:focus-visible {
                outline: 2px solid var(--showskip-focus-ring);
                outline-offset: 3px;
            }
            [data-showskip-launcher] svg {
                width: 1.3rem;
                height: 1.3rem;
                flex: 0 0 auto;
                fill: currentColor;
            }
            [data-showskip-panel] {
                --showskip-surface: ${PANEL_PALETTE.surface};
                --showskip-primary-text: ${PANEL_PALETTE.primaryText};
                --showskip-secondary-text: ${PANEL_PALETTE.secondaryText};
                --showskip-option-text: ${PANEL_PALETTE.optionText};
                --showskip-selected-text: ${PANEL_PALETTE.selectedText};
                --showskip-selected-surface: ${PANEL_PALETTE.selectedSurface};
                --showskip-disabled-text: ${PANEL_PALETTE.disabledText};
                --showskip-disabled-selected-surface: ${PANEL_PALETTE.disabledSelectedSurface};
                --showskip-control-surface: ${PANEL_PALETTE.controlSurface};
                --showskip-control-hover: ${PANEL_PALETTE.controlHover};
                --showskip-selected-hover: ${PANEL_PALETTE.selectedHover};
                --showskip-focus-ring: ${PANEL_PALETTE.focusRing};
                position: fixed;
                z-index: 10000;
                box-sizing: border-box;
                width: min(24rem, calc(100vw - 1.5rem));
                max-height: min(38rem, calc(100vh - 1.5rem));
                overflow: auto;
                padding: 1rem;
                color: var(--showskip-primary-text);
                background: var(--showskip-surface);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-top: 3px solid #f3ce55;
                border-radius: 1.1rem;
                box-shadow: 0 1.2rem 3.2rem rgba(0, 0, 0, 0.55);
                font: inherit;
                backdrop-filter: blur(18px);
                color-scheme: dark;
            }
            [data-showskip-panel] .showskip-header {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 1rem;
                margin-bottom: 0.9rem;
            }
            [data-showskip-panel] .showskip-title {
                margin: 0;
                color: var(--showskip-primary-text);
                font-size: 1.12rem;
                font-weight: 700;
                line-height: 1.25;
                letter-spacing: -0.01em;
            }
            [data-showskip-panel] .showskip-subtitle {
                margin: 0.18rem 0 0;
                color: var(--showskip-secondary-text);
                font-size: 0.78rem;
            }
            [data-showskip-panel] .showskip-close {
                appearance: none;
                width: 2rem;
                height: 2rem;
                display: grid;
                place-items: center;
                flex: 0 0 auto;
                padding: 0;
                border: 0;
                border-radius: 50%;
                color: var(--showskip-primary-text);
                background: rgba(255, 255, 255, 0.08);
                cursor: pointer;
                font: inherit;
                font-size: 1.15rem;
            }
            [data-showskip-panel] .showskip-close:hover {
                background: rgba(255, 255, 255, 0.16);
            }
            [data-showskip-panel] .showskip-row {
                min-width: 0;
                margin: 0 0 0.72rem;
                padding: 0;
                border: 0;
            }
            [data-showskip-panel] .showskip-row:last-of-type {
                margin-bottom: 0.35rem;
            }
            [data-showskip-panel] .showskip-row-title {
                display: block;
                float: none;
                box-sizing: border-box;
                width: 100%;
                margin: 0 0 0.36rem;
                padding: 0;
                color: var(--showskip-secondary-text);
                font-size: 0.78rem;
                font-weight: 650;
                line-height: 1.3;
                letter-spacing: 0.01em;
            }
            [data-showskip-panel] .showskip-choice-group {
                display: grid;
                grid-auto-flow: column;
                grid-auto-columns: minmax(0, 1fr);
                gap: 0.22rem;
                padding: 0.22rem;
                border-radius: 0.8rem;
                background: var(--showskip-control-surface);
                box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
            }
            [data-showskip-panel] .showskip-choice-input {
                position: absolute;
                width: 1px;
                height: 1px;
                margin: -1px;
                padding: 0;
                overflow: hidden;
                clip: rect(0 0 0 0);
                clip-path: inset(50%);
                white-space: nowrap;
                border: 0;
            }
            [data-showskip-panel] .showskip-choice-label {
                min-width: 0;
                padding: 0.48rem 0.34rem;
                border-radius: 0.54rem;
                color: var(--showskip-option-text);
                text-align: center;
                font-size: 0.72rem;
                font-weight: 550;
                line-height: 1.15;
                cursor: pointer;
                user-select: none;
                transition: color 140ms ease, background-color 140ms ease, box-shadow 140ms ease;
            }
            [data-showskip-panel] .showskip-choice-input:not(:checked):not(:disabled) + .showskip-choice-label:hover {
                background: var(--showskip-control-hover);
            }
            [data-showskip-panel] .showskip-choice-input:checked + .showskip-choice-label {
                color: var(--showskip-selected-text);
                background: var(--showskip-selected-surface);
                box-shadow: 0 0.2rem 0.7rem rgba(0, 0, 0, 0.2);
                font-weight: 600;
            }
            [data-showskip-panel] .showskip-choice-input:checked:not(:disabled) + .showskip-choice-label:hover {
                background: var(--showskip-selected-hover);
            }
            [data-showskip-panel] .showskip-choice-input:disabled + .showskip-choice-label {
                color: var(--showskip-disabled-text);
                cursor: not-allowed;
            }
            [data-showskip-panel] .showskip-choice-input:checked:disabled + .showskip-choice-label {
                background: var(--showskip-disabled-selected-surface);
            }
            [data-showskip-panel] .showskip-note {
                margin: 0.72rem 0 0;
                color: var(--showskip-secondary-text);
                font-size: 0.72rem;
                line-height: 1.35;
            }
            [data-showskip-panel] .showskip-attribution {
                margin: 0.52rem 0 0;
                color: var(--showskip-secondary-text);
                font-size: 0.7rem;
                line-height: 1.35;
            }
            [data-showskip-panel] .showskip-attribution a {
                color: var(--showskip-primary-text);
                text-decoration: underline;
                text-underline-offset: 0.14em;
            }
            [data-showskip-playback-action-root] {
                position: absolute;
                right: max(1.25rem, env(safe-area-inset-right));
                bottom: max(5.25rem, calc(env(safe-area-inset-bottom) + 4rem));
                z-index: 4;
                display: flex;
                justify-content: flex-end;
                pointer-events: none;
            }
            [data-showskip-playback-action] {
                appearance: none;
                min-width: 44px;
                min-height: 44px;
                padding: 0.62rem 1rem;
                border: 1px solid rgba(255, 255, 255, 0.24);
                border-radius: 0.62rem;
                color: #ffffff;
                background: rgba(18, 22, 29, 0.92);
                box-shadow: 0 0.42rem 1.2rem rgba(0, 0, 0, 0.4);
                cursor: pointer;
                font: inherit;
                font-size: 0.86rem;
                font-weight: 650;
                line-height: 1.2;
                pointer-events: auto;
                backdrop-filter: blur(12px);
            }
            [data-showskip-playback-action]:hover {
                background: #0d7a86;
            }
            [data-showskip-playback-action]:focus-visible {
                outline: 2px solid #ffffff;
                outline-offset: 3px;
            }
            [data-showskip-playback-action]:disabled {
                cursor: wait;
                opacity: 0.68;
            }
            [data-showskip-timeline-layer] {
                position: absolute;
                inset: 0;
                z-index: 0;
                pointer-events: none;
            }
            [class^="overlayHidden-"] [data-showskip-timeline-layer],
            [class*=" overlayHidden-"] [data-showskip-timeline-layer] {
                visibility: hidden;
            }
            [data-showskip-timeline-marker] {
                position: absolute;
                top: 50%;
                box-sizing: border-box;
                min-width: 1px;
                height: var(--track-size, 0.3rem);
                border: 1px solid rgba(10, 9, 14, 0.56);
                border-radius: 999px;
                opacity: 0.76;
                pointer-events: none;
                transform: translateY(-50%);
                box-shadow: 0 0 0.16rem rgba(0, 0, 0, 0.42);
            }
            [data-showskip-timeline-marker][data-showskip-segment-type="recap"] {
                background: #e8a23a;
            }
            [data-showskip-timeline-marker][data-showskip-segment-type="intro"] {
                background: #f3ce55;
            }
            [data-showskip-timeline-marker][data-showskip-segment-type="credits"] {
                background: #70a9f5;
            }
            [data-showskip-timeline-marker][data-showskip-segment-type="preview"] {
                background: #63c985;
            }
            [data-showskip-timeline-marker]:focus-visible {
                z-index: 1;
                opacity: 1;
                outline: 2px solid #f8f7fb;
                outline-offset: 1px;
            }
            [data-showskip-timeline-tooltip] {
                position: fixed;
                z-index: 10001;
                max-width: min(18rem, 70vw);
                padding: 0.28rem 0.46rem;
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 0.38rem;
                color: #f8f7fb;
                background: rgba(18, 22, 29, 0.96);
                box-shadow: 0 0.32rem 0.9rem rgba(0, 0, 0, 0.38);
                font-size: 0.72rem;
                line-height: 1.25;
                white-space: nowrap;
                pointer-events: none;
                transform: translate(-50%, -100%);
            }
            [data-showskip-timeline-tooltip][hidden] {
                display: none;
            }
            @media screen and (max-width: 640px) {
                [data-showskip-panel] {
                    left: max(0.75rem, env(safe-area-inset-left)) !important;
                    right: max(0.75rem, env(safe-area-inset-right)) !important;
                    top: auto !important;
                    bottom: max(0.75rem, env(safe-area-inset-bottom)) !important;
                    width: auto;
                    max-height: min(80vh, 38rem);
                }
                [data-showskip-panel] .showskip-choice-label {
                    padding-inline: 0.22rem;
                    font-size: 0.7rem;
                }
            }
            @media (prefers-reduced-motion: reduce) {
                [data-showskip-launcher] {
                    transition: none;
                }
            }
        `;
        return style;
    }

    class ContextDetector {
        constructor(windowObject, limits = LIMITS) {
            this.window = windowObject;
            this.limits = limits;
        }

        current() {
            return parseRoute(this.window.location.hash, this.limits);
        }
    }

    class ShowPageController {
        constructor(windowObject, documentObject, store, onStateSettled) {
            this.window = windowObject;
            this.document = documentObject;
            this.store = store;
            this.onStateSettled = onStateSettled;
            this.context = null;
            this.profile = null;
            this.actionRow = null;
            this.launcher = null;
            this.panel = null;
            this.resizeObserver = null;
            this.positionFrame = null;
            this.listeners = [];
            this.mutationRevision = 0;
            this.attributionVisible = false;
        }

        activate(context, profile, attributionVisible = false) {
            // The launcher is a floating pill on document.body, so it does not depend on
            // Stremio's internal action-row markup (which varies between versions).
            const host = this.document.body;
            if (!host) {
                this._removePresentation();
                this.context = context;
                this.profile = profile;
                return false;
            }

            const contextChanged = !this.context || this.context.showKey !== context.showKey;
            const launcherInvalid = !this.launcher
                || !this.launcher.isConnected
                || this.launcher.parentNode !== host;
            if (contextChanged && this.context) {
                this.mutationRevision += 1;
            }
            if (contextChanged || launcherInvalid) {
                this._removePresentation();
            }

            this.context = context;
            this.profile = profile;
            this.attributionVisible = attributionVisible === true;
            this.actionRow = null;

            let created = false;
            if (!this.launcher || !this.launcher.isConnected || this.launcher.parentNode !== host) {
                for (const stale of this.document.querySelectorAll(LAUNCHER_SELECTOR)) {
                    removeNode(stale);
                }
                this.launcher = this._createLauncher();
                host.appendChild(this.launcher);
                created = true;
            } else {
                for (const stale of this.document.querySelectorAll(LAUNCHER_SELECTOR)) {
                    if (stale !== this.launcher) {
                        removeNode(stale);
                    }
                }
            }
            if (created) {
                this._listen(this.launcher, "click", () => this._openPanelFromLauncher());
            }

            if (profile.panelOpen) {
                if (!this.panel || !this.panel.isConnected) {
                    this._mountPanel(false);
                } else {
                    this._syncPanel();
                }
            } else {
                this._removePanel(false);
            }
            this._syncLauncherState();
            this._positionPanel();
            return true;
        }

        deactivate() {
            this.mutationRevision += 1;
            this._removePresentation();
            this.context = null;
            this.profile = null;
            this.actionRow = null;
            this.attributionVisible = false;
        }

        destroy() {
            this.deactivate();
        }

        reposition() {
            if (this.positionFrame !== null) {
                return;
            }
            const requestFrame = typeof this.window.requestAnimationFrame === "function"
                ? this.window.requestAnimationFrame.bind(this.window)
                : (callback) => this.window.setTimeout(callback, 16);
            this.positionFrame = requestFrame(() => {
                this.positionFrame = null;
                this._positionPanel();
            });
        }

        _createLauncher() {
            const button = this.document.createElement("button");
            button.type = "button";
            button.setAttribute("data-showskip-owned", "launcher");
            button.setAttribute("data-showskip-launcher", "");
            button.setAttribute("aria-label", "ShowSkip settings for this series");
            button.setAttribute("title", "ShowSkip settings");
            button.setAttribute("aria-expanded", "false");
            button.appendChild(createSvgIcon(this.document));
            const label = this.document.createElement("span");
            label.className = "showskip-launcher-label";
            label.textContent = "ShowSkip settings";
            button.appendChild(label);
            return button;
        }

        _openPanelFromLauncher() {
            if (!this.context || !this.profile || this.profile.panelOpen) {
                return;
            }
            this.profile = { ...this.profile, panelOpen: true };
            this._mountPanel(true);
            this._syncLauncherState();
            this._persistPatch({ panelOpen: true });
        }

        _closePanelFromUser() {
            if (!this.context || !this.profile || !this.profile.panelOpen) {
                return;
            }
            this.profile = { ...this.profile, panelOpen: false };
            this._removePanel(true);
            this._syncLauncherState();
            this._persistPatch({ panelOpen: false });
        }

        _persistPatch(patch) {
            const showKey = this.context.showKey;
            const revision = this.mutationRevision + 1;
            this.mutationRevision = revision;
            void this.store.patchProfile(showKey, patch).then((result) => {
                if (this.context
                    && this.context.showKey === showKey
                    && this.mutationRevision === revision) {
                    this.profile = result.profile;
                    this._syncPanel();
                }
            }).catch(() => undefined).finally(() => {
                this.onStateSettled();
            });
        }

        _mountPanel(userInitiated) {
            this._removePanel(false);
            for (const stalePanel of this.document.querySelectorAll(PANEL_SELECTOR)) {
                removeNode(stalePanel);
            }

            const panel = this.document.createElement("section");
            const suffix = stableHash(this.context.showKey);
            const panelId = `showskip-panel-${suffix}`;
            const titleId = `showskip-title-${suffix}`;
            panel.id = panelId;
            panel.tabIndex = -1;
            panel.setAttribute("data-showskip-owned", "panel");
            panel.setAttribute("data-showskip-panel", "");
            panel.setAttribute("role", "dialog");
            panel.setAttribute("aria-modal", "false");
            panel.setAttribute("aria-labelledby", titleId);

            const header = this.document.createElement("div");
            header.className = "showskip-header";
            const headingGroup = this.document.createElement("div");
            const title = this.document.createElement("h2");
            title.id = titleId;
            title.className = "showskip-title";
            title.textContent = "ShowSkip";
            const subtitle = this.document.createElement("p");
            subtitle.className = "showskip-subtitle";
            subtitle.textContent = "Playback preferences for this series";
            headingGroup.append(title, subtitle);

            const closeButton = this.document.createElement("button");
            closeButton.type = "button";
            closeButton.className = "showskip-close";
            closeButton.setAttribute("aria-label", "Close ShowSkip settings");
            closeButton.setAttribute("title", "Close");
            closeButton.textContent = "×";
            header.append(headingGroup, closeButton);
            panel.appendChild(header);

            for (const row of PANEL_ROWS) {
                panel.appendChild(this._createChoiceRow(row, suffix));
            }

            const note = this.document.createElement("p");
            note.className = "showskip-note";
            note.setAttribute("data-showskip-note", "");
            panel.appendChild(note);

            this.document.body.appendChild(panel);
            this.panel = panel;
            this._listen(closeButton, "click", () => this._closePanelFromUser());
            this._listen(panel, "change", (event) => this._handleChoiceChange(event));
            this._listen(panel, "keydown", (event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    this._closePanelFromUser();
                }
            });

            if (typeof this.window.ResizeObserver === "function") {
                this.resizeObserver = new this.window.ResizeObserver(() => this.reposition());
                this.resizeObserver.observe(this.launcher);
                this.resizeObserver.observe(panel);
            }

            this._syncPanel();
            this._syncLauncherState();
            this._positionPanel();
            if (userInitiated) {
                try {
                    panel.focus({ preventScroll: true });
                } catch (_error) {
                    panel.focus();
                }
            }
        }

        _createChoiceRow(row, suffix) {
            const fieldset = this.document.createElement("fieldset");
            fieldset.className = "showskip-row";
            fieldset.setAttribute("data-showskip-setting-row", row.field);
            const legend = this.document.createElement("legend");
            legend.className = "showskip-row-title";
            legend.setAttribute("data-showskip-row-label", row.field);
            legend.textContent = row.label;
            const group = this.document.createElement("div");
            group.className = "showskip-choice-group";

            row.values.forEach((value, index) => {
                const input = this.document.createElement("input");
                const id = `showskip-${suffix}-${row.field}-${index}`;
                input.id = id;
                input.type = "radio";
                input.name = `showskip-${suffix}-${row.field}`;
                input.value = value;
                input.className = "showskip-choice-input";
                input.setAttribute("data-showskip-field", row.field);
                input.checked = this.profile[row.field] === value;

                const label = this.document.createElement("label");
                label.className = "showskip-choice-label";
                label.setAttribute("data-showskip-option-label", value);
                label.htmlFor = id;
                label.textContent = row.labels[index];
                group.append(input, label);
            });

            fieldset.append(legend, group);
            return fieldset;
        }

        _handleChoiceChange(event) {
            const input = event.target;
            if (!input
                || input.type !== "radio"
                || !input.hasAttribute("data-showskip-field")
                || !input.checked) {
                return;
            }
            const field = input.getAttribute("data-showskip-field");
            const value = input.value;
            if (!isAllowedProfileValue(field, value)) {
                return;
            }
            this.profile = { ...this.profile, [field]: value };
            this._persistPatch({ [field]: value });
        }

        _syncPanel() {
            if (!this.panel || !this.panel.isConnected || !this.profile) {
                return;
            }
            for (const input of this.panel.querySelectorAll("input[data-showskip-field]")) {
                const field = input.getAttribute("data-showskip-field");
                input.checked = this.profile[field] === input.value;
            }
            const note = this.panel.querySelector("[data-showskip-note]");
            if (note) {
                const message = this.store.getStatus().mode === "writable"
                    ? "Segment rules are saved for this show. Next-episode behavior remains managed by Stremio."
                    : "Changes are temporary because Enhanced settings are unavailable this session.";
                if (note.textContent !== message) {
                    note.textContent = message;
                }
            }
            this._syncAttribution();
        }

        _syncAttribution() {
            if (!this.panel || !this.panel.isConnected) {
                return;
            }
            let attribution = this.panel.querySelector("[data-showskip-attribution]");
            if (!this.attributionVisible) {
                removeNode(attribution);
                return;
            }
            if (!attribution) {
                attribution = this.document.createElement("p");
                attribution.className = "showskip-attribution";
                attribution.setAttribute("data-showskip-attribution", "");
                const prefix = this.document.createElement("span");
                prefix.textContent = "Timestamp data by ";
                const link = this.document.createElement("a");
                link.href = THEINTRODB_ATTRIBUTION_URL;
                link.target = "_blank";
                link.rel = "noreferrer";
                link.textContent = "TheIntroDB";
                attribution.append(prefix, link);
                this.panel.appendChild(attribution);
            }
        }

        _syncLauncherState() {
            if (!this.launcher) {
                return;
            }
            const open = Boolean(this.panel && this.panel.isConnected && this.profile && this.profile.panelOpen);
            this.launcher.setAttribute("aria-expanded", String(open));
            if (open) {
                this.launcher.setAttribute("aria-controls", this.panel.id);
            } else {
                this.launcher.removeAttribute("aria-controls");
            }
        }

        _positionPanel() {
            if (!this.panel || !this.panel.isConnected || !this.launcher || !this.launcher.isConnected) {
                return;
            }
            if (this.window.matchMedia && this.window.matchMedia("(max-width: 640px)").matches) {
                this.panel.style.removeProperty("left");
                this.panel.style.removeProperty("top");
                return;
            }

            const launcherRect = this.launcher.getBoundingClientRect();
            const panelRect = this.panel.getBoundingClientRect();
            const gap = 10;
            const margin = 12;
            const maxLeft = Math.max(margin, this.window.innerWidth - panelRect.width - margin);
            const left = Math.min(Math.max(launcherRect.left, margin), maxLeft);
            const below = launcherRect.bottom + gap;
            const preferredTop = below + panelRect.height <= this.window.innerHeight - margin
                ? below
                : Math.max(margin, launcherRect.top - panelRect.height - gap);
            const maxTop = Math.max(margin, this.window.innerHeight - panelRect.height - margin);
            const top = Math.min(Math.max(preferredTop, margin), maxTop);
            this.panel.style.left = `${Math.round(left)}px`;
            this.panel.style.top = `${Math.round(top)}px`;
        }

        _removePanel(restoreFocus) {
            if (this.positionFrame !== null) {
                const cancelFrame = typeof this.window.cancelAnimationFrame === "function"
                    ? this.window.cancelAnimationFrame.bind(this.window)
                    : this.window.clearTimeout.bind(this.window);
                cancelFrame(this.positionFrame);
                this.positionFrame = null;
            }
            if (this.resizeObserver) {
                this.resizeObserver.disconnect();
                this.resizeObserver = null;
            }
            if (this.panel) {
                const panel = this.panel;
                this.panel = null;
                this._removeListenersWithin(panel);
                removeNode(panel);
            }
            for (const stalePanel of this.document.querySelectorAll(PANEL_SELECTOR)) {
                removeNode(stalePanel);
            }
            this._syncLauncherState();
            if (restoreFocus && this.launcher && this.launcher.isConnected) {
                try {
                    this.launcher.focus({ preventScroll: true });
                } catch (_error) {
                    this.launcher.focus();
                }
            }
        }

        _removePresentation() {
            this._removePanel(false);
            this._removeAllListeners();
            if (this.launcher) {
                removeNode(this.launcher);
                this.launcher = null;
            }
            for (const staleLauncher of this.document.querySelectorAll(LAUNCHER_SELECTOR)) {
                removeNode(staleLauncher);
            }
            this.actionRow = null;
        }

        _listen(target, type, handler, options) {
            target.addEventListener(type, handler, options);
            this.listeners.push({ target, type, handler, options });
        }

        _removeListenersWithin(root) {
            const retained = [];
            for (const listener of this.listeners) {
                if (listener.target === root || (root.contains && root.contains(listener.target))) {
                    listener.target.removeEventListener(listener.type, listener.handler, listener.options);
                } else {
                    retained.push(listener);
                }
            }
            this.listeners = retained;
        }

        _removeAllListeners() {
            for (const listener of this.listeners) {
                listener.target.removeEventListener(listener.type, listener.handler, listener.options);
            }
            this.listeners = [];
        }
    }

    function selectReconcileProfile(controller, context, capturedRevision, storedProfile) {
        if (controller.context
            && controller.profile
            && controller.context.showKey === context.showKey
            && controller.context.signature === context.signature
            && controller.mutationRevision !== capturedRevision) {
            return cloneJson(controller.profile);
        }
        return storedProfile;
    }

    class ShowSkipPlugin {
        constructor(windowObject, documentObject, api) {
            this.window = windowObject;
            this.document = documentObject;
            this.api = api;
            this.logger = createLogger(api);
            this.store = new ProfileStore(api, this.logger);
            this.contextDetector = new ContextDetector(windowObject);
            this.coreStateReader = new CoreStateReader(windowObject);
            this.episodeIdentityProvider = new EpisodeIdentityProvider(this.contextDetector, this.coreStateReader);
            this.providerUsedShows = new Set();
            this.segmentProvider = new TheIntroDBProvider({
                fetch: typeof windowObject.fetch === "function" ? windowObject.fetch.bind(windowObject) : null,
                setTimeout: windowObject.setTimeout.bind(windowObject),
                clearTimeout: windowObject.clearTimeout.bind(windowObject),
                AbortController: windowObject.AbortController,
            });
            this.showPage = new ShowPageController(
                windowObject,
                documentObject,
                this.store,
                () => this.scheduleReconcile(),
            );
            this.player = new PlayerController({
                windowObject,
                documentObject,
                identityProvider: this.episodeIdentityProvider,
                provider: this.segmentProvider,
                onSchedule: () => this.scheduleReconcile(),
                onProviderUsed: (showKey) => this.providerUsedShows.add(showKey),
                AbortController: windowObject.AbortController,
                actionsEnabled: PHASE3_PLAYBACK_ACTIONS_ENABLED,
                getProfile: (showKey) => this.store.getOrCreateProfile(showKey),
                getCurrentRoute: () => this.contextDetector.current(),
            });
            this.documentObserver = null;
            this.loaderObserver = null;
            this.style = null;
            this.retryTimer = null;
            this.retrySignature = null;
            this.retryCount = 0;
            this.generation = 0;
            this.destroyed = false;
            this.listeners = [];

            const requestFrame = typeof windowObject.requestAnimationFrame === "function"
                ? windowObject.requestAnimationFrame.bind(windowObject)
                : (callback) => windowObject.setTimeout(callback, 16);
            const cancelFrame = typeof windowObject.cancelAnimationFrame === "function"
                ? windowObject.cancelAnimationFrame.bind(windowObject)
                : windowObject.clearTimeout.bind(windowObject);
            this.scheduler = new CoalescedScheduler(
                requestFrame,
                cancelFrame,
                () => this._reconcile(),
                () => this.logger.error("ShowSkip reconciliation failed safely."),
            );
        }

        async boot() {
            await this.store.initialize();
            if (this.destroyed) {
                return;
            }

            this.style = createStyles(this.document);
            (this.document.head || this.document.documentElement).appendChild(this.style);

            this._listen(this.window, "hashchange", () => {
                this.generation += 1;
                this._clearRetry();
                this.showPage.deactivate();
                this.player.deactivate();
                this.scheduleReconcile();
            });
            this._listen(this.window, "resize", () => this.showPage.reposition());
            this._listen(this.window, "scroll", () => this.showPage.reposition(), true);
            this._listen(this.window, "pagehide", () => this.destroy());
            this._listen(this.window, "beforeunload", () => this.destroy());

            if (typeof this.window.MutationObserver === "function" && this.document.documentElement) {
                this.documentObserver = new this.window.MutationObserver(() => {
                    this._invalidateStalePresentation(this.contextDetector.current());
                    this.scheduleReconcile();
                });
                this.documentObserver.observe(this.document.documentElement, { childList: true, subtree: true });
            }
            this._ensureLoaderObserver();
            this.scheduleReconcile();
        }

        scheduleReconcile() {
            if (!this.destroyed) {
                this.scheduler.schedule();
            }
        }

        destroy() {
            if (this.destroyed) {
                return;
            }
            this.destroyed = true;
            this.generation += 1;
            this._clearRetry();
            this.scheduler.destroy();
            if (this.documentObserver) {
                this.documentObserver.disconnect();
                this.documentObserver = null;
            }
            if (this.loaderObserver) {
                this.loaderObserver.disconnect();
                this.loaderObserver = null;
            }
            for (const listener of this.listeners) {
                listener.target.removeEventListener(listener.type, listener.handler, listener.options);
            }
            this.listeners = [];
            this.showPage.destroy();
            this.player.destroy();
            for (const node of this.document.querySelectorAll(OWNED_SELECTOR)) {
                removeNode(node);
            }
            this.style = null;
            if (this.window[GLOBAL_INSTANCE_KEY] === this) {
                delete this.window[GLOBAL_INSTANCE_KEY];
            }
        }

        async _reconcile() {
            if (this.destroyed) {
                return;
            }
            this._ensureLoaderObserver();
            const context = this.contextDetector.current();
            this._invalidateStalePresentation(context);
            const generation = this.generation;
            const controllerRevision = this.showPage.mutationRevision;
            if (context.kind === "player") {
                this.showPage.deactivate();
                const active = await this.player.reconcile(context);
                if (this.destroyed || generation !== this.generation) {
                    return;
                }
                if (active || context.eligible !== true) {
                    this._clearRetry();
                } else {
                    this._scheduleBoundedRetry(context.signature);
                }
                return;
            }
            if (context.kind !== "seriesDetail") {
                this._clearRetry();
                this.showPage.deactivate();
                this.player.deactivate();
                return;
            }
            this.player.deactivate();

            const result = await this.store.getOrCreateProfile(context.showKey);
            if (this.destroyed || generation !== this.generation) {
                return;
            }
            const current = this.contextDetector.current();
            if (current.kind !== "seriesDetail"
                || current.showKey !== context.showKey
                || current.signature !== context.signature) {
                return;
            }

            const profile = selectReconcileProfile(
                this.showPage,
                context,
                controllerRevision,
                result.profile,
            );
            const mounted = this.showPage.activate(context, profile, this.providerUsedShows.has(context.showKey));
            if (mounted) {
                this._clearRetry();
            } else {
                this._scheduleBoundedRetry(context.signature);
            }
        }

        _invalidateStalePresentation(context) {
            const mounted = this.showPage.context;
            const showMatches = !mounted || (context.kind === "seriesDetail"
                && context.showKey === mounted.showKey
                && context.signature === mounted.signature);
            const playerInvalidated = this.player.invalidateRoute(context);
            if (!showMatches || playerInvalidated) {
                this.generation += 1;
                this._clearRetry();
                if (!showMatches) {
                    this.showPage.deactivate();
                }
            }
        }

        _scheduleBoundedRetry(signature) {
            if (this.destroyed || this.retryTimer !== null) {
                return;
            }
            if (this.retrySignature !== signature) {
                this.retrySignature = signature;
                this.retryCount = 0;
            }
            if (this.retryCount >= 12) {
                return;
            }
            this.retryCount += 1;
            this.retryTimer = this.window.setTimeout(() => {
                this.retryTimer = null;
                this.scheduleReconcile();
            }, 250);
        }

        _clearRetry() {
            if (this.retryTimer !== null) {
                this.window.clearTimeout(this.retryTimer);
                this.retryTimer = null;
            }
            this.retrySignature = null;
            this.retryCount = 0;
        }

        _ensureLoaderObserver() {
            if (this.loaderObserver || typeof this.window.MutationObserver !== "function") {
                return;
            }
            const loaderScript = this.document.getElementById(PLUGIN_FILENAME);
            if (!loaderScript || !loaderScript.parentNode) {
                return;
            }
            this.loaderObserver = new this.window.MutationObserver(() => {
                if (!loaderScript.isConnected) {
                    this.destroy();
                }
            });
            this.loaderObserver.observe(loaderScript.parentNode, { childList: true });
        }

        _listen(target, type, handler, options) {
            target.addEventListener(type, handler, options);
            this.listeners.push({ target, type, handler, options });
        }
    }

    const isBrowserRuntime = typeof window === "object" && typeof document === "object";
    const globalObject = isBrowserRuntime ? window : globalThis;
    if (!isBrowserRuntime && globalObject && globalObject[TEST_MODE_KEY] === true) {
        Object.defineProperty(globalObject, TEST_HOOKS_KEY, {
            configurable: true,
            value: Object.freeze({
                LIMITS,
                DEFAULT_PROFILE_VALUES,
                PANEL_PALETTE,
                PANEL_ROWS,
                PHASE3_PLAYBACK_ACTIONS_ENABLED,
                PLAYBACK_ACTION_LIMITS,
                PROVIDER_LIMITS,
                ProfileStore,
                CoalescedScheduler,
                CoreStateReader,
                DurationStabilizer,
                EpisodeIdentityProvider,
                HtmlMediaAdapter,
                NextEpisodeAdapter,
                PlaybackActionStateMachine,
                PlayerController,
                PlayerActionRenderer,
                SessionSegmentCache,
                ShowPageController,
                TheIntroDBProvider,
                TimelineRenderer,
                buildTheIntroDbUrl,
                canonicalShowKey,
                classifyCorePlayerState,
                computeMarkerGeometry,
                createEpisodeIdentity,
                createDefaultProfile,
                createStyles,
                ensureSingleOwnedNode,
                formatTimelineTime,
                inspectJsonValue,
                normalizeDurationMs,
                normalizeProviderSegment,
                normalizeState,
                parseRoute,
                parseEpisodeVideoId,
                providerCacheKey,
                resolveActiveActionRow,
                resolveActiveHtmlVideo,
                resolveActiveRouteRoot,
                resolveActiveSeekTarget,
                segmentAccessibleLabel,
                segmentActionLabel,
                selectReconcileProfile,
                serializedByteLength,
                validateTheIntroDbResponse,
                validActionSegments,
            }),
        });
        return;
    }

    if (!isBrowserRuntime) {
        return;
    }

    const api = typeof StremioEnhancedAPI === "object" ? StremioEnhancedAPI : null;
    const existing = window[GLOBAL_INSTANCE_KEY];
    if (existing && typeof existing.destroy === "function") {
        existing.destroy();
    }

    const plugin = new ShowSkipPlugin(window, document, api);
    window[GLOBAL_INSTANCE_KEY] = plugin;
    void plugin.boot().catch(() => {
        plugin.logger.error("ShowSkip failed to start and was cleaned up.");
        plugin.destroy();
    });
})();
