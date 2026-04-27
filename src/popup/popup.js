(function initPopup(global) {
  "use strict";

  const namespace = global.RapidViewForChatGPT;
  const constants = namespace.Constants;
  const settingsApi = namespace.Settings;
  const DEFAULT_EXPORT_BUTTON_LABEL = "Download conversation as TXT";
  const EXPORT_ERROR_DURATION_MS = 2600;
  let exportFeedbackTimer = 0;
  let lastStatus = null;

  const elements = {
    enabled: document.getElementById("enabled"),
    dynamicScroll: document.getElementById("dynamicScroll"),
    exportConversation: document.getElementById("exportConversation"),
    manualModeButton: document.getElementById("manualModeButton"),
    dynamicButton: document.getElementById("dynamicButton"),
    statusState: document.getElementById("statusState")
  };

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    return activeTab && Number.isInteger(activeTab.id) ? activeTab : null;
  }

  async function getActiveTabId() {
    const activeTab = await getActiveTab();
    return activeTab ? activeTab.id : null;
  }

  function getErrorMessage(error) {
    if (!error) {
      return "";
    }

    if (typeof error === "string") {
      return error;
    }

    return typeof error.message === "string" && error.message
      ? error.message
      : String(error);
  }

  function createStageError(stage, reason) {
    const error = new Error(reason || "export failed");
    error.stage = stage;
    return error;
  }

  function getErrorStage(error) {
    return error && typeof error.stage === "string" && error.stage
      ? error.stage
      : "export";
  }

  function isKnownChatGptTab(tab) {
    if (!tab || typeof tab.url !== "string") {
      return false;
    }

    try {
      const url = new URL(tab.url);
      return url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com";
    } catch (error) {
      void error;
      return false;
    }
  }

  function isKnownUnsupportedTab(tab) {
    return Boolean(tab && typeof tab.url === "string" && !isKnownChatGptTab(tab));
  }

  function normalizeContentExportFailure(error, tab) {
    const message = getErrorMessage(error);

    if (isKnownUnsupportedTab(tab)) {
      return "export is available only on a ChatGPT conversation tab";
    }

    if (/message port closed/i.test(message)) {
      return "ChatGPT tab is running an old content script; reload the ChatGPT tab";
    }

    if (/could not establish connection|receiving end does not exist/i.test(message)) {
      return "export message failed; open or reload a ChatGPT conversation tab";
    }

    return message || "export message failed; open or reload a ChatGPT conversation tab";
  }

  function normalizeDownloadFailure(error) {
    const message = getErrorMessage(error);

    if (/downloads.*permission|downloads api/i.test(message)) {
      return "downloads permission is not active; reload the extension";
    }

    if (/offscreen.*permission|offscreen permission|offscreen.*required/i.test(message)) {
      return "offscreen permission is not active; reload the extension";
    }

    if (/could not establish connection|receiving end does not exist|message port closed/i.test(message)) {
      return "download service is not active; reload the extension";
    }

    return message || "download failed";
  }

  function clearExportFeedbackTimer() {
    if (exportFeedbackTimer) {
      global.clearTimeout(exportFeedbackTimer);
      exportFeedbackTimer = 0;
    }
  }

  function getExportButtonLabel(state, reason = "") {
    if (state === "busy") {
      return "Preparing conversation TXT export";
    }

    if (state === "error") {
      return `Export failed: ${reason || "see popup console for details"}`;
    }

    return DEFAULT_EXPORT_BUTTON_LABEL;
  }

  function setExportButtonState(state, reason = "") {
    const button = elements.exportConversation;
    if (!button) {
      return;
    }

    button.classList.toggle("is-busy", state === "busy");
    button.classList.toggle("is-error", state === "error");
    button.disabled = state === "busy";
    button.setAttribute("aria-busy", state === "busy" ? "true" : "false");

    const label = getExportButtonLabel(state, reason);
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  function renderTemporaryStatus(label, tone, reason = "") {
    if (!elements.statusState) {
      return;
    }

    elements.statusState.textContent = label;
    elements.statusState.dataset.state = tone;
    if (reason) {
      elements.statusState.title = reason;
    } else {
      elements.statusState.removeAttribute("title");
    }
  }

  function showExportError(stage, reason) {
    clearExportFeedbackTimer();
    console.warn("Rapid View TXT export failed:", {
      stage,
      reason
    });
    setExportButtonState("error", reason);
    renderTemporaryStatus("Export error", "error", reason);

    exportFeedbackTimer = global.setTimeout(() => {
      exportFeedbackTimer = 0;
      setExportButtonState("idle");
      renderStatus(lastStatus);
    }, EXPORT_ERROR_DURATION_MS);
  }

  async function requestConversationExport(tab) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: constants.EXPORT_CONVERSATION_MESSAGE_TYPE
      });

      if (!response) {
        throw new Error("ChatGPT tab is running an old content script; reload the ChatGPT tab");
      }

      if (!response.ok) {
        throw new Error(response.reason || "conversation export failed");
      }

      if (typeof response.text !== "string" || !response.text.trim()) {
        throw new Error("no exportable conversation turns were found");
      }

      return {
        text: response.text,
        turnCount: Number.isInteger(response.turnCount) ? response.turnCount : 0
      };
    } catch (error) {
      throw createStageError("content-export", normalizeContentExportFailure(error, tab));
    }
  }

  function normalizeBlobUrlFailure(error) {
    const message = getErrorMessage(error);

    if (/offscreen.*permission|offscreen permission|offscreen.*required/i.test(message)) {
      return "offscreen permission is not active; reload the extension";
    }

    if (/could not establish connection|receiving end does not exist|message port closed/i.test(message)) {
      return "download preparation service is not active; reload the extension";
    }

    return message || "Blob URL creation failed";
  }

  async function prepareTextDownload(text) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: constants.PREPARE_TEXT_EXPORT_DOWNLOAD_MESSAGE_TYPE,
        filename: constants.EXPORT_FILENAME,
        text
      });

      if (!response) {
        throw new Error("download preparation service is not active; reload the extension");
      }

      if (
        !response.ok
        || typeof response.blobUrl !== "string"
        || !response.blobUrl
        || typeof response.leaseId !== "string"
        || !response.leaseId
      ) {
        throw new Error(response && response.reason ? response.reason : "Blob URL creation failed");
      }

      return response;
    } catch (error) {
      throw createStageError("blob-url-create", normalizeBlobUrlFailure(error));
    }
  }

  async function releasePreparedDownload(leaseId) {
    if (!leaseId) {
      return;
    }

    try {
      await chrome.runtime.sendMessage({
        type: constants.RELEASE_TEXT_EXPORT_DOWNLOAD_MESSAGE_TYPE,
        leaseId
      });
    } catch (error) {
      console.warn("Rapid View TXT export cleanup failed:", {
        stage: "blob-url-release",
        reason: getErrorMessage(error) || "release failed"
      });
    }
  }

  async function trackPreparedDownload(leaseId, downloadId) {
    if (!leaseId || !Number.isInteger(downloadId)) {
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: constants.TRACK_TEXT_EXPORT_DOWNLOAD_MESSAGE_TYPE,
        leaseId,
        downloadId
      });

      if (!response || !response.ok) {
        console.warn("Rapid View TXT export download tracking failed:", {
          stage: "download-track",
          reason: response && response.reason ? response.reason : "lease was not found"
        });
      }
    } catch (error) {
      console.warn("Rapid View TXT export download tracking failed:", {
        stage: "download-track",
        reason: getErrorMessage(error) || "download tracking failed"
      });
    }
  }

  function startChromeDownload(blobUrl) {
    if (!chrome.downloads || typeof chrome.downloads.download !== "function") {
      throw createStageError("downloads-download", "downloads permission is not active; reload the extension");
    }

    return new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: blobUrl,
        filename: constants.EXPORT_FILENAME,
        saveAs: true,
        conflictAction: "uniquify"
      }, (downloadId) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(createStageError("downloads-download", normalizeDownloadFailure(runtimeError)));
          return;
        }

        if (!Number.isInteger(downloadId)) {
          reject(createStageError("downloads-download", "download did not start"));
          return;
        }

        resolve(downloadId);
      });
    });
  }

  async function exportConversation() {
    clearExportFeedbackTimer();
    renderStatus(lastStatus);
    setExportButtonState("busy");

    try {
      const activeTab = await getActiveTab();
      if (!activeTab) {
        throw createStageError("content-export", "No active tab was found.");
      }

      const exportPayload = await requestConversationExport(activeTab);
      const preparedDownload = await prepareTextDownload(exportPayload.text);

      try {
        const downloadId = await startChromeDownload(preparedDownload.blobUrl);
        void trackPreparedDownload(preparedDownload.leaseId, downloadId);
      } catch (error) {
        await releasePreparedDownload(preparedDownload.leaseId);
        throw error;
      }

      setExportButtonState("idle");
    } catch (error) {
      showExportError(getErrorStage(error), getErrorMessage(error) || "export failed");
    }
  }

  function renderSettings(settings) {
    elements.enabled.checked = settings.enabled;
    elements.dynamicScroll.checked = Boolean(settings.dynamicScroll);
    renderModeSelector(Boolean(settings.dynamicScroll));
    updateArchiveControlsState(settings);
  }

  function renderModeSelector(dynamicScrollEnabled) {
    if (elements.manualModeButton) {
      elements.manualModeButton.classList.toggle("is-active", !dynamicScrollEnabled);
      elements.manualModeButton.setAttribute("aria-pressed", dynamicScrollEnabled ? "false" : "true");
    }

    if (elements.dynamicButton) {
      elements.dynamicButton.classList.toggle("is-active", dynamicScrollEnabled);
      elements.dynamicButton.setAttribute("aria-pressed", dynamicScrollEnabled ? "true" : "false");
    }
  }

  function updateArchiveControlsState(settings) {
    void settings;
  }

  function getDisplayState(status) {
    const rawState = status && typeof status.state === "string"
      ? status.state.toLowerCase()
      : "";

    switch (rawState) {
      case "active":
        return { label: "Active", tone: "active" };
      case "suspended":
        return { label: "Ready", tone: "ready" };
      case "searching":
        return { label: "Searching", tone: "searching" };
      case "disabled":
        return { label: "Disabled", tone: "disabled" };
      case "error":
        return { label: "Error", tone: "error" };
      case "inactive":
      case "unsupported":
      default:
        return { label: "Unavailable", tone: "unavailable" };
    }
  }

  function renderStatus(status) {
    const displayState = status
      ? getDisplayState(status)
      : { label: "Unavailable", tone: "unavailable" };

    if (elements.statusState) {
      elements.statusState.textContent = displayState.label;
      elements.statusState.dataset.state = displayState.tone;
      if (status && status.reason) {
        elements.statusState.title = status.reason;
      } else {
        elements.statusState.removeAttribute("title");
      }
    }

    if (!status) {
      return;
    }
  }

  function setStatus(status) {
    lastStatus = status;
    renderStatus(status);
  }

  async function refreshStatus() {
    const tabId = await getActiveTabId();

    if (!Number.isInteger(tabId)) {
      setStatus(null);
      return;
    }

    try {
      const status = await chrome.tabs.sendMessage(tabId, { type: constants.STATUS_MESSAGE_TYPE });
      setStatus(status);
    } catch (error) {
      setStatus(null);
    }
  }

  async function saveForm() {
    const saved = await settingsApi.save({
      enabled: elements.enabled.checked,
      dynamicScroll: elements.dynamicScroll.checked
    });

    renderSettings(saved);
    await refreshStatus();
  }

  async function main() {
    elements.enabled.addEventListener("change", saveForm);
    if (elements.exportConversation) {
      elements.exportConversation.addEventListener("click", exportConversation);
    }
    elements.manualModeButton.addEventListener("click", async () => {
      if (elements.dynamicScroll.checked) {
        elements.dynamicScroll.checked = false;
        await saveForm();
      }
    });
    elements.dynamicButton.addEventListener("click", async () => {
      if (!elements.dynamicScroll.checked) {
        elements.dynamicScroll.checked = true;
        await saveForm();
      }
    });

    const settings = await settingsApi.load();
    renderSettings(settings);
    await refreshStatus();
  }

  main().catch((error) => {
    setStatus({
      state: "error"
    });
  });
})(globalThis);
