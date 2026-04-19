(function initArchiveTableScrollLab() {
  "use strict";

  const LAB_DATA = __LAB_DATA__;
  const WINNER_STORAGE_KEY = "rapidViewArchiveTableScrollLabWinner";
  const PASS_TOLERANCE_PX = 2;

  const scenarioSelect = document.getElementById("scenarioSelect");
  const modeSelect = document.getElementById("modeSelect");
  const viewportSelect = document.getElementById("viewportSelect");
  const variantFilterSelect = document.getElementById("variantFilterSelect");
  const variantGrid = document.getElementById("variantGrid");
  const winnerValue = document.getElementById("winnerValue");
  const refreshMetricsButton = document.getElementById("refreshMetricsButton");
  const scrollAllStartButton = document.getElementById("scrollAllStartButton");
  const scrollAllEndButton = document.getElementById("scrollAllEndButton");
  const copyWinnerButton = document.getElementById("copyWinnerButton");

  let renderedCards = [];

  function createOption(select, value, label) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }

  function populateControls() {
    for (const scenario of LAB_DATA.scenarios) {
      createOption(scenarioSelect, scenario.id, scenario.label);
    }
  }

  function loadWinner() {
    try {
      const raw = localStorage.getItem(WINNER_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function saveWinner(payload) {
    localStorage.setItem(WINNER_STORAGE_KEY, JSON.stringify(payload, null, 2));
    renderWinnerSummary();
  }

  function renderWinnerSummary() {
    const winner = loadWinner();
    if (!winner) {
      winnerValue.textContent = "No winner selected yet.";
      return;
    }

    winnerValue.textContent = JSON.stringify(winner);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function createCellHtml(cell) {
    const content = cell && cell.html ? cell.html : "";
    const sentinel = cell && cell.end
      ? '<span data-rv-end-sentinel="true" aria-hidden="true"></span>'
      : "";
    const tagName = cell && cell.header ? "th" : "td";
    const colspan = cell && Number(cell.colspan) > 1 ? ` colspan="${Number(cell.colspan)}"` : "";
    const rowspan = cell && Number(cell.rowspan) > 1 ? ` rowspan="${Number(cell.rowspan)}"` : "";
    return `<${tagName}${colspan}${rowspan}><div data-rv-table-cell-content="true">${content}${sentinel}</div></${tagName}>`;
  }

  function buildScenarioTableHtml(scenario) {
    const table = scenario.table || {};
    const header = Array.isArray(table.header) ? table.header : [];
    const rows = Array.isArray(table.rows) ? table.rows : [];

    const theadHtml = header.length
      ? `<thead><tr>${header.map(createCellHtml).join("")}</tr></thead>`
      : "";

    const tbodyHtml = rows.map((row) => {
      const cells = Array.isArray(row) ? row : [];
      return `<tr>${cells.map(createCellHtml).join("")}</tr>`;
    }).join("");

    return `
      <div data-rv-table-shell>
        <div data-rv-table-scroll>
          <div data-rv-table-track>
            <table data-rv-table>
              ${theadHtml}
              <tbody>${tbodyHtml}</tbody>
            </table>
            <div data-rv-table-end-gutter aria-hidden="true"></div>
          </div>
        </div>
      </div>
    `;
  }

  function applyVariantSettings(card, variant) {
    const settings = variant.settings || {};
    const gutter = Number(settings.end_gutter_px) || 0;
    const track = card.querySelector("[data-rv-table-track]");
    const table = card.querySelector("[data-rv-table]");
    const endGutter = card.querySelector("[data-rv-table-end-gutter]");
    const contents = Array.from(card.querySelectorAll("[data-rv-table-cell-content]"));

    card.style.setProperty("--rv-end-gutter", `${gutter}px`);

    if (track instanceof HTMLElement) {
      track.style.display = settings.track_display === "inline-block" ? "inline-block" : "inline-flex";
      track.style.width = "max-content";
      track.style.minWidth = "100%";
      track.style.maxWidth = "none";
    }

    if (table instanceof HTMLElement) {
      if (settings.table_min_width_mode === "full") {
        table.style.minWidth = "100%";
      } else if (settings.table_min_width_mode === "none") {
        table.style.minWidth = "0";
      } else {
        table.style.minWidth = gutter > 0 ? `calc(100% - ${gutter}px)` : "100%";
      }
    }

    if (endGutter instanceof HTMLElement) {
      endGutter.style.width = `${gutter}px`;
      endGutter.style.minWidth = `${gutter}px`;
      endGutter.style.flex = `0 0 ${gutter}px`;
    }

    for (const content of contents) {
      if (!(content instanceof HTMLElement)) {
        continue;
      }

      if (settings.cell_content_width === "auto") {
        content.style.width = "auto";
      } else if (settings.cell_content_width === "fit-content") {
        content.style.width = "fit-content";
      } else {
        content.style.width = "max-content";
      }

      content.style.minWidth = "100%";
      content.style.maxWidth = "none";

      if (settings.descendant_wrap_mode === "anywhere") {
        content.style.overflowWrap = "anywhere";
        content.style.wordBreak = "break-word";
      } else {
        content.style.overflowWrap = "normal";
        content.style.wordBreak = "normal";
      }

      const blocks = content.querySelectorAll("p, div, blockquote, ul, ol, li, h1, h2, h3, h4, h5, h6, section");
      for (const block of blocks) {
        if (!(block instanceof HTMLElement)) {
          continue;
        }

        if (block.closest("[data-rv-code-block]")) {
          continue;
        }

        if (block.closest("[data-rv-table-cell-content]") !== content) {
          continue;
        }

        if (settings.block_width_mode === "max-content") {
          block.style.width = "max-content";
          block.style.maxWidth = "none";
        } else {
          block.style.width = "auto";
          block.style.maxWidth = "100%";
        }

        block.style.minWidth = "0";
        block.style.boxSizing = "border-box";

        if (settings.descendant_wrap_mode === "anywhere") {
          block.style.overflowWrap = "anywhere";
          block.style.wordBreak = "break-word";
        } else {
          block.style.overflowWrap = "normal";
          block.style.wordBreak = "normal";
        }
      }
    }
  }

  function getCurrentScenario() {
    return LAB_DATA.scenarios.find((scenario) => scenario.id === scenarioSelect.value) || LAB_DATA.scenarios[0];
  }

  function getCurrentViewportWidth() {
    return Number(viewportSelect.value) || 760;
  }

  function getCurrentMode() {
    return modeSelect.value === "dynamic" ? "dynamic" : "manual";
  }

  function scrollHostToStart(card) {
    const host = card.querySelector("[data-rv-table-scroll]");
    if (host instanceof HTMLElement) {
      host.scrollLeft = 0;
    }
  }

  function scrollHostToEnd(card) {
    const host = card.querySelector("[data-rv-table-scroll]");
    if (host instanceof HTMLElement) {
      host.scrollLeft = host.scrollWidth;
    }
  }

  function measureCard(card) {
    const host = card.querySelector("[data-rv-table-scroll]");
    const sentinel = card.querySelector("[data-rv-end-sentinel]");
    const status = card.querySelector("[data-role='status']");
    const scrollWidthValue = card.querySelector("[data-role='scrollWidth']");
    const clientWidthValue = card.querySelector("[data-role='clientWidth']");
    const maxScrollLeftValue = card.querySelector("[data-role='maxScrollLeft']");
    const hiddenRightValue = card.querySelector("[data-role='hiddenRight']");

    if (!(host instanceof HTMLElement) || !(sentinel instanceof HTMLElement)) {
      return;
    }

    host.scrollLeft = host.scrollWidth;
    const hostRect = host.getBoundingClientRect();
    const sentinelRect = sentinel.getBoundingClientRect();
    const maxScrollLeft = Math.max(0, host.scrollWidth - host.clientWidth);
    const hiddenRight = Math.max(0, Math.ceil(sentinelRect.right - hostRect.right));
    const passed = hiddenRight <= PASS_TOLERANCE_PX;

    scrollWidthValue.textContent = String(host.scrollWidth);
    clientWidthValue.textContent = String(host.clientWidth);
    maxScrollLeftValue.textContent = String(maxScrollLeft);
    hiddenRightValue.textContent = `${hiddenRight} px`;
    status.textContent = passed ? "PASS" : "FAIL";
    status.className = `variant-status ${passed ? "pass" : "fail"}`;

    card.classList.toggle("is-pass", passed);
    card.classList.toggle("is-fail", !passed);
    card.dataset.pass = passed ? "true" : "false";
  }

  function buildVariantCard(scenario, variant) {
    const viewportWidth = getCurrentViewportWidth();
    const mode = getCurrentMode();
    const card = document.createElement("article");
    card.className = "variant-card";
    card.dataset.variantId = variant.id;

    card.innerHTML = `
      <div class="variant-head">
        <div>
          <h2>${escapeHtml(variant.label)}</h2>
          <p>${escapeHtml(variant.description || "")}</p>
        </div>
        <span data-role="status" class="variant-status fail">CHECK</span>
      </div>

      <div class="variant-meta">
        <span class="meta-pill">${escapeHtml(variant.id)}</span>
        <span class="meta-pill">${escapeHtml(mode)}</span>
        <span class="meta-pill">${viewportWidth} px</span>
      </div>

      <div class="variant-metrics">
        <div class="metric"><span class="metric-label">scrollWidth</span><span data-role="scrollWidth" class="metric-value">-</span></div>
        <div class="metric"><span class="metric-label">clientWidth</span><span data-role="clientWidth" class="metric-value">-</span></div>
        <div class="metric"><span class="metric-label">maxScrollLeft</span><span data-role="maxScrollLeft" class="metric-value">-</span></div>
        <div class="metric"><span class="metric-label">Hidden Right</span><span data-role="hiddenRight" class="metric-value">-</span></div>
      </div>

      <div class="variant-actions">
        <button type="button" data-action="start" class="secondary">Scroll Start</button>
        <button type="button" data-action="end" class="secondary">Scroll End</button>
        <button type="button" data-action="winner">Mark as Winner</button>
      </div>

      <div class="render-frame ${mode}" style="--rv-preview-width: ${viewportWidth}px;">
        <article class="rv-archive-card">
          <div class="rv-archive-header">
            <span class="rv-label">Archived assistant turn</span>
            <div class="rv-tabs">
              <span class="rv-tab">Simple</span>
              <span class="rv-tab active">Rendered</span>
            </div>
          </div>
          <div class="rv-archive-body">
            ${scenario.intro_html || ""}
            ${buildScenarioTableHtml(scenario)}
            ${scenario.outro_html || ""}
          </div>
        </article>
      </div>

      <p class="footer-note">Goal: when max-right scroll is reached, the last text must still be fully visible.</p>
    `;

    applyVariantSettings(card, variant);

    const startButton = card.querySelector("[data-action='start']");
    const endButton = card.querySelector("[data-action='end']");
    const winnerButton = card.querySelector("[data-action='winner']");

    startButton.addEventListener("click", () => {
      scrollHostToStart(card);
      measureCard(card);
    });

    endButton.addEventListener("click", () => {
      scrollHostToEnd(card);
      measureCard(card);
    });

    winnerButton.addEventListener("click", () => {
      saveWinner({
        variantId: variant.id,
        variantLabel: variant.label,
        scenarioId: scenario.id,
        scenarioLabel: scenario.label,
        mode: getCurrentMode(),
        viewportWidth: getCurrentViewportWidth(),
        settings: variant.settings
      });
    });

    return card;
  }

  function applyVariantFilter() {
    const filterValue = variantFilterSelect.value;
    for (const card of renderedCards) {
      const pass = card.dataset.pass === "true";
      if (filterValue === "pass") {
        card.hidden = !pass;
      } else if (filterValue === "fail") {
        card.hidden = pass;
      } else {
        card.hidden = false;
      }
    }
  }

  function renderVariants() {
    const scenario = getCurrentScenario();
    variantGrid.replaceChildren();
    renderedCards = LAB_DATA.variants.map((variant) => buildVariantCard(scenario, variant));
    for (const card of renderedCards) {
      variantGrid.appendChild(card);
    }
    window.requestAnimationFrame(() => {
      renderedCards.forEach(measureCard);
      applyVariantFilter();
    });
  }

  async function copyWinnerJson() {
    const winner = loadWinner();
    const text = JSON.stringify(winner || {
      variantId: "",
      variantLabel: "",
      scenarioId: "",
      scenarioLabel: "",
      mode: getCurrentMode(),
      viewportWidth: getCurrentViewportWidth(),
      settings: {}
    }, null, 2);

    try {
      await navigator.clipboard.writeText(text);
      copyWinnerButton.textContent = "Copied";
      window.setTimeout(() => {
        copyWinnerButton.textContent = "Copy Winner JSON";
      }, 1200);
    } catch (error) {
      window.prompt("Copy winner JSON:", text);
    }
  }

  populateControls();
  renderWinnerSummary();

  scenarioSelect.addEventListener("change", renderVariants);
  modeSelect.addEventListener("change", renderVariants);
  viewportSelect.addEventListener("change", renderVariants);
  variantFilterSelect.addEventListener("change", applyVariantFilter);
  refreshMetricsButton.addEventListener("click", () => {
    renderedCards.forEach(measureCard);
    applyVariantFilter();
  });
  scrollAllStartButton.addEventListener("click", () => {
    renderedCards.forEach(scrollHostToStart);
    renderedCards.forEach(measureCard);
    applyVariantFilter();
  });
  scrollAllEndButton.addEventListener("click", () => {
    renderedCards.forEach(scrollHostToEnd);
    renderedCards.forEach(measureCard);
    applyVariantFilter();
  });
  copyWinnerButton.addEventListener("click", copyWinnerJson);

  renderVariants();
})();
