(function initContentScript(global) {
  "use strict";

  if (global.__rapidViewForChatGptInitialized) {
    return;
  }

  global.__rapidViewForChatGptInitialized = true;

  const namespace = global.RapidViewForChatGPT;
  const constants = namespace.Constants;
  const settingsApi = namespace.Settings;
  const { LIMITS, STATUS, STATUS_MESSAGE_TYPE, ARCHIVE_ACTION_MESSAGE_TYPE } = constants;
  const OWN_ROOT_MUTATION_GUARD_MS = 250;
  const TURN_SELECTOR = "section[data-turn-id][data-turn][data-testid^='conversation-turn-']";
  const RAPID_VIEW_OWNED_UI_SELECTOR = [
    "[data-rapid-view-for-chatgpt-archive-host]",
    "[data-rapid-view-for-chatgpt-archive-block]",
    "[data-rapid-view-for-chatgpt-restore]",
    "[data-rapid-view-for-chatgpt-archive-actions]",
    "[data-rapid-view-for-chatgpt-dynamic-reader]",
    "[data-rapid-view-for-chatgpt-dynamic-window]",
    "[data-rapid-view-for-chatgpt-dynamic-measure]",
    "[data-rapid-view-for-chatgpt-dynamic-timeline]",
    "[data-rapid-view-for-chatgpt-dynamic-slot]"
  ].join(",");

  class Logger {
    info() {}

    warn() {}

    error() {}
  }

  class DomDetector {
    constructor(logger) {
      this.logger = logger;
      this.turnSelector = TURN_SELECTOR;
      this.lastStructuralSummary = null;
      this.lastFallbackSummary = null;
    }

    describeElement(node) {
      if (!(node instanceof Element)) {
        return "<non-element>";
      }

      const parts = [node.tagName.toLowerCase()];
      if (node.id) {
        parts.push(`#${node.id}`);
      }

      const testId = node.getAttribute("data-testid");
      if (testId) {
        parts.push(`[data-testid="${testId}"]`);
      }

      const turnRole = node.getAttribute("data-turn");
      if (turnRole) {
        parts.push(`[data-turn="${turnRole}"]`);
      }

      const role = node.getAttribute("role");
      if (role) {
        parts.push(`[role="${role}"]`);
      }

      const classList = Array.from(node.classList || []).slice(0, 3);
      if (classList.length) {
        parts.push(`.${classList.join(".")}`);
      }

      return parts.join("");
    }

    pushTopCandidate(summary, candidate, maxCount = 3) {
      if (!summary || !candidate) {
        return;
      }

      summary.topCandidates.push(candidate);
      summary.topCandidates.sort((left, right) => right.score - left.score);
      if (summary.topCandidates.length > maxCount) {
        summary.topCandidates.length = maxCount;
      }
    }

    recordCandidateRejection(summary, reason, node) {
      if (!summary) {
        return;
      }

      summary.rejectionCounts[reason] = (summary.rejectionCounts[reason] || 0) + 1;
      if (summary.rejectionSamples.length < 3) {
        summary.rejectionSamples.push({
          reason,
          node: this.describeElement(node)
        });
      }
    }

    detect(options = {}) {
      this.lastStructuralSummary = null;
      this.lastFallbackSummary = null;
      const main = this.findMain(options.preferredMain || null);

      if (!main) {
        return {
          ok: false,
          reason: "No visible main content area was found.",
          diagnostics: {
            mainFound: false,
            threadFound: false,
            fullScan: Boolean(options.fullScan),
            structuralSummary: this.lastStructuralSummary,
            fallbackSummary: this.lastFallbackSummary
          }
        };
      }

      const thread = main.querySelector("#thread");
      const rootResult = this.findMessageRoot(main, options);

      if (!rootResult) {
        return {
          ok: false,
          reason: "No stable message list candidate was found.",
          diagnostics: {
            mainFound: true,
            mainSummary: this.describeElement(main),
            threadFound: Boolean(thread),
            threadVisible: Boolean(thread && this.isVisible(thread)),
            fullScan: Boolean(options.fullScan),
            structuralSummary: this.lastStructuralSummary,
            fallbackSummary: this.lastFallbackSummary
          }
        };
      }

      const scrollContainer = this.findScrollContainer(rootResult.root, main);

      if (!scrollContainer) {
        return {
          ok: false,
          reason: "No vertical scroll container was found.",
          diagnostics: {
            mainFound: true,
            mainSummary: this.describeElement(main),
            threadFound: Boolean(thread),
            threadVisible: Boolean(thread && this.isVisible(thread)),
            fullScan: Boolean(options.fullScan),
            structuralSummary: this.lastStructuralSummary,
            fallbackSummary: this.lastFallbackSummary,
            selectedRoot: this.describeElement(rootResult.root),
            selectedMode: rootResult.mode,
            selectedScore: rootResult.score
          }
        };
      }

      return {
        ok: true,
        main,
        root: rootResult.root,
        messageNodes: rootResult.messageNodes,
        scrollContainer,
        score: rootResult.score,
        detectionMode: rootResult.mode,
        diagnostics: {
          mainFound: true,
          mainSummary: this.describeElement(main),
          threadFound: Boolean(thread),
          threadVisible: Boolean(thread && this.isVisible(thread)),
          fullScan: Boolean(options.fullScan),
          structuralSummary: this.lastStructuralSummary,
          fallbackSummary: this.lastFallbackSummary,
          selectedRoot: this.describeElement(rootResult.root),
          selectedMode: rootResult.mode,
          selectedScore: rootResult.score,
          selectedMessageCount: rootResult.messageNodes.length
        }
      };
    }

    detectFromKnownRoot(root, scrollContainer, preferredMain = null) {
      if (
        !(root instanceof HTMLElement)
        || !document.contains(root)
        || !this.isVisible(root)
        || this.isRapidViewOwnedElement(root)
      ) {
        return {
          ok: false,
          reason: "Known message root is no longer available."
        };
      }

      const messageNodes = this.getDirectMessageChildren(root);

      if (!messageNodes.length) {
        return {
          ok: false,
          reason: "Known message root no longer contains turn sections."
        };
      }

      const main = this.findMain(preferredMain) || root.closest("main, [role='main']");
      const resolvedScrollContainer = scrollContainer instanceof HTMLElement
        && document.contains(scrollContainer)
        && scrollContainer.contains(root)
        ? scrollContainer
        : this.findScrollContainer(root, main || document.body || document.documentElement);

      if (!resolvedScrollContainer) {
        return {
          ok: false,
          reason: "No vertical scroll container was found."
        };
      }

      return {
        ok: true,
        main,
        root,
        messageNodes,
        scrollContainer: resolvedScrollContainer,
        score: messageNodes.length * 100,
        detectionMode: "structural"
      };
    }

    findMain(preferredMain = null) {
      if (preferredMain instanceof HTMLElement && document.contains(preferredMain) && this.isVisible(preferredMain)) {
        return preferredMain;
      }

      const candidates = Array.from(document.querySelectorAll("main, [role='main']"));
      const visibleCandidates = candidates.filter((candidate) => this.isVisible(candidate));

      if (!visibleCandidates.length) {
        return null;
      }

      visibleCandidates.sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
      });

      return visibleCandidates[0];
    }

    findMessageRoot(main, options = {}) {
      const structuralResult = this.findStructuralMessageRoot(main);
      if (structuralResult) {
        return structuralResult;
      }

      if (
        this.lastStructuralSummary
        && Number(this.lastStructuralSummary.turnNodeCount) >= LIMITS.minStructuralTurns
      ) {
        return null;
      }

      if (!options.fullScan) {
        return null;
      }

      return this.findFallbackMessageRoot(main);
    }

    findStructuralMessageRoot(main) {
      const thread = main.querySelector("#thread");
      const summary = {
        threadFound: Boolean(thread),
        threadVisible: Boolean(thread && this.isVisible(thread)),
        turnNodeCount: 0,
        groupedParentCount: 0,
        candidateCount: 0,
        rejectionCounts: {},
        rejectionSamples: [],
        topCandidates: [],
        selected: null
      };

      if (!thread || !this.isVisible(thread)) {
        this.lastStructuralSummary = summary;
        return null;
      }

      const turnNodes = Array.from(thread.querySelectorAll(this.turnSelector))
        .filter((node) => this.isTurnNode(node));
      summary.turnNodeCount = turnNodes.length;

      if (turnNodes.length < LIMITS.minStructuralTurns) {
        this.lastStructuralSummary = summary;
        return null;
      }

      const wrapperItems = this.buildStructuralWrapperItems(thread, turnNodes);
      summary.groupedParentCount = new Set(
        wrapperItems
          .map((item) => item.wrapper.parentElement)
          .filter((parent) => parent instanceof HTMLElement)
      ).size;

      const wrapperByElement = new Map(wrapperItems.map((item) => [item.wrapper, item]));
      const candidateRoots = new Set();
      for (const item of wrapperItems) {
        let current = item.wrapper.parentElement;
        while (current && thread.contains(current)) {
          candidateRoots.add(current);
          if (current === thread) {
            break;
          }
          current = current.parentElement;
        }
      }

      let best = null;

      for (const candidateRoot of candidateRoots) {
        if (!this.isVisible(candidateRoot) || this.isRapidViewOwnedElement(candidateRoot)) {
          this.recordCandidateRejection(summary, "parent-not-visible", candidateRoot);
          continue;
        }

        const directChildren = Array.from(candidateRoot.children).filter((child) => (
          this.isVisible(child) && !this.isRapidViewOwnedElement(child)
        ));
        const directMessageChildren = directChildren.filter((child) => wrapperByElement.has(child));
        summary.candidateCount += 1;

        if (directMessageChildren.length < LIMITS.minStructuralTurns) {
          this.recordCandidateRejection(summary, "too-few-direct-turn-children", candidateRoot);
          continue;
        }

        const ratio = directChildren.length ? directMessageChildren.length / directChildren.length : 0;
        if (ratio < LIMITS.minStructuralDirectChildRatio) {
          this.recordCandidateRejection(summary, "direct-turn-ratio-too-low", candidateRoot);
          continue;
        }

        const resolvedTurnNodes = directMessageChildren
          .map((node) => wrapperByElement.get(node))
          .filter(Boolean)
          .map((item) => item.turnNode)
          .filter((node) => node instanceof HTMLElement);
        const distinctTurnIds = new Set(resolvedTurnNodes.map((node) => node.getAttribute("data-turn-id")).filter(Boolean));
        if (distinctTurnIds.size < LIMITS.minStructuralTurns) {
          this.recordCandidateRejection(summary, "insufficient-distinct-turns", candidateRoot);
          continue;
        }

        const roleSet = new Set(resolvedTurnNodes.map((node) => node.getAttribute("data-turn")));
        const assistantCount = resolvedTurnNodes.filter((node) => node.getAttribute("data-turn") === "assistant").length;

        if (assistantCount < 1) {
          this.recordCandidateRejection(summary, "no-assistant-turns", candidateRoot);
          continue;
        }

        const score = (directMessageChildren.length * 100)
          + (ratio * 100)
          + (roleSet.has("user") && roleSet.has("assistant") ? 25 : 0)
          + (candidateRoot.closest("#thread") ? 10 : 0)
          + (candidateRoot === thread ? 5 : 0);
        this.pushTopCandidate(summary, {
          root: this.describeElement(candidateRoot),
          score,
          directChildren: directChildren.length,
          directTurnChildren: directMessageChildren.length,
          groupedTurnNodes: resolvedTurnNodes.length,
          ratio: Number(ratio.toFixed(3)),
          assistantCount
        });

        if (!best || score > best.score) {
          best = {
            root: candidateRoot,
            messageNodes: directMessageChildren,
            score,
            mode: "structural"
          };
        }
      }

      if (best) {
        summary.selected = {
          root: this.describeElement(best.root),
          score: best.score,
          messageCount: best.messageNodes.length
        };
        this.logger.info("structural-root:selected", {
          ...summary.selected,
          threadFound: summary.threadFound,
          turnNodeCount: summary.turnNodeCount,
          groupedParentCount: summary.groupedParentCount,
          topCandidates: summary.topCandidates
        });
      }

      this.lastStructuralSummary = summary;
      return best;
    }

    buildStructuralWrapperItems(thread, turnNodes) {
      const items = [];
      const seenWrappers = new Set();

      for (const turnNode of turnNodes) {
        if (this.isRapidViewOwnedElement(turnNode)) {
          continue;
        }

        const wrapper = this.findNearestSingleTurnWrapper(turnNode, thread);
        if (
          !(wrapper instanceof HTMLElement)
          || seenWrappers.has(wrapper)
          || !this.isVisible(wrapper)
          || this.isRapidViewOwnedElement(wrapper)
        ) {
          continue;
        }

        seenWrappers.add(wrapper);
        items.push({
          wrapper,
          turnNode
        });
      }

      return items;
    }

    findNearestSingleTurnWrapper(turnNode, thread) {
      if (!(turnNode instanceof HTMLElement) || !(thread instanceof HTMLElement) || !thread.contains(turnNode)) {
        return null;
      }

      let best = turnNode;
      let current = turnNode;

      while (current.parentElement && thread.contains(current.parentElement)) {
        const parent = current.parentElement;
        const distinctTurnNodes = this.getDistinctTurnNodesWithin(parent);
        if (distinctTurnNodes.length !== 1 || distinctTurnNodes[0] !== turnNode) {
          break;
        }

        best = parent;
        current = parent;
      }

      return best;
    }

    getDistinctTurnNodesWithin(node) {
      if (!(node instanceof HTMLElement)) {
        return [];
      }

      const turnNodes = Array.from(node.querySelectorAll(this.turnSelector))
        .filter((candidate) => this.isTurnNode(candidate));
      const seenIds = new Set();
      const distinctTurnNodes = [];

      for (const turnNode of turnNodes) {
        const turnId = turnNode.getAttribute("data-turn-id") || "";
        if (!turnId || seenIds.has(turnId)) {
          continue;
        }

        seenIds.add(turnId);
        distinctTurnNodes.push(turnNode);
      }

      return distinctTurnNodes;
    }

    getDirectTurnChildren(root) {
      if (!(root instanceof HTMLElement) || this.isRapidViewOwnedElement(root)) {
        return [];
      }

      return Array.from(root.children).filter((child) => (
        this.isTurnNode(child) && !this.isRapidViewOwnedElement(child)
      ));
    }

    getDirectMessageChildren(root) {
      if (!(root instanceof HTMLElement) || this.isRapidViewOwnedElement(root)) {
        return [];
      }

      return Array.from(root.children).filter((child) => this.isDirectMessageItemChild(child));
    }

    isDirectMessageItemChild(node) {
      return this.isVisible(node)
        && !this.isRapidViewOwnedElement(node)
        && Boolean(this.resolveTurnNodeFromMessageNode(node));
    }

    resolveTurnNodeFromMessageNode(node) {
      if (!(node instanceof HTMLElement) || this.isRapidViewOwnedElement(node)) {
        return null;
      }

      if (this.isTurnNode(node)) {
        return node;
      }

      const turnNodes = Array.from(node.querySelectorAll(this.turnSelector))
        .filter((candidate) => this.isTurnNode(candidate) && !this.isRapidViewOwnedElement(candidate));

      if (turnNodes.length !== 1) {
        return null;
      }

      return turnNodes[0];
    }

    findFallbackMessageRoot(main) {
      const candidates = [main, ...Array.from(main.querySelectorAll("*"))]
        .filter((candidate) => !this.isRapidViewOwnedElement(candidate));
      const thread = main.querySelector("#thread");
      const threadTurnNodes = thread instanceof HTMLElement
        ? Array.from(thread.querySelectorAll(this.turnSelector)).filter((node) => this.isTurnNode(node))
        : [];
      const hasStructuralTurns = threadTurnNodes.length >= LIMITS.minStructuralTurns;
      const summary = {
        candidatePoolSize: candidates.length,
        candidateCount: 0,
        rejectionCounts: {},
        rejectionSamples: [],
        topCandidates: [],
        selected: null
      };
      let best = null;

      for (const candidate of candidates) {
        if (
          !this.isVisible(candidate)
          || this.isRapidViewOwnedElement(candidate)
          || candidate.childElementCount < LIMITS.minDetectableMessages
        ) {
          this.recordCandidateRejection(summary, "not-visible-or-too-few-children", candidate);
          continue;
        }

        const directChildren = Array.from(candidate.children).filter((child) => (
          this.isVisible(child) && !this.isRapidViewOwnedElement(child)
        ));
        summary.candidateCount += 1;

        if (directChildren.length < LIMITS.minDetectableMessages) {
          this.recordCandidateRejection(summary, "too-few-direct-children", candidate);
          continue;
        }

        if (hasStructuralTurns && candidate.closest(this.turnSelector)) {
          this.recordCandidateRejection(summary, "nested-inside-turn", candidate);
          continue;
        }

        const scoredChildren = directChildren
          .map((child, index) => ({
            child,
            index,
            score: this.scoreMessageNode(child),
            turnNode: this.resolveTurnNodeFromMessageNode(child)
          }))
          .filter((entry) => entry.score >= 5);

        if (scoredChildren.length < LIMITS.minDetectableMessages) {
          this.recordCandidateRejection(summary, "too-few-scored-children", candidate);
          continue;
        }

        if (hasStructuralTurns) {
          const resolvedScoredChildren = scoredChildren.filter((entry) => entry.turnNode instanceof HTMLElement);
          const distinctTurnIds = new Set(
            resolvedScoredChildren
              .map((entry) => entry.turnNode instanceof HTMLElement ? entry.turnNode.getAttribute("data-turn-id") : "")
              .filter(Boolean)
          );

          if (distinctTurnIds.size < LIMITS.minStructuralTurns) {
            this.recordCandidateRejection(summary, "insufficient-distinct-turns", candidate);
            continue;
          }

          if (resolvedScoredChildren.length < LIMITS.minDetectableMessages) {
            this.recordCandidateRejection(summary, "too-few-resolved-turn-children", candidate);
            continue;
          }
        }

        const firstIndex = scoredChildren[0].index;
        const lastIndex = scoredChildren[scoredChildren.length - 1].index;
        const span = Math.max(1, lastIndex - firstIndex + 1);
        const contiguity = scoredChildren.length / span;

        if (contiguity < 0.6) {
          this.recordCandidateRejection(summary, "contiguity-too-low", candidate);
          continue;
        }

        const averageScore = scoredChildren.reduce((total, entry) => total + entry.score, 0) / scoredChildren.length;
        const candidateScore = (scoredChildren.length * 50) + (contiguity * 100) + (averageScore * 10);
        this.pushTopCandidate(summary, {
          root: this.describeElement(candidate),
          score: Number(candidateScore.toFixed(1)),
          directChildren: directChildren.length,
          scoredChildren: scoredChildren.length,
          contiguity: Number(contiguity.toFixed(3)),
          averageScore: Number(averageScore.toFixed(2)),
          childSample: scoredChildren.slice(0, 4).map((entry) => this.describeElement(entry.child))
        });

        if (!best || candidateScore > best.score) {
          best = {
            root: candidate,
            messageNodes: hasStructuralTurns
              ? scoredChildren.filter((entry) => entry.turnNode instanceof HTMLElement).map((entry) => entry.child)
              : scoredChildren.map((entry) => entry.child),
            score: candidateScore,
            mode: "fallback"
          };
        }
      }

      if (best) {
        summary.selected = {
          root: this.describeElement(best.root),
          score: Number(best.score.toFixed(1)),
          messageCount: best.messageNodes.length
        };
        this.logger.info("fallback-root:selected", {
          ...summary.selected,
          candidatePoolSize: summary.candidatePoolSize,
          candidateCount: summary.candidateCount,
          topCandidates: summary.topCandidates,
          rejectionCounts: summary.rejectionCounts
        });
      }

      this.lastFallbackSummary = summary;
      return best;
    }

    findScrollContainer(root, main) {
      const structuralScrollRoot = root.closest("[data-scroll-root]");
      if (structuralScrollRoot && this.isVisible(structuralScrollRoot)) {
        return structuralScrollRoot;
      }

      const candidateScrollRoots = Array.from(main.querySelectorAll("[data-scroll-root]"))
        .filter((candidate) => this.isVisible(candidate) && candidate.contains(root));

      if (candidateScrollRoots.length) {
        return candidateScrollRoots[0];
      }

      let current = root;

      while (current && current !== document.documentElement) {
        if (this.isScrollable(current)) {
          return current;
        }

        current = current.parentElement;
      }

      return document.scrollingElement || document.documentElement;
    }

    isVisible(node) {
      if (!(node instanceof Element)) {
        return false;
      }

      const style = getComputedStyle(node);

      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }

      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    isTurnNode(node) {
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      if (this.isRapidViewOwnedElement(node)) {
        return false;
      }

      if (node.tagName !== "SECTION") {
        return false;
      }

      if (node.id === "thread-bottom-container" || node.hasAttribute("data-edge")) {
        return false;
      }

      if (node.getAttribute("aria-hidden") === "true") {
        return false;
      }

      const turnId = node.getAttribute("data-turn-id");
      const turnRole = node.getAttribute("data-turn");
      const testId = node.getAttribute("data-testid") || "";
      return Boolean(turnId) && (turnRole === "user" || turnRole === "assistant") && testId.startsWith("conversation-turn-");
    }

    isScrollable(node) {
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      const style = getComputedStyle(node);
      const overflowY = style.overflowY;
      const allowsScroll = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
      return allowsScroll && node.scrollHeight > node.clientHeight + 80 && node.clientHeight > 200;
    }

    scoreMessageNode(node) {
      if (!(node instanceof HTMLElement) || this.isRapidViewOwnedElement(node)) {
        return -10;
      }

      const tagName = node.tagName.toLowerCase();

      if (["nav", "aside", "header", "footer", "form"].includes(tagName)) {
        return -10;
      }

      const rect = node.getBoundingClientRect();
      const textLength = (node.textContent || "").trim().length;
      const buttonCount = node.querySelectorAll("button").length;
      const codeCount = node.querySelectorAll("pre, code").length;
      const richCount = node.querySelectorAll("img, picture, canvas, table, blockquote, ol, ul").length;
      const linkCount = node.querySelectorAll("a").length;
      const inputCount = node.querySelectorAll("textarea, input, [contenteditable='true']").length;
      const authorRole = node.querySelector("[data-message-author-role]");

      let score = 0;

      if (rect.height >= 40) {
        score += 2;
      }

      if (textLength >= 20) {
        score += 3;
      }

      if (textLength >= 200) {
        score += 1;
      }

      if (buttonCount >= 1) {
        score += 1;
      }

      if (codeCount >= 1) {
        score += 2;
      }

      if (richCount >= 1) {
        score += 1;
      }

      if (authorRole) {
        score += 5;
      }

      if (inputCount >= 1 && textLength < 20) {
        score -= 4;
      }

      if (linkCount >= 6 && textLength < 120) {
        score -= 3;
      }

      if (rect.height < 20) {
        score -= 2;
      }

      return score;
    }

    isRapidViewOwnedElement(node) {
      return Boolean(node instanceof Element && node.closest(RAPID_VIEW_OWNED_UI_SELECTOR));
    }
  }

  class VirtualizationEngine {
    constructor(logger) {
      this.logger = logger;
      this.settings = settingsApi.normalize(constants.DEFAULT_SETTINGS);
      this.root = null;
      this.scrollContainer = null;
      this.records = [];
      this.prefixHeights = [];
      this.resizeObserver = null;
      this.pendingRefresh = 0;
      this.domMutationDepth = 0;
      this.statusListener = null;
      this.virtualizationActive = false;
      this.hiddenCount = 0;
      this.restoreUi = null;
      this.handleLoadMoreClick = this.handleLoadMoreClick.bind(this);
      this.handleLoadAllClick = this.handleLoadAllClick.bind(this);
      this.onResizeObserved = this.onResizeObserved.bind(this);
    }

    setSettings(settings) {
      this.settings = settingsApi.normalize(settings);
      this.refreshWindow("settings-updated");
    }

    setStatusListener(listener) {
      this.statusListener = typeof listener === "function" ? listener : null;
    }

    getDurationMs(startTime) {
      return Number((performance.now() - startTime).toFixed(1));
    }

    bind({ root, scrollContainer, messageNodes }) {
      const rootChanged = this.root && this.root !== root;
      const containerChanged = this.scrollContainer && this.scrollContainer !== scrollContainer;

      if (rootChanged || containerChanged) {
        this.destroy();
      }

      this.root = root;
      this.scrollContainer = scrollContainer;
      this.rebuildRecords(messageNodes);
      this.attachListeners();
      this.refreshWindow("bind");
    }

    destroy() {
      const resizeObserver = this.resizeObserver;

      if (resizeObserver) {
        resizeObserver.disconnect();
      }

      if (this.pendingRefresh) {
        global.clearTimeout(this.pendingRefresh);
        this.pendingRefresh = 0;
      }

      this.mountAll();

      if (resizeObserver) {
        resizeObserver.disconnect();
      }

      this.removeRestoreUi();

      this.root = null;
      this.scrollContainer = null;
      this.records = [];
      this.prefixHeights = [];
      this.virtualizationActive = false;
      this.hiddenCount = 0;
      this.restoreUi = null;
      this.emitStatus();
    }

    refreshStructure(messageNodes) {
      this.mountAll();
      this.rebuildRecords(messageNodes);
      this.refreshWindow("structure-change");
    }

    scheduleRefresh(reason) {
      if (this.pendingRefresh) {
        global.clearTimeout(this.pendingRefresh);
      }

      this.pendingRefresh = global.setTimeout(() => {
        this.pendingRefresh = 0;
        this.refreshWindow(reason);
      }, LIMITS.rootMutationDebounceMs);
    }

    attachListeners() {
      if (!this.resizeObserver) {
        this.resizeObserver = new ResizeObserver(this.onResizeObserved);
      }

      this.resizeObserver.disconnect();
      for (const record of this.records) {
        if (record.node.parentElement === this.root) {
          this.resizeObserver.observe(record.node);
        }
      }
    }

    onResizeObserved() {
      this.scheduleRefresh("resize");
    }

    rebuildRecords(messageNodes) {
      const nextRecords = [];
      const previousById = new Map(this.records.map((record) => [record.id, record]));

      messageNodes.forEach((node, index) => {
        const id = this.getNodeId(node);
        const previous = previousById.get(id);
        nextRecords.push({
          id,
          role: node.getAttribute("data-turn") || (previous ? previous.role : "unknown"),
          node,
          index,
          height: previous ? previous.height : this.measureNode(node),
          mounted: node.parentElement === this.root
        });
      });

      this.records = nextRecords;
      this.recomputeHeights();
    }

    getNodeId(node) {
      const turnId = node.getAttribute("data-turn-id");
      if (turnId) {
        return turnId;
      }

      const existing = node.getAttribute("data-rapid-view-for-chatgpt-id");

      if (existing) {
        return existing;
      }

      const id = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      node.setAttribute("data-rapid-view-for-chatgpt-id", id);
      return id;
    }

    ensureSpacers() {
      if (!this.root) {
        return;
      }

      this.withDomMutationGuard(() => {
        if (!this.topSpacer) {
          this.topSpacer = document.createElement("div");
          this.topSpacer.setAttribute("data-rapid-view-for-chatgpt-spacer", "top");
          this.topSpacer.style.height = "0px";
        }

        if (!this.bottomSpacer) {
          this.bottomSpacer = document.createElement("div");
          this.bottomSpacer.setAttribute("data-rapid-view-for-chatgpt-spacer", "bottom");
          this.bottomSpacer.style.height = "0px";
        }

        if (!this.topSpacer.parentElement) {
          this.root.insertBefore(this.topSpacer, this.root.firstChild);
        }

        if (!this.bottomSpacer.parentElement) {
          this.root.appendChild(this.bottomSpacer);
        }
      });
    }

    mountAll() {
      if (!this.root || !this.records.length) {
        return;
      }

      const trailingAnchor = this.getTrailingAnchorNode();
      this.withDomMutationGuard(() => {
        this.removeRestoreUi();
        let reference = trailingAnchor;
        for (let index = this.records.length - 1; index >= 0; index -= 1) {
          const record = this.records[index];
          this.root.insertBefore(record.node, reference);
          record.mounted = true;
          reference = record.node;
        }
      });

      this.hiddenCount = 0;
      this.observeMountedNodes();
      this.emitStatus();
    }

    refreshWindow(reason) {
      if (!this.root || !this.scrollContainer) {
          return;
      }

      if (!this.settings.enabled) {
        this.mountAll();
        return;
      }

      if (this.shouldPauseForSelection() || this.isLikelyStreaming()) {
        this.logger.info("Skipping virtualization update due to active selection.");
        return;
      }

      this.measureMountedNodes();
      this.recomputeHeights();
      this.virtualizationActive = this.computeVirtualizationState();

      if (!this.virtualizationActive) {
        this.mountAll();
        return;
      }

      this.trimToWindow(reason);
      this.emitStatus();
    }

    trimToWindow(reason) {
      const keepCount = Math.min(this.records.length, this.settings.windowSize);
      const nextHiddenCount = Math.max(0, this.records.length - keepCount);

      if (nextHiddenCount <= 0) {
        this.mountAll();
        return;
      }

      if (nextHiddenCount === this.hiddenCount && this.isTrimApplied()) {
        this.updateRestoreUi();
        return;
      }

      const trailingAnchor = this.getTrailingAnchorNode();
      this.withDomMutationGuard(() => {
        for (let index = 0; index < nextHiddenCount; index += 1) {
          const record = this.records[index];
          if (record.node.parentElement === this.root) {
            record.node.remove();
          }
          record.mounted = false;
        }

        let reference = trailingAnchor;
        for (let index = this.records.length - 1; index >= nextHiddenCount; index -= 1) {
          const record = this.records[index];
          this.root.insertBefore(record.node, reference);
          record.mounted = true;
          reference = record.node;
        }

        this.hiddenCount = nextHiddenCount;
        this.ensureRestoreUi();
        this.updateRestoreUi();
      });

      this.observeMountedNodes();
    }

    ensureRestoreUi() {
      if (!this.root) {
        return;
      }

      if (!this.restoreUi) {
        const container = document.createElement("div");
        const actions = document.createElement("div");
        const counter = document.createElement("div");
        const loadMoreButton = document.createElement("button");

        container.setAttribute("data-rapid-view-for-chatgpt-restore", "true");
        Object.assign(container.style, {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          padding: "12px 16px",
          margin: "8px auto 20px",
          border: "1px solid rgba(92, 110, 143, 0.24)",
          borderRadius: "16px",
          background: "linear-gradient(180deg, rgba(229, 235, 247, 0.98), rgba(214, 223, 239, 0.96))",
          color: "#24364d",
          boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.54), inset 0 -1px 0 rgba(109, 128, 160, 0.08), 0 10px 24px rgba(34, 53, 84, 0.08)",
          maxWidth: "760px",
          width: "min(100%, 760px)"
        });

        Object.assign(counter.style, {
          font: "13px/1.35 'Segoe UI', sans-serif",
          color: "#4d6386"
        });

        Object.assign(actions.style, {
          display: "flex",
          gap: "8px",
          flexWrap: "wrap"
        });

        for (const button of [loadMoreButton]) {
          button.type = "button";
          Object.assign(button.style, {
            border: "1px solid rgba(58, 97, 170, 0.24)",
            borderRadius: "999px",
            padding: "8px 12px",
            cursor: "pointer",
            font: "600 12px/1 'Segoe UI', sans-serif",
            boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.16), 0 8px 18px rgba(38, 82, 162, 0.18)"
          });
        }

        loadMoreButton.textContent = "Load older messages";
        loadMoreButton.addEventListener("click", this.handleLoadMoreClick);
        loadMoreButton.style.background = "linear-gradient(180deg, rgba(79, 134, 241, 0.98), rgba(39, 92, 202, 0.96))";
        loadMoreButton.style.color = "#f7fbff";

        actions.appendChild(loadMoreButton);
        container.appendChild(counter);
        container.appendChild(actions);

        this.restoreUi = {
          container,
          counter,
          loadMoreButton
        };
      }

      const firstMountedRecord = this.records[this.hiddenCount];
      if (!firstMountedRecord) {
        return;
      }

      if (this.restoreUi.container.parentElement !== this.root || this.restoreUi.container.nextSibling !== firstMountedRecord.node) {
        this.root.insertBefore(this.restoreUi.container, firstMountedRecord.node);
      }
    }

    updateRestoreUi() {
      if (!this.restoreUi) {
        return;
      }

      if (this.hiddenCount <= 0) {
        this.removeRestoreUi();
        return;
      }

      const restoreBatchSize = Math.min(this.hiddenCount, this.settings.restoreBatchSize);
      this.restoreUi.counter.textContent = `${this.hiddenCount} older messages hidden`;
      this.restoreUi.loadMoreButton.textContent = `Load ${restoreBatchSize} older`;
    }

    removeRestoreUi() {
      if (!this.restoreUi) {
        return;
      }

      if (this.restoreUi.container.parentElement) {
        this.restoreUi.container.remove();
      }
    }

    handleLoadMoreClick() {
      this.restoreOlderBatch(this.settings.restoreBatchSize);
    }

    handleLoadAllClick() {
      this.restoreOlderBatch(this.hiddenCount);
    }

    restoreOlderBatch(batchSize) {
      if (!this.root || this.hiddenCount <= 0) {
        return;
      }

      const firstMountedRecord = this.records[this.hiddenCount];
      if (!firstMountedRecord) {
        return;
      }

      const restoreCount = Math.min(this.hiddenCount, Math.max(1, batchSize));
      const nextHiddenCount = this.hiddenCount - restoreCount;
      const anchorNode = firstMountedRecord.node;
      const beforeTop = anchorNode.getBoundingClientRect().top;

      this.withDomMutationGuard(() => {
        let reference = anchorNode;
        for (let index = this.hiddenCount - 1; index >= nextHiddenCount; index -= 1) {
          const record = this.records[index];
          this.root.insertBefore(record.node, reference);
          record.mounted = true;
          reference = record.node;
        }

        this.hiddenCount = nextHiddenCount;

        if (this.hiddenCount > 0) {
          this.root.insertBefore(this.restoreUi.container, this.records[this.hiddenCount].node);
          this.updateRestoreUi();
        } else {
          this.removeRestoreUi();
        }
      });

      const afterTop = anchorNode.getBoundingClientRect().top;
      this.scrollContainer.scrollTop += afterTop - beforeTop;
      this.observeMountedNodes();
      this.emitStatus();
    }

    prepareForDetection() {
      if (!this.root || !document.contains(this.root)) {
        return;
      }

      this.virtualizationActive = false;
      this.mountAll();
    }

    getTrailingAnchorNode() {
      if (!this.root) {
        return null;
      }

      for (const child of Array.from(this.root.children)) {
        const isManagedTurn = this.records.some((record) => record.node === child);
        const isRestoreUi = this.restoreUi && child === this.restoreUi.container;
        if (!isManagedTurn && !isRestoreUi) {
          return child;
        }
      }

      return null;
    }

    isTrimApplied() {
      if (!this.root || this.hiddenCount <= 0 || !this.restoreUi || !this.records[this.hiddenCount]) {
        return false;
      }

      const firstMountedRecord = this.records[this.hiddenCount];
      return this.restoreUi.container.parentElement === this.root
        && firstMountedRecord.node.parentElement === this.root
        && this.restoreUi.container.nextSibling === firstMountedRecord.node;
    }

    computeDesiredRange() {
      if (!this.records.length) {
        return null;
      }

      const visibleRange = this.computeVisibleRange();
      if (!visibleRange) {
        return null;
      }

      let start = visibleRange.start;
      let end = visibleRange.end;
      const buffer = this.settings.restoreBatchSize;

      start = Math.max(0, start - buffer);
      end = Math.min(this.records.length - 1, end + buffer);

      const protectedRange = this.findProtectedRange();
      if (protectedRange) {
        start = Math.min(start, protectedRange.start);
        end = Math.max(end, protectedRange.end);
      }

      const desiredLength = Math.max(this.settings.windowSize, end - start + 1);

      if (end - start + 1 < desiredLength) {
        ({ start, end } = this.expandRangeToLength(start, end, desiredLength));
      }

      return { start, end };
    }

    computeVisibleRange() {
      if (!this.records.length) {
        return null;
      }

      const rootOffset = this.getRootOffsetWithinContainer();
      const viewportStart = Math.max(0, this.scrollContainer.scrollTop - rootOffset);
      const viewportEnd = viewportStart + this.scrollContainer.clientHeight;

      return {
        start: this.findIndexForOffset(viewportStart),
        end: this.findIndexForOffset(viewportEnd)
      };
    }

    findProtectedRange() {
      const protectedIndices = [];
      const activeElement = document.activeElement;

      if (activeElement && this.root.contains(activeElement)) {
        const activeIndex = this.findRecordIndexByNode(activeElement);
        if (activeIndex >= 0) {
          protectedIndices.push(activeIndex);
        }
      }

      const scrollAnchorIndex = this.records.findIndex((record) => record.node.getAttribute("data-scroll-anchor") === "true");
      if (scrollAnchorIndex >= 0) {
        protectedIndices.push(scrollAnchorIndex);
      }

      const tailProtection = this.isLikelyStreaming()
        ? LIMITS.streamingTailProtection
        : LIMITS.defaultTailProtection;

      for (let index = Math.max(0, this.records.length - tailProtection); index < this.records.length; index += 1) {
        protectedIndices.push(index);
      }

      if (!protectedIndices.length) {
        return null;
      }

      return {
        start: Math.min(...protectedIndices),
        end: Math.max(...protectedIndices)
      };
    }

    applyRange(start, end) {
      this.withDomMutationGuard(() => {
        for (let index = 0; index < this.records.length; index += 1) {
          const record = this.records[index];
          if (index < start || index > end) {
            if (record.node.parentElement === this.root) {
              record.node.remove();
              record.mounted = false;
            }
          }
        }

        let reference = this.bottomSpacer;
        for (let index = end; index >= start; index -= 1) {
          const record = this.records[index];
          if (record.node.parentElement !== this.root || record.node.nextSibling !== reference) {
            this.root.insertBefore(record.node, reference);
          }
          record.mounted = true;
          reference = record.node;
        }
      });

      this.updateSpacers(start, end);
      this.observeMountedRange(start, end);
    }

    updateSpacers(start, end) {
      const topHeight = start > 0 ? this.prefixHeights[start] : 0;
      const bottomHeight = end < this.records.length - 1
        ? this.prefixHeights[this.records.length] - this.prefixHeights[end + 1]
        : 0;

      if (this.topSpacer) {
        this.topSpacer.style.height = `${Math.max(0, Math.round(topHeight))}px`;
      }

      if (this.bottomSpacer) {
        this.bottomSpacer.style.height = `${Math.max(0, Math.round(bottomHeight))}px`;
      }
    }

    recomputeHeights() {
      this.prefixHeights = [0];

      for (const record of this.records) {
        this.prefixHeights.push(this.prefixHeights[this.prefixHeights.length - 1] + Math.max(1, record.height));
      }
    }

    measureMountedNodes() {
      for (const record of this.records) {
        if (record.node.parentElement === this.root) {
          record.height = this.measureNode(record.node);
        }
      }
    }

    measureNode(node) {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const marginTop = parseFloat(style.marginTop) || 0;
      const marginBottom = parseFloat(style.marginBottom) || 0;
      return Math.max(1, rect.height + marginTop + marginBottom);
    }

    findIndexForOffset(offset) {
      let low = 0;
      let high = this.records.length - 1;

      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (this.prefixHeights[middle + 1] <= offset) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }

      return low;
    }

    getRootOffsetWithinContainer() {
      if (!this.root || !this.scrollContainer) {
        return 0;
      }

      const rootRect = this.root.getBoundingClientRect();
      const containerRect = this.scrollContainer.getBoundingClientRect();
      return rootRect.top - containerRect.top + this.scrollContainer.scrollTop;
    }

    shouldPauseForSelection() {
      const selection = document.getSelection();

      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        return false;
      }

      const anchorNode = selection.anchorNode;
      const focusNode = selection.focusNode;
      return Boolean(anchorNode && focusNode && this.root && this.root.contains(anchorNode) && this.root.contains(focusNode));
    }

    isLikelyStreaming() {
      const buttons = Array.from(document.querySelectorAll("button"));

      return buttons.some((button) => {
        const label = `${button.textContent || ""} ${button.getAttribute("aria-label") || ""}`.toLowerCase();
        return label.includes("stop generating") || label.trim() === "stop";
      });
    }

    findRecordIndexByNode(node) {
      for (let index = 0; index < this.records.length; index += 1) {
        const record = this.records[index];
        if (record.node === node || record.node.contains(node)) {
          return index;
        }
      }

      return -1;
    }

    getStatus() {
      const mountedMessages = this.records.filter((record) => record.node.parentElement === this.root).length;

      return {
        totalMessages: this.records.length,
        mountedMessages,
        hiddenMessages: this.hiddenCount,
        estimatedTotalHeightPx: this.getEstimatedTotalHeight(),
        virtualizationActive: this.virtualizationActive
      };
    }

    shouldVirtualize() {
      return this.virtualizationActive;
    }

    computeVirtualizationState() {
      const totalMessages = this.records.length;
      const estimatedTotalHeightPx = this.getEstimatedTotalHeight();
      const thresholds = this.getActivationThresholds();

      if (this.virtualizationActive) {
        const belowTurnThreshold = totalMessages <= thresholds.deactivateTurns;
        const belowHeightThreshold = estimatedTotalHeightPx < LIMITS.deactivateEstimatedHeightPx;
        return !(belowTurnThreshold && belowHeightThreshold);
      }

      return totalMessages >= thresholds.activateTurns || estimatedTotalHeightPx >= LIMITS.activateMinEstimatedHeightPx;
    }

    getActivationThresholds() {
      return {
        activateTurns: LIMITS.activateMinTurns,
        deactivateTurns: LIMITS.deactivateMinTurns
      };
    }

    getEstimatedTotalHeight() {
      return this.prefixHeights.length ? this.prefixHeights[this.prefixHeights.length - 1] : 0;
    }

    shouldSkipScrollRewindow(nextVisibleRange) {
      if (this.range.end < this.range.start) {
        return false;
      }

      const currentRangeLength = this.range.end - this.range.start + 1;
      if (currentRangeLength >= this.records.length) {
        return false;
      }

      const safeZoneOffset = Math.max(1, Math.ceil(this.settings.restoreBatchSize / 2));
      const innerStart = this.range.start + safeZoneOffset;
      const innerEnd = this.range.end - safeZoneOffset;

      return nextVisibleRange.start >= innerStart && nextVisibleRange.end <= innerEnd;
    }

    expandRangeToLength(start, end, desiredLength) {
      let nextStart = start;
      let nextEnd = end;
      let remaining = desiredLength - (nextEnd - nextStart + 1);
      const maxIndex = this.records.length - 1;

      while (remaining > 0 && (nextStart > 0 || nextEnd < maxIndex)) {
        const canGrowAbove = nextStart > 0;
        const canGrowBelow = nextEnd < maxIndex;

        if (canGrowAbove) {
          nextStart -= 1;
          remaining -= 1;
        }

        if (remaining <= 0) {
          break;
        }

        if (canGrowBelow) {
          nextEnd += 1;
          remaining -= 1;
        }
      }

      return { start: nextStart, end: nextEnd };
    }

    observeMountedNodes() {
      if (!this.resizeObserver) {
        return;
      }

      this.resizeObserver.disconnect();
      for (const record of this.records) {
        if (record.node.parentElement === this.root) {
          this.resizeObserver.observe(record.node);
        }
      }
    }

    observeMountedRange(start, end) {
      if (!this.resizeObserver) {
        return;
      }

      this.resizeObserver.disconnect();
      for (let index = start; index <= end; index += 1) {
        if (this.records[index] && this.records[index].node.parentElement === this.root) {
          this.resizeObserver.observe(this.records[index].node);
        }
      }
    }

    withDomMutationGuard(callback) {
      this.domMutationDepth += 1;
      try {
        callback();
      } finally {
        this.domMutationDepth -= 1;
      }
    }

    isApplyingDomChanges() {
      return this.domMutationDepth > 0;
    }

    emitStatus() {
      if (this.statusListener) {
        this.statusListener(this.getStatus());
      }
    }
  }

  class ArchiveEngine {
    constructor(logger) {
      this.logger = logger;
      this.settings = settingsApi.normalize(constants.DEFAULT_SETTINGS);
      this.root = null;
      this.scrollContainer = null;
      this.records = [];
      this.manualArchiveEntries = new Map();
      this.manualUserRestoredArchiveIds = new Set();
      this.archiveUi = null;
      this.domMutationDepth = 0;
      this.ignoreOwnRootMutationsUntil = 0;
      this.statusListener = null;
      this.archiveActive = false;
      this.hiddenCount = 0;
      this.detectedTurnCount = 0;
      this.lastActivationTrigger = "";
      this.deferredSnapshotTimer = 0;
      this.deferredPlainTextTimer = 0;
      this.pendingRichSnapshotIds = [];
      this.pendingPlainTextIds = [];
      this.pendingRestoreAction = false;
      this.dynamicScrollTimer = 0;
      this.dynamicScrollTargetId = "";
      this.dynamicScrollFocusId = "";
      this.dynamicScrollActiveId = "";
      this.dynamicCurrentSliceIndex = -1;
      this.dynamicSliceCount = 0;
      this.dynamicVisibleCount = 0;
      this.dynamicMeasurementHost = null;
      this.dynamicChromeHeightCache = new Map();
      this.boundScrollContainer = null;
      this.boundWindowScroll = false;
      this.boundDynamicWheel = false;
      this.boundDynamicWheelTarget = null;
      this.boundDynamicKeydown = false;
      this.dynamicInputLockedUntil = 0;
      this.lastScrollTop = 0;
      this.lastActivationEvaluationSignature = "";
      this.handleLoadMoreClick = this.handleLoadMoreClick.bind(this);
      this.handleLoadAllClick = this.handleLoadAllClick.bind(this);
      this.handleDynamicScroll = this.handleDynamicScroll.bind(this);
      this.handleDynamicWheel = this.handleDynamicWheel.bind(this);
      this.handleDynamicKeydown = this.handleDynamicKeydown.bind(this);
    }

    setSettings(settings) {
      const hadDynamicScroll = Boolean(this.settings.dynamicScroll);
      const hadEnabled = Boolean(this.settings.enabled);
      const previousScrollTop = this.scrollContainer ? this.scrollContainer.scrollTop : 0;
      const previousTrackOffset = this.getCurrentTrackOffset();
      this.settings = settingsApi.normalize(settings);
      if (!hadDynamicScroll && this.settings.dynamicScroll) {
        this.dynamicCurrentSliceIndex = -1;
        this.dynamicSliceCount = 0;
        for (const record of this.records) {
          this.restorePendingManualRecord(record);
        }
      }
      if (hadDynamicScroll && !this.settings.dynamicScroll) {
        this.resetDynamicScrollTracking(true);
        this.prepareDefaultLoadMoreState();
      }
      this.updateDynamicScrollBinding();
      this.refreshWindow("settings-updated");
      this.updateDynamicScrollBinding();
      if (
        this.scrollContainer
        && hadEnabled
        && this.settings.enabled
      ) {
        let nextScrollTop = previousScrollTop;
        if (this.archiveActive && this.root) {
          const trackStart = this.getArchiveTrackStartOffset();
          nextScrollTop = Math.max(0, trackStart + previousTrackOffset);
        }
        const maxScrollTop = Math.max(0, this.scrollContainer.scrollHeight - this.scrollContainer.clientHeight);
        this.scrollContainer.scrollTop = Math.max(0, Math.min(nextScrollTop, maxScrollTop));
        this.lastScrollTop = this.scrollContainer.scrollTop;
      }
    }

    setStatusListener(listener) {
      this.statusListener = typeof listener === "function" ? listener : null;
    }

    getDurationMs(startTime) {
      return Number((performance.now() - startTime).toFixed(1));
    }

    bind({ root, scrollContainer, messageNodes, preserveManualArchive = true }) {
      const sameBinding = this.root === root && this.scrollContainer === scrollContainer;
      const preserveSameBindingState = sameBinding && preserveManualArchive;
      const preserveManualArchiveAcrossRebind = Boolean(
        preserveManualArchive
        && !sameBinding
        && this.root
        && this.hasManualArchiveStateToPreserve()
      );
      const preserveExistingState = preserveSameBindingState || preserveManualArchiveAcrossRebind;

      if (!preserveExistingState && this.root) {
        this.destroy();
      }

      this.root = root;
      this.scrollContainer = scrollContainer;
      this.rebuildRecords(messageNodes, preserveExistingState);
      this.syncManualArchiveEntries();
      this.updateDynamicScrollBinding();
      this.lastScrollTop = this.scrollContainer ? this.scrollContainer.scrollTop : 0;
      this.refreshWindow("bind");
      this.updateDynamicScrollBinding();
    }

    destroy(options = {}) {
      const restoreHistory = Boolean(options.restoreHistory);
      this.clearDeferredSnapshotTimer();
      this.clearDeferredPlainTextTimer();
      this.resetDynamicScrollTracking(false);

      if (restoreHistory && this.root && document.contains(this.root)) {
        this.showEntireHistory();
      } else {
        this.removeArchiveUi();
      }

      this.root = null;
      this.scrollContainer = null;
      this.records = [];
      this.manualArchiveEntries = new Map();
      this.manualUserRestoredArchiveIds = new Set();
      this.archiveActive = false;
      this.hiddenCount = 0;
      this.detectedTurnCount = 0;
      this.lastActivationTrigger = "";
      this.archiveUi = null;
      this.domMutationDepth = 0;
      this.ignoreOwnRootMutationsUntil = 0;
      this.pendingRichSnapshotIds = [];
      this.pendingPlainTextIds = [];
      this.dynamicScrollFocusId = "";
      this.dynamicCurrentSliceIndex = -1;
      this.dynamicSliceCount = 0;
      this.dynamicVisibleCount = 0;
      this.destroyDynamicMeasurementHost();
      this.updateDynamicScrollBinding();
      this.emitStatus();
    }

    prepareForDetection() {
      if (this.hasManualArchiveStateToPreserve()) {
        if (!this.deferredPlainTextTimer && this.pendingPlainTextIds.length) {
          this.scheduleDeferredPlainTextWork(LIMITS.archiveIndexRetryDelayMs);
        }
      } else {
        this.clearDeferredSnapshotTimer();
        this.clearDeferredPlainTextTimer();
      }

      if (this.archiveUi && this.archiveUi.host && !this.archiveUi.host.isConnected) {
        this.archiveUi = null;
      }
    }

    shouldPreserveManualArchiveOnInactive() {
      return this.hasManualArchiveStateToPreserve();
    }

    hasManualArchiveStateToPreserve(records = this.records) {
      if (this.settings.dynamicScroll || !this.settings.enabled) {
        return false;
      }

      if (
        this.manualArchiveEntries.size > 0
        || this.pendingPlainTextIds.length > 0
        || this.pendingRichSnapshotIds.length > 0
      ) {
        return true;
      }

      return records.some((record) => (
        record
        && (
          record.state === "hidden"
          || record.state === "visibleArchive"
          || record.archivePending
          || record.plainTextPending
          || record.manualPayloadState === "pending"
          || this.isPendingManualArchiveRecord(record)
        )
      ));
    }

    hasManualArchiveWindowState(records = this.records) {
      return this.hasManualArchiveStateToPreserve(records);
    }

    preserveManualArchiveDuringDetectionFailure() {
      if (!this.hasManualArchiveStateToPreserve()) {
        return false;
      }

      if (!this.settings.dynamicScroll && this.pendingPlainTextIds.length && !this.deferredPlainTextTimer) {
        this.scheduleDeferredPlainTextWork(LIMITS.archiveIndexRetryDelayMs);
      }

      if (this.root && document.contains(this.root) && this.scrollContainer) {
        this.archiveActive = true;
        this.hiddenCount = this.countHiddenRecords();
        this.syncArchiveUi();
        this.updateDynamicScrollBinding();
        this.emitStatus();
      }

      return true;
    }

    refreshWindow(reason) {
      if (!this.root || !this.scrollContainer) {
        return;
      }

      if (this.settings.dynamicScroll) {
        this.measureCurrentTrackGeometry();
      } else {
        this.measureLiveRecords();
      }
      const shouldArchive = this.settings.enabled && this.computeArchiveModeState();

      if (!shouldArchive) {
        if (this.shouldPreserveManualArchiveOnInactive()) {
          this.archiveActive = true;
          this.lastActivationTrigger = this.lastActivationTrigger || this.getActivationTrigger();
          this.syncManualArchiveEntries();
          this.hiddenCount = this.countHiddenRecords();
          this.syncArchiveUi();
          this.updateDynamicScrollBinding();
          this.emitStatus();
          return;
        }

        this.archiveActive = false;
        this.lastActivationTrigger = "";
        this.clearDeferredSnapshotTimer();
        this.clearDeferredPlainTextTimer();
        this.pendingRichSnapshotIds = [];
        this.pendingPlainTextIds = [];
        this.showEntireHistory();
        this.updateDynamicScrollBinding();
        this.emitStatus();
        return;
      }

      this.archiveActive = true;
      this.lastActivationTrigger = this.getActivationTrigger();
      this.archiveOlderTurns(reason);
      this.updateDynamicScrollBinding();
      this.emitStatus();
    }

    rebuildRecords(messageNodes, preserveExistingState) {
      const previousRecords = this.records.slice();
      const previousById = new Map(previousRecords.map((record) => [record.id, record]));
      const turnGroups = this.groupMessageNodesIntoTurns(messageNodes);
      const detectedIds = turnGroups.map((group) => group.id);
      const preservedPrefix = preserveExistingState
        ? this.findPreservedPrefix(previousRecords, detectedIds)
        : [];
      const nextRecords = preservedPrefix.slice();
      let reusedRecordCount = 0;

      turnGroups.forEach((group, index) => {
        const id = detectedIds[index];
        const previous = previousById.get(id);
        const nextNodes = group.nodes.slice();
        const primaryNode = nextNodes[0] || null;

        if (previous) {
          previous.id = id;
          previous.role = group.role || previous.role || "assistant";
          previous.nodes = nextNodes;
          previous.node = primaryNode;
          previous.detachedSourceNodes = [];
          previous.detachedSourceNode = null;
          previous.estimatedHeight = previous.estimatedHeight || 0;
          previous.snapshotHtml = previous.snapshotHtml || "";
          previous.richHtml = previous.richHtml || "";
          previous.plainTextFallback = previous.plainTextFallback || "";
          previous.renderProfile = previous.renderProfile && typeof previous.renderProfile === "object"
            ? previous.renderProfile
            : null;
          previous.hadRichMedia = Boolean(previous.hadRichMedia);
          previous.richRequestPending = Boolean(previous.richRequestPending);
          previous.plainTextPending = Boolean(previous.plainTextPending);
          previous.simpleExpanded = Boolean(previous.simpleExpanded);
          previous.simplePreviewMeasureQueued = Boolean(previous.simplePreviewMeasureQueued);
          previous.dynamicAutoExpanded = Boolean(previous.dynamicAutoExpanded);
          previous.archiveBlock = previous.archiveBlock || null;
          previous.refreshArchiveBlock = previous.refreshArchiveBlock || null;
          previous.dynamicBaseHeight = previous.dynamicBaseHeight || 0;
          previous.trackHeightPx = previous.trackHeightPx || 0;
          previous.trackTopPx = previous.trackTopPx || 0;
          previous.dynamicTrackHeightPx = previous.dynamicTrackHeightPx || 0;
          previous.dynamicTrackTopPx = previous.dynamicTrackTopPx || 0;
          previous.dynamicChromeHeightPx = previous.dynamicChromeHeightPx || 0;
          previous.dynamicUnits = Array.isArray(previous.dynamicUnits) ? previous.dynamicUnits : [];
          previous.dynamicRenderedHeight = previous.dynamicRenderedHeight || 0;
          previous.archivePending = Boolean(previous.archivePending);
          previous.manualPendingOriginalStyles = Array.isArray(previous.manualPendingOriginalStyles)
            ? previous.manualPendingOriginalStyles
            : [];
          previous.snapshotState = previous.snapshotState
            || ((previous.snapshotHtml || previous.richHtml || previous.plainTextFallback) ? "ready" : "empty");
          previous.indexState = previous.indexState
            || ((previous.snapshotHtml || previous.richHtml || previous.plainTextFallback) ? "ready" : "empty");
          previous.manualPayloadState = previous.manualPayloadState
            || ((previous.snapshotHtml || previous.richHtml || previous.plainTextFallback) ? "ready" : "empty");
          previous.state = "live";
          previous.keepVisible = false;
          previous.viewMode = previous.viewMode || "simple";
          nextRecords.push(previous);
          reusedRecordCount += 1;
          return;
        }

        nextRecords.push({
          id,
          role: group.role || "assistant",
          nodes: nextNodes,
          node: primaryNode,
          detachedSourceNodes: [],
          detachedSourceNode: null,
          estimatedHeight: 0,
          snapshotHtml: "",
          richHtml: "",
          plainTextFallback: "",
          renderProfile: null,
          hadRichMedia: false,
          richRequestPending: false,
          plainTextPending: false,
          simpleExpanded: false,
          simplePreviewMeasureQueued: false,
          dynamicAutoExpanded: false,
          archiveBlock: null,
          refreshArchiveBlock: null,
          dynamicBaseHeight: 0,
          trackHeightPx: 0,
          trackTopPx: 0,
          dynamicTrackHeightPx: 0,
          dynamicTrackTopPx: 0,
          dynamicChromeHeightPx: 0,
          dynamicUnits: [],
          dynamicRenderedHeight: 0,
          archivePending: false,
          manualPendingOriginalStyles: [],
          snapshotState: "empty",
          indexState: "empty",
          manualPayloadState: "empty",
          state: "live",
          keepVisible: false,
          viewMode: "simple"
        });
      });

      this.records = nextRecords;
      this.detectedTurnCount = turnGroups.length;
      this.seedEstimatedHeights();
      this.syncManualArchiveEntries();
      this.hiddenCount = this.countHiddenRecords();
      this.logger.info("rebuild-records", {
        preserveExistingState,
        preservedPrefix: preservedPrefix.length,
        reusedRecordCount,
        totalRecords: this.records.length
      });
    }

    syncManualArchiveEntries() {
      const validIds = new Set(this.records.map((record) => record.id));

      for (const entryId of Array.from(this.manualArchiveEntries.keys())) {
        const entry = this.manualArchiveEntries.get(entryId);
        if (!validIds.has(entryId) && !this.hasStrictReadyManualArchiveEntry(entry)) {
          this.manualArchiveEntries.delete(entryId);
        }
      }

      for (const record of this.records) {
        const existing = this.getManualArchiveEntry(record);
        const entry = this.ensureManualArchiveEntryForRecord(record);
        if (entry) {
          entry.role = record.role;
          entry.sourceRecordId = record.id;
          if (entry.visible && !this.isManualUserRestoredArchiveEntry(entry)) {
            entry.visible = false;
          }
          if (record.state === "visibleArchive" && !this.isVisibleManualArchiveEntry(entry)) {
            record.state = "hidden";
            record.keepVisible = false;
          }
        } else if (record.state === "visibleArchive") {
          if (existing) {
            existing.visible = false;
          }
          record.state = "hidden";
          record.keepVisible = false;
        }
      }
    }

    getManualLiveTurnCount() {
      return Math.max(1, LIMITS.manualLiveTurnCount || 2);
    }

    getManualArchiveEntry(recordOrId) {
      const entryId = typeof recordOrId === "string"
        ? recordOrId
        : recordOrId && recordOrId.id;
      return entryId ? (this.manualArchiveEntries.get(entryId) || null) : null;
    }

    isManualArchiveEntry(record) {
      return Boolean(record && this.manualArchiveEntries.get(record.id) === record);
    }

    hasReadyManualArchiveEntry(recordOrId) {
      const entry = this.getManualArchiveEntry(recordOrId);
      return this.hasStrictReadyManualArchiveEntry(entry);
    }

    normalizeArchiveText(text) {
      return String(text || "")
        .replace(/\r/g, "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    isArchiveFallbackText(text) {
      const normalized = this.normalizeArchiveText(text).toLowerCase();
      return normalized === "archived content unavailable."
        || normalized === "preparing archived message..."
        || normalized === "preparing rendered archived message...";
    }

    hasUsableArchiveText(text) {
      const normalized = this.normalizeArchiveText(text);
      return Boolean(normalized && !this.isArchiveFallbackText(normalized));
    }

    isArchiveFallbackHtml(html) {
      if (!html || !html.trim()) {
        return false;
      }

      const container = document.createElement("div");
      container.innerHTML = html.trim();
      const text = this.normalizeArchiveText(container.textContent || "");

      if (!this.isArchiveFallbackText(text)) {
        return false;
      }

      return !container.querySelector("pre, table, math, .katex, .katex-display, mjx-container, .MathJax, img, picture, canvas, svg, video, audio, iframe, object, embed, hr, [data-rapid-view-for-chatgpt-code-block], [data-rapid-view-for-chatgpt-table-shell], [data-rapid-view-for-chatgpt-rich-placeholder]");
    }

    hasStrictArchiveHtml(html) {
      return Boolean(html && this.hasMeaningfulArchiveHtml(html) && !this.isArchiveFallbackHtml(html));
    }

    hasStrictReadyManualArchiveEntry(entry) {
      return Boolean(
        entry
        && (
          this.hasUsableArchiveText(entry.simpleText)
          || this.hasStrictArchiveHtml(entry.simpleHtml)
          || this.hasStrictArchiveHtml(entry.renderedHtml)
        )
      );
    }

    getManualArchiveEntryId(entryOrId) {
      if (typeof entryOrId === "string") {
        return entryOrId;
      }

      if (entryOrId && typeof entryOrId.id === "string") {
        return entryOrId.id;
      }

      return "";
    }

    isManualUserRestoredArchiveEntry(entryOrId) {
      const entryId = this.getManualArchiveEntryId(entryOrId);
      return Boolean(entryId && this.manualUserRestoredArchiveIds.has(entryId));
    }

    markManualArchiveEntryRestored(entryOrId) {
      const entryId = this.getManualArchiveEntryId(entryOrId);
      if (entryId) {
        this.manualUserRestoredArchiveIds.add(entryId);
      }
    }

    unmarkManualArchiveEntryRestored(entryOrId) {
      const entryId = this.getManualArchiveEntryId(entryOrId);
      if (entryId) {
        this.manualUserRestoredArchiveIds.delete(entryId);
      }
    }

    isVisibleManualArchiveEntry(entry) {
      return Boolean(
        entry
        && entry.visible
        && this.isManualUserRestoredArchiveEntry(entry)
        && this.hasStrictReadyManualArchiveEntry(entry)
      );
    }

    isRestorableManualEntry(entry) {
      return this.hasStrictReadyManualArchiveEntry(entry);
    }

    hydrateManualArchiveEntryFromRecord(record, existingEntry = null) {
      if (!record) {
        return null;
      }

      const existing = existingEntry || this.getManualArchiveEntry(record);
      const simpleText = this.hasUsableArchiveText(record.plainTextFallback)
        ? String(record.plainTextFallback).trim()
        : (this.hasUsableArchiveText(existing?.simpleText) ? String(existing.simpleText).trim() : "");
      const cachedSimpleHtml = this.hasStrictArchiveHtml(record.snapshotHtml)
        ? record.snapshotHtml.trim()
        : (this.hasStrictArchiveHtml(existing?.simpleHtml) ? existing.simpleHtml.trim() : "");
      const simpleHtml = cachedSimpleHtml || (simpleText ? this.renderPlainTextHtml(simpleText) : "");
      const renderedHtml = this.hasStrictArchiveHtml(record.richHtml)
        ? record.richHtml.trim()
        : (this.hasStrictArchiveHtml(existing?.renderedHtml) ? existing.renderedHtml.trim() : "");
      const renderProfile = record.renderProfile && typeof record.renderProfile === "object"
        ? record.renderProfile
        : (existing?.renderProfile && typeof existing.renderProfile === "object" ? existing.renderProfile : null);

      if (
        !this.hasUsableArchiveText(simpleText)
        && !this.hasStrictArchiveHtml(simpleHtml)
        && !this.hasStrictArchiveHtml(renderedHtml)
      ) {
        return null;
      }

      const entry = existing || {
        id: record.id,
        sourceRecordId: record.id,
        role: record.role,
        viewMode: record.viewMode || this.getDefaultArchiveViewMode(),
        simpleText: "",
        simpleHtml: "",
        renderedHtml: "",
        archiveBlock: null,
        refreshArchiveBlock: null,
        simpleExpanded: Boolean(record.simpleExpanded),
        dynamicAutoExpanded: Boolean(record.dynamicAutoExpanded),
        renderProfile: null,
        visible: record.state === "visibleArchive",
        estimatedHeight: 0
      };

      entry.id = record.id;
      entry.sourceRecordId = record.id;
      entry.role = record.role;
      entry.viewMode = entry.viewMode || record.viewMode || this.getDefaultArchiveViewMode();
      entry.simpleText = this.hasUsableArchiveText(simpleText) ? simpleText : "";
      entry.simpleHtml = this.hasStrictArchiveHtml(simpleHtml)
        ? simpleHtml
        : (entry.simpleText ? this.renderPlainTextHtml(entry.simpleText) : "");
      entry.renderedHtml = this.hasStrictArchiveHtml(renderedHtml) ? renderedHtml : "";
      entry.renderProfile = renderProfile || null;
      entry.simpleExpanded = Boolean(existing?.simpleExpanded || record.simpleExpanded);
      entry.dynamicAutoExpanded = Boolean(existing?.dynamicAutoExpanded || record.dynamicAutoExpanded);
      entry.visible = this.isManualUserRestoredArchiveEntry(entry)
        && (existing ? Boolean(existing.visible) : record.state === "visibleArchive");
      entry.estimatedHeight = Math.max(existing?.estimatedHeight || 0, record.estimatedHeight || 0);
      entry.manualPayloadState = "ready";

      if (entry.simpleText) {
        record.plainTextFallback = entry.simpleText;
      }
      if (entry.simpleHtml) {
        record.snapshotHtml = entry.simpleHtml;
      }
      if (entry.renderedHtml) {
        record.richHtml = entry.renderedHtml;
      }
      if (entry.renderProfile) {
        record.renderProfile = entry.renderProfile;
      }

      record.snapshotState = "ready";
      record.indexState = "ready";
      record.manualPayloadState = "ready";
      this.manualArchiveEntries.set(record.id, entry);
      return entry;
    }

    ensureManualArchiveEntryForRecord(record) {
      if (!record) {
        return null;
      }

      const entry = this.getManualArchiveEntry(record);
      if (this.hasStrictReadyManualArchiveEntry(entry)) {
        return entry;
      }

      return this.hydrateManualArchiveEntryFromRecord(record, entry);
    }

    isRenderableManualArchiveRecord(record) {
      if (!record || record.state !== "visibleArchive") {
        return false;
      }

      return this.isVisibleManualArchiveEntry(this.ensureManualArchiveEntryForRecord(record));
    }

    getVisibleManualArchiveEntries() {
      const entries = [];

      for (const record of this.records) {
        if (record.state !== "visibleArchive") {
          continue;
        }

        const existing = this.getManualArchiveEntry(record);
        const entry = this.ensureManualArchiveEntryForRecord(record);
        if (this.isVisibleManualArchiveEntry(entry)) {
          entries.push(entry);
        } else {
          if (existing) {
            existing.visible = false;
          }
          record.state = "hidden";
          record.keepVisible = false;
        }
      }

      return entries;
    }

    buildManualArchiveEntry(record, preferredNodes = null) {
      if (!record) {
        return null;
      }

      const existing = this.getManualArchiveEntry(record);
      const sourceRoot = this.buildRecordSourceRoot(record, preferredNodes);
      const cachedPlainText = this.hasUsableArchiveText(record.plainTextFallback)
        ? String(record.plainTextFallback).trim()
        : (this.hasUsableArchiveText(existing?.simpleText) ? String(existing.simpleText).trim() : "");
      const cachedSimpleHtml = this.hasStrictArchiveHtml(record.snapshotHtml)
        ? record.snapshotHtml.trim()
        : (this.hasStrictArchiveHtml(existing?.simpleHtml) ? existing.simpleHtml.trim() : "");
      const cachedRenderedHtml = this.hasStrictArchiveHtml(record.richHtml)
        ? record.richHtml.trim()
        : (this.hasStrictArchiveHtml(existing?.renderedHtml) ? existing.renderedHtml.trim() : "");
      const cachedRenderProfile = existing?.renderProfile && typeof existing.renderProfile === "object"
        ? existing.renderProfile
        : null;

      if (!(sourceRoot instanceof Element) && !cachedPlainText && !cachedSimpleHtml && !cachedRenderedHtml) {
        record.manualPayloadState = "pending";
        record.indexState = record.indexState === "ready" ? "ready" : "queued";
        return null;
      }

      let plainText = cachedPlainText;
      let simpleHtml = cachedSimpleHtml || (cachedPlainText ? this.renderPlainTextHtml(cachedPlainText) : "");
      let renderedHtml = cachedRenderedHtml;
      let renderProfile = cachedRenderProfile;

      if (sourceRoot instanceof Element) {
        const snapshotSource = this.selectSnapshotSource(sourceRoot, record.role);
        if (!(snapshotSource instanceof Element) || !this.hasMeaningfulSourceContent(snapshotSource)) {
          if (cachedPlainText || cachedSimpleHtml || cachedRenderedHtml) {
            // Continue below with cached payload.
          } else {
            record.manualPayloadState = "pending";
            record.indexState = record.indexState === "ready" ? "ready" : "queued";
            return null;
          }
        } else {
          const snapshot = this.buildSnapshot(sourceRoot, record.role);
          const snapshotText = this.hasUsableArchiveText(snapshot.text)
            ? String(snapshot.text).trim()
            : "";
          const extractedText = this.hasUsableArchiveText(this.extractPlainText(sourceRoot))
            ? String(this.extractPlainText(sourceRoot)).trim()
            : "";
          const simpleCandidate = this.hasStrictArchiveHtml(snapshot.simpleHtml)
            ? snapshot.simpleHtml.trim()
            : "";
          const renderedCandidate = this.hasStrictArchiveHtml(snapshot.richHtml)
            ? snapshot.richHtml.trim()
            : "";

          plainText = snapshotText || extractedText || cachedPlainText;
          simpleHtml = simpleCandidate || (plainText ? this.renderPlainTextHtml(plainText) : cachedSimpleHtml);
          renderedHtml = renderedCandidate || cachedRenderedHtml;
          renderProfile = snapshot.renderProfile || renderProfile;
        }
      }

      if (
        !this.hasUsableArchiveText(plainText)
        && !this.hasStrictArchiveHtml(simpleHtml)
        && !this.hasStrictArchiveHtml(renderedHtml)
      ) {
        record.manualPayloadState = "pending";
        record.indexState = record.indexState === "ready" ? "ready" : "queued";
        return null;
      }

      const nextViewMode = existing ? existing.viewMode : this.getDefaultArchiveViewMode();
      const entry = existing || {
        id: record.id,
        sourceRecordId: record.id,
        role: record.role,
        viewMode: nextViewMode,
        simpleText: "",
        simpleHtml: "",
        renderedHtml: "",
        archiveBlock: null,
        refreshArchiveBlock: null,
        simpleExpanded: false,
        dynamicAutoExpanded: false,
        renderProfile: null,
        visible: false,
        estimatedHeight: 0
      };

      entry.role = record.role;
      entry.viewMode = nextViewMode;
      entry.sourceRecordId = record.id;
      entry.simpleText = this.hasUsableArchiveText(plainText) ? plainText : "";
      entry.simpleHtml = this.hasStrictArchiveHtml(simpleHtml)
        ? simpleHtml
        : (entry.simpleText ? this.renderPlainTextHtml(entry.simpleText) : "");
      entry.renderedHtml = this.hasStrictArchiveHtml(renderedHtml) ? renderedHtml : "";
      entry.renderProfile = renderProfile || null;
      const entryReady = this.hasStrictReadyManualArchiveEntry(entry);
      entry.visible = Boolean(existing?.visible) && this.isManualUserRestoredArchiveEntry(entry);
      entry.estimatedHeight = Math.max(existing?.estimatedHeight || 0, record.estimatedHeight || 0);
      entry.manualPayloadState = entryReady ? "ready" : "pending";

      if (entry.simpleText) {
        record.plainTextFallback = entry.simpleText;
      }
      if (entry.simpleHtml) {
        record.snapshotHtml = entry.simpleHtml;
      }
      if (entry.renderedHtml) {
        record.richHtml = entry.renderedHtml;
      }
      if (entry.renderProfile) {
        record.renderProfile = entry.renderProfile;
      }
      record.snapshotState = entryReady ? "ready" : "empty";
      record.indexState = entryReady ? "ready" : "queued";
      record.manualPayloadState = entryReady ? "ready" : "pending";

      this.manualArchiveEntries.set(record.id, entry);
      return entryReady ? entry : null;
    }

    seedEstimatedHeights() {
      if (!this.records.length) {
        return;
      }

      const sampleCount = Math.min(
        this.records.length,
        Math.max(this.settings.liveTurnCount + 2, LIMITS.heightSampleSize)
      );
      const sampleStart = Math.max(0, this.records.length - sampleCount);
      let measuredTotal = 0;
      let measuredCount = 0;

      for (let index = sampleStart; index < this.records.length; index += 1) {
        const record = this.records[index];
        if (this.isPendingManualArchiveRecord(record)) {
          continue;
        }
        const liveHeight = this.measureRecordLiveHeight(record);
        if (liveHeight <= 0) {
          continue;
        }

        record.estimatedHeight = liveHeight;
        record.dynamicBaseHeight = record.estimatedHeight;
        record.trackHeightPx = record.estimatedHeight;
        measuredTotal += record.estimatedHeight;
        measuredCount += 1;
      }

      const fallbackHeight = measuredCount
        ? measuredTotal / measuredCount
        : 320;

      for (const record of this.records) {
        if (!record.estimatedHeight) {
          record.estimatedHeight = fallbackHeight;
        }
        if (!record.dynamicBaseHeight) {
          record.dynamicBaseHeight = record.estimatedHeight || fallbackHeight;
        }
        if (!record.trackHeightPx) {
          record.trackHeightPx = record.dynamicBaseHeight || record.estimatedHeight || fallbackHeight;
        }
      }
    }

    findPreservedPrefix(previousRecords, detectedIds) {
      if (!previousRecords.length || !detectedIds.length) {
        return [];
      }

      const requiredMatchCount = Math.max(1, Math.min(3, detectedIds.length, previousRecords.length));

      for (let startIndex = 0; startIndex < previousRecords.length; startIndex += 1) {
        if (previousRecords[startIndex].id !== detectedIds[0]) {
          continue;
        }

        let matchCount = 0;
        while (
          startIndex + matchCount < previousRecords.length
          && matchCount < detectedIds.length
          && previousRecords[startIndex + matchCount].id === detectedIds[matchCount]
        ) {
          matchCount += 1;
        }

        if (matchCount >= requiredMatchCount) {
          return previousRecords.slice(0, startIndex)
            .map((record) => this.normalizePreservedManualRecord(record));
        }
      }

      if (!this.hasManualArchiveWindowState(previousRecords)) {
        return [];
      }

      const detectedIdSet = new Set(detectedIds);
      const firstOverlapIndex = previousRecords.findIndex((record) => detectedIdSet.has(record.id));
      if (firstOverlapIndex > 0) {
        return previousRecords.slice(0, firstOverlapIndex)
          .map((record) => this.normalizePreservedManualRecord(record));
      }

      const maxTransientDetectedCount = Math.max(2, this.getManualLiveTurnCount() + 2);
      if (firstOverlapIndex < 0 && detectedIds.length <= maxTransientDetectedCount) {
        return previousRecords.map((record) => this.normalizePreservedManualRecord(record));
      }

      return [];
    }

    normalizePreservedManualRecord(record) {
      record.nodes = [];
      record.node = null;
      record.detachedSourceNodes = Array.isArray(record.detachedSourceNodes)
        ? record.detachedSourceNodes
        : [];
      record.detachedSourceNode = record.detachedSourceNode || null;
      record.renderProfile = record.renderProfile && typeof record.renderProfile === "object"
        ? record.renderProfile
        : null;
      record.snapshotState = record.snapshotState || ((record.snapshotHtml || record.richHtml || record.plainTextFallback) ? "ready" : "empty");
      record.indexState = record.indexState || record.snapshotState;
      record.manualPayloadState = record.manualPayloadState || record.snapshotState;
      record.state = record.state === "visibleArchive" ? "visibleArchive" : "hidden";
      record.keepVisible = Boolean(record.keepVisible);
      record.viewMode = record.viewMode || "simple";
      record.simplePreviewMeasureQueued = Boolean(record.simplePreviewMeasureQueued);
      record.dynamicAutoExpanded = Boolean(record.dynamicAutoExpanded);
      record.dynamicBaseHeight = record.dynamicBaseHeight || 0;
      record.trackHeightPx = record.trackHeightPx || record.dynamicBaseHeight || record.estimatedHeight || 0;
      record.trackTopPx = record.trackTopPx || 0;
      record.dynamicTrackHeightPx = record.dynamicTrackHeightPx || 0;
      record.dynamicTrackTopPx = record.dynamicTrackTopPx || 0;
      record.dynamicChromeHeightPx = record.dynamicChromeHeightPx || 0;
      record.dynamicUnits = Array.isArray(record.dynamicUnits) ? record.dynamicUnits : [];
      record.dynamicRenderedHeight = record.dynamicRenderedHeight || 0;
      return record;
    }

    groupMessageNodesIntoTurns(messageNodes) {
      if (!Array.isArray(messageNodes) || !messageNodes.length) {
        return [];
      }

      const groups = [];
      const occurrenceByBaseId = new Map();
      let currentGroup = null;

      for (const node of messageNodes) {
        if (!(node instanceof HTMLElement) || this.isRapidViewOwnedElement(node)) {
          continue;
        }

        const baseId = this.getNodeId(node);
        if (!baseId) {
          continue;
        }

        const role = this.getNodeRole(node);

        if (currentGroup && currentGroup.baseId === baseId && currentGroup.role === role) {
          currentGroup.nodes.push(node);
          continue;
        }

        const occurrence = occurrenceByBaseId.get(baseId) || 0;
        occurrenceByBaseId.set(baseId, occurrence + 1);

        currentGroup = {
          baseId,
          id: occurrence === 0 ? baseId : `${baseId}::${occurrence}`,
          role,
          nodes: [node]
        };
        groups.push(currentGroup);
      }

      return groups;
    }

    getNodeId(node) {
      if (!(node instanceof HTMLElement) || this.isRapidViewOwnedElement(node)) {
        return "";
      }

      const turnNode = this.resolveTurnNodeFromMessageNode(node);
      const turnId = turnNode instanceof HTMLElement
        ? turnNode.getAttribute("data-turn-id")
        : node.getAttribute("data-turn-id");
      if (turnId) {
        return turnId;
      }

      const existing = node.getAttribute("data-rapid-view-for-chatgpt-id");
      if (existing) {
        return existing;
      }

      const id = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      node.setAttribute("data-rapid-view-for-chatgpt-id", id);
      return id;
    }

    getNodeRole(node) {
      const turnNode = this.resolveTurnNodeFromMessageNode(node);
      const turnRole = turnNode instanceof HTMLElement
        ? turnNode.getAttribute("data-turn")
        : node instanceof HTMLElement
          ? node.getAttribute("data-turn")
          : "";
      return turnRole === "user" || turnRole === "assistant"
        ? turnRole
        : "assistant";
    }

    resolveTurnNodeFromMessageNode(node) {
      if (!(node instanceof HTMLElement) || this.isRapidViewOwnedElement(node)) {
        return null;
      }

      if (this.isTurnNode(node)) {
        return node;
      }

      const turnNodes = Array.from(node.querySelectorAll(TURN_SELECTOR))
        .filter((candidate) => this.isTurnNode(candidate) && !this.isRapidViewOwnedElement(candidate));

      if (turnNodes.length !== 1) {
        return null;
      }

      return turnNodes[0];
    }

    isTurnNode(node) {
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      if (this.isRapidViewOwnedElement(node)) {
        return false;
      }

      if (node.tagName !== "SECTION") {
        return false;
      }

      if (node.id === "thread-bottom-container" || node.hasAttribute("data-edge")) {
        return false;
      }

      if (node.getAttribute("aria-hidden") === "true") {
        return false;
      }

      const turnId = node.getAttribute("data-turn-id");
      const turnRole = node.getAttribute("data-turn");
      const testId = node.getAttribute("data-testid") || "";
      return Boolean(turnId) && (turnRole === "user" || turnRole === "assistant") && testId.startsWith("conversation-turn-");
    }

    isRapidViewOwnedElement(node) {
      return Boolean(node instanceof Element && node.closest(RAPID_VIEW_OWNED_UI_SELECTOR));
    }

    getRecordLiveNodes(record) {
      if (!record || !Array.isArray(record.nodes) || !this.root) {
        return [];
      }

      return record.nodes.filter((node) => (
        node instanceof HTMLElement
        && node.parentElement === this.root
      ));
    }

    getRecordSourceNodes(record) {
      if (!record) {
        return [];
      }

      const liveNodes = this.getRecordLiveNodes(record);
      if (liveNodes.length) {
        return liveNodes;
      }

      if (Array.isArray(record.detachedSourceNodes) && record.detachedSourceNodes.length) {
        return record.detachedSourceNodes.filter((node) => node instanceof Element);
      }

      if (Array.isArray(record.nodes) && record.nodes.length) {
        return record.nodes.filter((node) => node instanceof Element);
      }

      if (record.detachedSourceNode instanceof Element) {
        return [record.detachedSourceNode];
      }

      if (record.node instanceof Element) {
        return [record.node];
      }

      return [];
    }

    getRecordPrimaryLiveNode(record) {
      return this.getRecordLiveNodes(record)[0] || null;
    }

    measureNodes(nodes) {
      if (!Array.isArray(nodes) || !nodes.length) {
        return 0;
      }

      return nodes.reduce((total, node) => (
        node instanceof HTMLElement
          ? total + this.measureNode(node)
          : total
      ), 0);
    }

    measureRecordLiveHeight(record) {
      return Math.max(0, this.measureNodes(this.getRecordLiveNodes(record)));
    }

    buildRecordSourceRoot(record, preferredNodes = null) {
      const sourceNodes = Array.isArray(preferredNodes)
        ? preferredNodes.filter((node) => node instanceof Element)
        : this.getRecordSourceNodes(record);

      if (!sourceNodes.length) {
        return null;
      }

      if (sourceNodes.length === 1) {
        return sourceNodes[0];
      }

      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-rapid-view-for-chatgpt-turn-group-source", "true");
      for (const node of sourceNodes) {
        wrapper.appendChild(node.cloneNode(true));
      }
      return wrapper;
    }

    removeRecordLiveNodes(record) {
      for (const node of this.getRecordLiveNodes(record)) {
        node.remove();
      }
    }

    mountRecordNodesBefore(record, referenceNode = null) {
      if (!this.root || !record || !Array.isArray(record.nodes) || !record.nodes.length) {
        return;
      }

      let reference = referenceNode;
      for (let index = record.nodes.length - 1; index >= 0; index -= 1) {
        const node = record.nodes[index];
        if (!(node instanceof HTMLElement)) {
          continue;
        }

        this.root.insertBefore(node, reference);
        reference = node;
      }

      record.node = record.nodes[0] || null;
    }

    isPendingManualArchiveRecord(record) {
      return Boolean(
        record
        && (
          record.state === "pendingArchive"
          || this.isManualPendingVisualMaskApplied(record)
        )
      );
    }

    getPendingManualStyle(node) {
      const existing = node.getAttribute("style");
      return {
        node,
        style: existing === null ? null : existing
      };
    }

    isManualPendingVisualMaskApplied(record) {
      return Boolean(
        record
        && record.archivePending
        && record.state === "live"
        && Array.isArray(record.manualPendingOriginalStyles)
        && record.manualPendingOriginalStyles.length > 0
      );
    }

    restoreManualPendingStyleEntry(entry) {
      const node = entry && entry.node;
      if (!(node instanceof HTMLElement)) {
        return;
      }

      node.removeAttribute("data-rapid-view-for-chatgpt-pending-archive");
      node.removeAttribute("data-rapid-view-for-chatgpt-pending-visual-mask");
      if (entry.style === null) {
        node.removeAttribute("style");
      } else if (typeof entry.style === "string") {
        node.setAttribute("style", entry.style);
      }
    }

    applyManualPendingVisualMask(record) {
      if (!record || this.settings.dynamicScroll) {
        return false;
      }

      if (
        !record.archivePending
        || record.state !== "live"
        || this.hasStrictReadyManualArchiveEntry(this.getManualArchiveEntry(record))
      ) {
        this.restorePendingManualRecord(record);
        record.keepVisible = false;
        return false;
      }

      const sourceNodes = this.getRecordLiveNodes(record)
        .filter((node) => node instanceof HTMLElement);
      if (!sourceNodes.length) {
        this.restorePendingManualRecord(record);
        return false;
      }

      const sourceNodeSet = new Set(sourceNodes);
      const previousStyles = new Map();
      const previousEntries = Array.isArray(record.manualPendingOriginalStyles)
        ? record.manualPendingOriginalStyles
        : [];

      for (const entry of previousEntries) {
        const node = entry && entry.node;
        if (node instanceof HTMLElement && sourceNodeSet.has(node) && !previousStyles.has(node)) {
          previousStyles.set(node, entry.style);
        } else {
          this.restoreManualPendingStyleEntry(entry);
        }
      }

      record.manualPendingOriginalStyles = sourceNodes.map((node) => (
        previousStyles.has(node)
          ? { node, style: previousStyles.get(node) }
          : this.getPendingManualStyle(node)
      ));

      for (const node of sourceNodes) {
        node.removeAttribute("data-rapid-view-for-chatgpt-pending-archive");
        node.setAttribute("data-rapid-view-for-chatgpt-pending-visual-mask", "true");
        Object.assign(node.style, {
          visibility: "hidden",
          pointerEvents: "none",
          userSelect: "none"
        });
      }

      record.state = "live";
      record.keepVisible = false;
      return true;
    }

    hidePendingManualRecord(record) {
      return this.applyManualPendingVisualMask(record);
    }

    restorePendingManualRecord(record) {
      if (!record || !Array.isArray(record.manualPendingOriginalStyles)) {
        return;
      }

      for (const entry of record.manualPendingOriginalStyles) {
        this.restoreManualPendingStyleEntry(entry);
      }

      record.manualPendingOriginalStyles = [];
      if (record.state === "pendingArchive") {
        record.state = "live";
      }
    }

    measureLiveRecords() {
      const sampleStart = Math.max(
        0,
        this.records.length - Math.max(this.settings.liveTurnCount + 2, LIMITS.heightSampleSize)
      );

      for (let index = sampleStart; index < this.records.length; index += 1) {
        const record = this.records[index];
        const liveHeight = this.measureRecordLiveHeight(record);
        if (liveHeight > 0) {
          record.estimatedHeight = liveHeight;
          record.dynamicBaseHeight = record.estimatedHeight;
          record.trackHeightPx = record.estimatedHeight;
        }
      }
    }

    measureCurrentTrackGeometry() {
      const fallbackHeight = Math.max(1, LIMITS.dynamicScrollSlotHeightPx);

      for (const record of this.records) {
        const measuredHeight = this.measureRecordLiveHeight(record);
        if (measuredHeight > 0) {
          record.estimatedHeight = measuredHeight;
          record.dynamicBaseHeight = measuredHeight;
          record.trackHeightPx = measuredHeight;
          continue;
        }

        if (!record.trackHeightPx) {
          record.trackHeightPx = Math.max(
            1,
            Number(record.dynamicBaseHeight) || Number(record.estimatedHeight) || fallbackHeight
          );
        }

        if (!record.estimatedHeight) {
          record.estimatedHeight = Math.max(
            1,
            Number(record.trackHeightPx) || Number(record.dynamicBaseHeight) || fallbackHeight
          );
        }

        if (!record.dynamicBaseHeight) {
          record.dynamicBaseHeight = Math.max(
            1,
            Number(record.trackHeightPx) || Number(record.estimatedHeight) || fallbackHeight
          );
        }
      }
    }

    measureNode(node) {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const marginTop = parseFloat(style.marginTop) || 0;
      const marginBottom = parseFloat(style.marginBottom) || 0;
      return Math.max(1, rect.height + marginTop + marginBottom);
    }

    archiveOlderTurns() {
      if (!this.settings.dynamicScroll) {
        this.archiveOlderTurnsManual();
        return;
      }

      if (!this.records.length) {
        this.removeArchiveUi();
        this.hiddenCount = 0;
        return;
      }

      const liveTurnCount = Math.min(this.records.length, this.settings.liveTurnCount);
      const firstLiveIndex = Math.max(0, this.records.length - liveTurnCount);

      this.withDomMutationGuard(() => {
        for (let index = 0; index < this.records.length; index += 1) {
          const record = this.records[index];
          const liveNodes = this.getRecordLiveNodes(record);

          if (index < firstLiveIndex) {
            if (liveNodes.length) {
              record.dynamicBaseHeight = this.measureNodes(liveNodes);
              record.estimatedHeight = record.dynamicBaseHeight;
              record.trackHeightPx = record.dynamicBaseHeight;
            }

            if (!this.hasReadySnapshot(record)) {
              const sourceRoot = liveNodes.length
                ? this.buildRecordSourceRoot(record, liveNodes)
                : this.buildRecordSourceRoot(record);
              const baselineCaptured = this.captureBaselineSnapshot(record, sourceRoot);

              if (!baselineCaptured) {
                record.archivePending = true;
                record.indexState = "queued";
                record.state = "live";
                record.keepVisible = false;
                this.queuePlainTextForRecord(record, LIMITS.archiveIndexRetryDelayMs);
                continue;
              }
            }

            this.finalizeArchivedRecord(record);
          } else {
            record.state = "live";
            record.keepVisible = false;
            record.archivePending = false;
            if (record.nodes.some((node) => node instanceof HTMLElement && node.parentElement !== this.root)) {
              this.mountRecordNodesBefore(record, null);
            }
            this.clearRecordSourceNodes(record);
          }
        }

        this.syncArchiveUi();
      });

      this.hiddenCount = this.countHiddenRecords();
    }

    archiveOlderTurnsManual() {
      if (!this.records.length) {
        this.removeArchiveUi();
        this.hiddenCount = 0;
        return;
      }

      const liveTurnCount = Math.min(this.records.length, this.getManualLiveTurnCount());
      const firstLiveIndex = Math.max(0, this.records.length - liveTurnCount);
      const readyEntries = new Map();
      let pendingCount = 0;

      for (let index = firstLiveIndex - 1; index >= 0; index -= 1) {
        const record = this.records[index];
        const liveNodes = this.getRecordLiveNodes(record);
        let entry = this.getManualArchiveEntry(record);

        if (
          !this.hasStrictReadyManualArchiveEntry(entry)
          || (liveNodes.length && !this.hasStrictArchiveHtml(entry?.renderedHtml))
        ) {
          entry = this.buildManualArchiveEntry(record, liveNodes);
        }

        if (this.hasStrictReadyManualArchiveEntry(entry)) {
          record.archivePending = false;
          record.indexState = "ready";
          readyEntries.set(record.id, entry);
        } else {
          record.archivePending = true;
          record.indexState = "queued";
          record.manualPayloadState = "pending";
          pendingCount += 1;
          this.queuePlainTextForRecord(record, LIMITS.archiveIndexRetryDelayMs);
        }
      }

      this.archiveActive = true;
      this.withDomMutationGuard(() => {
        for (let index = 0; index < this.records.length; index += 1) {
          const record = this.records[index];
          const liveNodes = this.getRecordLiveNodes(record);

          if (index < firstLiveIndex) {
            const readyEntry = readyEntries.get(record.id);

            if (readyEntry) {
              this.restorePendingManualRecord(record);

              if (liveNodes.length) {
                record.estimatedHeight = this.measureNodes(liveNodes);
                record.dynamicBaseHeight = record.estimatedHeight;
                record.trackHeightPx = record.estimatedHeight;
                readyEntry.estimatedHeight = Math.max(readyEntry.estimatedHeight || 0, record.estimatedHeight || 0);
              }

              const keepVisible = Boolean(readyEntry.visible) && this.isManualUserRestoredArchiveEntry(readyEntry);
              readyEntry.visible = keepVisible;
              readyEntry.viewMode = readyEntry.viewMode || this.getDefaultArchiveViewMode();
              record.state = keepVisible ? "visibleArchive" : "hidden";
              record.keepVisible = keepVisible;

              if (liveNodes.length) {
                this.removeRecordLiveNodes(record);
              }

              record.nodes = [];
              record.node = null;
              record.detachedSourceNodes = [];
              record.detachedSourceNode = null;
              record.manualPendingOriginalStyles = [];
              record.manualPayloadState = "ready";
            } else {
              record.state = "live";
              record.keepVisible = false;
              record.archivePending = true;
              if (record.nodes.some((node) => node instanceof HTMLElement && node.parentElement !== this.root)) {
                this.mountRecordNodesBefore(record, null);
              }
              this.applyManualPendingVisualMask(record);
            }
          } else {
            this.restorePendingManualRecord(record);
            record.state = "live";
            record.keepVisible = false;
            record.archivePending = false;
            if (record.nodes.some((node) => node instanceof HTMLElement && node.parentElement !== this.root)) {
              this.mountRecordNodesBefore(record, null);
            }
          }
        }

        this.syncArchiveUi();
      });

      this.hiddenCount = this.countHiddenRecords();
      this.logger.info("manual-archive:applied", {
        readyCount: readyEntries.size,
        pendingCount,
        pendingHiddenCount: this.records.filter((record) => this.isPendingManualArchiveRecord(record)).length,
        hiddenCount: this.hiddenCount,
        liveTurnCount
      });
    }

    hasReadySnapshot(record) {
      return Boolean(
        record
        && record.snapshotState === "ready"
        && (
          this.hasUsableArchiveText(record.plainTextFallback)
          || this.hasStrictArchiveHtml(record.snapshotHtml)
          || this.hasStrictArchiveHtml(record.richHtml)
        )
      );
    }

    invalidateDerivedArchiveState(record) {
      if (!record) {
        return;
      }

      record.dynamicUnits = [];
      record.dynamicTrackHeightPx = 0;
      record.dynamicTrackTopPx = 0;
      record.dynamicRenderedHeight = 0;
    }

    clearRecordSourceNodes(record) {
      if (!record) {
        return;
      }

      record.detachedSourceNodes = [];
      record.detachedSourceNode = null;
    }

    hasManualArchivePayload(record) {
      return Boolean(
        record
        && record.snapshotState === "ready"
        && (
          this.hasUsableArchiveText(record.plainTextFallback)
          || this.hasStrictArchiveHtml(record.snapshotHtml)
          || this.hasStrictArchiveHtml(record.richHtml)
        )
      );
    }

    finalizeArchivedRecord(record) {
      if (!record || !this.hasManualArchivePayload(record)) {
        return false;
      }

      this.removeRecordLiveNodes(record);
      record.nodes = [];
      record.node = null;
      record.archivePending = false;
      record.indexState = "ready";
      record.snapshotState = "ready";
      this.clearRecordSourceNodes(record);

      if (record.keepVisible) {
        record.state = "visibleArchive";
      } else {
        record.state = "hidden";
      }

      return true;
    }

    captureBaselineSnapshot(record, sourceNode = null) {
      if (!record) {
        return false;
      }

      const effectiveSource = sourceNode instanceof Element
        ? sourceNode
        : this.buildRecordSourceRoot(record);

      if (!(effectiveSource instanceof Element)) {
        return false;
      }

      const snapshotSource = this.selectSnapshotSource(effectiveSource, record.role);
      if (!(snapshotSource instanceof Element) || !this.hasMeaningfulSourceContent(snapshotSource)) {
        return false;
      }

      const previousSnapshotHtml = record.snapshotHtml || "";
      const previousPlainText = record.plainTextFallback || "";
      const previousRichMedia = Boolean(record.hadRichMedia);
      const snapshot = this.buildSnapshot(effectiveSource, record.role, {
        includeRich: false
      });
      const nextPlainText = (snapshot.text || "").trim();
      const nextSimpleHtml = (snapshot.simpleHtml || "").trim();

      if (!this.hasUsableArchiveText(nextPlainText) && !this.hasStrictArchiveHtml(nextSimpleHtml)) {
        return false;
      }

      if (this.hasStrictArchiveHtml(nextSimpleHtml)) {
        record.snapshotHtml = nextSimpleHtml;
      } else if (!record.snapshotHtml && this.hasUsableArchiveText(nextPlainText)) {
        record.snapshotHtml = this.renderPlainTextHtml(nextPlainText);
      }

      if (this.hasUsableArchiveText(nextPlainText)) {
        const previousNormalizedPlainText = previousPlainText.trim();
        if (!previousNormalizedPlainText || nextPlainText.length >= previousNormalizedPlainText.length) {
          record.plainTextFallback = nextPlainText;
        }
      }

      record.hadRichMedia = record.hadRichMedia || snapshot.hadRichMedia;
      if (snapshot.renderProfile) {
        record.renderProfile = snapshot.renderProfile;
      }
      record.snapshotState = "ready";
      record.indexState = "ready";

      if (
        record.snapshotHtml !== previousSnapshotHtml
        || record.plainTextFallback !== previousPlainText
        || record.hadRichMedia !== previousRichMedia
      ) {
        this.invalidateDerivedArchiveState(record);
      }

      return this.hasManualArchivePayload(record);
    }

    captureSnapshot(record, sourceNode = null) {
      const effectiveSource = sourceNode instanceof Element
        ? sourceNode
        : this.buildRecordSourceRoot(record);
      const previousSnapshotHtml = record.snapshotHtml || "";
      const previousRichHtml = record.richHtml || "";
      const previousPlainText = record.plainTextFallback || "";

      if (!(effectiveSource instanceof Element)) {
        if (!record.snapshotHtml && this.hasUsableArchiveText(record.plainTextFallback)) {
          record.snapshotHtml = this.renderPlainTextHtml(record.plainTextFallback);
        }
        if (this.hasManualArchivePayload(record)) {
          record.snapshotState = "ready";
          record.indexState = "ready";
        }
        return;
      }

      const baselineReady = this.captureBaselineSnapshot(record, effectiveSource);

      if (!baselineReady) {
        if (!this.hasManualArchivePayload(record)) {
          record.indexState = "failed";
          record.snapshotState = "failed";
        }
        return;
      }

      const snapshot = this.buildSnapshot(effectiveSource, record.role);
      const nextPlainText = (snapshot.text || this.extractPlainText(effectiveSource) || "").trim();
      const previousNormalizedPlainText = previousPlainText.trim();
      if (this.hasStrictArchiveHtml(snapshot.simpleHtml)) {
        record.snapshotHtml = snapshot.simpleHtml;
      } else if (!record.snapshotHtml && this.hasUsableArchiveText(nextPlainText)) {
        record.snapshotHtml = this.renderPlainTextHtml(nextPlainText);
      }
      if (this.hasStrictArchiveHtml(snapshot.richHtml)) {
        record.richHtml = snapshot.richHtml;
      }
      if (snapshot.renderProfile) {
        record.renderProfile = snapshot.renderProfile;
      }
      if (this.hasUsableArchiveText(nextPlainText) && (!previousNormalizedPlainText || nextPlainText.length >= previousNormalizedPlainText.length)) {
        record.plainTextFallback = nextPlainText || record.plainTextFallback || this.extractPlainText(effectiveSource);
      }
      record.hadRichMedia = record.hadRichMedia || snapshot.hadRichMedia;
      record.estimatedHeight = record.estimatedHeight || this.measureNode(effectiveSource);
      record.snapshotState = "ready";
      record.indexState = "ready";
      this.clearRecordSourceNodes(record);
      if (
        record.snapshotHtml !== previousSnapshotHtml
        || record.richHtml !== previousRichHtml
        || record.plainTextFallback !== previousPlainText
      ) {
        this.invalidateDerivedArchiveState(record);
      }
    }

    ensureSnapshotReady(record) {
      if (!record || record.snapshotState === "ready") {
        return;
      }

      this.captureSnapshot(record);
    }

    scheduleDeferredSnapshotWork() {
      this.scheduleRichSnapshotWork();
    }

    clearDeferredSnapshotTimer() {
      if (this.deferredSnapshotTimer) {
        global.clearTimeout(this.deferredSnapshotTimer);
        this.deferredSnapshotTimer = 0;
      }
    }

    clearDeferredPlainTextTimer() {
      if (this.deferredPlainTextTimer) {
        global.clearTimeout(this.deferredPlainTextTimer);
        this.deferredPlainTextTimer = 0;
      }
    }

    sortPendingPlainTextQueue() {
      if (this.settings.dynamicScroll || this.pendingPlainTextIds.length < 2) {
        return;
      }

      const indexById = new Map(this.records.map((record, index) => [record.id, index]));
      this.pendingPlainTextIds.sort((leftId, rightId) => (
        (indexById.get(rightId) ?? -1) - (indexById.get(leftId) ?? -1)
      ));
    }

    queuePlainTextForRecord(record, delayMs = LIMITS.archiveIndexDelayMs) {
      const alreadyReady = this.settings.dynamicScroll
        ? this.hasManualArchivePayload(record)
        : this.hasStrictReadyManualArchiveEntry(this.getManualArchiveEntry(record));
      if (!record || alreadyReady || record.plainTextPending) {
        return;
      }

      record.plainTextPending = true;
      record.indexState = "queued";
      if (!this.pendingPlainTextIds.includes(record.id)) {
        this.pendingPlainTextIds.push(record.id);
        this.sortPendingPlainTextQueue();
      }
      this.scheduleDeferredPlainTextWork(delayMs);
    }

    scheduleDeferredPlainTextWork(delayMs = LIMITS.archiveIndexDelayMs) {
      this.clearDeferredPlainTextTimer();

      if (!this.pendingPlainTextIds.length) {
        return;
      }

      this.deferredPlainTextTimer = global.setTimeout(() => {
        this.deferredPlainTextTimer = 0;
        this.processDeferredPlainTextBatch();
      }, delayMs);
    }

    processDeferredPlainTextBatch() {
      const startedAt = performance.now();
      let processed = 0;
      let indexed = 0;
      let requeued = 0;
      let refreshedBlocks = 0;
      let shouldRefreshArchiveUi = false;
      const retryRecords = [];

      this.sortPendingPlainTextQueue();

      while (this.pendingPlainTextIds.length && processed < LIMITS.archiveIndexBatchSize) {
        const recordId = this.pendingPlainTextIds.shift();
        const record = this.records.find((candidate) => candidate.id === recordId);

        if (!record) {
          continue;
        }

        record.plainTextPending = false;
        processed += 1;

        if (!this.settings.dynamicScroll) {
          const liveNodes = this.getRecordLiveNodes(record);
          const entry = this.buildManualArchiveEntry(record, liveNodes);

          if (this.hasStrictReadyManualArchiveEntry(entry)) {
            const wasPendingArchive = this.isPendingManualArchiveRecord(record);
            indexed += 1;
            record.archivePending = false;
            record.indexState = "ready";
            record.snapshotState = "ready";
            shouldRefreshArchiveUi = true;
            if (wasPendingArchive) {
              this.logger.info("manual-pending:ready", {
                id: record.id,
                role: record.role
              });
            }

            if (this.isVisibleManualArchiveEntry(entry) && typeof entry.refreshArchiveBlock === "function") {
              entry.refreshArchiveBlock();
              refreshedBlocks += 1;
            }
            continue;
          }

          record.indexState = "queued";
          record.snapshotState = record.snapshotState === "ready" ? "ready" : "empty";
          record.manualPayloadState = "pending";
          if (liveNodes.length || this.getRecordSourceNodes(record).length) {
            if (record.archivePending) {
              record.state = "live";
              record.keepVisible = false;
              if (record.nodes.some((node) => node instanceof HTMLElement && node.parentElement !== this.root)) {
                this.mountRecordNodesBefore(record, null);
              }
              this.applyManualPendingVisualMask(record);
            } else {
              this.restorePendingManualRecord(record);
            }
            retryRecords.push(record);
            requeued += 1;
          } else {
            record.indexState = "failed";
          }
          continue;
        }

        if (this.hasManualArchivePayload(record)) {
          record.indexState = "ready";
          if (record.archivePending && this.finalizeArchivedRecord(record)) {
            shouldRefreshArchiveUi = true;
          } else if (record.state === "visibleArchive" && typeof record.refreshArchiveBlock === "function") {
            record.refreshArchiveBlock();
            refreshedBlocks += 1;
          }
          continue;
        }

        record.indexState = "capturing";
        const liveNodes = this.getRecordLiveNodes(record);
        const sourceRoot = liveNodes.length
          ? this.buildRecordSourceRoot(record, liveNodes)
          : this.buildRecordSourceRoot(record);
        const indexedRecord = this.captureBaselineSnapshot(record, sourceRoot);

        if (indexedRecord) {
          indexed += 1;
          if (record.archivePending && this.finalizeArchivedRecord(record)) {
            shouldRefreshArchiveUi = true;
          } else if (record.state === "visibleArchive" && typeof record.refreshArchiveBlock === "function") {
            record.refreshArchiveBlock();
            refreshedBlocks += 1;
          }
          continue;
        }

        record.indexState = "queued";
        if (liveNodes.length || this.getRecordSourceNodes(record).length) {
          retryRecords.push(record);
          requeued += 1;
        } else {
          record.indexState = "failed";
          record.snapshotState = record.snapshotState === "ready" ? "ready" : "failed";
          if (record.state === "visibleArchive" && typeof record.refreshArchiveBlock === "function") {
            record.refreshArchiveBlock();
            refreshedBlocks += 1;
          }
        }
      }

      for (const record of retryRecords) {
        this.queuePlainTextForRecord(record, LIMITS.archiveIndexRetryDelayMs);
      }

      if (!this.settings.dynamicScroll && (shouldRefreshArchiveUi || indexed > 0)) {
        this.archiveOlderTurnsManual();
        this.emitStatus();
      } else if (shouldRefreshArchiveUi || (this.settings.dynamicScroll && indexed > 0)) {
        this.hiddenCount = this.countHiddenRecords();
        this.syncArchiveUi();
        this.emitStatus();
      } else if (refreshedBlocks > 0) {
        this.emitStatus();
      }

      if (this.pendingPlainTextIds.length) {
        this.scheduleDeferredPlainTextWork(LIMITS.archiveIndexRetryDelayMs);
      }

      this.logger.info("archive-index-batch", {
        durationMs: this.getDurationMs(startedAt),
        processed,
        indexed,
        requeued,
        refreshedBlocks,
        remaining: this.pendingPlainTextIds.length
      });
    }

    extractFastPlainText(record) {
      const sourceNode = this.buildRecordSourceRoot(record);
      if (!(sourceNode instanceof Element)) {
        return "";
      }

      const contentSource = this.selectSnapshotSource(sourceNode, record.role);
      return ((contentSource && contentSource.textContent) || sourceNode.textContent || "")
        .replace(/\r/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
    }

    processDeferredSnapshotBatch() {
      this.processRichSnapshotBatch();
    }

    requestRichSnapshot(record) {
      if (!record) {
        return;
      }

      if (!this.hasManualArchivePayload(record)) {
        this.queuePlainTextForRecord(record, LIMITS.archiveIndexRetryDelayMs);
        this.logger.info("rich-snapshot:skip", {
          id: record.id,
          hasRich: Boolean(record.richHtml),
          richRequestPending: Boolean(record.richRequestPending),
          snapshotState: record.snapshotState || "empty",
          viewMode: record.viewMode,
          reason: "archive-payload-not-ready"
        });
        return;
      }

      if (record.richHtml || record.richRequestPending) {
        this.logger.info("rich-snapshot:skip", {
          id: record.id,
          hasRich: Boolean(record.richHtml),
          richRequestPending: Boolean(record.richRequestPending),
          snapshotState: record.snapshotState || "empty",
          viewMode: record.viewMode
        });
        return;
      }

      if (!this.getRecordSourceNodes(record).length) {
        this.logger.info("rich-snapshot:skip", {
          id: record.id,
          hasRich: Boolean(record.richHtml),
          richRequestPending: Boolean(record.richRequestPending),
          snapshotState: record.snapshotState || "empty",
          viewMode: record.viewMode,
          reason: "no-source-nodes"
        });
        return;
      }

      record.richRequestPending = true;
      if (!this.pendingRichSnapshotIds.includes(record.id)) {
        this.pendingRichSnapshotIds.push(record.id);
      }
      this.logger.info("rich-snapshot:queued", {
        id: record.id,
        snapshotState: record.snapshotState || "empty",
        hasDetachedSourceNode: this.getRecordSourceNodes(record).length > 0 && !this.getRecordLiveNodes(record).length,
        hasLiveNode: this.getRecordLiveNodes(record).length > 0,
        viewMode: record.viewMode
      });
      this.scheduleRichSnapshotWork();
    }

    scheduleRichSnapshotWork() {
      this.clearDeferredSnapshotTimer();

      if (!this.pendingRichSnapshotIds.length) {
        return;
      }

      this.deferredSnapshotTimer = global.setTimeout(() => {
        this.deferredSnapshotTimer = 0;
        this.processRichSnapshotBatch();
      }, LIMITS.deferredSnapshotDelayMs);
    }

    processRichSnapshotBatch() {
      const startedAt = performance.now();
      let processed = 0;
      let shouldRefreshVisibleArchive = false;
      let refreshedBlocks = 0;

      while (this.pendingRichSnapshotIds.length && processed < LIMITS.deferredSnapshotBatchSize) {
        const recordId = this.pendingRichSnapshotIds.shift();
        const record = this.records.find((candidate) => candidate.id === recordId);

        if (!record) {
          continue;
        }

        record.richRequestPending = false;

        if (record.richHtml || !this.getRecordSourceNodes(record).length || !this.hasManualArchivePayload(record)) {
          if (!this.hasManualArchivePayload(record)) {
            this.queuePlainTextForRecord(record, LIMITS.archiveIndexRetryDelayMs);
          }
          this.logger.info("rich-snapshot:skip-batch-record", {
            id: record.id,
            hasRich: Boolean(record.richHtml),
            hasDetachedSourceNode: this.getRecordSourceNodes(record).length > 0 && !this.getRecordLiveNodes(record).length,
            hasLiveNode: this.getRecordLiveNodes(record).length > 0,
            snapshotState: record.snapshotState || "empty",
            viewMode: record.viewMode
          });
          continue;
        }

        this.captureSnapshot(record);
        this.logger.info("rich-snapshot:captured", {
          id: record.id,
          richHtmlLength: record.richHtml ? record.richHtml.length : 0,
          snapshotHtmlLength: record.snapshotHtml ? record.snapshotHtml.length : 0,
          snapshotState: record.snapshotState || "empty",
          viewMode: record.viewMode
        });
        processed += 1;

        if (
          record.archiveBlock instanceof HTMLElement
          && record.archiveBlock.isConnected
          && typeof record.refreshArchiveBlock === "function"
        ) {
          record.refreshArchiveBlock();
          refreshedBlocks += 1;
        }

        if (
          (record.state === "visibleArchive" && record.viewMode === "rich")
          || refreshedBlocks > 0
        ) {
          shouldRefreshVisibleArchive = true;
        }
      }

      if (this.settings.dynamicScroll && processed > 0) {
        this.syncArchiveUi();
        this.emitStatus();
      } else if (shouldRefreshVisibleArchive && refreshedBlocks === 0) {
        this.syncArchiveUi();
        this.emitStatus();
      } else if (refreshedBlocks > 0) {
        this.emitStatus();
      }

      if (this.pendingRichSnapshotIds.length) {
        this.scheduleRichSnapshotWork();
      }

      this.logger.info("rich-snapshot-batch", {
        durationMs: this.getDurationMs(startedAt),
        processed,
        remaining: this.pendingRichSnapshotIds.length,
        refreshedVisibleArchive: shouldRefreshVisibleArchive,
        refreshedBlocks
      });
    }

    buildSnapshot(turnNode, role, options = {}) {
      const includeRich = options.includeRich !== false;
      const source = this.selectSnapshotSource(turnNode, role);
      const context = { hadRichMedia: false, renderProfile: null };
      const simpleHtmlCandidate = this.serializeSnapshotNode(source, context).trim();
      const text = this.extractPlainText(source);
      const simpleHtml = this.hasStrictArchiveHtml(simpleHtmlCandidate)
        ? simpleHtmlCandidate
        : (this.hasUsableArchiveText(text) ? this.renderPlainTextHtml(text) : "");
      const richHtml = includeRich
        ? this.buildValidatedRichSnapshot(turnNode, role, context)
        : "";
      const renderProfile = context.renderProfile || this.buildArchiveRenderProfile(turnNode, source, role);

      return {
        simpleHtml,
        richHtml,
        text,
        renderProfile,
        hadRichMedia: context.hadRichMedia
      };
    }

    buildValidatedRichSnapshot(turnNode, role, context) {
      const candidates = this.collectSnapshotSourceCandidates(turnNode, role, "rich");
      const rejectionSamples = [];

      for (const candidate of candidates) {
        const candidateContext = { hadRichMedia: false };
        const richHtml = this.buildRichSnapshot(candidate, candidateContext).trim();

        if (!richHtml) {
          rejectionSamples.push({
            candidate: this.describeElement(candidate),
            reason: "empty-after-sanitize"
          });
          continue;
        }

        if (!this.hasMeaningfulArchiveHtml(richHtml)) {
          rejectionSamples.push({
            candidate: this.describeElement(candidate),
            reason: "no-meaningful-content",
            htmlLength: richHtml.length
          });
          continue;
        }

        context.hadRichMedia = context.hadRichMedia || candidateContext.hadRichMedia;
        context.renderProfile = this.buildArchiveRenderProfile(turnNode, candidate, role);
        this.logger.info("rich-snapshot-source:selected", {
          role,
          candidate: this.describeElement(candidate),
          htmlLength: richHtml.length,
          hadRichMedia: candidateContext.hadRichMedia,
          rejectedCandidates: rejectionSamples.slice(0, 3)
        });
        return richHtml;
      }

      this.logger.info("rich-snapshot-source:failed", {
        role,
        candidateCount: candidates.length,
        rejectedCandidates: rejectionSamples.slice(0, 5)
      });
      return "";
    }

    buildArchiveRenderProfile(turnNode, source, role) {
      void turnNode;

      if (!(source instanceof HTMLElement)) {
        return null;
      }

      const rootProfile = this.captureElementRenderProfile(source);
      if (!rootProfile) {
        return null;
      }

      const elements = this.captureArchiveElementProfiles(source, role);
      return {
        version: 1,
        role: role === "user" ? "user" : "assistant",
        sourceKind: this.inferArchiveRenderSourceKind(source, role, rootProfile, elements),
        root: rootProfile,
        elements
      };
    }

    captureElementRenderProfile(element) {
      if (!(element instanceof HTMLElement) || typeof global.getComputedStyle !== "function") {
        return null;
      }

      let computed = null;
      try {
        computed = global.getComputedStyle(element);
      } catch (error) {
        return null;
      }

      if (!computed) {
        return null;
      }

      const propertyPairs = [
        ["whiteSpace", "white-space"],
        ["overflowWrap", "overflow-wrap"],
        ["wordBreak", "word-break"],
        ["direction", "direction"],
        ["textAlign", "text-align"],
        ["tabSize", "tab-size"],
        ["display", "display"]
      ];
      const profile = {};

      for (const [key, cssName] of propertyPairs) {
        const value = computed.getPropertyValue(cssName) || computed[key] || "";
        const normalized = this.normalizeArchiveRenderStyleValue(key, value);
        if (normalized) {
          profile[key] = normalized;
        }
      }

      return Object.keys(profile).length ? profile : null;
    }

    normalizeArchiveRenderStyleValue(key, value) {
      const normalized = String(value || "").trim().toLowerCase();
      if (!normalized || normalized.length > 64) {
        return "";
      }

      const allowedValues = {
        whiteSpace: new Set(["normal", "pre", "pre-wrap", "pre-line", "break-spaces", "nowrap"]),
        overflowWrap: new Set(["normal", "break-word", "anywhere"]),
        wordBreak: new Set(["normal", "break-all", "keep-all", "break-word"]),
        direction: new Set(["ltr", "rtl"]),
        textAlign: new Set(["start", "end", "left", "right", "center", "justify", "match-parent"]),
        display: new Set(["block", "inline", "inline-block", "flex", "inline-flex", "grid", "table", "table-row", "table-cell", "list-item"])
      };

      if (key === "tabSize") {
        return /^\d+(\.\d+)?(px|em|rem|ch)?$/u.test(normalized) ? normalized : "";
      }

      return allowedValues[key] && allowedValues[key].has(normalized) ? normalized : "";
    }

    captureArchiveElementProfiles(source, role) {
      const definitions = [
        { kind: "plainText", selector: ".whitespace-pre-wrap, [data-message-author-role='user'] [dir='auto']" },
        { kind: "markdown", selector: ".markdown-new-styling, .markdown.prose" },
        { kind: "codeBlock", selector: "pre" },
        { kind: "table", selector: "table" },
        { kind: "list", selector: "ul, ol" },
        { kind: "quote", selector: "blockquote" }
      ];
      const profiles = [];
      const seen = new Set();

      for (const definition of definitions) {
        const candidates = [];
        if (this.matchesArchiveSelector(source, definition.selector)) {
          candidates.push(source);
        }
        candidates.push(...Array.from(source.querySelectorAll(definition.selector)));

        for (const candidate of candidates) {
          if (!(candidate instanceof HTMLElement) || seen.has(candidate)) {
            continue;
          }

          const style = this.captureElementRenderProfile(candidate);
          if (!style) {
            continue;
          }

          profiles.push({
            kind: definition.kind,
            role: role === "user" ? "user" : "assistant",
            style
          });
          seen.add(candidate);
          break;
        }
      }

      return profiles.slice(0, 8);
    }

    matchesArchiveSelector(element, selector) {
      if (!(element instanceof Element)) {
        return false;
      }

      try {
        return element.matches(selector);
      } catch (error) {
        return false;
      }
    }

    inferArchiveRenderSourceKind(source, role, rootProfile, elements) {
      const kinds = new Set((elements || []).map((entry) => entry.kind));
      const hasStructuralContent = kinds.has("codeBlock")
        || kinds.has("table")
        || kinds.has("list")
        || kinds.has("quote")
        || Boolean(source.querySelector("pre, table, ul, ol, blockquote, h1, h2, h3, h4, h5, h6"));
      const hasPreWhiteSpace = rootProfile
        && ["pre", "pre-wrap", "pre-line", "break-spaces"].includes(rootProfile.whiteSpace);

      if (role === "user" || hasPreWhiteSpace || this.matchesArchiveSelector(source, ".whitespace-pre-wrap")) {
        return hasStructuralContent ? "mixed" : "plainText";
      }

      if (kinds.has("table") && !kinds.has("codeBlock")) {
        return "table";
      }

      if (kinds.has("codeBlock") && !kinds.has("table")) {
        return "code";
      }

      if (this.matchesArchiveSelector(source, ".markdown-new-styling, .markdown.prose")) {
        return hasStructuralContent ? "mixed" : "markdown";
      }

      return hasStructuralContent ? "mixed" : (role === "assistant" ? "markdown" : "plainText");
    }

    buildRichSnapshot(source, context) {
      if (!(source instanceof Element)) {
        return "";
      }

      const sourceCodeBlocks = this.collectSourceCodeBlocks(source);
      const clone = source.cloneNode(true);
      this.sanitizeRichClone(clone, context);
      this.injectArchivedCodeBlocks(clone, sourceCodeBlocks);

      if (clone instanceof HTMLTableElement) {
        return this.buildScrollableTableHtml(
          clone,
          (cell) => this.serializeRichTableCellContent(cell, context)
        );
      }

      this.replaceScrollableTablesInElement(clone);
      this.pruneRichCloneLayout(clone);

      if (!(clone instanceof HTMLElement) || !clone.innerHTML.trim() || !this.hasMeaningfulRenderedContent(clone)) {
        return "";
      }

      return clone.outerHTML;
    }

    collectSourceCodeBlocks(source) {
      if (!(source instanceof Element)) {
        return [];
      }

      return Array.from(source.querySelectorAll("pre"))
        .map((pre) => this.buildSourceCodeBlockDescriptor(pre, source))
        .filter((block) => block.text);
    }

    buildSourceCodeBlockDescriptor(pre, source) {
      const parts = this.buildCodeBlockParts(pre, source);
      const text = this.removeDuplicatedStructuralCodeLanguageLine(
        this.extractCodeText(parts.contentRoot, parts.omittedNodes),
        parts.language
      );

      return {
        text,
        html: this.extractCodeHtml(parts.contentRoot, parts.omittedNodes),
        language: parts.language
      };
    }

    buildCodeBlockParts(pre, source) {
      const contentRoot = this.getCodeBlockContentRoot(pre);
      const host = source instanceof Element ? this.findCodeBlockHost(pre, source) : pre;
      const hostHeader = this.findHostCodeLanguageHeader(host, contentRoot || pre);
      const embeddedHeader = this.findEmbeddedCodeLanguageHeader(contentRoot);
      const omittedNodes = new Set();

      if (hostHeader && hostHeader.element) {
        omittedNodes.add(hostHeader.element);
      }

      if (embeddedHeader && embeddedHeader.element) {
        omittedNodes.add(embeddedHeader.element);
      }

      const languageHint = (
        (hostHeader && hostHeader.label)
        || (embeddedHeader && embeddedHeader.label)
        || ""
      );

      return {
        host,
        contentRoot,
        omittedNodes,
        language: this.detectCodeLanguage(pre, source, contentRoot, languageHint)
      };
    }

    getCodeBlockContentRoot(pre) {
      if (!(pre instanceof Element)) {
        return null;
      }

      return pre.querySelector("code") || pre;
    }

    findHostCodeLanguageHeader(host, contentRoot) {
      if (!(host instanceof Element)) {
        return null;
      }

      for (const element of host.querySelectorAll("div, span")) {
        if (!this.isHostCodeLanguageElement(element, host, contentRoot)) {
          continue;
        }

        const label = this.normalizeCodeLanguageLabel(element.textContent || "");
        const omittedElement = this.getHostCodeHeaderOmitElement(element, host, contentRoot);
        return { element: omittedElement, label };
      }

      return null;
    }

    isHostCodeLanguageElement(element, host, contentRoot) {
      if (!(element instanceof Element) || this.shouldOmitCodeExtractionNode(element)) {
        return false;
      }

      if (element.querySelector("pre, code") || element.contains(contentRoot)) {
        return false;
      }

      if (contentRoot instanceof Element && contentRoot.contains(element)) {
        return false;
      }

      if (!this.isElementBeforeCodeContent(element, contentRoot)) {
        return false;
      }

      if (!this.normalizeCodeLanguageLabel(element.textContent || "")) {
        return false;
      }

      return this.hasCodeLanguageChrome(element, host, contentRoot);
    }

    isElementBeforeCodeContent(element, contentRoot) {
      if (!(element instanceof Element) || !(contentRoot instanceof Element) || element === contentRoot) {
        return false;
      }

      const position = element.compareDocumentPosition(contentRoot);
      return Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
    }

    hasCodeLanguageChrome(element, host, contentRoot) {
      if (!(element instanceof Element)) {
        return false;
      }

      if (element.querySelector("svg")) {
        return true;
      }

      let current = element.parentElement;
      while (current && current !== host) {
        if (contentRoot instanceof Element && current.contains(contentRoot)) {
          break;
        }

        if (current.querySelector("svg") && this.hasLikelyCodeCopyControl(current)) {
          return true;
        }

        if (this.hasLikelyCodeCopyControl(current) && !this.extractInlineCodeText(current, new Set([element])).trim()) {
          return true;
        }

        current = current.parentElement;
      }

      return false;
    }

    hasLikelyCodeCopyControl(root) {
      if (!(root instanceof Element)) {
        return false;
      }

      return Array.from(root.querySelectorAll("button")).some((button) => {
        const label = [
          button.textContent,
          button.getAttribute("aria-label"),
          button.getAttribute("title"),
          button.getAttribute("data-testid")
        ].join(" ");

        return /copy/i.test(label);
      });
    }

    getHostCodeHeaderOmitElement(element, host, contentRoot) {
      let omittedElement = element;
      let current = element.parentElement;

      while (current && current !== host) {
        if (contentRoot instanceof Element && current.contains(contentRoot)) {
          break;
        }

        if (current.querySelector("pre, code")) {
          break;
        }

        if (this.extractInlineCodeText(current, new Set([omittedElement])).trim()) {
          break;
        }

        omittedElement = current;
        current = current.parentElement;
      }

      return omittedElement;
    }

    findEmbeddedCodeLanguageHeader(contentRoot) {
      if (!(contentRoot instanceof Element)) {
        return null;
      }

      const element = this.findLeadingEmbeddedCodeLanguageHeaderElement(contentRoot, contentRoot);
      if (!(element instanceof Element)) {
        return null;
      }

      const label = this.normalizeCodeLanguageLabel(element.textContent || "");
      if (!label) {
        return null;
      }

      const omittedElement = this.getEmbeddedCodeHeaderOmitElement(element, contentRoot);
      const remainingText = this.extractStructuredCodeText(contentRoot, new Set([omittedElement])).trim();
      if (!remainingText) {
        return null;
      }

      return { element: omittedElement, label };
    }

    findLeadingEmbeddedCodeLanguageHeaderElement(root, contentRoot) {
      for (const child of root.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if ((child.nodeValue || "").trim()) {
            return null;
          }

          continue;
        }

        if (!(child instanceof Element)) {
          continue;
        }

        if (this.shouldOmitCodeExtractionNode(child)) {
          continue;
        }

        if (this.isEmbeddedCodeLanguageHeaderElement(child, contentRoot)) {
          return child;
        }

        const nested = this.findLeadingEmbeddedCodeLanguageHeaderElement(child, contentRoot);
        if (nested) {
          return nested;
        }

        if (this.hasMeaningfulCodeElementText(child)) {
          return null;
        }
      }

      return null;
    }

    isEmbeddedCodeLanguageHeaderElement(element, contentRoot) {
      if (!(element instanceof Element)) {
        return false;
      }

      const tagName = element.tagName.toLowerCase();
      if (tagName === "pre" || tagName === "code" || element.querySelector("pre, code")) {
        return false;
      }

      if (!this.normalizeCodeLanguageLabel(element.textContent || "")) {
        return false;
      }

      if (
        !this.isStandaloneCodeHeaderElement(element)
        && !this.isInlineLabelInCodeHeaderElement(element, contentRoot)
      ) {
        return false;
      }

      const nextNode = this.findNextMeaningfulCodeNodeAfter(element, contentRoot);
      if (!nextNode) {
        return false;
      }

      if (
        nextNode instanceof Element
        && this.isStandaloneCodeHeaderElement(nextNode)
        && this.normalizeCodeLanguageLabel(nextNode.textContent || "")
      ) {
        return false;
      }

      return true;
    }

    isInlineLabelInCodeHeaderElement(element, contentRoot) {
      const parent = element instanceof Element ? element.parentElement : null;
      if (!(parent instanceof Element) || parent === contentRoot) {
        return false;
      }

      const tagName = parent.tagName.toLowerCase();
      if (tagName === "pre" || tagName === "code" || parent.querySelector("pre, code")) {
        return false;
      }

      return (
        this.isStandaloneCodeHeaderElement(parent)
        && !this.extractInlineCodeText(parent, new Set([element])).trim()
        && Boolean(this.findNextMeaningfulCodeNodeAfter(parent, contentRoot))
      );
    }

    isStandaloneCodeHeaderElement(element) {
      if (!(element instanceof Element) || this.shouldOmitCodeExtractionNode(element)) {
        return false;
      }

      const tagName = element.tagName.toLowerCase();
      if (["div", "header"].includes(tagName)) {
        return true;
      }

      if (!["span", "p"].includes(tagName)) {
        return false;
      }

      const style = getComputedStyle(element);
      return ["block", "flex", "grid", "table", "table-row", "list-item", "inline-block", "inline-flex"].includes(style.display);
    }

    findNextMeaningfulCodeNodeAfter(element, contentRoot) {
      let current = element;

      while (current && current !== contentRoot) {
        let sibling = current.nextSibling;

        while (sibling) {
          if (sibling.nodeType === Node.TEXT_NODE) {
            if ((sibling.nodeValue || "").trim()) {
              return sibling;
            }
          } else if (sibling instanceof Element) {
            if (!this.shouldOmitCodeExtractionNode(sibling) && this.hasMeaningfulCodeElementText(sibling)) {
              return sibling;
            }
          }

          sibling = sibling.nextSibling;
        }

        current = current.parentNode;
      }

      return null;
    }

    hasMeaningfulCodeElementText(element) {
      if (!(element instanceof Element)) {
        return false;
      }

      return Boolean(this.extractInlineCodeText(element).trim());
    }

    getEmbeddedCodeHeaderOmitElement(element, contentRoot) {
      let omittedElement = element;
      let current = element.parentElement;

      while (current && current !== contentRoot) {
        const tagName = current.tagName.toLowerCase();
        if (tagName === "pre" || tagName === "code" || current.querySelector("pre, code")) {
          break;
        }

        if (this.extractInlineCodeText(current, new Set([omittedElement])).trim()) {
          break;
        }

        if (!this.findNextMeaningfulCodeNodeAfter(current, contentRoot)) {
          break;
        }

        omittedElement = current;
        current = current.parentElement;
      }

      return omittedElement;
    }

    extractCodeText(contentRoot, omittedNodes = new Set()) {
      if (!(contentRoot instanceof Element)) {
        return "";
      }

      const structuredText = this.extractStructuredCodeText(contentRoot, omittedNodes);
      if (omittedNodes.size) {
        return structuredText;
      }

      const directSource = contentRoot instanceof HTMLElement ? contentRoot.innerText : "";
      const directText = (directSource || contentRoot.textContent || "")
        .replace(/\r/g, "")
        .replace(/\u00a0/g, " ")
        .replace(/\n$/, "");

      if (structuredText) {
        const directBlankLines = (directText.match(/\n\s*\n/g) || []).length;
        const structuredBlankLines = (structuredText.match(/\n\s*\n/g) || []).length;
        const directIndentedLines = (directText.match(/(^|\n)[ \t]{2,}\S/g) || []).length;
        const structuredIndentedLines = (structuredText.match(/(^|\n)[ \t]{2,}\S/g) || []).length;

        if (
          !directText
          || structuredBlankLines > directBlankLines
          || structuredIndentedLines > directIndentedLines
          || (!directText.includes("\n") && structuredText.includes("\n"))
        ) {
          return structuredText;
        }
      }

      return directText || structuredText;
    }

    removeDuplicatedStructuralCodeLanguageLine(text, language) {
      const label = this.normalizeCodeLanguageLabel(language);
      if (!label || !text) {
        return text || "";
      }

      const normalizedText = String(text).replace(/\r/g, "");
      const firstNewlineIndex = normalizedText.indexOf("\n");
      if (firstNewlineIndex < 0) {
        return normalizedText;
      }

      const firstLine = normalizedText.slice(0, firstNewlineIndex).trim();
      if (firstLine !== label) {
        return normalizedText;
      }

      const remainingText = normalizedText.slice(firstNewlineIndex + 1).replace(/^\n+/, "");
      return remainingText.trim() ? remainingText : normalizedText;
    }

    extractCodeHtml(contentRoot, omittedNodes = new Set()) {
      if (!(contentRoot instanceof Element)) {
        return "";
      }

      const clone = contentRoot.cloneNode(true);
      this.removeOmittedCodeNodesFromClone(contentRoot, clone, omittedNodes);
      const nodes = [clone, ...Array.from(clone.querySelectorAll("*"))];

      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }

        const tagName = node.tagName.toLowerCase();
        if (["button", "textarea", "input", "select", "option", "form", "label", "script", "style", "noscript"].includes(tagName)) {
          if (node !== clone) {
            node.remove();
          }
          continue;
        }

        node.removeAttribute("id");
        node.removeAttribute("style");
        node.removeAttribute("data-testid");
        node.removeAttribute("aria-hidden");
        node.removeAttribute("contenteditable");

        if (!["div", "span", "code", "br", "b", "strong", "i", "em", "u", "s"].includes(tagName)) {
          const replacement = node.ownerDocument.createElement("span");
          replacement.innerHTML = node.innerHTML;
          node.replaceWith(replacement);
        }
      }

      return clone.innerHTML.trim();
    }

    removeOmittedCodeNodesFromClone(sourceRoot, cloneRoot, omittedNodes) {
      if (!(sourceRoot instanceof Element) || !(cloneRoot instanceof Element) || !omittedNodes.size) {
        return;
      }

      for (const omittedNode of omittedNodes) {
        if (!(omittedNode instanceof Node) || omittedNode === sourceRoot || !sourceRoot.contains(omittedNode)) {
          continue;
        }

        const path = this.getChildNodePath(sourceRoot, omittedNode);
        const clonedNode = this.getNodeByChildNodePath(cloneRoot, path);
        if (clonedNode && clonedNode.parentNode) {
          clonedNode.parentNode.removeChild(clonedNode);
        }
      }
    }

    getChildNodePath(root, node) {
      const path = [];
      let current = node;

      while (current && current !== root) {
        const parent = current.parentNode;
        if (!parent) {
          return [];
        }

        path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
        current = parent;
      }

      return current === root ? path : [];
    }

    getNodeByChildNodePath(root, path) {
      let current = root;

      for (const index of path) {
        if (!current || !current.childNodes || index < 0 || index >= current.childNodes.length) {
          return null;
        }

        current = current.childNodes[index];
      }

      return current;
    }

    extractStructuredCodeText(root, omittedNodes = new Set()) {
      if (!(root instanceof Element)) {
        return "";
      }

      const lineBasedText = this.extractLineBasedCodeText(root, omittedNodes);
      if (lineBasedText) {
        return lineBasedText;
      }

      let output = "";

      const appendText = (text) => {
        if (!text) {
          return;
        }

        output += text.replace(/\r/g, "").replace(/\u00a0/g, " ");
      };

      const appendNewline = () => {
        if (!output.endsWith("\n")) {
          output += "\n";
        }
      };

      const isBlockLike = (element) => {
        if (!(element instanceof Element) || element === root) {
          return false;
        }

        const tagName = element.tagName.toLowerCase();
        if (["div", "p", "li", "tr", "table", "section", "article", "header", "footer", "pre"].includes(tagName)) {
          return true;
        }

        const style = getComputedStyle(element);
        return ["block", "flex", "grid", "table", "table-row", "list-item"].includes(style.display);
      };

      const walk = (node) => {
        if (!node) {
          return;
        }

        if (node.nodeType === Node.TEXT_NODE) {
          appendText(node.nodeValue || "");
          return;
        }

        if (!(node instanceof Element)) {
          return;
        }

        if (this.shouldOmitCodeExtractionNode(node, omittedNodes)) {
          return;
        }

        if (node.tagName === "BR") {
          appendNewline();
          return;
        }

        const blockLike = isBlockLike(node);
        if (blockLike && output && !output.endsWith("\n")) {
          appendNewline();
        }

        for (const child of node.childNodes) {
          walk(child);
        }

        if (blockLike && output && !output.endsWith("\n")) {
          appendNewline();
        }
      };

      walk(root);

      return output
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/\n$/, "");
    }

    extractLineBasedCodeText(root, omittedNodes = new Set()) {
      if (!(root instanceof Element)) {
        return "";
      }

      const lineElements = Array.from(root.children).filter((child) => (
        !this.shouldOmitCodeExtractionNode(child, omittedNodes)
        && this.isLikelyCodeLineElement(child)
      ));
      if (lineElements.length < 2) {
        return "";
      }

      const lines = lineElements.map((lineElement) => this.extractInlineCodeText(lineElement, omittedNodes));
      if (!lines.some((line) => line.trim())) {
        return "";
      }

      return lines.join("\n").replace(/\r/g, "").replace(/\u00a0/g, " ").replace(/\n$/, "");
    }

    isLikelyCodeLineElement(element) {
      if (!(element instanceof Element)) {
        return false;
      }

      const tagName = element.tagName.toLowerCase();
      if (["div", "span"].includes(tagName)) {
        const style = getComputedStyle(element);
        return ["block", "flex", "grid", "table-row"].includes(style.display);
      }

      return false;
    }

    shouldOmitCodeExtractionNode(node, omittedNodes = new Set()) {
      if (!(node instanceof Element)) {
        return false;
      }

      return omittedNodes.has(node) || this.isCodeExtractionControlElement(node);
    }

    isCodeExtractionControlElement(element) {
      if (!(element instanceof Element)) {
        return false;
      }

      return ["button", "textarea", "input", "select", "option", "form", "label", "script", "style", "noscript"]
        .includes(element.tagName.toLowerCase());
    }

    extractInlineCodeText(node, omittedNodes = new Set()) {
      if (!node) {
        return "";
      }

      if (node.nodeType === Node.TEXT_NODE) {
        return (node.nodeValue || "").replace(/\u00a0/g, " ");
      }

      if (!(node instanceof Element)) {
        return "";
      }

      if (this.shouldOmitCodeExtractionNode(node, omittedNodes)) {
        return "";
      }

      if (node.tagName === "BR") {
        return "\n";
      }

      let output = "";
      for (const child of node.childNodes) {
        output += this.extractInlineCodeText(child, omittedNodes);
      }
      return output;
    }

    detectCodeLanguage(pre, source, contentRoot = this.getCodeBlockContentRoot(pre), embeddedHeaderLabel = "") {
      if (!(pre instanceof Element)) {
        return "";
      }

      const codeNode = contentRoot && contentRoot.tagName === "CODE"
        ? contentRoot
        : pre.querySelector("code");
      const host = source instanceof Element ? this.findCodeBlockHost(pre, source) : pre;
      const attributeOwner = pre.closest("[data-language], [data-lang], [data-code-language], [data-highlight-language]");
      const classHint = (
        this.extractCodeLanguageFromClass(codeNode)
        || this.extractCodeLanguageFromClass(pre)
        || this.extractCodeLanguageFromClass(host)
      );

      if (classHint) {
        return classHint;
      }

      const attributeHint = this.extractCodeLanguageFromAttributes([codeNode, pre, host, attributeOwner]);
      if (attributeHint) {
        return attributeHint;
      }

      return this.findStructuralCodeLanguageLabel(host, contentRoot || pre) || embeddedHeaderLabel || "";
    }

    extractCodeLanguageFromClass(element) {
      if (!(element instanceof Element)) {
        return "";
      }

      const classMatch = String(element.className || "").match(/(?:^|\s)language-([a-z0-9_+.#-]+)/i);
      return classMatch && classMatch[1] ? classMatch[1] : "";
    }

    extractCodeLanguageFromAttributes(elements) {
      const languageAttributeNames = [
        "data-language",
        "data-lang",
        "data-code-language",
        "data-highlight-language"
      ];

      for (const element of elements) {
        if (!(element instanceof Element)) {
          continue;
        }

        for (const attributeName of languageAttributeNames) {
          const label = this.normalizeCodeLanguageLabel(element.getAttribute(attributeName));
          if (label) {
            return label;
          }
        }
      }

      return "";
    }

    findStructuralCodeLanguageLabel(host, contentRoot) {
      const header = this.findHostCodeLanguageHeader(host, contentRoot);
      return header ? header.label : "";
    }

    normalizeCodeLanguageLabel(value) {
      const label = String(value || "").replace(/\s+/g, " ").trim();

      if (
        !label
        || label.length > 32
        || /copy/i.test(label)
        || !/^[A-Za-z0-9_+.#-]+$/.test(label)
      ) {
        return "";
      }

      return label;
    }

    injectArchivedCodeBlocks(root, sourceCodeBlocks) {
      if (!(root instanceof Element) || !sourceCodeBlocks.length) {
        return;
      }

      const preNodes = Array.from(root.querySelectorAll("pre"));
      let replacementIndex = 0;

      for (const preNode of preNodes) {
        const block = sourceCodeBlocks[replacementIndex];
        if (!block) {
          break;
        }

        const host = this.findCodeBlockHost(preNode, root);
        const replacement = this.createArchivedCodeBlockElement(root.ownerDocument, block);
        host.replaceWith(replacement);
        replacementIndex += 1;
      }
    }

    findCodeBlockHost(preNode, root) {
      let host = preNode;
      let current = preNode.parentElement;
      let depth = 0;
      const contentRoot = this.getCodeBlockContentRoot(preNode);

      while (current && current !== root && depth < 8) {
        if (current.querySelectorAll("pre").length !== 1) {
          break;
        }

        if (depth < 4) {
          host = current;
        }

        if (this.findHostCodeLanguageHeader(current, contentRoot || preNode)) {
          return current;
        }

        current = current.parentElement;
        depth += 1;
      }

      return host;
    }

    createArchivedCodeBlockElement(doc, block) {
      const wrapper = doc.createElement("div");
      wrapper.setAttribute("data-rapid-view-for-chatgpt-code-block", "true");

      const header = doc.createElement("div");
      header.setAttribute("data-rapid-view-for-chatgpt-code-header", "true");

      const language = doc.createElement("span");
      language.setAttribute("data-rapid-view-for-chatgpt-code-language", "true");
      language.textContent = block.language || "Code";

      const copyButton = doc.createElement("button");
      copyButton.type = "button";
      copyButton.setAttribute("data-rapid-view-for-chatgpt-copy-code", "true");
      copyButton.setAttribute("data-rapid-view-for-chatgpt-copy-value", block.text || "");
      copyButton.textContent = "Copy";

      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      code.textContent = block.text || "";
      pre.appendChild(code);

      header.appendChild(language);
      header.appendChild(copyButton);
      wrapper.appendChild(header);
      wrapper.appendChild(pre);
      return wrapper;
    }

    sanitizeRichClone(root, context) {
      const elements = [root, ...Array.from(root.querySelectorAll("*"))];

      for (let index = elements.length - 1; index >= 0; index -= 1) {
        const element = elements[index];
        if (!(element instanceof HTMLElement)) {
          continue;
        }

        const tagName = element.tagName.toLowerCase();

        if (this.shouldSkipArchiveElement(element) || ["button", "textarea", "input", "select", "option", "form", "label", "script", "style", "noscript"].includes(tagName)) {
          if (element !== root) {
            element.remove();
          }
          continue;
        }

        if (["img", "picture", "canvas", "svg", "video", "audio", "iframe", "object", "embed"].includes(tagName)) {
          context.hadRichMedia = true;
          const placeholder = element.ownerDocument.createElement("div");
          placeholder.textContent = "Rich content omitted for performance.";
          placeholder.setAttribute("data-rapid-view-for-chatgpt-rich-placeholder", "true");
          element.replaceWith(placeholder);
          continue;
        }

        for (const attribute of Array.from(element.attributes)) {
          const name = attribute.name.toLowerCase();
          const keepLinkAttribute = tagName === "a" && ["href", "target", "rel"].includes(name);
          const keepTableSpanAttribute = ["colspan", "rowspan"].includes(name);

          if (keepLinkAttribute || keepTableSpanAttribute) {
            continue;
          }

          if (
            name === "id"
            || name === "class"
            || name === "style"
            || name === "role"
            || name === "tabindex"
            || name === "contenteditable"
            || name === "data-testid"
            || name.startsWith("data-")
            || name.startsWith("aria-")
          ) {
            element.removeAttribute(attribute.name);
          }
        }

        if (tagName === "a") {
          const href = this.sanitizeHref(element.getAttribute("href"));
          if (href) {
            element.setAttribute("href", href);
            element.setAttribute("target", "_blank");
            element.setAttribute("rel", "noopener noreferrer");
          } else {
            element.removeAttribute("href");
          }
        }
      }
    }

    pruneRichCloneLayout(root) {
      if (!(root instanceof Element)) {
        return;
      }

      const transparentTags = new Set(["div", "span", "section", "article"]);
      const elements = Array.from(root.querySelectorAll("*")).reverse();

      for (const element of elements) {
        if (!(element instanceof HTMLElement)) {
          continue;
        }

        const tagName = element.tagName.toLowerCase();
        if (!transparentTags.has(tagName)) {
          continue;
        }

        const ownText = Array.from(element.childNodes).some((node) => (
          node.nodeType === Node.TEXT_NODE
          && Boolean((node.textContent || "").trim())
        ));
        const hasAttributes = element.attributes.length > 0;

        if (!ownText && !element.childElementCount) {
          element.remove();
          continue;
        }

        if (!ownText && element.childElementCount === 1 && !hasAttributes) {
          const fragment = element.ownerDocument.createDocumentFragment();
          while (element.firstChild) {
            fragment.appendChild(element.firstChild);
          }
          element.replaceWith(fragment);
        }
      }
    }

    describeElement(node) {
      if (!(node instanceof Element)) {
        return "<non-element>";
      }

      const parts = [node.tagName.toLowerCase()];
      if (node.id) {
        parts.push(`#${node.id}`);
      }

      const testId = node.getAttribute("data-testid");
      if (testId) {
        parts.push(`[data-testid="${testId}"]`);
      }

      const turnRole = node.getAttribute("data-turn");
      if (turnRole) {
        parts.push(`[data-turn="${turnRole}"]`);
      }

      const role = node.getAttribute("role");
      if (role) {
        parts.push(`[role="${role}"]`);
      }

      const classList = Array.from(node.classList || []).slice(0, 3);
      if (classList.length) {
        parts.push(`.${classList.join(".")}`);
      }

      return parts.join("");
    }

    getSnapshotSourceSelectors(role, mode = "simple") {
      void mode;

      if (role === "assistant") {
        return [
          ".markdown-new-styling",
          ".markdown.prose",
          "[data-message-author-role='assistant'] [dir='auto']",
          ".agent-turn [dir='auto']",
          "[data-message-author-role='assistant']",
          ".agent-turn",
          "[dir='auto']"
        ];
      }

      return [
        ".whitespace-pre-wrap",
        "[data-message-author-role='user'] [dir='auto']",
        "[dir='auto']",
        "[data-message-author-role='user']"
      ];
    }

    collectSnapshotSourceCandidates(turnNode, role, mode = "simple") {
      const selectors = this.getSnapshotSourceSelectors(role, mode);
      const candidates = [];
      const seen = new Set();

      const pushCandidate = (candidate) => {
        if (!(candidate instanceof Element)) {
          return;
        }

        if (candidate !== turnNode && !turnNode.contains(candidate)) {
          return;
        }

        if (seen.has(candidate)) {
          return;
        }

        seen.add(candidate);
        candidates.push(candidate);
      };

      for (const selector of selectors) {
        if (turnNode.matches(selector)) {
          pushCandidate(turnNode);
        }

        for (const candidate of turnNode.querySelectorAll(selector)) {
          pushCandidate(candidate);
        }
      }

      pushCandidate(turnNode);
      return candidates;
    }

    hasMeaningfulSourceContent(source) {
      if (!(source instanceof Element)) {
        return false;
      }

      if (this.extractPlainText(source).trim()) {
        return true;
      }

      return Boolean(
        source.querySelector("pre, table, math, .katex, .katex-display, mjx-container, .MathJax, img, picture, canvas, svg, video, audio, iframe, object, embed, hr")
      );
    }

    selectSnapshotSource(turnNode, role) {
      for (const candidate of this.collectSnapshotSourceCandidates(turnNode, role, "simple")) {
        if (this.hasMeaningfulSourceContent(candidate)) {
          return candidate;
        }
      }

      return turnNode;
    }

    selectRichSnapshotSource(turnNode, role) {
      return this.collectSnapshotSourceCandidates(turnNode, role, "rich")[0] || this.selectSnapshotSource(turnNode, role);
    }

    getMeaningfulRenderedText(root) {
      if (!(root instanceof Element)) {
        return "";
      }

      const clone = root.cloneNode(true);
      const removalSelectors = [
        "[data-rapid-view-for-chatgpt-code-header]",
        "[data-rapid-view-for-chatgpt-copy-code]",
        "button",
        "textarea",
        "input",
        "select",
        "option",
        "form",
        "label",
        "script",
        "style",
        "noscript"
      ];

      for (const selector of removalSelectors) {
        for (const node of clone.querySelectorAll(selector)) {
          node.remove();
        }
      }

      return (clone.textContent || "")
        .replace(/\r/g, "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    hasMeaningfulRenderedContent(root) {
      if (!(root instanceof Element)) {
        return false;
      }

      if (this.getMeaningfulRenderedText(root)) {
        return true;
      }

      return Boolean(
        root.querySelector("pre, table, [data-rapid-view-for-chatgpt-code-block], [data-rapid-view-for-chatgpt-latex], [data-rapid-view-for-chatgpt-rich-placeholder], img, picture, canvas, svg, video, audio, iframe, object, embed, hr")
      );
    }

    hasMeaningfulArchiveHtml(html) {
      if (!html || !html.trim()) {
        return false;
      }

      if (this.isArchiveFallbackHtml(html)) {
        return false;
      }

      const container = document.createElement("div");
      container.innerHTML = html.trim();
      return this.hasMeaningfulRenderedContent(container);
    }

    serializeSnapshotNode(node, context) {
      if (!node) {
        return "";
      }

      if (node.nodeType === Node.TEXT_NODE) {
        return this.escapeHtml(node.textContent || "");
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return "";
      }

      const element = node;
      const tagName = element.tagName.toLowerCase();

      if (this.isMathElement(element)) {
        const latexSource = this.extractLatexSource(element);
        if (latexSource) {
          const mathTag = this.isDisplayMathElement(element) ? "div" : "code";
          return `<${mathTag} data-rapid-view-for-chatgpt-latex="true">${this.escapeHtml(latexSource)}</${mathTag}>`;
        }
      }

      if (this.shouldSkipArchiveElement(element)) {
        return "";
      }

      if (["img", "picture", "canvas", "svg", "video", "audio", "iframe", "object", "embed"].includes(tagName)) {
        context.hadRichMedia = true;
        return "<div>Rich content omitted for performance.</div>";
      }

      if (["button", "textarea", "input", "select", "option", "form", "label", "script", "style", "noscript"].includes(tagName)) {
        return "";
      }

      if (tagName === "br") {
        return "<br>";
      }

      if (tagName === "hr") {
        return "<hr>";
      }

      if (tagName === "pre") {
        const codeText = element.innerText || element.textContent || "";
        return `<pre><code>${this.escapeHtml(codeText)}</code></pre>`;
      }

      if (tagName === "code") {
        return `<code>${this.escapeHtml(element.textContent || "")}</code>`;
      }

      if (tagName === "table") {
        return this.buildScrollableTableHtml(
          element,
          (cell) => {
            const html = Array.from(cell.childNodes)
              .map((child) => this.serializeSnapshotNode(child, context))
              .join("")
              .trim();
            return html || this.escapeHtml(cell.textContent || "");
          }
        );
      }

      const childHtml = Array.from(element.childNodes)
        .map((child) => this.serializeSnapshotNode(child, context))
        .join("");

      if (tagName === "a") {
        const href = this.sanitizeHref(element.getAttribute("href"));
        const safeHref = href ? ` href="${this.escapeAttribute(href)}"` : "";
        return `<a${safeHref} target="_blank" rel="noopener noreferrer">${childHtml || this.escapeHtml(element.textContent || href || "")}</a>`;
      }

      const allowedTags = new Set([
        "p", "div", "span", "strong", "em", "b", "i", "u",
        "ul", "ol", "li", "blockquote",
        "h1", "h2", "h3", "h4", "h5", "h6",
        "table", "thead", "tbody", "tr", "th", "td",
        "section", "sub", "sup"
      ]);

      if (allowedTags.has(tagName)) {
        if (!childHtml.trim() && !["div", "span"].includes(tagName)) {
          const fallbackText = this.escapeHtml(element.textContent || "");
          return fallbackText ? `<${tagName}>${fallbackText}</${tagName}>` : "";
        }

        return `<${tagName}>${childHtml}</${tagName}>`;
      }

      return childHtml;
    }

    serializeRichTableCellContent(cell, context) {
      if (!(cell instanceof Element)) {
        return "";
      }

      const html = Array.from(cell.childNodes)
        .map((child) => this.serializeRichTableCellNode(child, context))
        .join("")
        .trim();

      return html || this.escapeHtml(cell.textContent || "");
    }

    serializeRichTableCellNode(node, context) {
      if (!node) {
        return "";
      }

      if (node.nodeType === Node.TEXT_NODE) {
        return this.escapeHtml(node.textContent || "");
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return "";
      }

      const element = node;
      const tagName = element.tagName.toLowerCase();

      if (element.hasAttribute("data-rapid-view-for-chatgpt-code-block")) {
        return element.outerHTML;
      }

      if (this.isMathElement(element)) {
        const latexSource = this.extractLatexSource(element);
        if (latexSource) {
          const mathTag = this.isDisplayMathElement(element) ? "div" : "code";
          return `<${mathTag} data-rapid-view-for-chatgpt-latex="true">${this.escapeHtml(latexSource)}</${mathTag}>`;
        }
      }

      if (this.shouldSkipArchiveElement(element)) {
        return "";
      }

      if (["img", "picture", "canvas", "svg", "video", "audio", "iframe", "object", "embed"].includes(tagName)) {
        context.hadRichMedia = true;
        return '<div data-rapid-view-for-chatgpt-rich-placeholder="true">Rich content omitted for performance.</div>';
      }

      if (["button", "textarea", "input", "select", "option", "form", "label", "script", "style", "noscript"].includes(tagName)) {
        return "";
      }

      if (tagName === "br") {
        return "<br>";
      }

      if (tagName === "hr") {
        return "<hr>";
      }

      if (tagName === "table") {
        return this.buildScrollableTableHtml(
          element,
          (nestedCell) => this.serializeRichTableCellContent(nestedCell, context)
        );
      }

      const childHtml = Array.from(element.childNodes)
        .map((child) => this.serializeRichTableCellNode(child, context))
        .join("");

      if (tagName === "a") {
        const href = this.sanitizeHref(element.getAttribute("href"));
        const safeHref = href ? ` href="${this.escapeAttribute(href)}"` : "";
        return `<a${safeHref} target="_blank" rel="noopener noreferrer">${childHtml || this.escapeHtml(element.textContent || href || "")}</a>`;
      }

      const passthroughAttributes = [];
      if (element.hasAttribute("data-rapid-view-for-chatgpt-latex")) {
        passthroughAttributes.push(' data-rapid-view-for-chatgpt-latex="true"');
      }
      if (element.hasAttribute("data-rapid-view-for-chatgpt-rich-placeholder")) {
        passthroughAttributes.push(' data-rapid-view-for-chatgpt-rich-placeholder="true"');
      }

      const allowedTags = new Set([
        "p", "div", "span", "strong", "em", "b", "i", "u", "s",
        "ul", "ol", "li", "blockquote",
        "h1", "h2", "h3", "h4", "h5", "h6",
        "section", "sub", "sup", "pre", "code"
      ]);

      if (allowedTags.has(tagName)) {
        if (!childHtml.trim() && !["div", "span"].includes(tagName)) {
          const fallbackText = this.escapeHtml(element.textContent || "");
          return fallbackText ? `<${tagName}${passthroughAttributes.join("")}>${fallbackText}</${tagName}>` : "";
        }

        return `<${tagName}${passthroughAttributes.join("")}>${childHtml}</${tagName}>`;
      }

      return childHtml;
    }

    buildScrollableTableHtml(table, getCellHtml) {
      if (!(table instanceof Element)) {
        return "";
      }

      const resolveCellHtml = (cell) => {
        const contentHtml = typeof getCellHtml === "function"
          ? getCellHtml(cell)
          : (cell.innerHTML.trim() || this.escapeHtml(cell.textContent || ""));
        return contentHtml && contentHtml.trim()
          ? contentHtml
          : this.escapeHtml(cell.textContent || "");
      };

      const buildRowHtml = (row, fallbackSectionTagName = "tbody") => {
        const cellElements = row instanceof HTMLTableRowElement
          ? Array.from(row.cells)
          : Array.from(row.children).filter((cell) => cell instanceof Element && ["th", "td"].includes(cell.tagName.toLowerCase()));

        if (!cellElements.length) {
          return "";
        }

        const sectionTagName = row.parentElement instanceof Element
          ? row.parentElement.tagName.toLowerCase()
          : fallbackSectionTagName;

        const cellsHtml = cellElements
          .map((cell) => {
            const cellTagName = cell.tagName.toLowerCase() === "th" || sectionTagName === "thead" ? "th" : "td";
            const headerAttr = cellTagName === "th" ? ' data-rapid-view-for-chatgpt-table-header="true"' : "";
            const colSpan = Math.max(1, Number(cell.getAttribute("colspan")) || cell.colSpan || 1);
            const rowSpan = Math.max(1, Number(cell.getAttribute("rowspan")) || cell.rowSpan || 1);
            const colSpanAttr = colSpan > 1 ? ` colspan="${colSpan}"` : "";
            const rowSpanAttr = rowSpan > 1 ? ` rowspan="${rowSpan}"` : "";
            return `<${cellTagName}${headerAttr}${colSpanAttr}${rowSpanAttr}><div data-rapid-view-for-chatgpt-table-cell-content="true">${resolveCellHtml(cell)}</div></${cellTagName}>`;
          })
          .join("");

        return cellsHtml ? `<tr>${cellsHtml}</tr>` : "";
      };

      const tableSections = [];

      if (table instanceof HTMLTableElement) {
        if (table.tHead && table.tHead.rows.length) {
          const headRowsHtml = Array.from(table.tHead.rows)
            .map((row) => buildRowHtml(row, "thead"))
            .filter(Boolean)
            .join("");
          if (headRowsHtml) {
            tableSections.push(`<thead>${headRowsHtml}</thead>`);
          }
        }

        for (const section of Array.from(table.tBodies)) {
          const bodyRowsHtml = Array.from(section.rows)
            .map((row) => buildRowHtml(row, "tbody"))
            .filter(Boolean)
            .join("");
          if (bodyRowsHtml) {
            tableSections.push(`<tbody>${bodyRowsHtml}</tbody>`);
          }
        }

        if (table.tFoot && table.tFoot.rows.length) {
          const footRowsHtml = Array.from(table.tFoot.rows)
            .map((row) => buildRowHtml(row, "tfoot"))
            .filter(Boolean)
            .join("");
          if (footRowsHtml) {
            tableSections.push(`<tfoot>${footRowsHtml}</tfoot>`);
          }
        }

        const directRows = Array.from(table.children).filter((child) => child instanceof HTMLTableRowElement);
        if (directRows.length) {
          const directRowsHtml = directRows
            .map((row) => buildRowHtml(row, "tbody"))
            .filter(Boolean)
            .join("");
          if (directRowsHtml) {
            tableSections.push(`<tbody>${directRowsHtml}</tbody>`);
          }
        }
      }

      if (!tableSections.length) {
        const fallbackRowsHtml = Array.from(table.querySelectorAll("tr"))
          .map((row) => buildRowHtml(row, "tbody"))
          .filter(Boolean)
          .join("");
        if (fallbackRowsHtml) {
          tableSections.push(`<tbody>${fallbackRowsHtml}</tbody>`);
        }
      }

      const tableInnerHtml = tableSections.join("");
      return tableInnerHtml
        ? `<div data-rapid-view-for-chatgpt-table-shell="true"><div data-rapid-view-for-chatgpt-table-scroll="true"><div data-rapid-view-for-chatgpt-table-track="true"><table data-rapid-view-for-chatgpt-table="true">${tableInnerHtml}</table><div data-rapid-view-for-chatgpt-table-end-gutter="true" aria-hidden="true"></div></div></div></div>`
        : "";
    }

    replaceScrollableTablesInElement(root) {
      if (!(root instanceof Element)) {
        return;
      }

      const tables = Array.from(root.querySelectorAll("table")).reverse();
      for (const table of tables) {
        if (!(table instanceof HTMLTableElement)) {
          continue;
        }

        const replacementHtml = this.buildScrollableTableHtml(
          table,
          (cell) => this.serializeRichTableCellContent(cell, { hadRichMedia: false })
        );

        if (!replacementHtml) {
          continue;
        }

        const container = table.ownerDocument.createElement("div");
        container.innerHTML = replacementHtml;
        const replacement = container.firstElementChild;
        if (replacement) {
          table.replaceWith(replacement);
        }
      }
    }

    shouldSkipArchiveElement(element) {
      if (!(element instanceof HTMLElement)) {
        return true;
      }

      if ((element.hidden || element.getAttribute("aria-hidden") === "true") && !this.isRenderedMathElement(element)) {
        return true;
      }

      if (element.id === "thread-bottom-container" || element.hasAttribute("data-edge")) {
        return true;
      }

      if (element.classList.contains("sr-only")) {
        return true;
      }

      return element.hasAttribute("data-rapid-view-for-chatgpt-archive-host")
        || element.hasAttribute("data-rapid-view-for-chatgpt-archive-block");
    }

    isRenderedMathElement(element) {
      if (!(element instanceof Element)) {
        return false;
      }

      if (this.isMathElement(element)) {
        return true;
      }

      return Boolean(
        element.closest(".katex, .katex-display, mjx-container, .MathJax")
        || element.querySelector(".katex, .katex-display, mjx-container, .MathJax")
      );
    }

    isMathElement(element) {
      if (!(element instanceof Element)) {
        return false;
      }

      const tagName = element.tagName.toLowerCase();
      return tagName === "math"
        || tagName === "annotation"
        || element.matches(".katex, .katex-display, mjx-container, .MathJax, [data-latex]");
    }

    isDisplayMathElement(element) {
      if (!(element instanceof Element)) {
        return false;
      }

      return element.matches(".katex-display, mjx-container[display='true'], [data-display='true']");
    }

    extractLatexSource(element) {
      if (!(element instanceof Element)) {
        return "";
      }

      const annotation = element.matches("annotation")
        ? element
        : element.querySelector("annotation[encoding*='tex']");
      const annotationText = annotation ? (annotation.textContent || "").trim() : "";
      if (annotationText) {
        return annotationText;
      }

      const directHints = [
        element.getAttribute("aria-label"),
        element.getAttribute("alttext"),
        element.getAttribute("data-latex")
      ];

      for (const hint of directHints) {
        if (hint && hint.trim()) {
          return hint.trim();
        }
      }

      const fallbackText = (element.textContent || "").replace(/\s+/g, " ").trim();
      return fallbackText;
    }

    sanitizeHref(href) {
      if (!href) {
        return "";
      }

      const trimmed = href.trim();
      if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("/") || trimmed.startsWith("#")) {
        return trimmed;
      }

      return "";
    }

    extractPlainText(node) {
      if (!node) {
        return "";
      }

      const blockTags = new Set([
        "p", "div", "section", "article", "blockquote",
        "ul", "ol", "li",
        "h1", "h2", "h3", "h4", "h5", "h6",
        "pre", "table", "thead", "tbody", "tr"
      ]);

      const visitNode = (currentNode) => {
        if (!currentNode) {
          return "";
        }

        if (currentNode.nodeType === Node.TEXT_NODE) {
          return currentNode.textContent || "";
        }

        if (currentNode.nodeType !== Node.ELEMENT_NODE) {
          return "";
        }

        const element = currentNode;
        const tagName = element.tagName.toLowerCase();

        if (this.isMathElement(element)) {
          const latexSource = this.extractLatexSource(element);
          if (latexSource) {
            return this.isDisplayMathElement(element) ? `\n${latexSource}\n` : latexSource;
          }
        }

        if (this.shouldSkipArchiveElement(element)) {
          return "";
        }

        if (tagName === "br") {
          return "\n";
        }

        if (tagName === "hr") {
          return "\n---\n";
        }

        let text = "";

        if (blockTags.has(tagName)) {
          text += "\n";
        }

        for (const child of element.childNodes) {
          text += visitNode(child);
        }

        if (blockTags.has(tagName)) {
          text += "\n";
        }

        return text;
      };

      return visitNode(node)
        .replace(/\r/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
    }

    renderPlainTextHtml(text) {
      if (!text) {
        return "<p>Archived content unavailable.</p>";
      }

      return text
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${this.escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
        .join("");
    }

    renderFastPreviewHtml(text) {
      if (!text) {
        return "<p>Archived content unavailable.</p>";
      }

      return `<div data-rapid-view-for-chatgpt-plain-preview="true">${this.escapeHtml(text)}</div>`;
    }

    getCollapsedSimplePreview(record) {
      const text = record && record.plainTextFallback ? record.plainTextFallback : "";
      if (!text) {
        return {
          text: "",
          truncated: false
        };
      }

      let previewEnd = Math.min(text.length, LIMITS.simplePreviewMaxChars);
      let lineCount = 0;

      for (let index = 0; index < text.length; index += 1) {
        if (index >= LIMITS.simplePreviewMaxChars) {
          previewEnd = LIMITS.simplePreviewMaxChars;
          break;
        }

        if (text[index] === "\n") {
          lineCount += 1;
          if (lineCount >= LIMITS.simplePreviewMaxLines) {
            previewEnd = index;
            break;
          }
        }
      }

      let previewText = text.slice(0, previewEnd);
      const truncated = previewEnd < text.length;

      if (truncated) {
        previewText = `${previewText.trimEnd()}\n\n...`;
      }

      return {
        text: previewText,
        truncated
      };
    }

    getSimplePreviewText(record) {
      const text = record && record.plainTextFallback ? record.plainTextFallback : "";
      if (!text) {
        return {
          text: "",
          truncated: false
        };
      }

      if (record.simpleExpanded) {
        return {
          text,
          truncated: false
        };
      }

      return this.getCollapsedSimplePreview(record);
    }

    escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;");
    }

    escapeAttribute(value) {
      return this.escapeHtml(value).replace(/'/g, "&#39;");
    }

    ensureArchiveUi() {
      if (!this.root) {
        return null;
      }

      if (!this.archiveUi) {
        const host = document.createElement("div");
        const restoreBar = document.createElement("div");
        const counter = document.createElement("div");
        const timeline = document.createElement("div");
        const timelineTrack = document.createElement("div");
        const timelineTooltip = document.createElement("div");
        const actions = document.createElement("div");
        const archiveActionRow = document.createElement("div");
        const archiveActionLeftCluster = document.createElement("div");
        const archiveActionRightCluster = document.createElement("div");
        const loadMoreButton = document.createElement("button");
        const collapseAllDot = document.createElement("button");
        const loadAllDot = document.createElement("button");
        const allSimpleDot = document.createElement("button");
        const allRenderedDot = document.createElement("button");
        const list = document.createElement("div");
        const topSpacer = document.createElement("div");
        const bottomSpacer = document.createElement("div");

        host.setAttribute("data-rapid-view-for-chatgpt-archive-host", "true");
        Object.assign(host.style, {
          display: "flex",
          flexDirection: "column",
          gap: "0",
          margin: "0 auto 20px",
          width: "100%",
          maxWidth: "100%",
          minWidth: "0"
        });

        restoreBar.setAttribute("data-rapid-view-for-chatgpt-restore", "true");
        Object.assign(restoreBar.style, {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          padding: "12px 16px",
          margin: "8px auto 0",
          border: "1px solid rgba(92, 110, 143, 0.24)",
          borderRadius: "16px",
          background: "linear-gradient(180deg, rgba(229, 235, 247, 0.98), rgba(214, 223, 239, 0.96))",
          color: "#24364d",
          boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.54), inset 0 -1px 0 rgba(109, 128, 160, 0.08), 0 10px 24px rgba(34, 53, 84, 0.08)",
          maxWidth: "760px",
          width: "min(100%, 760px)"
        });

        Object.assign(counter.style, {
          font: "13px/1.35 'Segoe UI', sans-serif",
          color: "#4d6386"
        });

        timeline.setAttribute("data-rapid-view-for-chatgpt-dynamic-timeline", "true");
        Object.assign(timeline.style, {
          display: "none",
          position: "relative",
          width: "100%"
        });

        Object.assign(timelineTrack.style, {
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          width: "100%"
        });

        Object.assign(timelineTooltip.style, {
          position: "absolute",
          left: "0",
          top: "0",
          maxWidth: "260px",
          padding: "8px 10px",
          borderRadius: "12px",
          border: "1px solid rgba(96, 114, 150, 0.28)",
          background: "linear-gradient(180deg, rgba(238, 243, 250, 0.99), rgba(221, 230, 243, 0.98))",
          color: "#263b54",
          font: "12px/1.45 'Segoe UI', sans-serif",
          boxShadow: "0 12px 28px rgba(43, 60, 92, 0.16)",
          pointerEvents: "none",
          opacity: "0",
          visibility: "hidden",
          transform: "translate(-50%, calc(-100% - 10px))",
          transition: "opacity 120ms ease",
          zIndex: "3"
        });

        Object.assign(actions.style, {
          display: "flex",
          gap: "8px",
          flexWrap: "wrap"
        });

        archiveActionRow.setAttribute("data-rapid-view-for-chatgpt-archive-actions", "true");
        Object.assign(archiveActionRow.style, {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "140px",
          margin: "-4px auto 0",
          padding: "0 24px",
          maxWidth: "760px",
          width: "min(100%, 760px)",
          boxSizing: "border-box"
        });

        for (const cluster of [archiveActionLeftCluster, archiveActionRightCluster]) {
          Object.assign(cluster.style, {
            display: "flex",
            alignItems: "center",
            gap: "18px"
          });
        }

        for (const button of [loadMoreButton]) {
          button.type = "button";
          Object.assign(button.style, {
            border: "1px solid rgba(58, 97, 170, 0.24)",
            borderRadius: "999px",
            padding: "8px 12px",
            cursor: "pointer",
            font: "600 12px/1 'Segoe UI', sans-serif",
            boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.16), 0 8px 18px rgba(38, 82, 162, 0.18)"
          });
        }

        loadMoreButton.style.background = "linear-gradient(180deg, rgba(79, 134, 241, 0.98), rgba(39, 92, 202, 0.96))";
        loadMoreButton.style.color = "#f7fbff";
        loadMoreButton.addEventListener("click", this.handleLoadMoreClick);

        const archiveActionDots = [
          [collapseAllDot, "Collapse all", () => this.collapseVisibleArchived()],
          [loadAllDot, "Load all", () => this.loadAllArchived()],
          [allSimpleDot, "All simple", () => this.setVisibleArchiveViewMode("simple")],
          [allRenderedDot, "All rendered", () => this.setVisibleArchiveViewMode("rich")]
        ];

        for (const [button, label, onClick] of archiveActionDots) {
          button.type = "button";
          button.title = label;
          button.setAttribute("aria-label", label);
          Object.assign(button.style, {
            width: "16px",
            height: "16px",
            padding: "0",
            border: "1px solid rgba(122, 142, 179, 0.46)",
            borderRadius: "50%",
            background: "radial-gradient(circle at 35% 35%, rgba(250, 252, 255, 0.98), rgba(210, 221, 239, 0.96) 42%, rgba(132, 149, 180, 0.94) 72%, rgba(89, 103, 129, 0.96))",
            cursor: "pointer",
            transition: "transform 140ms ease, border-color 140ms ease"
          });
          button.addEventListener("mouseenter", () => {
            button.style.transform = "translateY(-1px) scale(1.05)";
            button.style.borderColor = "rgba(78, 132, 229, 0.72)";
          });
          button.addEventListener("mouseleave", () => {
            button.style.transform = "";
            button.style.borderColor = "rgba(122, 142, 179, 0.46)";
          });
          button.addEventListener("mousedown", () => {
            button.style.transform = "translateY(0) scale(0.98)";
          });
          button.addEventListener("mouseup", () => {
            button.style.transform = "translateY(-1px) scale(1.05)";
          });
          button.addEventListener("click", onClick);
        }

        Object.assign(list.style, {
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          marginTop: "12px",
          width: "100%",
          maxWidth: "100%",
          minWidth: "0"
        });

        for (const spacer of [topSpacer, bottomSpacer]) {
          spacer.setAttribute("aria-hidden", "true");
          Object.assign(spacer.style, {
            width: "100%",
            height: "0px",
            flex: "0 0 auto",
            pointerEvents: "none"
          });
        }

        actions.appendChild(loadMoreButton);
        archiveActionLeftCluster.appendChild(collapseAllDot);
        archiveActionLeftCluster.appendChild(loadAllDot);
        archiveActionRightCluster.appendChild(allSimpleDot);
        archiveActionRightCluster.appendChild(allRenderedDot);
        archiveActionRow.appendChild(archiveActionLeftCluster);
        archiveActionRow.appendChild(archiveActionRightCluster);
        restoreBar.appendChild(counter);
        timeline.appendChild(timelineTrack);
        timeline.appendChild(timelineTooltip);
        restoreBar.appendChild(timeline);
        restoreBar.appendChild(actions);
        host.appendChild(restoreBar);
        host.appendChild(list);
        host.appendChild(archiveActionRow);

        this.archiveUi = {
          host,
          restoreBar,
          counter,
          timeline,
          timelineTrack,
          timelineTooltip,
          actions,
          archiveActionRow,
          collapseAllDot,
          loadAllDot,
          allSimpleDot,
          allRenderedDot,
          loadMoreButton,
          list,
          topSpacer,
          bottomSpacer
        };
      }

      return this.archiveUi;
    }

    syncArchiveUi() {
      if (!this.root) {
        return;
      }

      const startedAt = performance.now();

      if (this.settings.dynamicScroll) {
        this.syncDynamicArchiveUi(startedAt);
        return;
      }

      this.syncManualArchiveEntries();
      this.hiddenCount = this.countHiddenRecords();
      this.dynamicVisibleCount = 0;
      const visibleArchiveRecords = this.getVisibleManualArchiveEntries();
      this.hiddenCount = this.countHiddenRecords();
      const pendingManualArchiveCount = this.countPendingManualArchiveRecords();
      const preserveManualArchiveState = this.hasManualArchiveStateToPreserve();

      if (
        !this.hiddenCount
        && !visibleArchiveRecords.length
        && !pendingManualArchiveCount
        && !preserveManualArchiveState
      ) {
        this.removeArchiveUi();
        return;
      }

      const archiveUi = this.ensureArchiveUi();
      archiveUi.host.style.minHeight = "";
      archiveUi.list.style.alignItems = "";
      archiveUi.list.style.justifyContent = "";
      archiveUi.list.style.minHeight = "";
      archiveUi.list.style.gap = "12px";
      const renderState = this.getArchiveRenderState(visibleArchiveRecords);
      const archiveBlocks = renderState.records
        .map((record) => this.createArchiveBlock(record))
        .filter((block) => block instanceof HTMLElement);
      this.updateArchiveUiChrome(archiveUi, archiveBlocks.length);
      archiveUi.topSpacer.style.height = `${Math.max(0, Math.round(renderState.topHeight))}px`;
      archiveUi.bottomSpacer.style.height = `${Math.max(0, Math.round(renderState.bottomHeight))}px`;
      archiveUi.list.replaceChildren(archiveUi.topSpacer, ...archiveBlocks, archiveUi.bottomSpacer);

      this.mountArchiveUiHost(archiveUi);

      for (const record of renderState.records) {
        if (record.archiveBlock instanceof HTMLElement && record.archiveBlock.isConnected) {
          record.estimatedHeight = Math.max(record.estimatedHeight || 0, this.measureNode(record.archiveBlock));
        }
      }

      this.logger.info("sync-archive-ui", {
        durationMs: this.getDurationMs(startedAt),
        visibleArchiveCount: visibleArchiveRecords.length,
        renderedArchiveCount: archiveBlocks.length,
        hiddenCount: this.hiddenCount,
        pendingManualArchiveCount
      });
    }

    syncDynamicArchiveUi(startedAt) {
      this.ensureDynamicTrackGeometry();
      const trackEntries = this.getDynamicTrackRecords();
      if (!trackEntries.length) {
        this.dynamicSliceCount = 0;
        this.dynamicVisibleCount = 0;
        this.removeArchiveUi();
        this.updateDynamicScrollBinding();
        return;
      }

      const archiveUi = this.ensureArchiveUi();
      const renderState = this.buildDynamicSliceRenderState(trackEntries);
      const sliceKey = `slice-${renderState.windowStartSlice}`;
      this.dynamicScrollFocusId = sliceKey;
      this.dynamicScrollActiveId = sliceKey;
      this.dynamicScrollTargetId = "";
      this.dynamicSliceCount = renderState.sliceCount;

      for (const entry of renderState.visibleEntries) {
        this.ensureDynamicRenderableRecord(entry.record);
      }

      this.virtualizeDynamicTrackNodes();
      this.hiddenCount = 0;
      this.dynamicVisibleCount = renderState.visibleEntries.length;
      this.updateArchiveUiChrome(archiveUi, trackEntries.length);
      archiveUi.host.style.minHeight = `${Math.max(420, Math.round(renderState.windowHeight + 120))}px`;
      archiveUi.list.style.gap = "0px";
      archiveUi.list.style.alignItems = "center";
      archiveUi.list.style.justifyContent = "center";
      archiveUi.list.style.minHeight = `${Math.max(420, Math.round(renderState.windowHeight + 24))}px`;
      archiveUi.topSpacer.style.height = "0px";
      archiveUi.bottomSpacer.style.height = "0px";
      archiveUi.list.replaceChildren(this.createDynamicSliceWindow(renderState));

      this.mountArchiveUiHost(archiveUi);
      this.renderDynamicTimeline(archiveUi, trackEntries, renderState);
      this.updateDynamicScrollBinding();

      for (const entry of renderState.visibleEntries) {
        if (!entry.record.richHtml && !entry.record.richRequestPending) {
          this.requestRichSnapshot(entry.record);
        }
      }

      if (renderState.visibleEntries.some((entry) => entry.record.snapshotState === "pending")) {
        this.scheduleDeferredSnapshotWork();
      }

      this.logger.info("sync-dynamic-archive-ui", {
        durationMs: this.getDurationMs(startedAt),
        indexedCount: trackEntries.length,
        currentSliceIndex: renderState.currentSliceIndex,
        sliceCount: renderState.sliceCount,
        sliceHeight: Math.round(renderState.sliceHeight),
        totalTrackHeight: Math.round(renderState.totalHeight),
        contentTrackHeight: Math.round(renderState.contentHeight),
        visibleRecordCount: renderState.visibleEntries.length,
        hiddenCount: this.hiddenCount,
        windowStartSlice: renderState.windowStartSlice,
        windowEndSlice: renderState.windowEndSlice,
        windowStartY: Math.round(renderState.windowStartY),
        windowEndY: Math.round(renderState.windowEndY)
      });
    }

    getDynamicTrackRecords() {
      const entries = [];

      for (const record of this.records) {
        if (record.state === "live") {
          continue;
        }

        const height = this.getDynamicRecordHeight(record);
        const top = Math.max(0, Number(record.dynamicTrackTopPx) || 0);
        entries.push({
          record,
          top,
          height,
          bottom: top + height
        });
      }

      return entries;
    }

    getDynamicRecordHeight(record) {
      if (!record) {
        return LIMITS.dynamicScrollSlotHeightPx;
      }

      const dynamicTrackHeight = Number(record.dynamicTrackHeightPx) || 0;
      const trackHeight = Number(record.trackHeightPx) || 0;
      const measuredHeight = Number(record.estimatedHeight) || 0;
      const fallbackHeight = Number(record.dynamicBaseHeight) || 0;
      return Math.max(
        1,
        dynamicTrackHeight || trackHeight || measuredHeight || fallbackHeight || LIMITS.dynamicScrollSlotHeightPx
      );
    }

    getDynamicRecordRenderHtml(record) {
      if (!record) {
        return "<p>Preparing archived message...</p>";
      }

      if (record.richHtml) {
        return record.richHtml;
      }

      if (record.snapshotHtml) {
        return record.snapshotHtml;
      }

      if (record.plainTextFallback) {
        return this.renderPlainTextHtml(record.plainTextFallback);
      }

      return "<p>Preparing archived message...</p>";
    }

    ensureDynamicTrackGeometry() {
      if (!this.records.length) {
        return;
      }

      const fallbackHeight = Math.max(1, LIMITS.dynamicScrollSlotHeightPx);
      let runningTop = 0;

      for (const record of this.records) {
        this.ensureDynamicRenderableRecord(record);

        const html = this.getDynamicRecordRenderHtml(record);
        if (!record.dynamicTrackHeightPx) {
          const chromeHeight = record.dynamicChromeHeightPx || this.measureDynamicChromeHeight(record.role);
          const contentHeight = this.measureDynamicContentHtml(html);
          record.dynamicChromeHeightPx = chromeHeight;
          record.dynamicTrackHeightPx = Math.max(
            fallbackHeight,
            Math.round(chromeHeight + contentHeight)
          );
        }

        record.dynamicTrackTopPx = runningTop;
        runningTop += Math.max(1, Number(record.dynamicTrackHeightPx) || fallbackHeight);
      }
    }

    getDynamicReaderMetrics() {
      const viewportHeight = this.scrollContainer && this.scrollContainer.clientHeight
        ? this.scrollContainer.clientHeight
        : global.innerHeight || 800;
      const targetWindowHeight = Math.max(420, Math.min(viewportHeight - 96, Math.round(viewportHeight * 0.81)));
      const sliceHeight = Math.max(140, Math.round(targetWindowHeight / 3));
      return {
        sliceHeight,
        visibleSliceCount: 3,
        windowHeight: sliceHeight * 3
      };
    }

    getDynamicSliceHeight() {
      return this.getDynamicReaderMetrics().sliceHeight;
    }

    getDynamicTrackStartOffset() {
      if (
        this.archiveUi
        && this.archiveUi.list instanceof HTMLElement
        && this.archiveUi.list.isConnected
        && this.scrollContainer
      ) {
        return this.getElementOffsetWithinContainer(this.archiveUi.list, this.scrollContainer);
      }

      const connectedTurn = this.records.find((record) => this.getRecordPrimaryLiveNode(record) instanceof HTMLElement);
      if (connectedTurn && this.scrollContainer) {
        return this.getElementOffsetWithinContainer(this.getRecordPrimaryLiveNode(connectedTurn), this.scrollContainer);
      }

      if (this.root instanceof HTMLElement && this.scrollContainer) {
        return this.getElementOffsetWithinContainer(this.root, this.scrollContainer);
      }

      return 0;
    }

    getArchiveTrackStartOffset() {
      if (
        this.archiveUi
        && this.archiveUi.list instanceof HTMLElement
        && this.archiveUi.list.isConnected
        && this.scrollContainer
      ) {
        return this.getElementOffsetWithinContainer(this.archiveUi.list, this.scrollContainer);
      }

      return this.getDynamicTrackStartOffset();
    }

    getCurrentTrackOffset() {
      if (!this.scrollContainer) {
        return 0;
      }

      if (
        this.archiveActive
        && this.archiveUi
        && this.archiveUi.list instanceof HTMLElement
        && this.archiveUi.list.isConnected
      ) {
        return Math.max(0, this.scrollContainer.scrollTop - this.getArchiveTrackStartOffset());
      }

      if (this.root instanceof HTMLElement) {
        return Math.max(0, this.scrollContainer.scrollTop - this.getElementOffsetWithinContainer(this.root, this.scrollContainer));
      }

      return Math.max(0, this.scrollContainer.scrollTop || 0);
    }

    buildDynamicSliceRenderState(trackEntries) {
      const contentHeight = trackEntries.length ? trackEntries[trackEntries.length - 1].bottom : 0;
      const metrics = this.getDynamicReaderMetrics();
      const sliceHeight = metrics.sliceHeight;
      const sliceCount = Math.max(1, Math.ceil(Math.max(1, contentHeight) / sliceHeight));
      const totalHeight = sliceCount * sliceHeight;
      const maxWindowStartSlice = Math.max(0, sliceCount - metrics.visibleSliceCount);
      if (
        !Number.isFinite(this.dynamicCurrentSliceIndex)
        || this.dynamicCurrentSliceIndex < 0
        || this.dynamicCurrentSliceIndex > maxWindowStartSlice
      ) {
        this.dynamicCurrentSliceIndex = maxWindowStartSlice;
      }
      const windowStartSlice = this.dynamicCurrentSliceIndex;
      const currentSliceIndex = Math.min(sliceCount - 1, windowStartSlice + 1);
      const windowEndSlice = Math.min(sliceCount - 1, windowStartSlice + metrics.visibleSliceCount - 1);
      const windowStartY = windowStartSlice * sliceHeight;
      const windowEndY = Math.min(totalHeight, windowStartY + metrics.windowHeight);
      const visibleWindowEndY = Math.min(contentHeight, windowEndY);
      const visibleEntries = trackEntries
        .filter((entry) => entry.bottom > windowStartY && entry.top < visibleWindowEndY)
        .map((entry) => {
          const visibleTop = Math.max(entry.top, windowStartY);
          const visibleBottom = Math.min(entry.bottom, visibleWindowEndY);
          return {
            ...entry,
            visibleTop,
            visibleBottom,
            visibleHeight: Math.max(1, visibleBottom - visibleTop),
            clipTopPx: Math.max(0, visibleTop - entry.top),
            clipBottomPx: Math.max(0, entry.bottom - visibleBottom)
          };
        });

      return {
        totalHeight,
        contentHeight,
        sliceHeight,
        sliceCount,
        currentSliceIndex,
        windowStartSlice,
        windowEndSlice,
        windowStartY,
        windowEndY,
        windowHeight: metrics.windowHeight,
        visibleEntries
      };
    }

    getDynamicTimelinePreviewText(record) {
      const rawText = (record && record.plainTextFallback ? record.plainTextFallback : "")
        .replace(/\s+/g, " ")
        .trim();

      if (!rawText) {
        return "No preview available.";
      }

      const sentences = rawText.match(/[^.!?]+[.!?]?/g) || [];
      let preview = "";
      let usedSentences = 0;

      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (!trimmed) {
          continue;
        }

        const nextPreview = preview ? `${preview} ${trimmed}` : trimmed;
        if (nextPreview.length > 220 && usedSentences > 0) {
          break;
        }

        preview = nextPreview;
        usedSentences += 1;
        if (usedSentences >= 3 || preview.length >= 220) {
          break;
        }
      }

      if (!preview) {
        preview = rawText.slice(0, 220).trim();
      }

      if (preview.length < rawText.length) {
        preview = `${preview.replace(/[\s.]+$/u, "")}...`;
      }

      return preview;
    }

    getDynamicTimelineState(trackEntries, renderState) {
      const userEntries = trackEntries.filter((entry) => entry.record.role === "user");
      if (!userEntries.length) {
        return {
          entries: [],
          activeRecordId: ""
        };
      }

      const centerY = renderState.windowStartY + (renderState.windowHeight / 2);
      let activeEntry = userEntries[0];
      let bestDistance = Number.POSITIVE_INFINITY;
      const maxWindowStartSlice = Math.max(0, renderState.sliceCount - 3);

      const timelineEntries = userEntries.map((entry, index) => {
        const centerOffset = entry.top + (entry.height / 2);
        const targetSliceIndex = index === 0
          ? Math.max(
            0,
            Math.min(
              maxWindowStartSlice,
              Math.floor(entry.top / renderState.sliceHeight)
            )
          )
          : Math.max(
            0,
            Math.min(
              maxWindowStartSlice,
              Math.round((centerOffset - (renderState.windowHeight / 2)) / renderState.sliceHeight)
            )
          );
        const distance = centerY < entry.top
          ? entry.top - centerY
          : centerY > entry.bottom
            ? centerY - entry.bottom
            : 0;

        if (distance < bestDistance) {
          bestDistance = distance;
          activeEntry = entry;
        }

        return {
          ...entry,
          previewText: this.getDynamicTimelinePreviewText(entry.record),
          targetSliceIndex
        };
      });

      return {
        entries: timelineEntries,
        activeRecordId: activeEntry && activeEntry.record ? activeEntry.record.id : ""
      };
    }

    hideDynamicTimelineTooltip(archiveUi) {
      if (!archiveUi || !(archiveUi.timelineTooltip instanceof HTMLElement)) {
        return;
      }

      archiveUi.timelineTooltip.style.opacity = "0";
      archiveUi.timelineTooltip.style.visibility = "hidden";
    }

    showDynamicTimelineTooltip(archiveUi, button, text) {
      if (
        !archiveUi
        || !(archiveUi.timeline instanceof HTMLElement)
        || !(archiveUi.timelineTooltip instanceof HTMLElement)
        || !(button instanceof HTMLElement)
      ) {
        return;
      }

      const tooltip = archiveUi.timelineTooltip;
      tooltip.textContent = text;
      tooltip.style.opacity = "1";
      tooltip.style.visibility = "hidden";
      tooltip.style.transform = "translate(-50%, calc(-100% - 10px))";

      const timelineRect = archiveUi.timeline.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const desiredCenter = (buttonRect.left - timelineRect.left) + (buttonRect.width / 2);
      const clampedCenter = Math.max(
        (tooltipRect.width / 2) + 8,
        Math.min(desiredCenter, timelineRect.width - (tooltipRect.width / 2) - 8)
      );
      const aboveTop = buttonRect.top - timelineRect.top - 8;
      const shouldPlaceBelow = aboveTop < tooltipRect.height + 8;

      tooltip.style.left = `${Math.round(clampedCenter)}px`;
      if (shouldPlaceBelow) {
        tooltip.style.top = `${Math.round(buttonRect.bottom - timelineRect.top + 8)}px`;
        tooltip.style.transform = "translate(-50%, 0)";
      } else {
        tooltip.style.top = `${Math.round(aboveTop)}px`;
        tooltip.style.transform = "translate(-50%, calc(-100% - 10px))";
      }
      tooltip.style.visibility = "visible";
    }

    renderDynamicTimeline(archiveUi, trackEntries, renderState) {
      if (
        !archiveUi
        || !(archiveUi.timelineTrack instanceof HTMLElement)
        || !(archiveUi.timelineTooltip instanceof HTMLElement)
      ) {
        return;
      }

      const timelineState = this.getDynamicTimelineState(trackEntries, renderState);
      archiveUi.timelineTrack.replaceChildren();
      this.hideDynamicTimelineTooltip(archiveUi);

      if (!timelineState.entries.length) {
        const placeholder = document.createElement("div");
        placeholder.textContent = "No indexed user prompts available.";
        Object.assign(placeholder.style, {
          font: "12px/1.35 'Segoe UI', sans-serif",
          color: "#5a7194",
          textAlign: "center"
        });
        archiveUi.timelineTrack.appendChild(placeholder);
        return;
      }

      const availableWidth = Math.max(220, (archiveUi.restoreBar.clientWidth || 760) - 32);
      const itemsPerRow = Math.max(1, Math.floor(availableWidth / 28));

      for (let startIndex = 0; startIndex < timelineState.entries.length; startIndex += itemsPerRow) {
        const rowEntries = timelineState.entries.slice(startIndex, startIndex + itemsPerRow);
        const row = document.createElement("div");
        const line = document.createElement("div");

        Object.assign(row.style, {
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: rowEntries.length === 1 ? "center" : "space-between",
          minHeight: "18px",
          padding: "2px 8px",
          gap: "0"
        });

        Object.assign(line.style, {
          position: "absolute",
          left: "12px",
          right: "12px",
          top: "50%",
          borderTop: "2px solid rgba(118, 137, 172, 0.26)",
          transform: "translateY(-50%)",
          pointerEvents: "none"
        });

        row.appendChild(line);

        for (const entry of rowEntries) {
          const button = document.createElement("button");
          const isActive = entry.record.id === timelineState.activeRecordId;
          button.type = "button";
          button.setAttribute("aria-label", entry.previewText);
          Object.assign(button.style, {
            position: "relative",
            zIndex: "1",
            width: "14px",
            height: "14px",
            padding: "0",
            borderRadius: "999px",
            border: isActive
              ? "2px solid rgba(54, 92, 161, 0.86)"
              : "2px solid rgba(124, 143, 176, 0.46)",
            background: isActive
              ? "linear-gradient(180deg, rgba(94, 141, 230, 0.98), rgba(61, 101, 191, 0.98))"
              : "linear-gradient(180deg, rgba(249, 251, 255, 0.99), rgba(208, 220, 239, 0.98))",
            boxShadow: isActive
              ? "0 0 0 4px rgba(85, 120, 184, 0.12)"
              : "0 0 0 3px rgba(141, 156, 181, 0.10)",
            cursor: "pointer",
            flex: "0 0 auto"
          });

          const showTooltip = () => this.showDynamicTimelineTooltip(archiveUi, button, entry.previewText);
          const hideTooltip = () => this.hideDynamicTimelineTooltip(archiveUi);

          button.addEventListener("mouseenter", showTooltip);
          button.addEventListener("focus", showTooltip);
          button.addEventListener("mouseleave", hideTooltip);
          button.addEventListener("blur", hideTooltip);
          button.addEventListener("click", (event) => {
            event.preventDefault();
            this.hideDynamicTimelineTooltip(archiveUi);
            this.jumpToDynamicSlice(entry.targetSliceIndex, "timeline", {
              recordId: entry.record.id
            });
          });

          row.appendChild(button);
        }

        archiveUi.timelineTrack.appendChild(row);
      }
    }

    ensureDynamicRenderableRecord(record) {
      if (!record) {
        return;
      }

      if (!this.hasManualArchivePayload(record)) {
        this.queuePlainTextForRecord(record);
      }

      if (!record.snapshotHtml && record.plainTextFallback) {
        record.snapshotHtml = this.renderPlainTextHtml(record.plainTextFallback);
      }

      if (!record.snapshotState || record.snapshotState === "empty") {
        record.snapshotState = this.hasManualArchivePayload(record) ? "ready" : (record.indexState || "empty");
      }
    }

    createDynamicDisplayRecord(record) {
      return {
        id: `dynamic-track-${record.id}`,
        role: record.role,
        viewMode: "rich",
        richHtml: record.richHtml || "",
        snapshotHtml: record.snapshotHtml || (record.plainTextFallback ? this.renderPlainTextHtml(record.plainTextFallback) : ""),
        plainTextFallback: record.plainTextFallback || "",
        snapshotState: record.snapshotState || "empty",
        richRequestPending: Boolean(record.richRequestPending),
        archiveBlock: null,
        refreshArchiveBlock: null,
        dynamicAutoExpanded: false
      };
    }

    createDynamicSliceWindow(renderState) {
      const readerHost = document.createElement("div");
      const windowHost = document.createElement("div");
      readerHost.setAttribute("data-rapid-view-for-chatgpt-dynamic-reader", "true");
      windowHost.setAttribute("data-rapid-view-for-chatgpt-dynamic-window", "true");
      Object.assign(readerHost.style, {
        width: "min(100%, 820px)",
        maxWidth: "820px",
        margin: "0 auto",
        padding: "0 0 8px"
      });
      Object.assign(windowHost.style, {
        position: "relative",
        width: "100%",
        height: `${Math.max(1, Math.round(renderState.windowHeight))}px`,
        overflow: "hidden",
        border: "1px solid rgba(89, 108, 142, 0.22)",
        borderRadius: "20px",
        background: "linear-gradient(180deg, rgba(233, 238, 247, 0.98), rgba(219, 227, 241, 0.95))",
        boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.42), 0 14px 36px rgba(49, 69, 101, 0.10)"
      });

      for (let dividerIndex = 1; dividerIndex < 3; dividerIndex += 1) {
        const divider = document.createElement("div");
        divider.setAttribute("aria-hidden", "true");
        Object.assign(divider.style, {
          position: "absolute",
          left: "18px",
          right: "18px",
          top: `${Math.max(0, Math.round(renderState.sliceHeight * dividerIndex))}px`,
          borderTop: "1px solid rgba(98, 118, 153, 0.14)",
          pointerEvents: "none"
        });
        windowHost.appendChild(divider);
      }

      for (const entry of renderState.visibleEntries) {
        const slot = document.createElement("div");
        const blockHost = document.createElement("div");
        const displayRecord = this.createDynamicDisplayRecord(entry.record);
        const block = this.createArchiveBlock(displayRecord);

        slot.setAttribute("data-rapid-view-for-chatgpt-dynamic-slot", entry.record.id);
        Object.assign(slot.style, {
          position: "absolute",
          left: "0",
          right: "0",
          top: `${Math.max(0, Math.round(entry.visibleTop - renderState.windowStartY))}px`,
          height: `${Math.max(1, Math.round(entry.visibleHeight))}px`,
          overflow: "hidden",
          display: "flex",
          justifyContent: "center",
          alignItems: "flex-start",
          minWidth: "0",
          pointerEvents: "auto"
        });

        Object.assign(blockHost.style, {
          width: "100%",
          maxWidth: "100%",
          minWidth: "0",
          transform: `translateY(-${Math.max(0, Math.round(entry.clipTopPx))}px)`,
          willChange: "transform"
        });

        block.style.margin = "0 auto";
        blockHost.appendChild(block);
        slot.appendChild(blockHost);
        windowHost.appendChild(slot);
      }

      readerHost.appendChild(windowHost);
      return readerHost;
    }

    virtualizeDynamicTrackNodes() {
      this.withDomMutationGuard(() => {
        for (const record of this.records) {
          if (
            record.state !== "live"
            && this.getRecordLiveNodes(record).length
          ) {
            this.removeRecordLiveNodes(record);
            record.nodes = [];
            record.node = null;
          }
        }
      });
    }

    getArchiveRenderState(visibleArchiveRecords) {
      return {
        records: visibleArchiveRecords,
        topHeight: 0,
        bottomHeight: 0
      };
    }

    getDynamicArchivedRecords() {
      return this.records.filter((record) => record.state !== "live");
    }

    ensureDynamicUnitsForRecords(records) {
      for (const record of records) {
        this.ensureDynamicUnits(record);
      }
    }

    ensureDynamicUnits(record) {
      if (!record) {
        return;
      }

      if (Array.isArray(record.dynamicUnits) && record.dynamicUnits.length) {
        return;
      }

      if (!this.hasManualArchivePayload(record)) {
        this.ensureDynamicRenderableRecord(record);
      }

      if (!this.hasManualArchivePayload(record)) {
        return;
      }

      const fragments = this.buildDynamicFragments(record);
      const chromeHeight = this.measureDynamicChromeHeight(record.role);
      const units = this.chunkDynamicFragments(record, fragments);
      const segmentCount = units.length || 1;

      units.forEach((unit, index) => {
        unit.segmentIndex = index;
        unit.segmentCount = segmentCount;
      });

      this.distributeDynamicUnitBaseHeights(record, units);
      record.dynamicChromeHeightPx = chromeHeight;
      record.dynamicUnits = units;
      if (!record.dynamicBaseHeight) {
        record.dynamicBaseHeight = units.reduce((total, unit) => total + Math.max(1, unit.baseHeightPx || 1), 0);
      }
    }

    buildDynamicFragments(record) {
      const fragments = [];
      const htmlSource = (record.richHtml || record.snapshotHtml || this.renderPlainTextHtml(record.plainTextFallback || "")).trim();
      if (!htmlSource) {
        return fragments;
      }

      const parser = new DOMParser();
      const doc = parser.parseFromString(`<div data-rapid-view-for-chatgpt-dynamic-root="true">${htmlSource}</div>`, "text/html");
      const wrapper = doc.body.firstElementChild;
      const root = this.getDynamicHtmlRoot(wrapper);
      const nodes = Array.from(root.childNodes).filter((node) => this.nodeHasDynamicContent(node));
      const sourceNodes = nodes.length ? nodes : [root];
      let blockIndex = 0;
      let codeIndex = 0;

      for (const node of sourceNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = (node.textContent || "").trim();
          if (!text) {
            continue;
          }

          fragments.push(this.createDynamicHtmlFragment(
            record,
            `<p>${this.escapeHtml(text)}</p>`,
            text,
            `text-${blockIndex}`
          ));
          blockIndex += 1;
          continue;
        }

        if (!(node instanceof Element)) {
          continue;
        }

        const directCodeBlock = node.matches("[data-rapid-view-for-chatgpt-code-block]")
          ? node
          : (node.children.length === 1 && node.firstElementChild && node.firstElementChild.matches("[data-rapid-view-for-chatgpt-code-block]"))
            ? node.firstElementChild
            : null;

        if (directCodeBlock) {
          const codeFragments = this.buildDynamicCodeFragments(record, directCodeBlock, `code-${codeIndex}`);
          fragments.push(...codeFragments);
          codeIndex += 1;
          continue;
        }

        const plainText = (node.textContent || "").trim();
        const html = node.outerHTML || this.renderPlainTextHtml(plainText);
        fragments.push(this.createDynamicHtmlFragment(record, html, plainText, `block-${blockIndex}`));
        blockIndex += 1;
      }

      if (!fragments.length && record.plainTextFallback) {
        fragments.push(this.createDynamicHtmlFragment(
          record,
          this.renderPlainTextHtml(record.plainTextFallback),
          record.plainTextFallback,
          "fallback-0"
        ));
      }

      return fragments;
    }

    getDynamicHtmlRoot(wrapper) {
      if (!(wrapper instanceof Element)) {
        return wrapper;
      }

      if (wrapper.childElementCount === 1) {
        const onlyChild = wrapper.firstElementChild;
        if (
          onlyChild
          && ["div", "section", "article"].includes(onlyChild.tagName.toLowerCase())
          && onlyChild.childNodes.length > 1
        ) {
          return onlyChild;
        }
      }

      return wrapper;
    }

    nodeHasDynamicContent(node) {
      if (!node) {
        return false;
      }

      if (node.nodeType === Node.TEXT_NODE) {
        return Boolean((node.textContent || "").trim());
      }

      if (!(node instanceof Element)) {
        return false;
      }

      return Boolean((node.textContent || "").trim()) || node.matches("[data-rapid-view-for-chatgpt-code-block]");
    }

    createDynamicHtmlFragment(record, html, plainText, fragmentId) {
      const richHtml = (html || this.renderPlainTextHtml(plainText || "")).trim();
      return {
        fragmentId: `${record.id}:${fragmentId}`,
        kind: "html",
        recordId: record.id,
        sourceBlockId: `${record.id}:${fragmentId}`,
        plainText: plainText || "",
        richHtml,
        baseContentHeightPx: this.measureDynamicContentHtml(richHtml)
      };
    }

    buildDynamicCodeFragments(record, codeBlockElement, codeIndexKey) {
      const languageElement = codeBlockElement.querySelector("[data-rapid-view-for-chatgpt-code-language]");
      const copyButton = codeBlockElement.querySelector("[data-rapid-view-for-chatgpt-copy-code]");
      const pre = codeBlockElement.querySelector("pre");
      const fullText = (
        (copyButton && copyButton.getAttribute("data-rapid-view-for-chatgpt-copy-value"))
        || (pre && (pre.innerText || pre.textContent))
        || ""
      ).replace(/\r/g, "").replace(/\n$/, "");
      const language = (languageElement && languageElement.textContent ? languageElement.textContent : "Code").trim();
      const lines = fullText ? fullText.split("\n") : [""];
      const chunkSize = LIMITS.dynamicCodeChunkLineCount;
      const fragments = [];

      for (let start = 0; start < lines.length; start += chunkSize) {
        const end = Math.min(lines.length, start + chunkSize);
        const chunkText = lines.slice(start, end).join("\n");
        const richHtml = this.createDynamicCodeFragmentHtml(language, fullText, chunkText);
        fragments.push({
          fragmentId: `${record.id}:${codeIndexKey}:${start}`,
          kind: "code-lines",
          recordId: record.id,
          sourceBlockId: `${record.id}:${codeIndexKey}`,
          language,
          plainText: chunkText,
          fullText,
          richHtml,
          lineStart: start,
          lineEnd: end,
          baseContentHeightPx: this.measureDynamicContentHtml(richHtml)
        });
      }

      return fragments;
    }

    createDynamicCodeFragmentHtml(language, fullText, visibleText) {
      return [
        '<div data-rapid-view-for-chatgpt-code-block="true">',
        '<div data-rapid-view-for-chatgpt-code-header="true">',
        `<span data-rapid-view-for-chatgpt-code-language="true">${this.escapeHtml(language || "Code")}</span>`,
        `<button type="button" data-rapid-view-for-chatgpt-copy-code="true" data-rapid-view-for-chatgpt-copy-value="${this.escapeAttribute(fullText || visibleText || "")}">Copy</button>`,
        "</div>",
        `<pre><code>${this.escapeHtml(visibleText || "")}</code></pre>`,
        "</div>"
      ].join("");
    }

    chunkDynamicFragments(record, fragments) {
      if (!fragments.length) {
        return [];
      }

      const units = [];
      let currentFragments = [];
      let currentHeight = 0;

      const flush = () => {
        if (!currentFragments.length) {
          return;
        }

        const baseContentHeightPx = currentFragments.reduce(
          (total, fragment) => total + Math.max(1, fragment.baseContentHeightPx || 1),
          0
        );

        units.push({
          unitId: `${record.id}:unit-${units.length}`,
          recordId: record.id,
          role: record.role,
          fragments: currentFragments.slice(),
          baseContentHeightPx,
          baseHeightPx: 0,
          renderedHeightPx: 0,
          segmentIndex: units.length,
          segmentCount: 0
        });

        currentFragments = [];
        currentHeight = 0;
      };

      for (const fragment of fragments) {
        const fragmentHeight = Math.max(1, fragment.baseContentHeightPx || 1);
        if (
          currentFragments.length
          && (
            (
              currentHeight >= LIMITS.dynamicUnitTargetHeightPx * 0.55
              && currentHeight + fragmentHeight > LIMITS.dynamicUnitTargetHeightPx
            )
            || currentHeight + fragmentHeight > LIMITS.dynamicUnitSoftMaxHeightPx
          )
        ) {
          flush();
        }

        currentFragments.push(fragment);
        currentHeight += fragmentHeight;
      }

      flush();
      return units;
    }

    distributeDynamicUnitBaseHeights(record, units) {
      if (!Array.isArray(units) || !units.length) {
        return;
      }

      const fallbackTotalHeight = units.reduce(
        (total, unit) => total + Math.max(1, unit.baseContentHeightPx || 1),
        0
      );
      const targetTotalHeight = Math.max(
        1,
        record && record.dynamicBaseHeight
          ? record.dynamicBaseHeight
          : fallbackTotalHeight
      );
      const baseContentTotal = Math.max(
        1,
        units.reduce((total, unit) => total + Math.max(1, unit.baseContentHeightPx || 1), 0)
      );
      let remainingHeight = targetTotalHeight;

      units.forEach((unit, index) => {
        const baseContentHeight = Math.max(1, unit.baseContentHeightPx || 1);
        const allocatedHeight = index === units.length - 1
          ? Math.max(1, remainingHeight)
          : Math.max(1, Math.round((baseContentHeight / baseContentTotal) * targetTotalHeight));

        unit.baseHeightPx = allocatedHeight;
        remainingHeight = Math.max(0, remainingHeight - allocatedHeight);
      });
    }

    ensureDynamicMeasurementHost() {
      if (this.dynamicMeasurementHost && this.dynamicMeasurementHost.isConnected) {
        return this.dynamicMeasurementHost;
      }

      const host = document.createElement("div");
      host.setAttribute("data-rapid-view-for-chatgpt-dynamic-measure", "true");
      Object.assign(host.style, {
        position: "fixed",
        left: "-20000px",
        top: "0",
        width: "760px",
        pointerEvents: "none",
        visibility: "hidden",
        opacity: "0",
        zIndex: "-1"
      });

      document.documentElement.appendChild(host);
      this.dynamicMeasurementHost = host;
      return host;
    }

    destroyDynamicMeasurementHost() {
      if (this.dynamicMeasurementHost && this.dynamicMeasurementHost.parentElement) {
        this.dynamicMeasurementHost.remove();
      }
      this.dynamicMeasurementHost = null;
      this.dynamicChromeHeightCache.clear();
    }

    measureDynamicChromeHeight(role) {
      const cacheKey = role === "user" ? "user" : "assistant";
      if (this.dynamicChromeHeightCache.has(cacheKey)) {
        return this.dynamicChromeHeightCache.get(cacheKey);
      }

      const host = this.ensureDynamicMeasurementHost();
      const article = document.createElement("article");
      const header = document.createElement("div");
      const label = document.createElement("div");
      const body = document.createElement("div");

      Object.assign(article.style, {
        position: "relative",
        maxWidth: "760px",
        width: "760px",
        margin: "0 auto",
        padding: "14px 16px",
        boxSizing: "border-box"
      });

      Object.assign(header.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        marginBottom: "10px"
      });

      Object.assign(label.style, {
        font: "600 11px/1.2 'Segoe UI', sans-serif",
        textTransform: "uppercase",
        letterSpacing: "0.06em"
      });
      label.textContent = cacheKey === "assistant" ? "Archived assistant turn" : "Archived user turn";

      Object.assign(body.style, {
        height: "0",
        margin: "0",
        padding: "0",
        overflow: "hidden"
      });

      header.appendChild(label);
      article.appendChild(header);
      article.appendChild(body);
      host.replaceChildren(article);

      const height = Math.max(1, article.getBoundingClientRect().height);
      this.dynamicChromeHeightCache.set(cacheKey, height);
      return height;
    }

    measureDynamicContentHtml(html) {
      const host = this.ensureDynamicMeasurementHost();
      const body = document.createElement("div");
      Object.assign(body.style, {
        width: "728px",
        boxSizing: "border-box"
      });
      body.innerHTML = html || "<p></p>";
      this.styleArchiveBody(body, "rich");
      host.replaceChildren(body);
      return Math.max(1, body.getBoundingClientRect().height);
    }

    getDynamicUnits(archivedRecords) {
      const units = [];
      for (const record of archivedRecords) {
        if (!Array.isArray(record.dynamicUnits) || !record.dynamicUnits.length) {
          continue;
        }

        for (const unit of record.dynamicUnits) {
          unit.record = record;
          units.push(unit);
        }
      }
      return units;
    }

    getElementOffsetWithinContainer(element, container) {
      if (!(element instanceof HTMLElement) || !(container instanceof HTMLElement)) {
        return 0;
      }

      const elementRect = element.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      return container.scrollTop + (elementRect.top - containerRect.top);
    }

    getDynamicLayoutMetrics(units) {
      const focusIndex = units.findIndex((unit) => unit.unitId === this.dynamicScrollFocusId);
      const safeFocusIndex = focusIndex >= 0 ? focusIndex : 0;
      const visibleStart = Math.max(0, safeFocusIndex - LIMITS.dynamicNeighborUnitCount);
      const visibleEnd = Math.min(units.length - 1, safeFocusIndex + LIMITS.dynamicNeighborUnitCount);
      const baseHeights = units.map((unit) => Math.max(1, unit.baseHeightPx || unit.baseContentHeightPx || LIMITS.dynamicScrollSlotHeightPx));
      const displayHeights = baseHeights.slice();
      const offsets = new Array(units.length);
      let runningTop = 0;

      for (let index = visibleStart; index <= visibleEnd; index += 1) {
        if (units[index] && units[index].renderedHeightPx > 0) {
          displayHeights[index] = Math.max(baseHeights[index], units[index].renderedHeightPx);
        }
      }

      for (let index = 0; index < units.length; index += 1) {
        offsets[index] = runningTop;
        runningTop += displayHeights[index];
      }

      return {
        focusIndex: safeFocusIndex,
        visibleStart,
        visibleEnd,
        baseHeights,
        displayHeights,
        offsets,
        totalHeight: runningTop
      };
    }

    getDynamicFocusIndex(units) {
      if (
        !units.length
        || !this.scrollContainer
        || !this.archiveUi
        || !(this.archiveUi.list instanceof HTMLElement)
        || !this.archiveUi.list.isConnected
      ) {
        return units.length ? 0 : -1;
      }

      const metrics = this.getDynamicLayoutMetrics(units);
      const trackStart = this.getElementOffsetWithinContainer(this.archiveUi.list, this.scrollContainer);
      const relativeTop = this.scrollContainer.scrollTop - trackStart;

      if (metrics.totalHeight <= 0) {
        return units.length ? 0 : -1;
      }

      const clampedRelativeTop = Math.max(0, Math.min(Math.max(0, metrics.totalHeight - 1), relativeTop));

      for (let index = 0; index < units.length; index += 1) {
        const start = metrics.offsets[index];
        const end = start + metrics.displayHeights[index];
        if (clampedRelativeTop >= start && clampedRelativeTop < end) {
          return index;
        }
      }

      return units.length - 1;
    }

    getDynamicArchiveRenderState(units) {
      const focusIndex = this.getDynamicFocusIndex(units);
      if (focusIndex < 0) {
        return {
          focusUnit: null,
          visibleUnits: [],
          groups: [],
          topHeight: 0,
          bottomHeight: 0,
          totalHeight: 0
        };
      }

      this.dynamicScrollFocusId = units[focusIndex].unitId;
      const metrics = this.getDynamicLayoutMetrics(units);
      const visibleUnits = units.slice(metrics.visibleStart, metrics.visibleEnd + 1);
      const groups = this.buildDynamicVisibleGroups(visibleUnits);
      const topHeight = metrics.offsets[metrics.visibleStart];
      const visibleHeight = Math.max(
        0,
        (metrics.offsets[metrics.visibleEnd] + metrics.displayHeights[metrics.visibleEnd]) - topHeight
      );
      const bottomHeight = Math.max(0, metrics.totalHeight - topHeight - visibleHeight);

      return {
        focusUnit: units[focusIndex],
        focusIndex,
        visibleUnits,
        groups,
        topHeight,
        bottomHeight,
        totalHeight: metrics.totalHeight
      };
    }

    buildDynamicVisibleGroups(visibleUnits) {
      const groups = [];
      let currentGroup = null;

      for (const unit of visibleUnits) {
        if (!currentGroup || currentGroup.recordId !== unit.recordId) {
          currentGroup = {
            groupId: `${unit.recordId}:${groups.length}`,
            recordId: unit.recordId,
            record: unit.record,
            units: [],
            baseHeightPx: 0,
            html: "",
            plainText: "",
            node: null
          };
          groups.push(currentGroup);
        }

        currentGroup.units.push(unit);
      }

      for (const group of groups) {
        group.baseHeightPx = group.units.reduce((total, unit) => total + Math.max(1, unit.baseHeightPx || 1), 0);
        group.html = this.buildDynamicGroupHtml(group.units);
        group.plainText = group.units
          .flatMap((unit) => unit.fragments.map((fragment) => fragment.plainText || ""))
          .filter(Boolean)
          .join("\n\n");
      }

      return groups;
    }

    buildDynamicGroupHtml(units) {
      const mergedFragments = [];

      for (const unit of units) {
        for (const fragment of unit.fragments) {
          if (
            fragment.kind === "code-lines"
            && mergedFragments.length
            && mergedFragments[mergedFragments.length - 1].kind === "code-lines"
            && mergedFragments[mergedFragments.length - 1].sourceBlockId === fragment.sourceBlockId
          ) {
            mergedFragments[mergedFragments.length - 1].plainText += `\n${fragment.plainText}`;
            continue;
          }

          mergedFragments.push({
            ...fragment
          });
        }
      }

      return mergedFragments.map((fragment) => {
        if (fragment.kind === "code-lines") {
          return this.createDynamicCodeFragmentHtml(
            fragment.language,
            fragment.fullText,
            fragment.plainText
          );
        }

        return fragment.richHtml;
      }).join("");
    }

    createDynamicGroupBlock(group) {
      const pseudoRecord = {
        id: `dynamic-${group.groupId}`,
        role: group.record.role,
        viewMode: "rich",
        richHtml: group.html,
        snapshotHtml: group.html,
        plainTextFallback: group.plainText,
        snapshotState: "ready",
        richRequestPending: false,
        archiveBlock: null,
        refreshArchiveBlock: null,
        dynamicAutoExpanded: false
      };

      const block = this.createArchiveBlock(pseudoRecord);
      block.setAttribute("data-rapid-view-for-chatgpt-dynamic-group", group.groupId);
      group.node = block;
      group.displayRecord = pseudoRecord;
      return block;
    }

    measureDynamicRenderedGroups(renderState) {
      let changed = false;

      for (const group of renderState.groups) {
        if (!(group.node instanceof HTMLElement) || !group.node.isConnected) {
          continue;
        }

        const totalHeight = Math.max(1, this.measureNode(group.node));
        const totalBaseContentHeight = Math.max(
          1,
          group.units.reduce((sum, unit) => sum + Math.max(1, unit.baseHeightPx || unit.baseContentHeightPx || 1), 0)
        );
        let remainingRenderedHeight = totalHeight;

        group.units.forEach((unit, index) => {
          const baseHeight = Math.max(1, unit.baseHeightPx || unit.baseContentHeightPx || 1);
          const renderedShare = index === group.units.length - 1
            ? Math.max(1, remainingRenderedHeight)
            : Math.max(1, Math.round((baseHeight / totalBaseContentHeight) * totalHeight));
          remainingRenderedHeight = Math.max(0, remainingRenderedHeight - renderedShare);

          if (Math.abs((unit.renderedHeightPx || 0) - renderedShare) > 1) {
            changed = true;
          }

          unit.renderedHeightPx = renderedShare;
        });
      }

      return changed;
    }

    updateArchiveUiChrome(archiveUi, archiveCount) {
      if (this.settings.dynamicScroll) {
        archiveUi.restoreBar.style.display = "block";
        archiveUi.restoreBar.style.padding = "14px 16px";
        archiveUi.list.style.display = "flex";
        archiveUi.archiveActionRow.style.display = "none";
        archiveUi.counter.style.display = "none";
        archiveUi.counter.textContent = "";
        archiveUi.timeline.style.display = "block";
        archiveUi.timelineTrack.style.display = "flex";
        archiveUi.timelineTooltip.style.opacity = "0";
        archiveUi.timelineTooltip.textContent = "";
        archiveUi.actions.style.display = "none";
        if (this.dynamicSliceCount > 0) {
          const windowStart = Math.max(0, Math.min(this.dynamicCurrentSliceIndex, Math.max(0, this.dynamicSliceCount - 1)));
          const windowEnd = Math.min(this.dynamicSliceCount, windowStart + 3);
          archiveUi.counter.textContent = `${archiveCount} messages indexed • slices ${windowStart + 1}-${windowEnd}/${this.dynamicSliceCount} • use wheel or arrow keys`;
        } else {
          archiveUi.counter.textContent = `${archiveCount} messages indexed for Dynamic`;
        }
        archiveUi.loadMoreButton.hidden = true;
        archiveUi.loadMoreButton.disabled = true;
        return;
      }

      archiveUi.restoreBar.style.display = "flex";
      archiveUi.restoreBar.style.padding = "12px 16px";
      archiveUi.list.style.display = archiveCount > 0 ? "flex" : "none";
      archiveUi.archiveActionRow.style.display = archiveCount > 0 ? "flex" : "none";
      archiveUi.counter.style.display = "block";
      archiveUi.timeline.style.display = "none";
      archiveUi.timelineTrack.replaceChildren();
      archiveUi.timelineTooltip.style.opacity = "0";
      archiveUi.timelineTooltip.textContent = "";
      archiveUi.actions.style.display = "flex";

      const readyHiddenCount = this.countHiddenRecords();
      const pendingManualCount = this.countPendingManualArchiveRecords();
      const batchSize = Math.min(readyHiddenCount, this.settings.restoreBatchSize);
      const canRestoreMore = readyHiddenCount > 0;

      archiveUi.counter.textContent = canRestoreMore
        ? `${readyHiddenCount} older messages archived for speed`
        : (pendingManualCount > 0 ? "Indexing older messages..." : "All archived messages loaded");
      archiveUi.loadMoreButton.textContent = `Load ${Math.max(1, batchSize)} older`;
      archiveUi.loadMoreButton.hidden = !canRestoreMore;
      archiveUi.loadMoreButton.disabled = !canRestoreMore;
    }

    mountArchiveUiHost(archiveUi) {
      const firstLiveNode = this.settings.dynamicScroll
        ? this.getFirstLiveNode()
        : this.getManualArchiveInsertionNode();
      this.withDomMutationGuard(() => {
        if (firstLiveNode) {
          this.root.insertBefore(archiveUi.host, firstLiveNode);
        } else if (archiveUi.host.parentElement !== this.root) {
          this.root.appendChild(archiveUi.host);
        }
      });
    }

    insertVisibleArchiveRecords(recordsToInsert) {
      if (!recordsToInsert.length) {
        return;
      }

      if (this.settings.dynamicScroll) {
        this.syncArchiveUi();
        return;
      }

      const renderableRecords = recordsToInsert.filter((record) => (
        this.settings.dynamicScroll || this.isVisibleManualArchiveEntry(record)
      ));

      if (!renderableRecords.length) {
        this.syncArchiveUi();
        return;
      }

      const startedAt = performance.now();
      const archiveUi = this.ensureArchiveUi();
      const fragment = document.createDocumentFragment();
      let insertedCount = 0;

      for (const record of renderableRecords) {
        const recordStartedAt = performance.now();
        const isManualEntry = this.isManualArchiveEntry(record);
        this.logger.info("archive-block:create:start", {
          id: record.id,
          role: record.role,
          hasPlainText: isManualEntry ? this.hasUsableArchiveText(record.simpleText) : this.hasUsableArchiveText(record.plainTextFallback),
          hasRich: isManualEntry ? this.hasStrictArchiveHtml(record.renderedHtml) : this.hasStrictArchiveHtml(record.richHtml),
          hasManualSimpleHtml: isManualEntry ? this.hasStrictArchiveHtml(record.simpleHtml) : undefined,
          hasManualRenderedHtml: isManualEntry ? this.hasStrictArchiveHtml(record.renderedHtml) : undefined,
          viewMode: record.viewMode
        });
        const block = this.createArchiveBlock(record);
        if (!(block instanceof HTMLElement)) {
          continue;
        }

        fragment.appendChild(block);
        insertedCount += 1;
        this.logger.info("archive-block:create:end", {
          id: record.id,
          durationMs: this.getDurationMs(recordStartedAt)
        });
      }

      if (!insertedCount) {
        this.syncArchiveUi();
        return;
      }

      archiveUi.list.insertBefore(fragment, archiveUi.list.firstChild);
      this.updateArchiveUiChrome(archiveUi, this.countVisibleArchiveRecords());
      this.mountArchiveUiHost(archiveUi);
      this.logger.info("insert-visible-archive-records", {
        durationMs: this.getDurationMs(startedAt),
        insertedCount,
        totalVisibleArchiveCount: this.countVisibleArchiveRecords()
      });
    }

    removeArchiveUi() {
      if (!this.archiveUi) {
        this.dynamicVisibleCount = 0;
        return;
      }

      if (this.archiveUi.host.parentElement) {
        this.withDomMutationGuard(() => {
          if (this.archiveUi.host.parentElement) {
            this.archiveUi.host.remove();
          }
        });
      }
      this.dynamicVisibleCount = 0;
    }

    createArchiveBlock(record) {
      if (!record) {
        return null;
      }

      const isManualEntry = this.isManualArchiveEntry(record);
      if (!this.settings.dynamicScroll && (!isManualEntry || !this.isVisibleManualArchiveEntry(record))) {
        return null;
      }

      if (record.archiveBlock instanceof HTMLElement && typeof record.refreshArchiveBlock === "function") {
        record.refreshArchiveBlock();
        return record.archiveBlock;
      }

      const article = document.createElement("article");
      const header = document.createElement("div");
      const label = document.createElement("div");
      const actions = document.createElement("div");
      const collapseOlderButton = document.createElement("button");
      const collapseOlderIcon = document.createElement("span");
      const simpleButton = document.createElement("button");
      const richButton = document.createElement("button");
      const body = document.createElement("div");

      article.setAttribute("data-rapid-view-for-chatgpt-archive-block", "true");
      Object.assign(article.style, {
        position: "relative",
        maxWidth: "760px",
        width: "min(100%, 760px)",
        minWidth: "0",
        margin: "0 auto",
        padding: "14px 16px",
        borderRadius: "16px",
        border: "1px solid rgba(101, 120, 154, 0.22)",
        background: "linear-gradient(180deg, rgba(236, 241, 248, 0.99), rgba(224, 232, 244, 0.97))",
        color: "#22364b",
        boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.48), 0 14px 30px rgba(35, 52, 78, 0.06)",
        boxSizing: "border-box",
        overflowX: "hidden"
      });

      Object.assign(header.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        marginBottom: "10px",
        paddingRight: "28px"
      });

      Object.assign(label.style, {
        font: "600 11px/1.2 'Segoe UI', sans-serif",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "#6980a4"
      });
      label.textContent = record.role === "assistant" ? "Archived assistant turn" : "Archived user turn";

      Object.assign(actions.style, {
        display: "flex",
        gap: "6px",
        flexWrap: "wrap",
        marginLeft: "auto"
      });

      collapseOlderButton.type = "button";
      collapseOlderButton.title = "Collapse this archived turn and all older ones";
      collapseOlderButton.setAttribute("aria-label", "Collapse this archived turn and all older ones");
      Object.assign(collapseOlderButton.style, {
        position: "absolute",
        top: "-1px",
        right: "-1px",
        width: "28px",
        height: "28px",
        padding: "0",
        border: "0",
        background: "transparent",
        cursor: "pointer",
        overflow: "hidden",
        borderTopRightRadius: "14px",
        borderBottomLeftRadius: "12px"
      });

      Object.assign(collapseOlderIcon.style, {
        display: "block",
        width: "100%",
        height: "100%",
        background: "linear-gradient(135deg, rgba(211, 221, 236, 0.14) 0 47%, rgba(98, 118, 154, 0.90) 47% 100%)",
        borderTop: "1px solid rgba(103, 123, 159, 0.30)",
        borderRight: "1px solid rgba(103, 123, 159, 0.30)",
        borderBottom: "1px solid rgba(80, 99, 132, 0.22)",
        borderLeft: "1px solid rgba(80, 99, 132, 0.22)",
        borderTopRightRadius: "16px",
        borderBottomLeftRadius: "14px",
        boxSizing: "border-box",
        clipPath: "polygon(0 0, 100% 0, 100% 100%, 0 100%, 100% 0)"
      });

      collapseOlderButton.addEventListener("mouseenter", () => {
        collapseOlderIcon.style.background = "linear-gradient(135deg, rgba(221, 230, 243, 0.18) 0 47%, rgba(77, 106, 159, 0.96) 47% 100%)";
      });

      collapseOlderButton.addEventListener("mouseleave", () => {
        collapseOlderIcon.style.background = "linear-gradient(135deg, rgba(211, 221, 236, 0.14) 0 47%, rgba(98, 118, 154, 0.90) 47% 100%)";
      });

      collapseOlderButton.addEventListener("click", () => {
        this.collapseArchivedThrough(record.id);
      });
      collapseOlderButton.appendChild(collapseOlderIcon);

      for (const button of [simpleButton, richButton]) {
        button.type = "button";
        Object.assign(button.style, {
          border: "1px solid rgba(112, 130, 164, 0.20)",
          borderRadius: "999px",
          padding: "4px 8px",
          cursor: "pointer",
          font: "600 11px/1 'Segoe UI', sans-serif",
          background: "linear-gradient(180deg, rgba(245, 248, 252, 0.96), rgba(224, 232, 243, 0.96))",
          color: "#41597a",
          boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.52)"
        });
      }

      simpleButton.textContent = "Simple";
      richButton.textContent = "Rendered";

      Object.assign(body.style, {
        font: "14px/1.55 'Segoe UI', sans-serif",
        color: "#22374d",
        overflowWrap: "anywhere",
        width: "100%",
        maxWidth: "100%",
        minWidth: "0",
        boxSizing: "border-box"
      });

      const updateView = () => {
        const isAssistant = record.role === "assistant";
        const roleSimpleBackground = isAssistant
          ? "linear-gradient(180deg, rgba(218, 226, 239, 0.98), rgba(208, 218, 234, 0.97))"
          : "linear-gradient(180deg, rgba(224, 231, 242, 0.98), rgba(213, 223, 238, 0.97))";
        const roleRichBackground = isAssistant
          ? "linear-gradient(180deg, rgba(236, 241, 248, 0.99), rgba(225, 232, 244, 0.97))"
          : "linear-gradient(180deg, rgba(239, 244, 250, 0.99), rgba(228, 235, 246, 0.97))";
        const roleSimpleBorder = isAssistant
          ? "1px solid rgba(92, 112, 148, 0.26)"
          : "1px solid rgba(104, 119, 151, 0.24)";
        const roleRichBorder = isAssistant
          ? "1px solid rgba(116, 132, 163, 0.22)"
          : "1px solid rgba(126, 139, 166, 0.20)";

        if (
          !isManualEntry
          && this.settings.dynamicScroll
          && record.viewMode === "rich"
          && !record.richHtml
          && !record.richRequestPending
          && this.hasManualArchivePayload(record)
          && this.getRecordSourceNodes(record).length
        ) {
          this.requestRichSnapshot(record);
        }

        const manualRenderedReady = isManualEntry && this.hasStrictArchiveHtml(record.renderedHtml);
        if (isManualEntry && record.viewMode === "rich" && !manualRenderedReady) {
          record.viewMode = "simple";
        }

        let renderedSource = "simple";
        if (isManualEntry && record.viewMode === "rich" && manualRenderedReady) {
          renderedSource = "manualRenderedHtml";
        } else if (isManualEntry) {
          renderedSource = "manualSimple";
        } else if (record.viewMode === "rich" && record.richHtml) {
          renderedSource = "richHtml";
        } else if (record.viewMode === "rich" && record.snapshotState === "ready" && record.snapshotHtml) {
          renderedSource = "snapshotHtml";
        } else if (record.viewMode === "rich" && record.richRequestPending) {
          renderedSource = "pending";
        } else if (record.viewMode === "rich" && !isManualEntry && !this.hasManualArchivePayload(record)) {
          renderedSource = "indexing";
        } else if (record.viewMode === "rich") {
          renderedSource = "snapshotFallbackMessage";
        }

        body.innerHTML = this.getArchiveBodyHtml(record);
        this.styleArchiveBody(body, record.viewMode);
        this.applyArchiveRenderProfile(body, record);
        this.syncSimplePreviewState(body, record, updateView);
        this.logger.info("archive-block:update-view", {
          id: record.id,
          viewMode: record.viewMode,
          renderedSource,
          hasRich: isManualEntry ? this.hasStrictArchiveHtml(record.renderedHtml) : this.hasStrictArchiveHtml(record.richHtml),
          hasManualSimpleHtml: isManualEntry ? this.hasStrictArchiveHtml(record.simpleHtml) : undefined,
          hasManualRenderedHtml: isManualEntry ? this.hasStrictArchiveHtml(record.renderedHtml) : undefined,
          richRequestPending: isManualEntry ? false : Boolean(record.richRequestPending),
          snapshotState: isManualEntry ? "manual-ready" : (record.snapshotState || "empty"),
          hasSnapshotHtml: isManualEntry ? this.hasStrictArchiveHtml(record.simpleHtml) : this.hasStrictArchiveHtml(record.snapshotHtml),
          bodyTextPreview: (body.textContent || "").trim().slice(0, 120)
        });

        label.style.color = isAssistant ? "#657da2" : "#6f7fa1";
        article.style.background = record.viewMode === "simple" ? roleSimpleBackground : roleRichBackground;
        article.style.border = record.viewMode === "simple" ? roleSimpleBorder : roleRichBorder;
        actions.style.display = this.settings.dynamicScroll ? "none" : "flex";
        collapseOlderButton.style.display = this.settings.dynamicScroll ? "none" : "block";
        header.style.paddingRight = this.settings.dynamicScroll ? "0" : "28px";

        simpleButton.disabled = record.viewMode === "simple";
        const hasRenderedView = isManualEntry
          ? manualRenderedReady
          : this.hasStrictArchiveHtml(record.richHtml);
        richButton.disabled = isManualEntry
          ? (!manualRenderedReady || record.viewMode === "rich")
          : (record.viewMode === "rich" && hasRenderedView);
        simpleButton.style.opacity = simpleButton.disabled ? "1" : "0.72";
        richButton.style.opacity = (record.viewMode === "rich" || (!isManualEntry && record.richRequestPending)) ? "1" : "0.72";
        simpleButton.style.background = simpleButton.disabled
          ? "linear-gradient(180deg, rgba(112, 151, 222, 0.30), rgba(85, 120, 188, 0.24))"
          : "linear-gradient(180deg, rgba(245, 248, 252, 0.96), rgba(224, 232, 243, 0.96))";
        richButton.style.background = (record.viewMode === "rich" || (!isManualEntry && record.richRequestPending))
          ? "linear-gradient(180deg, rgba(112, 151, 222, 0.30), rgba(85, 120, 188, 0.24))"
          : "linear-gradient(180deg, rgba(245, 248, 252, 0.96), rgba(224, 232, 243, 0.96))";
        simpleButton.style.border = simpleButton.disabled
          ? "1px solid rgba(77, 114, 180, 0.24)"
          : "1px solid rgba(112, 130, 164, 0.20)";
        richButton.style.border = (record.viewMode === "rich" || (!isManualEntry && record.richRequestPending))
          ? "1px solid rgba(77, 114, 180, 0.24)"
          : "1px solid rgba(112, 130, 164, 0.20)";
        simpleButton.style.color = simpleButton.disabled ? "#2e4a72" : "#445c7e";
        richButton.style.color = (record.viewMode === "rich" || (!isManualEntry && record.richRequestPending)) ? "#2e4a72" : "#445c7e";
      };

      simpleButton.addEventListener("click", () => {
        this.clearDynamicScrollTimer();
        record.dynamicAutoExpanded = false;
        record.simpleExpanded = false;
        if (this.dynamicScrollActiveId === record.id) {
          this.dynamicScrollActiveId = "";
        }
        if (this.dynamicScrollTargetId === record.id) {
          this.dynamicScrollTargetId = "";
        }
        record.viewMode = "simple";
        updateView();
      });

      richButton.addEventListener("click", () => {
        this.clearDynamicScrollTimer();
        record.dynamicAutoExpanded = false;
        record.simpleExpanded = false;
        if (this.dynamicScrollActiveId === record.id) {
          this.dynamicScrollActiveId = "";
        }
        if (this.dynamicScrollTargetId === record.id) {
          this.dynamicScrollTargetId = "";
        }
        if (isManualEntry && !this.hasStrictArchiveHtml(record.renderedHtml)) {
          return;
        }
        record.viewMode = "rich";
        if (!isManualEntry && !record.richHtml) {
          this.requestRichSnapshot(record);
        }
        this.logger.info("archive-block:rendered-click", {
          id: record.id,
          hasRich: isManualEntry ? this.hasStrictArchiveHtml(record.renderedHtml) : this.hasStrictArchiveHtml(record.richHtml),
          hasManualSimpleHtml: isManualEntry ? this.hasStrictArchiveHtml(record.simpleHtml) : undefined,
          hasManualRenderedHtml: isManualEntry ? this.hasStrictArchiveHtml(record.renderedHtml) : undefined,
          richRequestPending: isManualEntry ? false : Boolean(record.richRequestPending),
          snapshotState: isManualEntry ? "manual-ready" : (record.snapshotState || "empty"),
          hasSnapshotHtml: isManualEntry ? this.hasStrictArchiveHtml(record.simpleHtml) : this.hasStrictArchiveHtml(record.snapshotHtml)
        });
        updateView();
      });

      actions.appendChild(simpleButton);
      actions.appendChild(richButton);

      header.appendChild(label);
      header.appendChild(actions);

      updateView();

      article.appendChild(collapseOlderButton);
      article.appendChild(header);
      article.appendChild(body);
      record.archiveBlock = article;
      record.refreshArchiveBlock = updateView;
      return article;
    }

    getArchiveBodyHtml(record) {
      const isManualEntry = this.isManualArchiveEntry(record);

      if (isManualEntry) {
        if (record.viewMode === "rich") {
          if (this.hasStrictArchiveHtml(record.renderedHtml)) {
            return record.renderedHtml;
          }

          return "";
        }

        if (this.hasUsableArchiveText(record.simpleText)) {
          const preview = this.getSimplePreviewText({
            plainTextFallback: record.simpleText,
            simpleExpanded: record.simpleExpanded
          });
          return this.renderFastPreviewHtml(preview.text);
        }

        if (this.hasStrictArchiveHtml(record.simpleHtml)) {
          return record.simpleHtml;
        }

        return this.hasStrictArchiveHtml(record.renderedHtml)
          ? record.renderedHtml
          : "";
      }

      if (record.viewMode === "rich" && this.hasStrictArchiveHtml(record.richHtml)) {
        return record.richHtml;
      }

      if (record.viewMode === "rich") {
        if (record.snapshotState === "ready" && this.hasStrictArchiveHtml(record.snapshotHtml)) {
          return record.snapshotHtml;
        }

        if (!isManualEntry && (record.richRequestPending || record.plainTextPending || record.indexState === "queued" || record.indexState === "capturing")) {
          return "<p>Preparing rendered archived message...</p>";
        }

        if (record.snapshotState === "failed" || record.indexState === "failed") {
          return "<p>Archived content unavailable.</p>";
        }

        return this.hasUsableArchiveText(record.plainTextFallback)
          ? this.renderPlainTextHtml(record.plainTextFallback)
          : "<p>Archived content unavailable.</p>";
      }

      if (this.hasUsableArchiveText(record.plainTextFallback)) {
        const preview = this.getSimplePreviewText(record);
        return this.renderFastPreviewHtml(preview.text);
      }

      if (record.snapshotState === "ready" && this.hasStrictArchiveHtml(record.snapshotHtml)) {
        return record.snapshotHtml;
      }

      if (record.snapshotState === "failed" || record.indexState === "failed") {
        return "<p>Archived content unavailable.</p>";
      }

      if (isManualEntry && this.hasStrictArchiveHtml(record.snapshotHtml)) {
        return record.snapshotHtml;
      }

      return "<p>Preparing archived message...</p>";
    }

    getDefaultArchiveViewMode() {
      if (this.settings.dynamicScroll) {
        return "simple";
      }

      return this.settings.archiveDefaultRendered ? "rich" : "simple";
    }

    ensureTableScrollWrappers(body) {
      if (!(body instanceof HTMLElement)) {
        return;
      }

      for (const table of body.querySelectorAll("table")) {
        if (!(table instanceof HTMLElement)) {
          continue;
        }

        let scrollHost = table.parentElement;
        if (!(scrollHost instanceof HTMLElement) || !scrollHost.hasAttribute("data-rapid-view-for-chatgpt-table-scroll")) {
          const nextScrollHost = document.createElement("div");
          nextScrollHost.setAttribute("data-rapid-view-for-chatgpt-table-scroll", "true");
          table.parentNode.insertBefore(nextScrollHost, table);
          nextScrollHost.appendChild(table);
          scrollHost = nextScrollHost;
        }

        let shell = scrollHost.parentElement;
        if (!(shell instanceof HTMLElement) || !shell.hasAttribute("data-rapid-view-for-chatgpt-table-shell")) {
          const nextShell = document.createElement("div");
          nextShell.setAttribute("data-rapid-view-for-chatgpt-table-shell", "true");
          scrollHost.parentNode.insertBefore(nextShell, scrollHost);
          nextShell.appendChild(scrollHost);
          shell = nextShell;
        }

        Object.assign(shell.style, {
          display: "block",
          width: "100%",
          maxWidth: "100%",
          minWidth: "0",
          boxSizing: "border-box",
          overflow: "hidden",
          margin: "0 0 10px"
        });

        Object.assign(scrollHost.style, {
          display: "block",
          width: "100%",
          maxWidth: "100%",
          minWidth: "0",
          boxSizing: "border-box",
          overflowX: "hidden",
          overflowY: "visible",
          margin: "0",
          WebkitOverflowScrolling: "touch"
        });
      }
    }

    getResponsiveTableColumnCount(table) {
      if (!(table instanceof HTMLTableElement)) {
        return 1;
      }

      let maxColumnCount = 1;
      for (const row of Array.from(table.rows)) {
        let columnCount = 0;
        for (const cell of Array.from(row.cells)) {
          columnCount += Math.max(1, cell.colSpan || 1);
        }
        maxColumnCount = Math.max(maxColumnCount, columnCount);
      }

      return maxColumnCount;
    }

    applyResponsiveTableFallback(table) {
      if (!(table instanceof HTMLTableElement)) {
        return;
      }

      const columnCount = this.getResponsiveTableColumnCount(table);
      table.setAttribute("data-rapid-view-for-chatgpt-table-responsive", "true");

      Object.assign(table.style, {
        display: "block",
        width: "100%",
        maxWidth: "100%",
        minWidth: "0",
        tableLayout: "fixed",
        borderCollapse: "separate",
        borderSpacing: "0",
        margin: "0"
      });

      for (const section of table.querySelectorAll("thead, tbody, tfoot")) {
        if (!(section instanceof HTMLElement)) {
          continue;
        }

        Object.assign(section.style, {
          display: "block",
          width: "100%",
          maxWidth: "100%",
          minWidth: "0"
        });
      }

      for (const row of table.querySelectorAll("tr")) {
        if (!(row instanceof HTMLElement)) {
          continue;
        }

        Object.assign(row.style, {
          display: "grid",
          gridTemplateColumns: `repeat(${Math.max(1, columnCount)}, minmax(0, 1fr))`,
          width: "100%",
          maxWidth: "100%",
          minWidth: "0"
        });
      }

      for (const cell of table.querySelectorAll("th, td")) {
        if (!(cell instanceof HTMLElement)) {
          continue;
        }

        const span = Math.max(1, cell.colSpan || 1);
        Object.assign(cell.style, {
          display: "block",
          width: "auto",
          maxWidth: "100%",
          minWidth: "0",
          whiteSpace: "normal",
          overflowWrap: "anywhere",
          wordBreak: "break-word",
          verticalAlign: "top",
          boxSizing: "border-box",
          gridColumn: span > 1 ? `span ${span}` : "auto"
        });
      }
    }

    syncResponsiveTables(body) {
      if (!(body instanceof HTMLElement)) {
        return;
      }

      if (!body.isConnected) {
        if (!body.__rapidViewForChatGptTableSyncQueued) {
          body.__rapidViewForChatGptTableSyncQueued = true;
          global.requestAnimationFrame(() => {
            body.__rapidViewForChatGptTableSyncQueued = false;
            if (body.isConnected) {
              this.syncResponsiveTables(body);
            }
          });
        }
        return;
      }

      for (const table of body.querySelectorAll("table")) {
        if (!(table instanceof HTMLTableElement)) {
          continue;
        }

        const shell = table.closest("[data-rapid-view-for-chatgpt-table-shell]");
        const container = shell instanceof HTMLElement ? shell : body;
        const containerRect = container.getBoundingClientRect();
        const tableRect = table.getBoundingClientRect();
        const tableWidth = Math.max(table.scrollWidth, tableRect.width);
        const containerWidth = Math.max(container.clientWidth, containerRect.width);
        const cellOverflows = Array.from(table.querySelectorAll("th, td")).some((cell) => {
          if (!(cell instanceof HTMLElement)) {
            return false;
          }
          const cellRect = cell.getBoundingClientRect();
          return cellRect.right > containerRect.right + 1;
        });

        if (
          tableWidth > containerWidth + 1
          || tableRect.right > containerRect.right + 1
          || cellOverflows
        ) {
          this.applyResponsiveTableFallback(table);
        }
      }
    }

    applyArchiveRenderProfile(body, record) {
      if (!(body instanceof HTMLElement) || !record || record.viewMode !== "rich") {
        return;
      }

      const profile = record.renderProfile && typeof record.renderProfile === "object"
        ? record.renderProfile
        : null;
      const rootProfile = profile && profile.root && typeof profile.root === "object"
        ? profile.root
        : null;
      const plainTextElementProfile = profile && Array.isArray(profile.elements)
        ? profile.elements.find((entry) => entry && entry.kind === "plainText" && entry.style)?.style || null
        : null;
      const plainTextLike = this.isArchiveRenderedBodyPlainTextLike(body);
      const shouldPreservePlainText = record.role === "user"
        && (
          plainTextLike
          || !profile
          || profile.sourceKind === "plainText"
          || profile.sourceKind === "mixed"
        );
      const effectiveRootProfile = shouldPreservePlainText && plainTextElementProfile
        ? plainTextElementProfile
        : rootProfile;
      const style = this.buildArchiveRenderProfileStyle(effectiveRootProfile, shouldPreservePlainText);

      if (!Object.keys(style).length) {
        return;
      }

      for (const target of this.getArchiveRenderProfileTargets(body, shouldPreservePlainText)) {
        Object.assign(target.style, style);
      }
    }

    buildArchiveRenderProfileStyle(rootProfile, shouldPreservePlainText) {
      const style = {};
      const profiledWhiteSpace = this.normalizeArchiveRenderStyleValue("whiteSpace", rootProfile?.whiteSpace || "");
      const whiteSpace = shouldPreservePlainText && (!profiledWhiteSpace || profiledWhiteSpace === "normal")
        ? "pre-wrap"
        : profiledWhiteSpace;

      if (whiteSpace && (shouldPreservePlainText || whiteSpace !== "normal")) {
        style.whiteSpace = whiteSpace;
      }

      const profiledOverflowWrap = this.normalizeArchiveRenderStyleValue("overflowWrap", rootProfile?.overflowWrap || "");
      const overflowWrap = shouldPreservePlainText && (!profiledOverflowWrap || profiledOverflowWrap === "normal")
        ? "anywhere"
        : profiledOverflowWrap;
      if (overflowWrap && (shouldPreservePlainText || overflowWrap !== "normal")) {
        style.overflowWrap = overflowWrap;
      }

      const wordBreak = this.normalizeArchiveRenderStyleValue("wordBreak", rootProfile?.wordBreak || "");
      if (wordBreak && wordBreak !== "normal") {
        style.wordBreak = wordBreak;
      }

      const direction = this.normalizeArchiveRenderStyleValue("direction", rootProfile?.direction || "");
      if (direction) {
        style.direction = direction;
      }

      const textAlign = this.normalizeArchiveRenderStyleValue("textAlign", rootProfile?.textAlign || "");
      if (textAlign && textAlign !== "start") {
        style.textAlign = textAlign;
      }

      const tabSize = this.normalizeArchiveRenderStyleValue("tabSize", rootProfile?.tabSize || "");
      if (tabSize && style.whiteSpace && style.whiteSpace !== "normal") {
        style.tabSize = tabSize;
      }

      return style;
    }

    getArchiveRenderProfileTargets(body, shouldPreservePlainText) {
      const targets = [body];
      if (!shouldPreservePlainText) {
        return targets;
      }

      const firstContentElement = Array.from(body.children).find((child) => (
        child instanceof HTMLElement
        && !child.matches("pre, code, table, thead, tbody, tr, th, td, ul, ol, li, blockquote")
      ));

      if (firstContentElement) {
        targets.push(firstContentElement);
      }

      return targets;
    }

    isArchiveRenderedBodyPlainTextLike(body) {
      if (!(body instanceof HTMLElement) || !(body.textContent || "").trim()) {
        return false;
      }

      return !body.querySelector(
        "pre, table, ul, ol, blockquote, h1, h2, h3, h4, h5, h6, [data-rapid-view-for-chatgpt-code-block], [data-rapid-view-for-chatgpt-table-shell], [data-rapid-view-for-chatgpt-latex], [data-rapid-view-for-chatgpt-rich-placeholder], img, picture, canvas, svg, video, audio, iframe, object, embed, hr"
      );
    }

    styleArchiveBody(body, viewMode) {
      Object.assign(body.style, {
        font: viewMode === "rich" ? "14px/1.55 'Segoe UI', sans-serif" : "14px/1.6 'Segoe UI', sans-serif",
        color: viewMode === "rich" ? "#25394f" : "#20344a",
        overflowWrap: "anywhere",
        whiteSpace: "",
        wordBreak: "",
        direction: "",
        textAlign: "",
        tabSize: "",
        width: "100%",
        maxWidth: "100%",
        minWidth: "0",
        boxSizing: "border-box"
      });

      for (const element of body.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
        Object.assign(element.style, {
          margin: "0 0 10px",
          lineHeight: "1.25",
          color: "#1e3450"
        });
      }

      for (const element of body.querySelectorAll("p")) {
        Object.assign(element.style, {
          margin: "0 0 10px"
        });
      }

      for (const preview of body.querySelectorAll("[data-rapid-view-for-chatgpt-plain-preview]")) {
        Object.assign(preview.style, {
          whiteSpace: "pre-wrap",
          margin: "0",
          color: viewMode === "rich" ? "#25394f" : "#20344a",
          font: viewMode === "rich" ? "14px/1.55 'Segoe UI', sans-serif" : "14px/1.6 'Segoe UI', sans-serif"
        });
      }

      for (const toggle of body.querySelectorAll("[data-rapid-view-for-chatgpt-simple-toggle]")) {
        this.styleSimplePreviewToggle(toggle);
      }

      for (const element of body.querySelectorAll("ul, ol")) {
        Object.assign(element.style, {
          margin: "0 0 10px",
          paddingLeft: "22px"
        });
      }

      for (const element of body.querySelectorAll("li")) {
        Object.assign(element.style, {
          marginBottom: "6px"
        });
      }

      for (const element of body.querySelectorAll("blockquote")) {
        Object.assign(element.style, {
          margin: "0 0 10px",
          padding: "4px 0 4px 12px",
          borderLeft: "3px solid rgba(80, 110, 168, 0.30)",
          color: "#4d6586",
          background: "rgba(126, 149, 191, 0.06)"
        });
      }

      for (const element of body.querySelectorAll("hr")) {
        Object.assign(element.style, {
          margin: "12px 0",
          border: "0",
          borderTop: "1px solid rgba(88, 108, 142, 0.16)"
        });
      }

      for (const codeBlock of body.querySelectorAll("[data-rapid-view-for-chatgpt-code-block]")) {
        Object.assign(codeBlock.style, {
          display: "block",
          width: "100%",
          maxWidth: "100%",
          minWidth: "0",
          margin: "0 0 12px",
          border: "1px solid rgba(101, 120, 154, 0.20)",
          borderRadius: "12px",
          overflow: "visible",
          boxSizing: "border-box",
          background: viewMode === "rich"
            ? "linear-gradient(180deg, rgba(225, 232, 243, 0.98), rgba(214, 223, 238, 0.96))"
            : "linear-gradient(180deg, rgba(216, 225, 240, 0.98), rgba(205, 216, 234, 0.96))"
        });
      }

      for (const codeHeader of body.querySelectorAll("[data-rapid-view-for-chatgpt-code-header]")) {
        Object.assign(codeHeader.style, {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
          padding: "8px 10px",
          background: viewMode === "rich"
            ? "linear-gradient(180deg, rgba(214, 224, 239, 0.98), rgba(202, 214, 233, 0.96))"
            : "linear-gradient(180deg, rgba(206, 218, 236, 0.98), rgba(194, 207, 228, 0.96))",
          borderBottom: "1px solid rgba(102, 121, 155, 0.14)"
        });
      }

      for (const language of body.querySelectorAll("[data-rapid-view-for-chatgpt-code-language]")) {
        Object.assign(language.style, {
          display: "inline-flex",
          alignItems: "center",
          minHeight: "24px",
          padding: "0 10px",
          borderRadius: "999px",
          background: "linear-gradient(180deg, rgba(245, 249, 255, 0.98), rgba(227, 235, 246, 0.96))",
          color: "#3a5374",
          font: "600 11px/1 'Segoe UI', sans-serif"
        });
      }

      for (const copyButton of body.querySelectorAll("[data-rapid-view-for-chatgpt-copy-code]")) {
        Object.assign(copyButton.style, {
          border: "1px solid rgba(103, 122, 156, 0.20)",
          borderRadius: "999px",
          padding: "5px 10px",
          background: "linear-gradient(180deg, rgba(245, 249, 255, 0.98), rgba(227, 235, 246, 0.96))",
          color: "#3a5374",
          font: "600 11px/1 'Segoe UI', sans-serif",
          cursor: "pointer",
          boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.48)"
        });

        copyButton.addEventListener("click", async () => {
          const value = copyButton.getAttribute("data-rapid-view-for-chatgpt-copy-value") || "";
          try {
            await navigator.clipboard.writeText(value);
            const previousText = copyButton.textContent;
            copyButton.textContent = "Copied";
            global.setTimeout(() => {
              copyButton.textContent = previousText || "Copy";
            }, 1200);
          } catch (error) {
            this.logger.warn("archive-code-copy-failed", {
              message: error && error.message ? error.message : String(error)
            });
          }
        });
      }

      for (const pre of body.querySelectorAll("pre")) {
        Object.assign(pre.style, {
          display: "block",
          width: "100%",
          maxWidth: "100%",
          minWidth: "0",
          whiteSpace: "pre",
          overflowX: "auto",
          overflowY: "visible",
          padding: "12px",
          margin: pre.closest("[data-rapid-view-for-chatgpt-code-block]") ? "0" : "0 0 10px",
          borderRadius: "10px",
          background: viewMode === "rich" ? "rgba(205, 216, 234, 0.86)" : "rgba(194, 207, 228, 0.88)",
          color: "#22364d",
          font: "12px/1.5 Consolas, 'Courier New', monospace",
          boxSizing: "border-box",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "thin"
        });
      }

      for (const code of body.querySelectorAll("code")) {
        if (code.parentElement && code.parentElement.tagName === "PRE") {
          Object.assign(code.style, {
            display: "block",
            width: "max-content",
            minWidth: "100%",
            maxWidth: "none",
            whiteSpace: "pre",
            padding: "0",
            background: "transparent",
            color: "#22364d",
            font: "12px/1.5 Consolas, 'Courier New', monospace",
            boxSizing: "border-box",
            overflow: "visible"
          });
          continue;
        }

        const isLatex = code.hasAttribute("data-rapid-view-for-chatgpt-latex");
        Object.assign(code.style, {
          display: isLatex ? "inline-block" : "inline",
          padding: isLatex ? "4px 8px" : "1px 4px",
          margin: isLatex ? "2px 0" : "0",
          borderRadius: "6px",
          background: isLatex
            ? (viewMode === "rich" ? "rgba(173, 189, 216, 0.34)" : "rgba(151, 171, 208, 0.38)")
            : (viewMode === "rich" ? "rgba(83, 109, 158, 0.10)" : "rgba(78, 103, 149, 0.14)"),
          color: "#27435f",
          font: "12px/1.45 Consolas, 'Courier New', monospace"
        });
      }

      for (const nestedCodeElement of body.querySelectorAll("[data-rapid-view-for-chatgpt-code-block] pre code *")) {
        if (!(nestedCodeElement instanceof HTMLElement)) {
          continue;
        }

        nestedCodeElement.style.font = "inherit";
        nestedCodeElement.style.color = "inherit";

        if (nestedCodeElement.tagName.toLowerCase() === "span") {
          nestedCodeElement.style.whiteSpace = "inherit";
        }
      }

      for (const latexBlock of body.querySelectorAll("div[data-rapid-view-for-chatgpt-latex]")) {
        Object.assign(latexBlock.style, {
          margin: "0 0 10px",
          padding: "8px 10px",
          borderRadius: "8px",
          background: viewMode === "rich" ? "rgba(187, 200, 224, 0.28)" : "rgba(161, 179, 212, 0.32)",
          font: "12px/1.5 Consolas, 'Courier New', monospace",
          color: "#27435f"
        });
      }

      for (const tableShell of body.querySelectorAll("[data-rapid-view-for-chatgpt-table-shell]")) {
        if (!(tableShell instanceof HTMLElement)) {
          continue;
        }

        Object.assign(tableShell.style, {
          display: "block",
          width: "100%",
          maxWidth: "100%",
          minWidth: "0",
          margin: "0 0 10px",
          border: "1px solid rgba(95, 114, 147, 0.16)",
          borderRadius: "10px",
          overflow: "hidden",
          boxSizing: "border-box",
          background: viewMode === "rich"
            ? "rgba(233, 239, 248, 0.82)"
            : "rgba(223, 232, 244, 0.86)"
        });
      }

      for (const tableScrollHost of body.querySelectorAll("[data-rapid-view-for-chatgpt-table-scroll]")) {
        if (!(tableScrollHost instanceof HTMLElement)) {
          continue;
        }

        Object.assign(tableScrollHost.style, {
          display: "block",
          width: "100%",
          maxWidth: "100%",
          minWidth: "0",
          overflowX: "auto",
          overflowY: "hidden",
          boxSizing: "border-box",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "thin"
        });
      }

      for (const tableTrack of body.querySelectorAll("[data-rapid-view-for-chatgpt-table-track]")) {
        if (!(tableTrack instanceof HTMLElement)) {
          continue;
        }

        Object.assign(tableTrack.style, {
          display: "inline-flex",
          alignItems: "stretch",
          width: "max-content",
          minWidth: "100%",
          maxWidth: "none",
          boxSizing: "border-box"
        });
      }

      for (const tableElement of body.querySelectorAll("[data-rapid-view-for-chatgpt-table]")) {
        if (!(tableElement instanceof HTMLElement)) {
          continue;
        }

        Object.assign(tableElement.style, {
          display: "table",
          flex: "0 0 auto",
          width: "max-content",
          minWidth: "calc(100% - 24px)",
          maxWidth: "none",
          margin: "0",
          tableLayout: "auto",
          borderCollapse: "collapse",
          borderSpacing: "0",
          boxSizing: "border-box",
          background: "transparent"
        });
      }

      for (const endGutter of body.querySelectorAll("[data-rapid-view-for-chatgpt-table-end-gutter]")) {
        if (!(endGutter instanceof HTMLElement)) {
          continue;
        }

        Object.assign(endGutter.style, {
          display: "block",
          flex: "0 0 24px",
          width: "24px",
          minWidth: "24px",
          pointerEvents: "none",
          background: "transparent"
        });
      }

      for (const cell of body.querySelectorAll("[data-rapid-view-for-chatgpt-table] th, [data-rapid-view-for-chatgpt-table] td")) {
        if (!(cell instanceof HTMLElement)) {
          continue;
        }

        const isHeader = cell.hasAttribute("data-rapid-view-for-chatgpt-table-header") || cell.tagName.toLowerCase() === "th";
        Object.assign(cell.style, {
          padding: "8px 10px",
          border: "1px solid rgba(95, 114, 147, 0.16)",
          boxSizing: "border-box",
          textAlign: "left",
          verticalAlign: "top",
          color: isHeader ? "#233a57" : "#25394f",
          font: isHeader ? "600 13px/1.45 'Segoe UI', sans-serif" : "400 14px/1.55 'Segoe UI', sans-serif",
          background: isHeader
            ? (viewMode === "rich" ? "rgba(219, 228, 241, 0.72)" : "rgba(208, 221, 239, 0.76)")
            : "transparent"
        });
      }

      for (const content of body.querySelectorAll("[data-rapid-view-for-chatgpt-table-cell-content]")) {
        if (!(content instanceof HTMLElement)) {
          continue;
        }

        Object.assign(content.style, {
          display: "block",
          width: "max-content",
          minWidth: "100%",
          maxWidth: "none",
          boxSizing: "border-box",
          whiteSpace: "normal",
          overflowWrap: "normal",
          wordBreak: "normal"
        });

        for (const block of content.querySelectorAll("p, div, blockquote, ul, ol, li, h1, h2, h3, h4, h5, h6, section")) {
          if (!(block instanceof HTMLElement)) {
            continue;
          }

          if (block.closest("[data-rapid-view-for-chatgpt-code-block]")) {
            continue;
          }

          if (block.closest("[data-rapid-view-for-chatgpt-table-cell-content]") !== content) {
            continue;
          }

          Object.assign(block.style, {
            width: "max-content",
            maxWidth: "none",
            minWidth: "0",
            boxSizing: "border-box",
            whiteSpace: "normal",
            overflowWrap: "normal",
            wordBreak: "normal"
          });
        }

        for (const inner of content.querySelectorAll("*")) {
          if (!(inner instanceof HTMLElement)) {
            continue;
          }

          if (inner.hasAttribute("data-rapid-view-for-chatgpt-code-block") || inner.closest("[data-rapid-view-for-chatgpt-code-block]")) {
            continue;
          }

          Object.assign(inner.style, {
            maxWidth: "none",
            minWidth: "0",
            boxSizing: "border-box",
            whiteSpace: "inherit",
            overflowWrap: "inherit",
            wordBreak: "inherit"
          });
        }
      }

      for (const link of body.querySelectorAll("a")) {
        link.style.color = "#315fbd";
      }

      for (const placeholder of body.querySelectorAll("[data-rapid-view-for-chatgpt-rich-placeholder]")) {
        Object.assign(placeholder.style, {
          margin: "0 0 10px",
          padding: "10px 12px",
          borderRadius: "10px",
          background: "rgba(169, 184, 209, 0.24)",
          color: "#576f92",
          font: "12px/1.4 'Segoe UI', sans-serif"
        });
      }

    }

    styleSimplePreviewToggle(toggle) {
      if (!(toggle instanceof HTMLElement)) {
        return;
      }

      Object.assign(toggle.style, {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        marginTop: "10px",
        padding: "6px 10px",
        border: "1px solid rgba(104, 122, 157, 0.20)",
        borderRadius: "999px",
        background: "linear-gradient(180deg, rgba(245, 248, 252, 0.96), rgba(223, 231, 242, 0.96))",
        color: "#40597a",
        font: "600 11px/1 'Segoe UI', sans-serif",
        cursor: "pointer",
        boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.52)"
      });
    }

    getSimplePreviewCollapsedHeight(preview) {
      if (!(preview instanceof HTMLElement)) {
        return 0;
      }

      const computed = global.getComputedStyle(preview);
      const parsedLineHeight = parseFloat(computed.lineHeight);
      const fontSize = parseFloat(computed.fontSize) || 14;
      const lineHeight = Number.isFinite(parsedLineHeight) ? parsedLineHeight : fontSize * 1.6;
      return Math.ceil(lineHeight * LIMITS.simplePreviewMaxLines + 1);
    }

    syncSimplePreviewState(body, record, refreshView) {
      if (!record || record.viewMode !== "simple") {
        return;
      }

      const preview = body.querySelector("[data-rapid-view-for-chatgpt-plain-preview]");
      if (!(preview instanceof HTMLElement)) {
        return;
      }

      if (!preview.isConnected) {
        if (!record.simplePreviewMeasureQueued) {
          record.simplePreviewMeasureQueued = true;
          global.requestAnimationFrame(() => {
            record.simplePreviewMeasureQueued = false;
            if (
              record.archiveBlock instanceof HTMLElement
              && record.archiveBlock.isConnected
              && typeof refreshView === "function"
            ) {
              refreshView();
            }
          });
        }
        return;
      }

      const collapsedPreview = this.getCollapsedSimplePreview(record);
      const collapsedHeight = this.getSimplePreviewCollapsedHeight(preview);
      const needsToggle = collapsedPreview.truncated || preview.scrollHeight > collapsedHeight + 1;

      if (needsToggle && !record.simpleExpanded) {
        preview.style.maxHeight = `${collapsedHeight}px`;
        preview.style.overflow = "hidden";
      } else {
        preview.style.maxHeight = "none";
        preview.style.overflow = "visible";
      }

      const existingToggle = body.querySelector("[data-rapid-view-for-chatgpt-simple-toggle]");
      if (existingToggle instanceof HTMLElement) {
        existingToggle.remove();
      }

      if (!needsToggle) {
        return;
      }

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.setAttribute("data-rapid-view-for-chatgpt-simple-toggle", "true");
      toggle.textContent = record.simpleExpanded ? "Collapse simple" : "Show full simple";
      this.styleSimplePreviewToggle(toggle);
      toggle.addEventListener("click", () => {
        record.simpleExpanded = !record.simpleExpanded;
        refreshView();
      });
      body.appendChild(toggle);
    }

    getFirstLiveNode() {
      for (const record of this.records) {
        if (record.state === "live") {
          const liveNode = this.getRecordPrimaryLiveNode(record);
          if (liveNode) {
            return liveNode;
          }
        }
      }

      return null;
    }

    getManualArchiveInsertionNode() {
      const liveTurnCount = Math.min(this.records.length, this.getManualLiveTurnCount());
      const firstLiveIndex = Math.max(0, this.records.length - liveTurnCount);

      for (let index = firstLiveIndex; index < this.records.length; index += 1) {
        const record = this.records[index];
        if (record && record.state === "live") {
          const liveNode = this.getRecordPrimaryLiveNode(record);
          if (liveNode) {
            return liveNode;
          }
        }
      }

      return this.getFirstLiveNode();
    }

    showEntireHistory() {
      this.resetDynamicScrollTracking(false);

      for (const record of this.records) {
        this.restorePendingManualRecord(record);
      }

      if (this.settings.dynamicScroll) {
        for (const record of this.records) {
          if (record.state !== "live") {
            record.state = "visibleArchive";
            record.keepVisible = false;
            record.simpleExpanded = false;
            record.dynamicAutoExpanded = false;
            record.viewMode = this.getDefaultArchiveViewMode();
          }
        }
        this.hiddenCount = 0;
        this.syncArchiveUi();
        return;
      }

      for (const record of this.records) {
        const entry = this.getManualArchiveEntry(record);
        if (this.hasStrictReadyManualArchiveEntry(entry)) {
          this.markManualArchiveEntryRestored(entry);
          entry.visible = true;
          entry.viewMode = entry.viewMode || this.getDefaultArchiveViewMode();
          record.state = "visibleArchive";
          record.keepVisible = false;
          record.archivePending = false;
          continue;
        }

        record.state = "live";
        record.keepVisible = false;
        record.archivePending = false;
        if (record.nodes.some((node) => node instanceof HTMLElement && node.parentElement !== this.root)) {
          this.mountRecordNodesBefore(record, null);
        }
      }

      this.hiddenCount = 0;
      this.syncArchiveUi();
    }

    prepareDefaultLoadMoreState() {
      this.manualUserRestoredArchiveIds.clear();

      if (this.settings.dynamicScroll) {
        const liveTurnCount = Math.min(this.records.length, this.settings.liveTurnCount);
        const firstLiveIndex = Math.max(0, this.records.length - liveTurnCount);
        const defaultViewMode = this.getDefaultArchiveViewMode();

        for (let index = 0; index < this.records.length; index += 1) {
          const record = this.records[index];
          this.restorePendingManualRecord(record);
          record.keepVisible = false;
          record.simpleExpanded = false;
          record.dynamicAutoExpanded = false;

          if (index < firstLiveIndex && this.hasManualArchivePayload(record)) {
            record.state = "hidden";
            record.archivePending = false;
            record.viewMode = defaultViewMode;
          } else {
            record.state = "live";
            record.archivePending = index < firstLiveIndex;
            if (record.archivePending) {
              this.queuePlainTextForRecord(record, LIMITS.archiveIndexRetryDelayMs);
            }
          }
        }
        return;
      }

      const liveTurnCount = Math.min(this.records.length, this.getManualLiveTurnCount());
      const firstLiveIndex = Math.max(0, this.records.length - liveTurnCount);
      const defaultViewMode = this.getDefaultArchiveViewMode();

      for (let index = 0; index < this.records.length; index += 1) {
        const record = this.records[index];
        const entry = this.getManualArchiveEntry(record);
        record.keepVisible = false;

        if (this.isRestorableManualEntry(entry) && index < firstLiveIndex) {
          this.restorePendingManualRecord(record);
          entry.visible = false;
          entry.viewMode = defaultViewMode;
          entry.simpleExpanded = false;
          entry.dynamicAutoExpanded = false;
          record.state = "hidden";
          record.archivePending = false;
        } else if (index < firstLiveIndex) {
          record.archivePending = true;
          record.state = "live";
          record.indexState = record.indexState === "ready" ? "ready" : "queued";
          record.manualPayloadState = record.manualPayloadState === "ready" ? "ready" : "pending";
          this.queuePlainTextForRecord(record, LIMITS.archiveIndexRetryDelayMs);
          if (record.nodes.some((node) => node instanceof HTMLElement && node.parentElement !== this.root)) {
            this.mountRecordNodesBefore(record, null);
          }
          this.applyManualPendingVisualMask(record);
        } else {
          record.archivePending = false;
          if (record.nodes.some((node) => node instanceof HTMLElement && node.parentElement !== this.root)) {
            this.mountRecordNodesBefore(record, null);
          }
          this.restorePendingManualRecord(record);
          record.state = "live";
        }
      }
    }

    handleLoadMoreClick() {
      if (this.settings.dynamicScroll) {
        return;
      }

      this.prepareAndRestore("load-older", this.settings.restoreBatchSize);
    }

    handleLoadAllClick() {
      if (this.settings.dynamicScroll) {
        return;
      }

      this.prepareAndRestore("load-all", this.hiddenCount);
    }

    prepareAndRestore(actionLabel, batchSize) {
      if (!this.root || this.hiddenCount <= 0 || this.pendingRestoreAction) {
        return;
      }

      this.pendingRestoreAction = true;
      const restoreCount = Math.min(this.hiddenCount, Math.max(1, batchSize));

      this.logger.info("restore-older:prepare", {
        action: actionLabel,
        restoreCount,
        hiddenCount: this.hiddenCount,
        visibleArchiveCount: this.countVisibleArchiveRecords()
      });

      global.setTimeout(() => {
        try {
          this.restoreOlderBatch(restoreCount);
        } finally {
          this.pendingRestoreAction = false;
        }
      }, 0);
    }

    restoreOlderBatch(batchSize) {
      if (!this.root || this.hiddenCount <= 0) {
        return;
      }

      const startedAt = performance.now();
      const hiddenRecords = this.records.filter((record) => (
        record.state === "hidden"
        && this.isRestorableManualEntry(this.getManualArchiveEntry(record))
      ));
      const restoreCount = Math.min(hiddenRecords.length, Math.max(1, batchSize));
      if (!restoreCount) {
        return;
      }
      const scrollAnchor = this.getRestoreScrollAnchor();
      const beforeTop = scrollAnchor ? scrollAnchor.getBoundingClientRect().top : 0;
      const previousHiddenCount = this.hiddenCount;
      const newlyVisibleRecords = [];

      this.logger.info("restore-older:start", {
        restoreCount,
        previousHiddenCount,
        previousVisibleArchiveCount: this.countVisibleArchiveRecords()
      });

      const recordsToRestore = hiddenRecords.slice(-restoreCount);

      for (const record of recordsToRestore) {
        const entry = this.getManualArchiveEntry(record);

        if (record && this.hasStrictReadyManualArchiveEntry(entry)) {
          this.markManualArchiveEntryRestored(entry);
          entry.visible = true;
          entry.simpleExpanded = false;
          entry.dynamicAutoExpanded = false;
          entry.viewMode = entry.viewMode || this.getDefaultArchiveViewMode();
          record.state = "visibleArchive";
          record.keepVisible = true;
          newlyVisibleRecords.push(entry);
        }
      }

      this.hiddenCount = this.countHiddenRecords();
      if (newlyVisibleRecords.length) {
        this.insertVisibleArchiveRecords(newlyVisibleRecords);
      } else {
        this.syncArchiveUi();
      }

      if (scrollAnchor) {
        const afterTop = scrollAnchor.getBoundingClientRect().top;
        this.scrollContainer.scrollTop += afterTop - beforeTop;
        this.logger.info("restore-older:scroll-adjust", {
          deltaPx: Number((afterTop - beforeTop).toFixed(1))
        });
      }

      this.logger.info("restore-older:end", {
        durationMs: this.getDurationMs(startedAt),
        restoreCount,
        hiddenCount: this.hiddenCount,
        visibleArchiveCount: this.countVisibleArchiveRecords(),
        queuedPlainText: this.pendingPlainTextIds.length,
        queuedRich: this.pendingRichSnapshotIds.length
      });
      this.emitStatus();
    }

    getRestoreScrollAnchor() {
      if (this.archiveUi && this.archiveUi.list instanceof HTMLElement) {
        const firstArchiveBlock = Array.from(this.archiveUi.list.children).find((child) => (
          child instanceof HTMLElement
          && child.hasAttribute("data-rapid-view-for-chatgpt-archive-block")
        ));

        if (firstArchiveBlock instanceof HTMLElement && firstArchiveBlock.isConnected) {
          return firstArchiveBlock;
        }

        if (this.archiveUi.list.isConnected) {
          return this.archiveUi.list;
        }
      }

      return this.settings.dynamicScroll ? this.getFirstLiveNode() : this.getManualArchiveInsertionNode();
    }

    collapseVisibleArchived() {
      if (this.settings.dynamicScroll) {
        return;
      }

      if (!this.root || !this.countVisibleArchiveRecords()) {
        return;
      }

      this.manualUserRestoredArchiveIds.clear();
      this.resetDynamicScrollTracking(false);
      const firstLiveNode = this.getManualArchiveInsertionNode();
      const beforeTop = firstLiveNode ? firstLiveNode.getBoundingClientRect().top : 0;

      for (const record of this.records) {
        if (record.state === "visibleArchive") {
          const entry = this.getManualArchiveEntry(record);
          if (entry) {
            this.unmarkManualArchiveEntryRestored(entry);
            entry.visible = false;
          }
          record.state = "hidden";
          record.keepVisible = false;
        }
      }

      this.hiddenCount = this.countHiddenRecords();
      this.syncArchiveUi();

      if (firstLiveNode) {
        const afterTop = firstLiveNode.getBoundingClientRect().top;
        this.scrollContainer.scrollTop += afterTop - beforeTop;
      }

      this.emitStatus();
    }

    collapseArchivedThrough(targetId) {
      if (this.settings.dynamicScroll) {
        return;
      }

      if (!this.root || !targetId) {
        return;
      }

      this.resetDynamicScrollTracking(false);
      const targetIndex = this.records.findIndex((record) => record.id === targetId);
      if (targetIndex < 0) {
        return;
      }

      const firstLiveNode = this.getManualArchiveInsertionNode();
      const beforeTop = firstLiveNode ? firstLiveNode.getBoundingClientRect().top : 0;
      let changed = false;

      for (let index = 0; index <= targetIndex; index += 1) {
        const record = this.records[index];
        if (record && record.state === "visibleArchive") {
          const entry = this.getManualArchiveEntry(record);
          if (entry) {
            this.unmarkManualArchiveEntryRestored(entry);
            entry.visible = false;
          }
          record.state = "hidden";
          record.keepVisible = false;
          changed = true;
        }
      }

      if (!changed) {
        return;
      }

      this.hiddenCount = this.countHiddenRecords();
      this.syncArchiveUi();

      if (firstLiveNode) {
        const afterTop = firstLiveNode.getBoundingClientRect().top;
        this.scrollContainer.scrollTop += afterTop - beforeTop;
      }

      this.emitStatus();
    }

    loadAllArchived() {
      if (this.settings.dynamicScroll) {
        return;
      }

      if (!this.root || this.hiddenCount <= 0) {
        return;
      }

      this.resetDynamicScrollTracking(false);
      const firstLiveNode = this.getManualArchiveInsertionNode();
      const beforeTop = firstLiveNode ? firstLiveNode.getBoundingClientRect().top : 0;
      const nextViewMode = this.getDefaultArchiveViewMode();

      for (const record of this.records) {
        const entry = this.getManualArchiveEntry(record);
        if (this.hasStrictReadyManualArchiveEntry(entry)) {
          this.markManualArchiveEntryRestored(entry);
          entry.visible = true;
          entry.simpleExpanded = false;
          entry.dynamicAutoExpanded = false;
          entry.viewMode = nextViewMode;
          record.state = "visibleArchive";
          record.keepVisible = true;
        }
      }

      this.hiddenCount = 0;
      this.syncArchiveUi();

      if (firstLiveNode) {
        const afterTop = firstLiveNode.getBoundingClientRect().top;
        this.scrollContainer.scrollTop += afterTop - beforeTop;
      }

      this.emitStatus();
    }

    setVisibleArchiveViewMode(mode) {
      if (this.settings.dynamicScroll) {
        return;
      }

      const nextMode = mode === "rich" ? "rich" : "simple";
      let changed = false;
      let queuedRichSnapshots = 0;
      let requiresFullSync = false;
      const recordsToRefresh = [];

      this.clearDynamicScrollTimer();
      this.dynamicScrollTargetId = "";
      this.dynamicScrollActiveId = "";

      for (const record of this.records) {
        if (record.state === "visibleArchive") {
          const entry = this.getManualArchiveEntry(record);
          if (!this.isVisibleManualArchiveEntry(entry)) {
            continue;
          }

          entry.dynamicAutoExpanded = false;

          const entryMode = nextMode === "rich" && !this.hasStrictArchiveHtml(entry.renderedHtml)
            ? "simple"
            : nextMode;

          if (entry.viewMode !== entryMode) {
            entry.viewMode = entryMode;
            changed = true;
          }

          if (entry.refreshArchiveBlock) {
            recordsToRefresh.push(entry);
          } else {
            requiresFullSync = true;
          }
        }
      }

      if (!changed && queuedRichSnapshots === 0) {
        return;
      }

      if (requiresFullSync) {
        this.syncArchiveUi();
      } else {
        for (const record of recordsToRefresh) {
          record.refreshArchiveBlock();
        }
      }

      this.emitStatus();
    }

    updateDynamicScrollBinding() {
      const dynamicModeActive = Boolean(this.settings.dynamicScroll && this.archiveActive && this.root);
      const dynamicWheelTarget = dynamicModeActive
        && this.archiveUi
        && this.archiveUi.host instanceof HTMLElement
        && this.archiveUi.host.isConnected
        ? this.archiveUi.host
        : null;

      if (this.boundScrollContainer) {
        this.boundScrollContainer.removeEventListener("scroll", this.handleDynamicScroll);
        this.boundScrollContainer = null;
      }

      if (this.boundWindowScroll) {
        global.removeEventListener("scroll", this.handleDynamicScroll);
        this.boundWindowScroll = false;
      }

      if (this.boundDynamicWheelTarget && this.boundDynamicWheelTarget !== dynamicWheelTarget) {
        this.boundDynamicWheelTarget.removeEventListener("wheel", this.handleDynamicWheel, true);
        this.boundDynamicWheelTarget = null;
        this.boundDynamicWheel = false;
      }

      if (this.boundDynamicKeydown && !dynamicModeActive) {
        global.removeEventListener("keydown", this.handleDynamicKeydown, true);
        this.boundDynamicKeydown = false;
      }

      if (dynamicModeActive) {
        if (dynamicWheelTarget && this.boundDynamicWheelTarget !== dynamicWheelTarget) {
          dynamicWheelTarget.addEventListener("wheel", this.handleDynamicWheel, { passive: false, capture: true });
          this.boundDynamicWheelTarget = dynamicWheelTarget;
          this.boundDynamicWheel = true;
        }

        if (!this.boundDynamicKeydown) {
          global.addEventListener("keydown", this.handleDynamicKeydown, true);
          this.boundDynamicKeydown = true;
        }
      } else {
        this.boundDynamicWheelTarget = null;
        this.boundDynamicWheel = false;
        this.lastScrollTop = this.scrollContainer ? this.scrollContainer.scrollTop : 0;
      }
    }

    clearDynamicScrollTimer() {
      if (this.dynamicScrollTimer) {
        global.clearTimeout(this.dynamicScrollTimer);
        this.dynamicScrollTimer = 0;
      }
    }

    resetDynamicScrollTracking(collapseActive) {
      this.clearDynamicScrollTimer();
      this.dynamicScrollTargetId = "";
      this.dynamicScrollFocusId = "";
      this.dynamicCurrentSliceIndex = -1;
      this.dynamicSliceCount = 0;
      this.dynamicVisibleCount = 0;
      this.dynamicInputLockedUntil = 0;

      for (const record of this.records) {
        if (Array.isArray(record.dynamicUnits)) {
          for (const unit of record.dynamicUnits) {
            unit.renderedHeightPx = 0;
          }
        }

        if (!record.dynamicAutoExpanded) {
          continue;
        }

        record.dynamicAutoExpanded = false;
        record.dynamicRenderedHeight = 0;
        if (collapseActive && record.viewMode === "rich") {
          record.viewMode = "simple";
          if (typeof record.refreshArchiveBlock === "function") {
            record.refreshArchiveBlock();
          }
        }
      }

      this.dynamicScrollActiveId = "";
    }

    handleDynamicScroll() {
      if (this.settings.dynamicScroll && this.archiveActive) {
        this.syncArchiveUi();
      }
    }

    jumpToDynamicSlice(targetIndex, source = "direct", extra = {}) {
      if (!this.settings.dynamicScroll || !this.archiveActive) {
        return;
      }

      const trackEntries = this.getDynamicTrackRecords();
      if (!trackEntries.length) {
        return;
      }

      const sliceHeight = this.getDynamicSliceHeight();
      const contentHeight = trackEntries[trackEntries.length - 1].bottom;
      const sliceCount = Math.max(1, Math.ceil(Math.max(1, contentHeight) / sliceHeight));
      const maxWindowStartSlice = Math.max(0, sliceCount - 3);
      const nextIndex = Math.max(0, Math.min(maxWindowStartSlice, Math.round(targetIndex || 0)));

      if (nextIndex === this.dynamicCurrentSliceIndex && this.dynamicSliceCount === sliceCount) {
        return;
      }

      this.dynamicCurrentSliceIndex = nextIndex;
      this.dynamicSliceCount = sliceCount;
      this.dynamicScrollTargetId = "";
      this.dynamicScrollActiveId = `slice-${nextIndex}`;
      this.dynamicScrollFocusId = `slice-${nextIndex}`;
      this.logger.info("dynamic:index-change", {
        currentSliceIndex: nextIndex,
        sliceHeight: Math.round(sliceHeight),
        sliceCount,
        totalTrackHeight: Math.round(sliceCount * sliceHeight),
        source,
        ...extra
      });
      this.syncArchiveUi();
    }

    stepDynamicSlice(delta) {
      if (!this.settings.dynamicScroll || !this.archiveActive) {
        return;
      }

      const trackEntries = this.getDynamicTrackRecords();
      if (!trackEntries.length) {
        return;
      }

      const sliceHeight = this.getDynamicSliceHeight();
      const contentHeight = trackEntries[trackEntries.length - 1].bottom;
      const sliceCount = Math.max(1, Math.ceil(Math.max(1, contentHeight) / sliceHeight));
      const maxWindowStartSlice = Math.max(0, sliceCount - 3);
      const nextIndex = Math.max(
        0,
        Math.min(
          maxWindowStartSlice,
          (Number.isFinite(this.dynamicCurrentSliceIndex) ? this.dynamicCurrentSliceIndex : maxWindowStartSlice) + delta
        )
      );
      this.jumpToDynamicSlice(nextIndex, "step");
    }

    handleDynamicWheel(event) {
      if (!this.settings.dynamicScroll || !this.archiveActive) {
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      const eventTarget = event.target;
      if (eventTarget instanceof Element) {
        const tableScrollHost = eventTarget.closest("[data-rapid-view-for-chatgpt-table-scroll]");
        if (
          tableScrollHost instanceof HTMLElement
          && tableScrollHost.scrollWidth > tableScrollHost.clientWidth + 1
        ) {
          const deltaX = Number(event.deltaX) || 0;
          const deltaY = Number(event.deltaY) || 0;
          if (event.shiftKey || Math.abs(deltaX) > Math.abs(deltaY)) {
            return;
          }
        }
      }

      const now = Date.now();
      if (now < this.dynamicInputLockedUntil) {
        event.preventDefault();
        return;
      }

      const deltaY = Number(event.deltaY) || 0;
      if (!deltaY) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      this.dynamicInputLockedUntil = now + 160;
      this.stepDynamicSlice(deltaY < 0 ? -1 : 1);
    }

    handleDynamicKeydown(event) {
      if (!this.settings.dynamicScroll || !this.archiveActive) {
        return;
      }

      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLElement
        && (
          target.isContentEditable
          || target.tagName === "INPUT"
          || target.tagName === "TEXTAREA"
          || target.tagName === "SELECT"
        )
      ) {
        return;
      }

      let delta = 0;
      if (event.key === "ArrowUp" || event.key === "PageUp") {
        delta = -1;
      } else if (event.key === "ArrowDown" || event.key === "PageDown") {
        delta = 1;
      } else {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      this.stepDynamicSlice(delta);
    }

    activateDynamicScrollRecord(unitId) {
      if (!unitId || unitId === this.dynamicScrollFocusId) {
        return;
      }

      this.dynamicScrollActiveId = unitId;
      this.dynamicScrollFocusId = unitId;
      this.dynamicScrollTargetId = "";
      this.syncArchiveUi();
    }

    deactivateDynamicScrollRecord(unitId) {
      if (this.dynamicScrollActiveId === unitId) {
        this.dynamicScrollActiveId = "";
      }

      for (const record of this.records) {
        if (!Array.isArray(record.dynamicUnits)) {
          continue;
        }

        for (const unit of record.dynamicUnits) {
          if (unit.unitId === unitId) {
            unit.renderedHeightPx = 0;
          }
        }
      }
    }

    countHiddenRecords() {
      if (!this.settings.dynamicScroll) {
        return this.records.filter((record) => (
          record.state === "hidden"
          && this.isRestorableManualEntry(this.getManualArchiveEntry(record))
        )).length;
      }

      return this.records.filter((record) => record.state === "hidden").length;
    }

    countPendingManualArchiveRecords() {
      if (this.settings.dynamicScroll || !this.records.length) {
        return 0;
      }

      const liveTurnCount = Math.min(this.records.length, this.getManualLiveTurnCount());
      const firstLiveIndex = Math.max(0, this.records.length - liveTurnCount);
      const queuedIds = new Set(this.pendingPlainTextIds);

      return this.records.filter((record, index) => {
        if (index >= firstLiveIndex || this.isRestorableManualEntry(this.getManualArchiveEntry(record))) {
          return false;
        }

        if (record.indexState === "failed" && !this.isPendingManualArchiveRecord(record)) {
          return false;
        }

        return Boolean(
          record.archivePending
          || record.plainTextPending
          || queuedIds.has(record.id)
          || record.indexState === "queued"
          || record.indexState === "capturing"
          || record.manualPayloadState === "pending"
          || this.isPendingManualArchiveRecord(record)
        );
      }).length;
    }

    countLiveRecords() {
      return this.records.filter((record) => record.state === "live").length;
    }

    countVisibleArchiveRecords() {
      if (!this.settings.dynamicScroll) {
        return this.records.filter((record) => {
          const entry = this.getManualArchiveEntry(record);
          return record.state === "visibleArchive" && this.isVisibleManualArchiveEntry(entry);
        }).length;
      }

      return this.records.filter((record) => record.state === "visibleArchive").length;
    }

    computeArchiveModeState() {
      const totalMessages = this.records.length;
      const estimatedTotalHeightPx = this.getEstimatedTotalHeight();
      const thresholds = this.getActivationThresholds();
      let nextState = false;
      let belowTurnThreshold = false;
      let belowHeightThreshold = false;

      if (this.detectedTurnCount < 2) {
        nextState = false;
      } else
      if (this.archiveActive) {
        belowTurnThreshold = totalMessages <= thresholds.deactivateTurns;
        belowHeightThreshold = estimatedTotalHeightPx < LIMITS.deactivateEstimatedHeightPx;
        nextState = !(belowTurnThreshold && belowHeightThreshold);
      } else {
        nextState = totalMessages >= thresholds.activateTurns || estimatedTotalHeightPx >= LIMITS.activateMinEstimatedHeightPx;
      }

      const evaluation = {
        archiveActiveBefore: this.archiveActive,
        totalMessages,
        estimatedTotalHeightPx,
        activateTurns: thresholds.activateTurns,
        deactivateTurns: thresholds.deactivateTurns,
        activateHeightPx: LIMITS.activateMinEstimatedHeightPx,
        deactivateHeightPx: LIMITS.deactivateEstimatedHeightPx,
        detectedTurnCount: this.detectedTurnCount,
        meetsTurnThreshold: totalMessages >= thresholds.activateTurns,
        meetsHeightThreshold: estimatedTotalHeightPx >= LIMITS.activateMinEstimatedHeightPx,
        belowTurnThreshold,
        belowHeightThreshold,
        nextArchiveActive: nextState
      };
      const signature = JSON.stringify(evaluation);
      if (signature !== this.lastActivationEvaluationSignature) {
        this.lastActivationEvaluationSignature = signature;
        this.logger.info("activation:evaluate", evaluation);
      }

      return nextState;
    }

    getActivationTrigger() {
      if (this.records.length >= LIMITS.activateMinTurns) {
        return "turn";
      }

      if (this.getEstimatedTotalHeight() >= LIMITS.activateMinEstimatedHeightPx) {
        return "height";
      }

      return "";
    }

    getActivationThresholds() {
      return {
        activateTurns: LIMITS.activateMinTurns,
        deactivateTurns: LIMITS.deactivateMinTurns
      };
    }

    getEstimatedTotalHeight() {
      return this.records.reduce((total, record) => total + Math.max(1, record.estimatedHeight || 1), 0);
    }

    getStatus() {
      const dynamicModeActive = this.settings.dynamicScroll && this.archiveActive;
      return {
        totalMessages: this.records.length,
        mountedMessages: dynamicModeActive ? this.dynamicVisibleCount : this.countLiveRecords(),
        hiddenMessages: dynamicModeActive ? 0 : this.countHiddenRecords(),
        visibleArchiveMessages: this.countVisibleArchiveRecords(),
        estimatedTotalHeightPx: this.getEstimatedTotalHeight(),
        virtualizationActive: this.archiveActive,
        archiveActive: this.archiveActive,
        activationTrigger: this.lastActivationTrigger
      };
    }

    withDomMutationGuard(callback) {
      this.ignoreOwnRootMutationsUntil = Math.max(
        this.ignoreOwnRootMutationsUntil,
        Date.now() + OWN_ROOT_MUTATION_GUARD_MS
      );
      this.domMutationDepth += 1;
      try {
        callback();
      } finally {
        this.domMutationDepth -= 1;
        this.ignoreOwnRootMutationsUntil = Math.max(
          this.ignoreOwnRootMutationsUntil,
          Date.now() + OWN_ROOT_MUTATION_GUARD_MS
        );
      }
    }

    isApplyingDomChanges() {
      return this.domMutationDepth > 0 || Date.now() < this.ignoreOwnRootMutationsUntil;
    }

    emitStatus() {
      if (this.statusListener) {
        this.statusListener(this.getStatus());
      }
    }
  }

  class BoosterController {
    constructor() {
      this.logger = new Logger();
      this.detector = new DomDetector(this.logger);
      this.engine = new ArchiveEngine(this.logger);
      this.engine.setStatusListener((engineStatus) => {
        if (!this.settings.enabled || !this.engine.root) {
          this.updateStatus(engineStatus);
          return;
        }

        this.refreshActivationStatus(engineStatus);
      });
      this.settings = settingsApi.normalize(constants.DEFAULT_SETTINGS);
      this.detectionMode = "inactive";
      this.status = {
        state: STATUS.searching,
        reason: "Initializing",
        totalMessages: 0,
        mountedMessages: 0
      };
      this.routeKey = this.getRouteKey();
      this.cachedMain = null;
      this.bootstrapObserverTarget = null;
      this.bodyObserver = null;
      this.rootObserver = null;
      this.observedRoot = null;
      this.routeTimer = 0;
      this.reinitializeTimer = 0;
      this.bootstrapDeadline = 0;
      this.bootstrapStartedAt = 0;
      this.lastBootstrapSignature = "";
      this.forceImmediateBootstrap = false;
      this.lastDetectionFailureLogAt = 0;
      this.lastActivationStatusLogSignature = "";
      this.unsubscribeSettings = null;
      this.onRuntimeMessage = this.onRuntimeMessage.bind(this);
      this.handleNavigationEvent = this.handleNavigationEvent.bind(this);
    }

    async init() {
      this.settings = await settingsApi.load();
      this.engine.setSettings(this.settings);

      this.unsubscribeSettings = settingsApi.onChanged((nextSettings) => {
        const wasEnabled = Boolean(this.settings && this.settings.enabled);
        const hadRoot = Boolean(this.engine.root);
        this.settings = nextSettings;

        if (wasEnabled && !nextSettings.enabled) {
          this.disconnectBodyObserver();
          this.disconnectRootObserver();
          this.engine.destroy({ restoreHistory: true });
          this.updateStatus({
            state: STATUS.disabled,
            reason: "Extension disabled in popup."
          });

          global.setTimeout(() => {
            global.location.reload();
          }, 0);
          return;
        }

        this.engine.setSettings(nextSettings);
        if (!wasEnabled && nextSettings.enabled) {
          this.startBootstrap("settings-enabled", { forceImmediate: true });
          return;
        }

        if (hadRoot) {
          this.syncRootObservation();
          this.refreshActivationStatus();
          return;
        }

        this.initialize("settings-change");
      });

      chrome.runtime.onMessage.addListener(this.onRuntimeMessage);
      this.startObservers();
      this.startBootstrap("startup");
    }

    installNavigationHooks() {
      if (!global.__rapidViewForChatGptHistoryPatched) {
        const dispatchNavigationEvent = () => {
          global.dispatchEvent(new CustomEvent("rapid-view-for-chatgpt:navigation"));
        };

        for (const methodName of ["pushState", "replaceState"]) {
          const originalMethod = history[methodName];
          history[methodName] = function patchedHistoryMethod(...args) {
            const result = originalMethod.apply(this, args);
            dispatchNavigationEvent();
            return result;
          };
        }

        global.__rapidViewForChatGptHistoryPatched = true;
      }

      global.addEventListener("popstate", this.handleNavigationEvent);
      global.addEventListener("rapid-view-for-chatgpt:navigation", this.handleNavigationEvent);
    }

    isConversationRoute(routeKey = this.routeKey) {
      const pathname = typeof routeKey === "string"
        ? routeKey.split("?")[0].split("#")[0]
        : location.pathname;

      return /^\/c\/[^/]+$/.test(pathname);
    }

    hasConversationDomEvidence(preferredMain = this.cachedMain || null) {
      const main = this.detector.findMain(preferredMain);
      if (!(main instanceof HTMLElement)) {
        return false;
      }

      const thread = main.querySelector("#thread");
      if (thread instanceof HTMLElement && this.detector.isVisible(thread)) {
        return true;
      }

      const turnNode = Array.from(main.querySelectorAll(this.detector.turnSelector)).find((node) => (
        node instanceof HTMLElement
        && this.detector.isTurnNode(node)
        && this.detector.isVisible(node)
      ));
      if (turnNode) {
        return true;
      }

      const visibleAuthorMarkers = Array.from(main.querySelectorAll("[data-message-author-role]")).filter((node) => (
        node instanceof HTMLElement
        && this.detector.isVisible(node)
      ));
      return visibleAuthorMarkers.length >= 2;
    }

    shouldPreserveManualArchiveOnDetectionFailure({
      reason,
      recognizedConversationRoute,
      hasConversationEvidence,
      threadVisible
    }) {
      if (reason === "route-change") {
        return false;
      }

      return Boolean(
        this.engine
        && typeof this.engine.hasManualArchiveStateToPreserve === "function"
        && this.engine.hasManualArchiveStateToPreserve()
        && (
          recognizedConversationRoute
          || hasConversationEvidence
          || threadVisible
        )
      );
    }

    startObservers() {
      this.observeForBootstrap();
      this.installNavigationHooks();
      this.routeTimer = global.setInterval(() => {
        if (this.engine.root && !document.contains(this.engine.root)) {
          this.startBootstrap("root-detached");
          return;
        }

        const nextRouteKey = this.getRouteKey();
        if (nextRouteKey !== this.routeKey) {
          this.routeKey = nextRouteKey;
          this.startBootstrap("route-change");
        }
      }, LIMITS.routeCheckIntervalMs);
    }

    handleNavigationEvent() {
      global.setTimeout(() => {
        const nextRouteKey = this.getRouteKey();
        const routeChanged = nextRouteKey !== this.routeKey;
        this.routeKey = nextRouteKey;
        this.startBootstrap(routeChanged ? "route-change" : "navigation-event");
      }, 0);
    }

    watchCurrentRoot(root) {
      if (this.rootObserver) {
        this.rootObserver.disconnect();
      }
      this.observedRoot = root;

      this.rootObserver = new MutationObserver((mutations) => {
        if (this.engine.isApplyingDomChanges() || (this.settings.dynamicScroll && this.engine.archiveActive)) {
          return;
        }

        const structuralChange = mutations.some((mutation) => mutation.type === "childList" && (mutation.addedNodes.length || mutation.removedNodes.length));
        if (structuralChange) {
          this.scheduleInitialize("root-structure-change", LIMITS.rootMutationDebounceMs);
        }
      });

      this.rootObserver.observe(root, {
        childList: true,
        subtree: false
      });
    }

    observeForBootstrap() {
      const nextTarget = this.getBootstrapObserverTarget();
      if (!nextTarget) {
        return;
      }

      if (this.bodyObserver && this.bootstrapObserverTarget === nextTarget) {
        return;
      }

      this.disconnectBodyObserver();

      this.bodyObserver = new MutationObserver(() => {
        if (!this.engine.root || !document.contains(this.engine.root)) {
          if (!this.reinitializeTimer) {
            this.scheduleInitialize("bootstrap-mutation", LIMITS.bootstrapRetryMs);
          }
        }
      });

      this.bootstrapObserverTarget = nextTarget;
      this.bodyObserver.observe(nextTarget, {
        childList: true,
        subtree: true
      });
    }

    getBootstrapObserverTarget() {
      return document.body || document.documentElement;
    }

    startBootstrap(reason, options = {}) {
      this.observeForBootstrap();
      this.forceImmediateBootstrap = Boolean(options.forceImmediate);
      this.bootstrapStartedAt = Date.now();
      this.bootstrapDeadline = this.bootstrapStartedAt + LIMITS.bootstrapMaxWaitMs;
      this.logger.info("bootstrap:start", {
        reason,
        forceImmediate: this.forceImmediateBootstrap,
        routeKey: this.routeKey
      });
      this.scheduleInitialize(reason, 0);
    }

    scheduleInitialize(reason, delayMs = LIMITS.rescanDebounceMs) {
      if (this.reinitializeTimer) {
        global.clearTimeout(this.reinitializeTimer);
      }

      this.reinitializeTimer = global.setTimeout(() => {
        this.reinitializeTimer = 0;
        this.initialize(reason);
      }, delayMs);
    }

    initialize(reason) {
      const startedAt = performance.now();
      if (!this.settings.enabled) {
        this.forceImmediateBootstrap = false;
        this.bootstrapDeadline = 0;
        this.bootstrapStartedAt = 0;
        this.detectionMode = "inactive";
        this.cachedMain = null;
        this.disconnectBodyObserver();
        this.disconnectRootObserver();
        this.engine.destroy({ restoreHistory: true });
        this.updateStatus({
          state: STATUS.disabled,
          reason: "Extension disabled in popup."
        });
        return;
      }

      const recognizedConversationRoute = this.isConversationRoute();
      const hasConversationEvidence = this.hasConversationDomEvidence();
      if (!recognizedConversationRoute && !hasConversationEvidence) {
        this.detectionMode = "inactive";
        this.cachedMain = null;
        this.disconnectRootObserver();
        this.engine.destroy();

        if (this.bootstrapDeadline && Date.now() < this.bootstrapDeadline) {
          this.observeForBootstrap();
          this.updateStatus({
            state: STATUS.searching,
            reason: "Waiting for ChatGPT conversation to appear..."
          });
          this.scheduleInitialize("bootstrap-retry", LIMITS.bootstrapRetryMs);
          return;
        }

        this.forceImmediateBootstrap = false;
        this.bootstrapDeadline = 0;
        this.bootstrapStartedAt = 0;
        this.lastBootstrapSignature = "";
        this.disconnectBodyObserver();
        this.updateStatus({
          state: STATUS.inactive,
          reason: "Open a saved ChatGPT conversation to enable speed mode."
        });
        return;
      }

      this.engine.prepareForDetection();
      this.logger.info("initialize:start", {
        reason,
        routeKey: this.routeKey,
        fullScan: true,
        forceImmediate: this.forceImmediateBootstrap,
        hasRoot: Boolean(this.engine.root)
      });
      const detection = this.detector.detect({
        fullScan: true
      });

      if (!detection.ok) {
        const structuralSummary = detection.diagnostics ? detection.diagnostics.structuralSummary : null;
        const turnNodeCount = structuralSummary ? Number(structuralSummary.turnNodeCount) || 0 : 0;
        const threadVisible = Boolean(detection.diagnostics && detection.diagnostics.threadVisible);
        const waitingForThreadHydration = threadVisible && turnNodeCount < LIMITS.minStructuralTurns;
        const waitingForStructuralResolution = threadVisible && turnNodeCount >= LIMITS.minStructuralTurns;
        const effectiveBootstrapDeadline = threadVisible
          ? Math.max(
            this.bootstrapDeadline || 0,
            this.bootstrapStartedAt + LIMITS.bootstrapVisibleThreadMaxWaitMs
          )
          : this.bootstrapDeadline;

        const now = Date.now();
        if (
          reason !== "bootstrap-retry"
          || now - this.lastDetectionFailureLogAt >= LIMITS.detectionFailureLogCooldownMs
        ) {
          this.lastDetectionFailureLogAt = now;
          this.logger.info("initialize:detection-failed", {
            reason,
            detectionReason: detection.reason,
            routeKey: this.routeKey,
            fullScan: true,
            forceImmediate: this.forceImmediateBootstrap,
            mainFound: Boolean(detection.diagnostics && detection.diagnostics.mainFound),
            threadFound: Boolean(detection.diagnostics && detection.diagnostics.threadFound),
            threadVisible: Boolean(detection.diagnostics && detection.diagnostics.threadVisible),
            structuralSummary: detection.diagnostics ? detection.diagnostics.structuralSummary : null,
            fallbackSummary: detection.diagnostics ? detection.diagnostics.fallbackSummary : null,
            durationMs: Number((performance.now() - startedAt).toFixed(1))
          });
        }
        if (effectiveBootstrapDeadline && Date.now() < effectiveBootstrapDeadline) {
          this.bootstrapDeadline = effectiveBootstrapDeadline;
          this.observeForBootstrap();
          this.updateStatus({
            state: STATUS.searching,
            reason: waitingForStructuralResolution
              ? "Waiting for stable ChatGPT conversation structure..."
              : waitingForThreadHydration
                ? "Waiting for ChatGPT conversation turns to appear..."
                : "Waiting for ChatGPT thread to appear..."
          });
          this.scheduleInitialize("bootstrap-retry", LIMITS.bootstrapRetryMs);
          return;
        }

        if (this.shouldPreserveManualArchiveOnDetectionFailure({
          reason,
          recognizedConversationRoute,
          hasConversationEvidence,
          threadVisible
        })) {
          this.forceImmediateBootstrap = false;
          this.bootstrapDeadline = 0;
          this.bootstrapStartedAt = 0;
          this.observeForBootstrap();
          this.engine.preserveManualArchiveDuringDetectionFailure();
          this.updateStatus({
            state: STATUS.searching,
            reason: waitingForStructuralResolution
              ? "Waiting for stable ChatGPT conversation structure..."
              : waitingForThreadHydration
                ? "Waiting for ChatGPT conversation turns to appear..."
                : "Waiting for ChatGPT thread to appear..."
          });
          this.scheduleInitialize("manual-archive-preserve-retry", LIMITS.bootstrapRetryMs);
          return;
        }

        this.forceImmediateBootstrap = false;
        this.bootstrapDeadline = 0;
        this.bootstrapStartedAt = 0;
        this.detectionMode = "inactive";
        this.cachedMain = null;
        this.disconnectRootObserver();
        this.engine.destroy();
        this.updateStatus({
          state: STATUS.inactive,
          reason: detection.reason
        });
        return;
      }

      this.bootstrapDeadline = 0;
      this.bootstrapStartedAt = 0;
      this.forceImmediateBootstrap = false;
      this.detectionMode = detection.detectionMode || "fallback";
      this.cachedMain = detection.main || null;
      this.engine.setSettings(this.settings);
      this.engine.bind({
        root: detection.root,
        scrollContainer: detection.scrollContainer,
        messageNodes: detection.messageNodes,
        preserveManualArchive: reason !== "route-change"
      });

      this.disconnectBodyObserver();
      this.syncRootObservation();
      this.refreshActivationStatus();

      const engineStatus = this.engine.getStatus();
      this.logger.info("Initialized", {
        durationMs: Number((performance.now() - startedAt).toFixed(1)),
        reason,
        routeKey: this.routeKey,
        detectionMode: this.detectionMode,
        detectionScore: detection.score,
        selectedRoot: detection.diagnostics ? detection.diagnostics.selectedRoot : "",
        totalMessages: engineStatus.totalMessages,
        mountedMessages: engineStatus.mountedMessages
      });
    }

    refreshActivationStatus(engineStatus = this.engine.getStatus()) {
      this.syncRootObservation();
      const thresholds = this.engine.getActivationThresholds();
      const detectionPrefix = this.detectionMode === "structural" ? "Structural detector" : "Fallback detector";
      const triggerLabel = engineStatus.activationTrigger === "height" ? "height trigger" : "turn threshold";
      const missingThresholdParts = [];
      if (engineStatus.totalMessages < thresholds.activateTurns) {
        missingThresholdParts.push(`${engineStatus.totalMessages}/${thresholds.activateTurns} turns`);
      }
      if (engineStatus.estimatedTotalHeightPx < LIMITS.activateMinEstimatedHeightPx) {
        missingThresholdParts.push(`${Math.round(engineStatus.estimatedTotalHeightPx)}/${LIMITS.activateMinEstimatedHeightPx}px`);
      }
      const suspendedReason = missingThresholdParts.length
        ? `${detectionPrefix} ready. Detected ${engineStatus.totalMessages} messages; below activation threshold (${missingThresholdParts.join(", ")}).`
        : `${detectionPrefix} ready. Activates at ${thresholds.activateTurns}+ turns or ${LIMITS.activateMinEstimatedHeightPx}px.`;
      const activationStatusLog = {
        detectionMode: this.detectionMode,
        archiveActive: engineStatus.archiveActive,
        totalMessages: engineStatus.totalMessages,
        mountedMessages: engineStatus.mountedMessages,
        hiddenMessages: engineStatus.hiddenMessages,
        visibleArchiveMessages: engineStatus.visibleArchiveMessages,
        estimatedTotalHeightPx: engineStatus.estimatedTotalHeightPx,
        activationTrigger: engineStatus.activationTrigger,
        activateTurns: thresholds.activateTurns,
        activateHeightPx: LIMITS.activateMinEstimatedHeightPx
      };

      if (engineStatus.archiveActive) {
        const activeReason = `${detectionPrefix} live-tail mode active via ${triggerLabel}.`;
        this.updateStatus({
          state: STATUS.active,
          reason: activeReason,
          detectionMode: this.detectionMode,
          totalMessages: engineStatus.totalMessages,
          mountedMessages: engineStatus.mountedMessages,
          hiddenMessages: engineStatus.hiddenMessages,
          estimatedTotalHeightPx: engineStatus.estimatedTotalHeightPx
        });
        const activeSignature = JSON.stringify({
          ...activationStatusLog,
          state: STATUS.active,
          reason: activeReason
        });
        if (activeSignature !== this.lastActivationStatusLogSignature) {
          this.lastActivationStatusLogSignature = activeSignature;
          this.logger.info("activation:status", {
            ...activationStatusLog,
            state: STATUS.active,
            reason: activeReason
          });
        }
        return;
      }

      this.updateStatus({
        state: STATUS.suspended,
        reason: suspendedReason,
        detectionMode: this.detectionMode,
        totalMessages: engineStatus.totalMessages,
        mountedMessages: engineStatus.mountedMessages,
        hiddenMessages: engineStatus.hiddenMessages,
        estimatedTotalHeightPx: engineStatus.estimatedTotalHeightPx
      });
      const suspendedPayload = {
        ...activationStatusLog,
        state: STATUS.suspended,
        reason: suspendedReason
      };
      const suspendedSignature = JSON.stringify(suspendedPayload);
      if (suspendedSignature !== this.lastActivationStatusLogSignature) {
        this.lastActivationStatusLogSignature = suspendedSignature;
        this.logger.info("activation:status", suspendedPayload);
        if (this.detectionMode === "fallback") {
          this.logger.info("activation:suspended-fallback", suspendedPayload);
        }
      }
    }

    updateStatus(partialStatus) {
      this.status = {
        ...this.status,
        ...this.engine.getStatus(),
        ...partialStatus
      };
    }

    disconnectRootObserver() {
      if (this.rootObserver) {
        this.rootObserver.disconnect();
        this.rootObserver = null;
      }
      this.observedRoot = null;
    }

    syncRootObservation() {
      if (!this.engine.root || !document.contains(this.engine.root)) {
        this.disconnectRootObserver();
        return;
      }

      if (this.settings.dynamicScroll && this.engine.archiveActive) {
        this.disconnectRootObserver();
        return;
      }

      if (this.rootObserver && this.observedRoot === this.engine.root) {
        return;
      }

      this.watchCurrentRoot(this.engine.root);
    }

    disconnectBodyObserver() {
      if (this.bodyObserver) {
        this.bodyObserver.disconnect();
        this.bodyObserver = null;
      }

      this.bootstrapObserverTarget = null;
    }

    onRuntimeMessage(message, sender, sendResponse) {
      if (!message || !message.type) {
        return false;
      }

      if (message.type === STATUS_MESSAGE_TYPE) {
        sendResponse(this.status);
        return true;
      }

      if (message.type === ARCHIVE_ACTION_MESSAGE_TYPE) {
        if (!this.engine.root) {
          sendResponse({ ok: false, reason: "No active archive root." });
          return true;
        }

        if (this.settings.dynamicScroll) {
          sendResponse({ ok: false, reason: "Archive actions are disabled while Dynamic is enabled." });
          return true;
        }

        switch (message.action) {
          case "collapse_all_archived":
            this.engine.collapseVisibleArchived();
            break;
          case "load_all_archived":
            this.engine.loadAllArchived();
            break;
          case "set_all_simple":
            this.engine.setVisibleArchiveViewMode("simple");
            break;
          case "set_all_rendered":
            this.engine.setVisibleArchiveViewMode("rich");
            break;
          default:
            sendResponse({ ok: false, reason: "Unknown archive action." });
            return true;
        }

        this.refreshActivationStatus();
        sendResponse({ ok: true });
        return true;
      }

      return false;
    }

    getRouteKey() {
      return `${location.pathname}${location.search}${location.hash}`;
    }
  }

  const controller = new BoosterController();
  controller.init().catch((error) => {
    void error;
  });
})(globalThis);
