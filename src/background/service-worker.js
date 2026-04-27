importScripts("../shared/constants.js");

(function initServiceWorker(global) {
  "use strict";

  const namespace = global.RapidViewForChatGPT;
  const constants = namespace.Constants;
  const {
    PREPARE_TEXT_EXPORT_DOWNLOAD_MESSAGE_TYPE,
    TRACK_TEXT_EXPORT_DOWNLOAD_MESSAGE_TYPE,
    RELEASE_TEXT_EXPORT_DOWNLOAD_MESSAGE_TYPE,
    OFFSCREEN_CREATE_BLOB_URL_MESSAGE_TYPE,
    OFFSCREEN_REVOKE_BLOB_URL_MESSAGE_TYPE,
    EXPORT_FILENAME
  } = constants;

  const OFFSCREEN_DOCUMENT_PATH = "src/offscreen/download.html";
  const BLOB_URL_LEASE_TIMEOUT_MS = 5 * 60 * 1000;
  const leaseById = new Map();
  const leaseIdByBlobUrl = new Map();
  const leaseIdByDownloadId = new Map();
  const recentlyReleasedDownloadIds = new Set();
  let creatingOffscreenDocument = null;
  let nextLeaseCounter = 0;

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

  function createLeaseId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }

    nextLeaseCounter += 1;
    return `${Date.now()}-${nextLeaseCounter}`;
  }

  function getOffscreenReason() {
    if (chrome.offscreen && chrome.offscreen.Reason && chrome.offscreen.Reason.BLOBS) {
      return chrome.offscreen.Reason.BLOBS;
    }

    return "BLOBS";
  }

  async function hasOffscreenDocument() {
    if (chrome.runtime.getContexts) {
      const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [offscreenUrl]
      });

      return contexts.length > 0;
    }

    if (global.clients && typeof global.clients.matchAll === "function") {
      const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
      const matchedClients = await global.clients.matchAll();
      return matchedClients.some((client) => client.url === offscreenUrl);
    }

    return false;
  }

  async function ensureOffscreenDocument() {
    if (!chrome.offscreen || typeof chrome.offscreen.createDocument !== "function") {
      throw new Error("offscreen permission is not active; reload the extension");
    }

    if (await hasOffscreenDocument()) {
      return;
    }

    if (!creatingOffscreenDocument) {
      creatingOffscreenDocument = chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: [getOffscreenReason()],
        justification: "Create and hold local TXT Blob URLs for Save As downloads."
      }).catch((error) => {
        const message = getErrorMessage(error);
        if (/single offscreen document/i.test(message) || /already exists/i.test(message)) {
          return;
        }

        throw error;
      }).finally(() => {
        creatingOffscreenDocument = null;
      });
    }

    await creatingOffscreenDocument;
  }

  async function createBlobUrl(text) {
    await ensureOffscreenDocument();

    const response = await chrome.runtime.sendMessage({
      type: OFFSCREEN_CREATE_BLOB_URL_MESSAGE_TYPE,
      text
    });

    if (!response || !response.ok || typeof response.url !== "string" || !response.url) {
      throw new Error(response && response.reason
        ? response.reason
        : "offscreen document failed to create Blob URL");
    }

    return response.url;
  }

  async function revokeBlobUrl(blobUrl) {
    if (!blobUrl) {
      return;
    }

    try {
      await ensureOffscreenDocument();
      await chrome.runtime.sendMessage({
        type: OFFSCREEN_REVOKE_BLOB_URL_MESSAGE_TYPE,
        url: blobUrl
      });
    } catch (error) {
      console.warn("Rapid View TXT export Blob URL cleanup failed:", getErrorMessage(error));
    }
  }

  function refreshLeaseTimer(leaseId) {
    const lease = leaseById.get(leaseId);
    if (!lease) {
      return;
    }

    if (lease.timerId) {
      global.clearTimeout(lease.timerId);
    }

    lease.timerId = global.setTimeout(() => {
      const currentLease = leaseById.get(leaseId);
      if (!currentLease) {
        return;
      }

      console.warn(
        "Rapid View TXT export Blob URL lease timed out:",
        currentLease.downloadId
          ? `download ${currentLease.downloadId} did not complete before cleanup`
          : "no download was bound to the prepared Blob URL"
      );
      void releaseLease(leaseId, "timeout");
    }, BLOB_URL_LEASE_TIMEOUT_MS);
  }

  function storeLease(blobUrl, filename) {
    const leaseId = createLeaseId();
    const lease = {
      leaseId,
      blobUrl,
      filename,
      downloadId: null,
      createdAt: Date.now(),
      timerId: 0
    };

    leaseById.set(leaseId, lease);
    leaseIdByBlobUrl.set(blobUrl, leaseId);
    refreshLeaseTimer(leaseId);
    return lease;
  }

  function rememberReleasedDownloadId(downloadId) {
    if (!Number.isInteger(downloadId)) {
      return;
    }

    recentlyReleasedDownloadIds.add(downloadId);
    global.setTimeout(() => {
      recentlyReleasedDownloadIds.delete(downloadId);
    }, 30000);
  }

  async function releaseLease(leaseId, reason = "release-request") {
    const lease = leaseById.get(leaseId);
    if (!lease) {
      return false;
    }

    leaseById.delete(leaseId);
    leaseIdByBlobUrl.delete(lease.blobUrl);

    if (Number.isInteger(lease.downloadId)) {
      leaseIdByDownloadId.delete(lease.downloadId);
      rememberReleasedDownloadId(lease.downloadId);
    }

    if (lease.timerId) {
      global.clearTimeout(lease.timerId);
    }

    if (reason === "timeout") {
      console.warn("Rapid View TXT export releasing timed-out Blob URL lease:", leaseId);
    }

    await revokeBlobUrl(lease.blobUrl);
    return true;
  }

  function trackLeaseDownload(leaseId, downloadId) {
    const lease = leaseById.get(leaseId);
    if (!lease) {
      return false;
    }

    if (!Number.isInteger(downloadId)) {
      return false;
    }

    lease.downloadId = downloadId;
    leaseIdByDownloadId.set(downloadId, leaseId);
    refreshLeaseTimer(leaseId);
    return true;
  }

  function getDownloadState(downloadId) {
    if (!chrome.downloads || typeof chrome.downloads.search !== "function") {
      return Promise.resolve("");
    }

    return new Promise((resolve) => {
      chrome.downloads.search({ id: downloadId }, (items) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError || !Array.isArray(items) || !items[0]) {
          resolve("");
          return;
        }

        resolve(typeof items[0].state === "string" ? items[0].state : "");
      });
    });
  }

  async function trackLeaseDownloadAndCleanupIfDone(leaseId, downloadId) {
    const tracked = trackLeaseDownload(leaseId, downloadId);
    if (!tracked) {
      return false;
    }

    const state = await getDownloadState(downloadId);
    if (state === "complete" || state === "interrupted") {
      await releaseLease(leaseId, state);
    }

    return true;
  }

  function trackDownloadByUrl(downloadItem) {
    if (!downloadItem || typeof downloadItem.url !== "string" || !Number.isInteger(downloadItem.id)) {
      return false;
    }

    const leaseId = leaseIdByBlobUrl.get(downloadItem.url);
    if (!leaseId) {
      return false;
    }

    void trackLeaseDownloadAndCleanupIfDone(leaseId, downloadItem.id);
    return true;
  }

  async function handlePrepareTextExportDownload(message) {
    const text = typeof message.text === "string" ? message.text : "";
    const filename = typeof message.filename === "string" && message.filename.trim()
      ? message.filename.trim()
      : EXPORT_FILENAME;

    if (!text.trim()) {
      return {
        ok: false,
        reason: "no exportable conversation turns were found"
      };
    }

    try {
      const blobUrl = await createBlobUrl(text);
      const lease = storeLease(blobUrl, filename);

      return {
        ok: true,
        blobUrl: lease.blobUrl,
        leaseId: lease.leaseId
      };
    } catch (error) {
      return {
        ok: false,
        reason: getErrorMessage(error) || "Blob URL creation failed"
      };
    }
  }

  async function handleTrackTextExportDownload(message) {
    const leaseId = typeof message.leaseId === "string" ? message.leaseId : "";
    const downloadId = Number.isInteger(message.downloadId) ? message.downloadId : null;

    if (!leaseById.has(leaseId) && recentlyReleasedDownloadIds.has(downloadId)) {
      return {
        ok: true,
        alreadyReleased: true
      };
    }

    return {
      ok: await trackLeaseDownloadAndCleanupIfDone(leaseId, downloadId)
    };
  }

  async function handleReleaseTextExportDownload(message) {
    const leaseId = typeof message.leaseId === "string" ? message.leaseId : "";
    const released = await releaseLease(leaseId, "popup-release");

    return {
      ok: true,
      released
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void sender;

    if (!message || !message.type) {
      return false;
    }

    let responsePromise = null;
    if (message.type === PREPARE_TEXT_EXPORT_DOWNLOAD_MESSAGE_TYPE) {
      responsePromise = handlePrepareTextExportDownload(message);
    } else if (message.type === TRACK_TEXT_EXPORT_DOWNLOAD_MESSAGE_TYPE) {
      responsePromise = handleTrackTextExportDownload(message);
    } else if (message.type === RELEASE_TEXT_EXPORT_DOWNLOAD_MESSAGE_TYPE) {
      responsePromise = handleReleaseTextExportDownload(message);
    }

    if (!responsePromise) {
      return false;
    }

    responsePromise
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          reason: getErrorMessage(error) || "background export message failed"
        });
      });

    return true;
  });

  if (chrome.downloads && chrome.downloads.onCreated) {
    chrome.downloads.onCreated.addListener((downloadItem) => {
      trackDownloadByUrl(downloadItem);
    });
  }

  if (chrome.downloads && chrome.downloads.onChanged) {
    chrome.downloads.onChanged.addListener((delta) => {
      if (
        !delta
        || !Number.isInteger(delta.id)
        || !delta.state
        || !["complete", "interrupted"].includes(delta.state.current)
      ) {
        return;
      }

      const leaseId = leaseIdByDownloadId.get(delta.id);
      if (leaseId) {
        void releaseLease(leaseId, delta.state.current);
      }
    });
  }
})(globalThis);
