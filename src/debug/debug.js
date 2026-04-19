(function initDebugPage() {
  "use strict";

  const STORAGE_KEY = "rapidViewForChatGptDebugLog";
  const updatedAtElement = document.getElementById("updatedAt");
  const routeKeyElement = document.getElementById("routeKey");
  const entryCountElement = document.getElementById("entryCount");
  const logOutputElement = document.getElementById("logOutput");
  const refreshButton = document.getElementById("refreshButton");
  const copyButton = document.getElementById("copyButton");
  const clearButton = document.getElementById("clearButton");

  function stringifyValue(value) {
    if (value == null) {
      return "";
    }

    if (typeof value === "string") {
      return value;
    }

    try {
      return JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  }

  function formatTime(isoString) {
    if (!isoString) {
      return "-";
    }

    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
      return isoString;
    }

    return date.toLocaleString();
  }

  function formatEntry(entry) {
    const time = entry && entry.ts ? new Date(entry.ts).toLocaleTimeString() : "--:--:--";
    const level = entry && entry.level ? String(entry.level).toUpperCase() : "INFO";
    const message = entry && entry.message ? entry.message : "(no message)";
    const details = entry && entry.details ? ` ${stringifyValue(entry.details)}` : "";
    return `[${time}] ${level} ${message}${details}`;
  }

  function renderPayload(payload) {
    const safePayload = payload && typeof payload === "object" ? payload : {};
    const entries = Array.isArray(safePayload.entries) ? safePayload.entries : [];

    updatedAtElement.textContent = formatTime(safePayload.updatedAt || "");
    routeKeyElement.textContent = safePayload.routeKey || "-";
    entryCountElement.textContent = String(entries.length);
    logOutputElement.value = entries.length
      ? entries.map(formatEntry).join("\n")
      : "No debug logs have been written yet.";
  }

  async function loadLogs() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      renderPayload(result[STORAGE_KEY] || null);
    } catch (error) {
      renderPayload({
        updatedAt: new Date().toISOString(),
        routeKey: "storage-read-failed",
        entries: [
          {
            ts: new Date().toISOString(),
            level: "error",
            message: "debug-log-read-failed",
            details: {
              message: error && error.message ? error.message : String(error)
            }
          }
        ]
      });
    }
  }

  async function copyLogs() {
    const text = logOutputElement.value || "";

    try {
      await navigator.clipboard.writeText(text);
      copyButton.textContent = "Copied";
      window.setTimeout(() => {
        copyButton.textContent = "Copy";
      }, 1200);
    } catch (error) {
      logOutputElement.focus();
      logOutputElement.select();
      document.execCommand("copy");
    }
  }

  async function clearLogs() {
    await chrome.storage.local.remove(STORAGE_KEY);
    renderPayload(null);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !(STORAGE_KEY in changes)) {
      return;
    }

    renderPayload(changes[STORAGE_KEY].newValue || null);
  });

  refreshButton.addEventListener("click", loadLogs);
  copyButton.addEventListener("click", copyLogs);
  clearButton.addEventListener("click", () => {
    clearLogs().catch(() => {
      // Ignore clear failures in the UI.
    });
  });

  loadLogs().catch(() => {
    renderPayload(null);
  });
})();
