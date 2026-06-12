/**
 * connections.js  –  Event · Drug · Company parallel connections view
 *
 * Architecture
 * ─────────────
 * Data from /api/connections is a flat list of {event, drug, company} triples.
 * We build six lookup maps:
 *   eventToDrugs[event]      → Set<drug>
 *   eventToCompanies[event]  → Set<company>
 *   drugToEvents[drug]       → Set<event>
 *   drugToCompanies[drug]    → Set<company>
 *   companyToEvents[company] → Set<event>
 *   companyToDrugs[company]  → Set<drug>
 *
 * Layout: 5-column grid  [events] [gap-svg] [drugs] [gap-svg] [companies]
 * Ribbons are bezier curves drawn inside the two gap SVGs, which sit between
 * the list columns and have overflow:visible so curves can reach out to rows.
 */

const API_BASE = window.location.protocol + "//" + window.location.host + "/api";

// ── STATE ──────────────────────────────────────────────────────────────────
const state = {
  events:    [],
  drugs:     [],
  companies: [],
  links:     [],

  eventToDrugs:      {},
  eventToCompanies:  {},
  drugToEvents:      {},
  drugToCompanies:   {},
  companyToEvents:   {},
  companyToDrugs:    {},

  colFilter: { events: "", drugs: "", companies: "" },
  selection: null,   // { col: "events"|"drugs"|"companies", val: string } | null
};

// ── BOOT ───────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", loadData);
window.addEventListener("resize", () => requestAnimationFrame(drawRibbons));

async function loadData() {
  showLoading(true);
  try {
    const res  = await fetch(`${API_BASE}/connections`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.events    = data.events;
    state.drugs     = data.drugs;
    state.companies = data.companies;
    state.links     = data.links;

    buildMaps();
    renderAll();
    showLoading(false);
  } catch (err) {
    showError(err.message || "Failed to load data");
  }
}

// ── MAPS ───────────────────────────────────────────────────────────────────
function buildMaps() {
  const em = {};
  const dm = {};
  const cm = {};

  for (const { event, drug, company } of state.links) {
    if (!em[event])   em[event]   = { drugs: new Set(), companies: new Set() };
    if (!dm[drug])    dm[drug]    = { events: new Set(), companies: new Set() };
    if (!cm[company]) cm[company] = { events: new Set(), drugs: new Set() };

    em[event].drugs.add(drug);
    em[event].companies.add(company);
    dm[drug].events.add(event);
    dm[drug].companies.add(company);
    cm[company].events.add(event);
    cm[company].drugs.add(drug);
  }

  state.eventToDrugs      = Object.fromEntries(Object.entries(em).map(([k,v]) => [k, v.drugs]));
  state.eventToCompanies  = Object.fromEntries(Object.entries(em).map(([k,v]) => [k, v.companies]));
  state.drugToEvents      = Object.fromEntries(Object.entries(dm).map(([k,v]) => [k, v.events]));
  state.drugToCompanies   = Object.fromEntries(Object.entries(dm).map(([k,v]) => [k, v.companies]));
  state.companyToEvents   = Object.fromEntries(Object.entries(cm).map(([k,v]) => [k, v.events]));
  state.companyToDrugs    = Object.fromEntries(Object.entries(cm).map(([k,v]) => [k, v.drugs]));
}

// ── RENDER ─────────────────────────────────────────────────────────────────
function renderAll() {
  document.getElementById("count-events").textContent    = state.events.length;
  document.getElementById("count-drugs").textContent     = state.drugs.length;
  document.getElementById("count-companies").textContent = state.companies.length;

  renderCol("events",    state.events,    "list-events");
  renderCol("drugs",     state.drugs,     "list-drugs");
  renderCol("companies", state.companies, "list-companies");

  document.getElementById("cx-layout").style.display = "grid";
  updateStatus();
}

function renderCol(colKey, items, listId) {
  const container = document.getElementById(listId);
  const filter    = state.colFilter[colKey].toLowerCase();
  const visible   = filter ? items.filter(i => i.toLowerCase().includes(filter)) : items;

  const badgeCount = {
    events:    v => state.eventToDrugs[v]?.size     || 0,
    drugs:     v => state.drugToEvents[v]?.size      || 0,
    companies: v => state.companyToEvents[v]?.size   || 0,
  };
  const badgeSuffix = { events: " drugs", drugs: " events", companies: " events" };

  container.innerHTML = "";
  for (const item of visible) {
    const row = document.createElement("div");
    row.className = "cx-row";
    row.dataset.col = colKey;
    row.dataset.val = item;
    row.innerHTML = `
      <div class="cx-row-dot"></div>
      <div class="cx-row-name" title="${escHtml(item)}">${escHtml(item)}</div>
      <div class="cx-row-badge">${badgeCount[colKey](item)}${badgeSuffix[colKey]}</div>
    `;
    row.addEventListener("click", () => selectItem(colKey, item));
    container.appendChild(row);
  }
}

// ── SELECTION ──────────────────────────────────────────────────────────────
function selectItem(col, val) {
  if (state.selection?.col === col && state.selection?.val === val) {
    clearSelection();
    return;
  }
  state.selection = { col, val };
  applyHighlights();
  requestAnimationFrame(drawRibbons);
  showDetail();
  updateStatus();
}

window.clearSelection = function () {
  state.selection = null;
  applyHighlights();
  clearSVGs();
  hideDetail();
  updateStatus();
};

function applyHighlights() {
  const sel = state.selection;

  let connectedEvents    = null;
  let connectedDrugs     = null;
  let connectedCompanies = null;

  if (sel) {
    if (sel.col === "events") {
      connectedDrugs     = state.eventToDrugs[sel.val]     || new Set();
      connectedCompanies = state.eventToCompanies[sel.val] || new Set();
      connectedEvents    = new Set([sel.val]);
    } else if (sel.col === "drugs") {
      connectedEvents    = state.drugToEvents[sel.val]     || new Set();
      connectedCompanies = state.drugToCompanies[sel.val]  || new Set();
      connectedDrugs     = new Set([sel.val]);
    } else {
      connectedEvents    = state.companyToEvents[sel.val]  || new Set();
      connectedDrugs     = state.companyToDrugs[sel.val]   || new Set();
      connectedCompanies = new Set([sel.val]);
    }
  }

  const colMap = {
    events:    connectedEvents,
    drugs:     connectedDrugs,
    companies: connectedCompanies,
  };

  document.querySelectorAll(".cx-row").forEach(row => {
    const rCol = row.dataset.col;
    const rVal = row.dataset.val;
    row.classList.remove("active", "highlighted", "dimmed");
    if (!sel) return;
    const connSet = colMap[rCol];
    if (!connSet) return;
    if (rCol === sel.col && rVal === sel.val) {
      row.classList.add("active");
    } else if (connSet.has(rVal)) {
      row.classList.add("highlighted");
    } else {
      row.classList.add("dimmed");
    }
  });
}

// ── RIBBONS ────────────────────────────────────────────────────────────────
// Each gap column has its own SVG (#svg-left between events↔drugs,
// #svg-right between drugs↔companies). Bezier curves start at the right
// edge of the left column and end at the left edge of the right column,
// converted into the SVG's local coordinate space.

function clearSVGs() {
  document.getElementById("svg-left").innerHTML  = "";
  document.getElementById("svg-right").innerHTML = "";
}

function drawRibbons() {
  clearSVGs();
  const sel = state.selection;
  if (!sel) return;

  let connectedEvents    = [];
  let connectedDrugs     = [];
  let connectedCompanies = [];

  if (sel.col === "events") {
    connectedDrugs     = [...(state.eventToDrugs[sel.val]     || [])];
    connectedCompanies = [...(state.eventToCompanies[sel.val] || [])];
    connectedEvents    = [sel.val];
  } else if (sel.col === "drugs") {
    connectedEvents    = [...(state.drugToEvents[sel.val]     || [])];
    connectedCompanies = [...(state.drugToCompanies[sel.val]  || [])];
    connectedDrugs     = [sel.val];
  } else {
    connectedEvents    = [...(state.companyToEvents[sel.val]  || [])];
    connectedDrugs     = [...(state.companyToDrugs[sel.val]   || [])];
    connectedCompanies = [sel.val];
  }

  // ── helpers ──
  // Returns the vertical midpoint of a row in PAGE coordinates,
  // or null if the row is scrolled outside its container's visible area.
  function rowPageY(colKey, val) {
    const row = document.querySelector(
      `.cx-row[data-col="${colKey}"][data-val="${CSS.escape(val)}"]`
    );
    if (!row) return null;
    const rr = row.getBoundingClientRect();
    const body = row.closest(".cx-col-body");
    if (body) {
      const br = body.getBoundingClientRect();
      if (rr.bottom < br.top || rr.top > br.bottom) return null;
    }
    return rr.top + rr.height / 2;
  }

  // Returns the horizontal RIGHT edge of a column in page coordinates.
  function colRightX(colId) {
    const el = document.getElementById(colId);
    return el ? el.getBoundingClientRect().right : 0;
  }

  // Returns the horizontal LEFT edge of a column in page coordinates.
  function colLeftX(colId) {
    const el = document.getElementById(colId);
    return el ? el.getBoundingClientRect().left : 0;
  }

  // Draws a bezier into an SVG element.
  // x1,y1 and x2,y2 are in PAGE coordinates; they are converted to the
  // SVG's local coordinate space via its bounding rect.
  function drawBezier(svgEl, x1PageY, x2PageY, svgRect, cls) {
    if (x1PageY === null || x2PageY === null) return;
    const svgH = svgRect.height;
    const y1 = x1PageY - svgRect.top;
    const y2 = x2PageY - svgRect.top;
    const x1 = 0;
    const x2 = svgRect.width;
    const mx = svgRect.width / 2;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
    path.setAttribute("class", `cx-ribbon ${cls}`);
    svgEl.appendChild(path);
  }

  // ── Left gap: events ↔ drugs ──
  const svgL    = document.getElementById("svg-left");
  const rectL   = svgL.getBoundingClientRect();

  for (const ev of connectedEvents) {
    const y1 = rowPageY("events", ev);
    for (const dr of connectedDrugs) {
      const y2 = rowPageY("drugs", dr);
      const isSelected = (sel.col === "events" && ev === sel.val) ||
                         (sel.col === "drugs"  && dr === sel.val);
      drawBezier(svgL, y1, y2, rectL, isSelected ? "active-ribbon" : "highlight-ribbon");
    }
  }

  // ── Right gap: drugs ↔ companies ──
  const svgR  = document.getElementById("svg-right");
  const rectR = svgR.getBoundingClientRect();

  for (const dr of connectedDrugs) {
    const y1 = rowPageY("drugs", dr);
    for (const co of connectedCompanies) {
      const y2 = rowPageY("companies", co);
      const isSelected = (sel.col === "drugs"     && dr === sel.val) ||
                         (sel.col === "companies" && co === sel.val);
      drawBezier(svgR, y1, y2, rectR, isSelected ? "active-ribbon" : "highlight-ribbon");
    }
  }
}

// ── DETAIL BAR ─────────────────────────────────────────────────────────────
function showDetail() {
  const sel = state.selection;
  if (!sel) return hideDetail();

  const label = sel.col === "events" ? "Adverse Event"
              : sel.col === "drugs"  ? "Drug"
                                     : "Company";

  let peers = [];
  if (sel.col === "events") {
    peers = [...(state.eventToDrugs[sel.val] || [])].slice(0, 14).map(d => ({ label: d, col: "drugs" }));
  } else if (sel.col === "drugs") {
    peers = [...(state.drugToEvents[sel.val] || [])].slice(0, 14).map(e => ({ label: e, col: "events" }));
  } else {
    peers = [...(state.companyToDrugs[sel.val] || [])].slice(0, 14).map(d => ({ label: d, col: "drugs" }));
  }

  document.getElementById("cx-detail-label").textContent = label;
  document.getElementById("cx-detail-name").textContent  = sel.val;

  const chips = document.getElementById("cx-detail-chips");
  chips.innerHTML = peers.map(p =>
    `<span class="cx-chip" onclick="selectItem('${p.col}', ${JSON.stringify(p.label)})">${escHtml(p.label)}</span>`
  ).join("");

  document.getElementById("cx-detail").style.display = "flex";
}

function hideDetail() {
  document.getElementById("cx-detail").style.display = "none";
}

// ── COLUMN FILTERS ─────────────────────────────────────────────────────────
window.filterCol = function(colKey, value) {
  state.colFilter[colKey] = value;
  const listMap  = { events: "list-events", drugs: "list-drugs", companies: "list-companies" };
  const itemsMap = { events: state.events,  drugs: state.drugs,  companies: state.companies };
  renderCol(colKey, itemsMap[colKey], listMap[colKey]);
  applyHighlights();
  requestAnimationFrame(drawRibbons);
};

// Global search — filters all three columns simultaneously
document.getElementById("cx-search").addEventListener("input", function () {
  const q = this.value.trim();
  ["events", "drugs", "companies"].forEach(col => {
    document.getElementById(`filter-${col}`).value = q;
    state.colFilter[col] = q;
  });
  renderAll();
  applyHighlights();
  requestAnimationFrame(drawRibbons);
});

// Redraw when any list column is scrolled
document.addEventListener("scroll", function (e) {
  if (e.target?.classList?.contains("cx-col-body")) {
    requestAnimationFrame(drawRibbons);
  }
}, true);

// ── STATUS ─────────────────────────────────────────────────────────────────
function updateStatus() {
  const sel = state.selection;
  const el  = document.getElementById("cx-status");
  if (!sel) {
    el.textContent = `${state.events.length} events · ${state.drugs.length} drugs · ${state.companies.length} companies`;
    return;
  }
  if (sel.col === "events") {
    const nd = state.eventToDrugs[sel.val]?.size     || 0;
    const nc = state.eventToCompanies[sel.val]?.size || 0;
    el.textContent = `"${sel.val}"  →  ${nd} drug${nd !== 1 ? "s" : ""}  ·  ${nc} compan${nc !== 1 ? "ies" : "y"}`;
  } else if (sel.col === "drugs") {
    const ne = state.drugToEvents[sel.val]?.size     || 0;
    const nc = state.drugToCompanies[sel.val]?.size  || 0;
    el.textContent = `"${sel.val}"  →  ${ne} event${ne !== 1 ? "s" : ""}  ·  ${nc} compan${nc !== 1 ? "ies" : "y"}`;
  } else {
    const ne = state.companyToEvents[sel.val]?.size || 0;
    const nd = state.companyToDrugs[sel.val]?.size  || 0;
    el.textContent = `"${sel.val}"  →  ${ne} event${ne !== 1 ? "s" : ""}  ·  ${nd} drug${nd !== 1 ? "s" : ""}`;
  }
}

// ── LOADING / ERROR ─────────────────────────────────────────────────────────
function showLoading(show) {
  document.getElementById("cx-loading").style.display = show ? "flex" : "none";
  if (show) document.getElementById("cx-error").style.display = "none";
}
function showError(msg) {
  document.getElementById("cx-loading").style.display = "none";
  document.getElementById("cx-error").style.display   = "flex";
  document.getElementById("cx-error-msg").textContent  = msg;
}

// ── UTIL ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
