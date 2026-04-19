(function initPopup(global) {
  "use strict";

  const namespace = global.RapidViewForChatGPT;
  const constants = namespace.Constants;
  const settingsApi = namespace.Settings;

  const elements = {
    enabled: document.getElementById("enabled"),
    dynamicScroll: document.getElementById("dynamicScroll"),
    manualModeButton: document.getElementById("manualModeButton"),
    dynamicButton: document.getElementById("dynamicButton"),
    statusState: document.getElementById("statusState")
  };

  async function getActiveTabId() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] && tabs[0].id ? tabs[0].id : null;
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

  function setStatus(status) {
    const displayState = status
      ? getDisplayState(status)
      : { label: "Unavailable", tone: "unavailable" };

    if (elements.statusState) {
      elements.statusState.textContent = displayState.label;
      elements.statusState.dataset.state = displayState.tone;
    }

    if (!status) {
      return;
    }
  }

  async function refreshStatus() {
    const tabId = await getActiveTabId();

    if (!tabId) {
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
