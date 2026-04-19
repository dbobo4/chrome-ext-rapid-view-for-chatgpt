(function initConstants(global) {
  "use strict";

  const namespace = global.RapidViewForChatGPT = global.RapidViewForChatGPT || {};

  namespace.Constants = Object.freeze({
    VERSION: "0.1.0",
    STORAGE_KEY: "rapidViewForChatGptSettings",
    DEBUG_LOG_STORAGE_KEY: "rapidViewForChatGptDebugLog",
    STATUS_MESSAGE_TYPE: "RAPID_VIEW_FOR_CHATGPT_GET_STATUS",
    ARCHIVE_ACTION_MESSAGE_TYPE: "RAPID_VIEW_FOR_CHATGPT_ARCHIVE_ACTION",
    DEFAULT_SETTINGS: Object.freeze({
      enabled: true,
      liveTurnCount: 4,
      restoreBatchSize: 4,
      archiveDefaultRendered: false,
      dynamicScroll: false,
      debugMode: false
    }),
    LIMITS: Object.freeze({
      minLiveTurnCount: 4,
      maxLiveTurnCount: 20,
      minRestoreBatchSize: 4,
      maxRestoreBatchSize: 30,
      activateMinTurns: 18,
      deactivateMinTurns: 12,
      activateMinEstimatedHeightPx: 6500,
      deactivateEstimatedHeightPx: 5000,
      defaultTailProtection: 2,
      streamingTailProtection: 4,
      oversizedMessageHeight: 3000,
      minDetectableMessages: 6,
      minStructuralTurns: 2,
      minStructuralDirectChildRatio: 0.7,
      bootstrapRetryMs: 250,
      bootstrapStabilityMs: 50,
      bootstrapMaxWaitMs: 5000,
      bootstrapVisibleThreadMaxWaitMs: 15000,
      routeCheckIntervalMs: 3000,
      rescanDebounceMs: 60,
      rootMutationDebounceMs: 60,
      detectionFailureLogCooldownMs: 750,
      longTaskLogMinDurationMs: 200,
      longTaskLogCooldownMs: 1200,
      debugLogFlushMs: 250,
      debugLogFlushTimeoutMs: 150,
      heightSampleSize: 6,
      deferredSnapshotBatchSize: 1,
      deferredSnapshotDelayMs: 40,
      dynamicScrollDwellMs: 1000,
      dynamicScrollSlotHeightPx: 160,
      dynamicUnitTargetHeightPx: 900,
      dynamicUnitSoftMaxHeightPx: 1400,
      dynamicNeighborUnitCount: 1,
      dynamicCodeChunkLineCount: 32,
      preHeavyActionYieldMs: 40,
      simplePreviewMaxChars: 1200,
      simplePreviewMaxLines: 14
    }),
    STATUS: Object.freeze({
      disabled: "disabled",
      searching: "searching",
      active: "active",
      inactive: "inactive",
      suspended: "suspended",
      unsupported: "unsupported"
    })
  });
})(globalThis);
