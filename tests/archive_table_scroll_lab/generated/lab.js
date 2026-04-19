(function initArchiveTableScrollLab() {
  "use strict";

  const LAB_DATA = {"scenarios": [{"id": "hungarian_long_text", "label": "Hungarian long text baseline", "description": "Close to the currently failing archive rendered table case with long Hungarian prose in the right column.", "intro_html": "<p>Igen, a Rapid View for ChatGPT összességében jó név. Nem tökéletes, de eddig ez az egyik legerősebb jelölted.</p><p>Az értékelésem:</p>", "outro_html": "<p>A tiszta verdict: ez a scenario a mostani hibát próbálja vizuálisan reprodukálni.</p>", "table": {"header": [{"html": "Értékelés", "header": true}, {"html": "Miért", "header": true}], "rows": [[{"html": "8.5/10"}, {"html": "Nem megy rá a tipikus <span data-chip=\"true\">Speed Booster</span>, <span data-chip=\"true\">Lag Remover</span>, <span data-chip=\"true\">Optimizer</span>, <span data-chip=\"true\">Turbo</span> sablonra. A most látható nevek között inkább a gyors megjelenítés és a rendered nézet kontrollált kezelése érződik."}], [{"html": "7/10"}, {"html": "A <span data-chip=\"true\">for ChatGPT</span> rész segít, mert egyértelmű célplatformot ad. A <span data-chip=\"true\">Rapid</span> utal gyorsulásra, de a felhasználók valószínűleg inkább a konkrét előnyt keresik, például a gördülékenyebb olvashatóságot."}], [{"html": "7.5/10"}, {"html": "A <span data-chip=\"true\">View</span> nem teljesen sebességszó, de jól passzol ahhoz, hogy a bővítmény a látható és rendered üzenetek nézetét optimalizálja, nem pedig a ChatGPT válaszidejét ígéri."}], [{"html": "8/10"}, {"html": "Rövid, tiszta, nem túl technikai, nem túl brandes. Könnyű kimondani és visszaidézni."}], [{"html": "9/10"}, {"html": "Repo névként jól működik, például <span data-chip=\"true\">rapid-view-for-chatgpt</span> formában."}], [{"html": "6/10"}, {"html": "Itt a gyenge pont a <span data-chip=\"true\">ChatGPT</span>. Az OpenAI hivatalos brand oldalára utalva ez public store névnél érzékenyebb lehet, még akkor is, ha a felhasználók egyből tudják mire való."}], [{"html": "8/10"}, {"html": "A gyors keresésben nem láttam egyértelmű, pontos egyezést erre a névre a Chrome Web Store találatok között, ezért működhet, de a választott szöveg vége most is nehezen elérhető max-right scroll után.<span data-rv-end-sentinel=\"true\" aria-hidden=\"true\"></span>"}]]}}, {"id": "long_no_space_token", "label": "Long no-space token", "description": "Checks how long unbroken tokens influence horizontal width and max-right reach.", "intro_html": "<p>Ez a scenario direkt hosszú, egybefüggő tokeneket használ, hogy kiderüljön mennyire torzul a scroll-szélesség.</p>", "outro_html": "<p>A cél itt is az, hogy max-right scroll után a legvége ténylegesen látható legyen.</p>", "table": {"header": [{"html": "Token", "header": true}, {"html": "Magyarázat", "header": true}], "rows": [[{"html": "A"}, {"html": "rapidviewforchatgpt_horizontal_scroll_intrinsic_width_measurement_case_001_without_natural_breakpoints_and_with_realistic_sentence_tail_to_check_visibility_end"}], [{"html": "B"}, {"html": "A normál szöveg mellett ez az egybefüggő token mutatja meg, hogy a táblázat tényleges scrollWidth-je mennyire követi a vizuális szélességet."}], [{"html": "C"}, {"html": "A végpontnak itt is teljesen látszania kell, különben a scrollbar csak részben hasznos.<span data-rv-end-sentinel=\"true\" aria-hidden=\"true\"></span>"}]]}}, {"id": "mixed_badges_links", "label": "Badges and links", "description": "Mix of inline chips, links, and prose in cells.", "intro_html": "<p>Itt inline badge-ek, linkek és normál mondatok vannak összekeverve egy cellán belül.</p>", "outro_html": "<p>Ez segít kiszúrni, ha a chip-szerű elemek vagy a linkek torzítják a scroll szélességét.</p>", "table": {"header": [{"html": "Elem", "header": true}, {"html": "Megjegyzés", "header": true}], "rows": [[{"html": "Badge"}, {"html": "A <span data-chip=\"true\">Rapid</span> + <span data-chip=\"true\">Rendered</span> + <span data-chip=\"true\">Archive</span> kombináció néha széthúzza a mérést, főleg akkor, ha utána még hosszú magyarázó mondat következik ugyanabban a cellában."}], [{"html": "Link"}, {"html": "A leírás végén egy link is van: <a href=\"https://example.com/docs/table-scroll\">example.com/docs/table-scroll</a>, és a scrollnak így is el kell érnie az egész sort."}], [{"html": "Mix"}, {"html": "A kombinált tartalom miatt a jobb szélső rész gyakran pont a kártya lekerekített széle alá csúszik, ezt kell kizárni.<span data-rv-end-sentinel=\"true\" aria-hidden=\"true\"></span>"}]]}}, {"id": "nested_blocks", "label": "Nested block content", "description": "Paragraphs, lists, and blockquote inside the right column.", "intro_html": "<p>Ez a case blokkszintű elemekkel terheli a cellát.</p>", "outro_html": "<p>Ha itt jó a scroll, akkor valószínűleg a blokkleszármazottak szélességszámítása is rendben van.</p>", "table": {"header": [{"html": "Szegmens", "header": true}, {"html": "Részletek", "header": true}], "rows": [[{"html": "Lista"}, {"html": "<div><p>Az első blokk bevezető szöveg.</p><ul><li>Első hosszú pont, ami végigfut a soron és segít megmutatni a valódi szélességet.</li><li>Második hosszú pont szintén széles tartalommal.</li></ul></div>"}], [{"html": "Quote"}, {"html": "<blockquote>Ez a blokkquote azért van itt, hogy a belső block layout ne nyelje el a scrollhoz szükséges természetes szélességet.</blockquote>"}], [{"html": "Zárás"}, {"html": "<section><h4>Megfigyelés</h4><p>A right edge itt is teljesen látható kell legyen.<span data-rv-end-sentinel=\"true\" aria-hidden=\"true\"></span></p></section>"}]]}}, {"id": "colspan_rowspan", "label": "Colspan and rowspan", "description": "Exercises table structure complexity while keeping the right edge observable.", "intro_html": "<p>Ez a scenario colspan és rowspan kombinációkat is tartalmaz.</p>", "outro_html": "<p>Ha ez is jól működik, akkor a strukturált táblák sem törik meg a scrollt.</p>", "table": {"header": [{"html": "Szempont", "header": true}, {"html": "Rész A", "header": true}, {"html": "Rész B", "header": true}], "rows": [[{"html": "Szerkezet", "rowspan": 2}, {"html": "Az első sorban külön cellák vannak."}, {"html": "A jobb oldali rész itt még rövidebb."}], [{"html": "A második sor első jobb cellája."}, {"html": "A második sor utolsó cellája hosszabb megfigyeléssel arról, hogy a scroll végén se legyen levágás."}], [{"html": "Összegzés"}, {"html": "Ez a két oszlopot összefogó záró szakasz továbbra is elérhető kell legyen a végpontig.", "colspan": 2, "end": true}]]}}, {"id": "code_block_cell", "label": "Code block in cell", "description": "Includes a code block inside a table cell while keeping prose around it.", "intro_html": "<p>Ez a scenario a code block önálló scrollját és a táblázat horizontális scrollját együtt terheli.</p>", "outro_html": "<p>A code block ne rontsa el a jobb szélső szöveg elérését.</p>", "table": {"header": [{"html": "Típus", "header": true}, {"html": "Tartalom", "header": true}], "rows": [[{"html": "Code"}, {"html": "<div data-rv-code-block=\"true\"><div data-rv-code-header=\"true\">example.ts</div><pre><code>const example = \\\"A very long code block that should stay self-contained\\\";\\nconst scroll = () =&gt; \\\"Table scroll should still reach the real end.\\\";\\n</code></pre></div>"}], [{"html": "Megjegyzés"}, {"html": "A code block utáni prózaszövegnek ugyanúgy teljesen láthatónak kell lennie a jobb szélen, nem maradhat félig levágva.<span data-rv-end-sentinel=\"true\" aria-hidden=\"true\"></span>"}]]}}], "variants": [{"id": "baseline_current_prod_like", "label": "Baseline current prod-like", "description": "Mimics the current production-like table strategy as a comparison baseline.", "settings": {"track_display": "inline-flex", "table_min_width_mode": "minus_gutter", "cell_content_width": "max-content", "block_width_mode": "none", "descendant_wrap_mode": "normal", "end_gutter_px": 24}}, {"id": "block_intrinsic_24", "label": "Block intrinsic + gutter 24", "description": "Adds intrinsic block descendants with the current 24px end gutter.", "settings": {"track_display": "inline-flex", "table_min_width_mode": "minus_gutter", "cell_content_width": "max-content", "block_width_mode": "max-content", "descendant_wrap_mode": "normal", "end_gutter_px": 24}}, {"id": "block_intrinsic_32", "label": "Block intrinsic + gutter 32", "description": "Like the current preferred direction, but with a larger end gutter.", "settings": {"track_display": "inline-flex", "table_min_width_mode": "minus_gutter", "cell_content_width": "max-content", "block_width_mode": "max-content", "descendant_wrap_mode": "normal", "end_gutter_px": 32}}, {"id": "block_intrinsic_16", "label": "Block intrinsic + gutter 16", "description": "Tests whether a smaller real gutter is still enough.", "settings": {"track_display": "inline-flex", "table_min_width_mode": "minus_gutter", "cell_content_width": "max-content", "block_width_mode": "max-content", "descendant_wrap_mode": "normal", "end_gutter_px": 16}}, {"id": "full_min_width_block_intrinsic", "label": "Full min width + intrinsic blocks", "description": "Keeps table min-width at 100% while preserving intrinsic block widths.", "settings": {"track_display": "inline-flex", "table_min_width_mode": "full", "cell_content_width": "max-content", "block_width_mode": "max-content", "descendant_wrap_mode": "normal", "end_gutter_px": 24}}, {"id": "no_min_width_block_intrinsic", "label": "No min width + intrinsic blocks", "description": "Lets the table shrink to pure intrinsic width plus gutter.", "settings": {"track_display": "inline-flex", "table_min_width_mode": "none", "cell_content_width": "max-content", "block_width_mode": "max-content", "descendant_wrap_mode": "normal", "end_gutter_px": 24}}, {"id": "track_inline_block", "label": "Inline-block track", "description": "Tests whether inline-block track width behaves better than inline-flex.", "settings": {"track_display": "inline-block", "table_min_width_mode": "minus_gutter", "cell_content_width": "max-content", "block_width_mode": "max-content", "descendant_wrap_mode": "normal", "end_gutter_px": 24}}, {"id": "content_auto_blocks_intrinsic", "label": "Content auto + intrinsic blocks", "description": "Uses auto width at the cell-content wrapper and intrinsic width for inner blocks.", "settings": {"track_display": "inline-flex", "table_min_width_mode": "minus_gutter", "cell_content_width": "auto", "block_width_mode": "max-content", "descendant_wrap_mode": "normal", "end_gutter_px": 24}}, {"id": "content_fit_blocks_intrinsic", "label": "Content fit-content + intrinsic blocks", "description": "Uses fit-content wrapper width while preserving intrinsic block descendants.", "settings": {"track_display": "inline-flex", "table_min_width_mode": "minus_gutter", "cell_content_width": "fit-content", "block_width_mode": "max-content", "descendant_wrap_mode": "normal", "end_gutter_px": 24}}, {"id": "aggressive_wrap_reference", "label": "Aggressive wrap reference", "description": "Reference case that intentionally favors wrapping over horizontal reach.", "settings": {"track_display": "inline-flex", "table_min_width_mode": "full", "cell_content_width": "max-content", "block_width_mode": "none", "descendant_wrap_mode": "anywhere", "end_gutter_px": 0}}, {"id": "wide_gutter_no_block_intrinsic", "label": "Wide gutter only", "description": "Checks whether gutter alone helps when intrinsic block sizing is not enabled.", "settings": {"track_display": "inline-flex", "table_min_width_mode": "minus_gutter", "cell_content_width": "max-content", "block_width_mode": "none", "descendant_wrap_mode": "normal", "end_gutter_px": 32}}, {"id": "inline_block_track_32", "label": "Inline-block track + gutter 32", "description": "Combines inline-block track with wider gutter and intrinsic blocks.", "settings": {"track_display": "inline-block", "table_min_width_mode": "minus_gutter", "cell_content_width": "max-content", "block_width_mode": "max-content", "descendant_wrap_mode": "normal", "end_gutter_px": 32}}]};
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
