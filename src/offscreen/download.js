(function initOffscreenDownload(global) {
  "use strict";

  const namespace = global.RapidViewForChatGPT;
  const constants = namespace.Constants;
  const {
    OFFSCREEN_CREATE_BLOB_URL_MESSAGE_TYPE,
    OFFSCREEN_REVOKE_BLOB_URL_MESSAGE_TYPE
  } = constants;

  const blobUrls = new Set();

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

  function createTextBlobUrl(text) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    blobUrls.add(url);
    return url;
  }

  function revokeTextBlobUrl(url) {
    if (!blobUrls.has(url)) {
      return false;
    }

    URL.revokeObjectURL(url);
    blobUrls.delete(url);
    return true;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void sender;

    if (!message || !message.type) {
      return false;
    }

    if (message.type === OFFSCREEN_CREATE_BLOB_URL_MESSAGE_TYPE) {
      try {
        const text = typeof message.text === "string" ? message.text : "";
        if (!text.trim()) {
          sendResponse({
            ok: false,
            reason: "no exportable conversation turns were found"
          });
          return true;
        }

        sendResponse({
          ok: true,
          url: createTextBlobUrl(text)
        });
      } catch (error) {
        sendResponse({
          ok: false,
          reason: getErrorMessage(error) || "Blob URL creation failed"
        });
      }

      return true;
    }

    if (message.type === OFFSCREEN_REVOKE_BLOB_URL_MESSAGE_TYPE) {
      try {
        const url = typeof message.url === "string" ? message.url : "";
        sendResponse({
          ok: true,
          revoked: revokeTextBlobUrl(url)
        });
      } catch (error) {
        sendResponse({
          ok: false,
          reason: getErrorMessage(error) || "Blob URL cleanup failed"
        });
      }

      return true;
    }

    return false;
  });
})(globalThis);
