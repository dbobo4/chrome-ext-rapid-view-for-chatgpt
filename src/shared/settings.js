(function initSettings(global) {
  "use strict";

  const namespace = global.RapidViewForChatGPT = global.RapidViewForChatGPT || {};
  const constants = namespace.Constants;

  if (!constants) {
    throw new Error("Rapid View for ChatGPT constants must load before settings.");
  }

  const { STORAGE_KEY, DEFAULT_SETTINGS } = constants;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalize(raw) {
    const source = raw || {};

    return {
      enabled: source.enabled !== false,
      liveTurnCount: DEFAULT_SETTINGS.liveTurnCount,
      restoreBatchSize: DEFAULT_SETTINGS.restoreBatchSize,
      archiveDefaultRendered: false,
      dynamicScroll: Boolean(source.dynamicScroll),
      debugMode: false
    };
  }

  async function load() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return normalize(stored[STORAGE_KEY]);
  }

  async function save(partial) {
    const current = await load();
    const merged = normalize({ ...current, ...partial });
    await chrome.storage.local.set({ [STORAGE_KEY]: merged });
    return merged;
  }

  async function reset() {
    const defaults = normalize(DEFAULT_SETTINGS);
    await chrome.storage.local.set({ [STORAGE_KEY]: defaults });
    return defaults;
  }

  function onChanged(listener) {
    const handler = (changes, areaName) => {
      if (areaName !== "local" || !changes[STORAGE_KEY]) {
        return;
      }

      listener(normalize(changes[STORAGE_KEY].newValue));
    };

    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }

  namespace.Settings = {
    clamp,
    normalize,
    load,
    save,
    reset,
    onChanged
  };
})(globalThis);
