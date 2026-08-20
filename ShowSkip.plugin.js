/**
 * @name ShowSkip
 * @description Per-show segment skipping and next-episode rules for Stremio Enhanced.
 * @updateUrl none
 * @version 0.1.0
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
        Object.freeze({
            field: "nextEpisode",
            label: "Next Episode",
            values: NEXT_VALUES,
            labels: ["At credits", "After credits", "Button", "Stremio default", "Never"],
        }),
    ]);

    const OWNED_SELECTOR = "[data-showskip-owned]";
    const LAUNCHER_SELECTOR = "[data-showskip-launcher]";
    const PANEL_SELECTOR = "[data-showskip-panel]";

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

    function parseRoute(hash, limits = LIMITS) {
        if (typeof hash !== "string") {
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
                width: 4rem;
                height: 4rem;
                min-width: 44px;
                min-height: 44px;
                display: inline-grid;
                place-items: center;
                flex: 0 0 auto;
                margin: 0 0 1rem;
                padding: 0;
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 50%;
                color: var(--primary-foreground-color, rgba(255, 255, 255, 0.92));
                background: var(--overlay-color, rgba(28, 28, 36, 0.66));
                box-shadow: 0 0.4rem 1.2rem rgba(0, 0, 0, 0.16);
                cursor: pointer;
                font: inherit;
                transition: background-color 120ms ease, transform 120ms ease, border-color 120ms ease;
                backdrop-filter: blur(10px);
            }
            [data-showskip-launcher]:hover {
                background: var(--primary-accent-color, rgba(123, 91, 245, 0.86));
                border-color: rgba(255, 255, 255, 0.28);
                transform: translateY(-1px);
            }
            [data-showskip-launcher]:focus-visible,
            [data-showskip-panel] .showskip-choice-input:focus-visible + .showskip-choice-label,
            [data-showskip-panel] .showskip-close:focus-visible {
                outline: 2px solid var(--primary-accent-color, #9c7cff);
                outline-offset: 3px;
            }
            [data-showskip-launcher] svg {
                width: 1.65rem;
                height: 1.65rem;
                fill: currentColor;
            }
            [data-showskip-panel] {
                position: fixed;
                z-index: 10000;
                box-sizing: border-box;
                width: min(24rem, calc(100vw - 1.5rem));
                max-height: min(38rem, calc(100vh - 1.5rem));
                overflow: auto;
                padding: 1rem;
                color: var(--primary-foreground-color, #f7f5ff);
                background: var(--primary-background-color, rgba(25, 23, 34, 0.96));
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 1rem;
                box-shadow: 0 1rem 3rem rgba(0, 0, 0, 0.42);
                font: inherit;
                backdrop-filter: blur(18px);
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
                font-size: 1.05rem;
                font-weight: 650;
                line-height: 1.25;
            }
            [data-showskip-panel] .showskip-subtitle {
                margin: 0.18rem 0 0;
                color: var(--secondary-foreground-color, rgba(255, 255, 255, 0.64));
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
                color: inherit;
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
                margin: 0 0 0.36rem;
                padding: 0;
                color: var(--secondary-foreground-color, rgba(255, 255, 255, 0.72));
                font-size: 0.76rem;
                font-weight: 600;
            }
            [data-showskip-panel] .showskip-choice-group {
                display: grid;
                grid-auto-flow: column;
                grid-auto-columns: minmax(0, 1fr);
                gap: 0.22rem;
                padding: 0.22rem;
                border-radius: 0.72rem;
                background: rgba(255, 255, 255, 0.055);
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
                color: var(--secondary-foreground-color, rgba(255, 255, 255, 0.68));
                text-align: center;
                font-size: 0.72rem;
                line-height: 1.15;
                cursor: pointer;
                user-select: none;
            }
            [data-showskip-panel] .showskip-choice-input:checked + .showskip-choice-label {
                color: #fff;
                background: var(--primary-accent-color, rgba(123, 91, 245, 0.92));
                box-shadow: 0 0.2rem 0.7rem rgba(0, 0, 0, 0.2);
            }
            [data-showskip-panel] .showskip-note {
                margin: 0.72rem 0 0;
                color: var(--secondary-foreground-color, rgba(255, 255, 255, 0.58));
                font-size: 0.72rem;
                line-height: 1.35;
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
                    font-size: 0.68rem;
                }
            }
            @media screen and (max-width: 1000px) and (max-height: 500px) and (orientation: landscape) {
                [data-showskip-launcher] {
                    width: 3rem;
                    height: 3rem;
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
        }

        activate(context, profile) {
            const actionRow = resolveActiveActionRow(this.document);
            if (!actionRow) {
                this._removePresentation();
                this.context = context;
                this.profile = profile;
                return false;
            }

            const contextChanged = !this.context || this.context.showKey !== context.showKey;
            const launcherInvalid = !this.launcher
                || !this.launcher.isConnected
                || this.launcher.parentNode !== actionRow;
            if (contextChanged && this.context) {
                this.mutationRevision += 1;
            }
            if (contextChanged || launcherInvalid) {
                this._removePresentation();
            }

            this.context = context;
            this.profile = profile;
            this.actionRow = actionRow;

            const result = ensureSingleOwnedNode(
                actionRow,
                Array.from(this.document.querySelectorAll(LAUNCHER_SELECTOR)),
                this.launcher,
                () => this._createLauncher(),
            );
            this.launcher = result.node;
            if (result.created) {
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
            const legend = this.document.createElement("legend");
            legend.className = "showskip-row-title";
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
                    ? "Playback rules are saved for this show. Playback actions arrive in a later phase."
                    : "Changes are temporary because Enhanced settings are unavailable this session.";
                if (note.textContent !== message) {
                    note.textContent = message;
                }
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
            this.showPage = new ShowPageController(
                windowObject,
                documentObject,
                this.store,
                () => this.scheduleReconcile(),
            );
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
            if (context.kind !== "seriesDetail") {
                this._clearRetry();
                return;
            }

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
            const mounted = this.showPage.activate(context, profile);
            if (mounted) {
                this._clearRetry();
            } else {
                this._scheduleBoundedRetry(context.signature);
            }
        }

        _invalidateStalePresentation(context) {
            const mounted = this.showPage.context;
            if (!mounted) {
                return;
            }
            const matches = context.kind === "seriesDetail"
                && context.showKey === mounted.showKey
                && context.signature === mounted.signature;
            if (!matches) {
                this.generation += 1;
                this._clearRetry();
                this.showPage.deactivate();
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
                ProfileStore,
                CoalescedScheduler,
                canonicalShowKey,
                createDefaultProfile,
                ensureSingleOwnedNode,
                inspectJsonValue,
                normalizeState,
                parseRoute,
                resolveActiveActionRow,
                selectReconcileProfile,
                serializedByteLength,
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
