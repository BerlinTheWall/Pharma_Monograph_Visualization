/* =====================================================================
   Adverse Event Co-occurrence Explorer — adverse.js
   D3 force-directed graph + drug/event selection UI
   ===================================================================== */

// ─── CONFIG ───────────────────────────────────────────────────────────
// const API_BASE = "http://localhost:5000/api";
const API_BASE = window.location.protocol + "//" + window.location.host + "/api";

// Node colour thresholds (fraction of companies that report the event)
const HIGH_PREV  = 0.70;
const MED_PREV   = 0.40;
const COL_HIGH   = "#dc143c";
const COL_MED    = "#2563eb";
const COL_LOW    = "#6b7280";

// ─── STATE ────────────────────────────────────────────────────────────
const state = {
  drugs:           [],      // all drugs from /api/drugs
  selectedDrug:    null,
  mode:            "drug",  // "drug" | "global"
  adverseData:     null,    // response from /api/drugs/<drug>/adverse-events
  graphData:       null,    // response from /api/drugs/<drug>/cooccurrence
  checkedEvents:   new Set(),   // events the user has checked (filter)
  filterText:      "",
  jaccardThresh:   0.35,
  prevThresh:      0.20,
  simulation:      null,
  zoom:            null,
  selectedNode:    null,
};

// ─── TOOLTIP ──────────────────────────────────────────────────────────
const tipEl = document.getElementById("tooltip");
function showTip(evt, html) {
  tipEl.innerHTML = html;
  tipEl.classList.add("show");
  moveTip(evt);
}
function moveTip(evt) {
  const x = Math.min(evt.clientX + 14, window.innerWidth  - 240);
  const y = Math.min(evt.clientY - 8,  window.innerHeight - 200);
  tipEl.style.left = x + "px";
  tipEl.style.top  = y + "px";
}
function hideTip() { tipEl.classList.remove("show"); }

// ─── HELPERS ──────────────────────────────────────────────────────────
async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function nodeColor(count, nCompanies) {
  const frac = count / nCompanies;
  if (frac >= HIGH_PREV) return COL_HIGH;
  if (frac >= MED_PREV)  return COL_MED;
  return COL_LOW;
}

function nodeRadius(count, nCompanies) {
  const frac = count / nCompanies;
  return 6 + frac * 22;
}

// ─── EDGE VISUAL ENCODING ─────────────────────────────────────────────
// Each edge gets width from Jaccard weight AND the combined degree of its
// two endpoints (busier nodes → thicker pipes), then both are normalised
// against the graph's own range so the result always uses the full scale.

function buildEdgeScales(edges, nodeById) {
  // Pre-compute degree (number of edges) for every node
  const degree = {};
  edges.forEach(e => {
    const s = e.source?.id ?? e.source;
    const t = e.target?.id ?? e.target;
    degree[s] = (degree[s] || 0) + 1;
    degree[t] = (degree[t] || 0) + 1;
  });

  // Raw visual score for each edge = Jaccard × sqrt(avg degree of endpoints)
  // sqrt keeps very high-degree nodes from overwhelming everything
  const scores = edges.map(e => {
    const s = e.source?.id ?? e.source;
    const t = e.target?.id ?? e.target;
    const degAvg = ((degree[s] || 1) + (degree[t] || 1)) / 2;
    return e.weight * Math.sqrt(degAvg);
  });

  const minS = Math.min(...scores);
  const maxS = Math.max(...scores);
  const range = maxS - minS || 1;

  // Returns stroke-width (px) in [MIN_W, MAX_W]
  const MIN_W = 1.2, MAX_W = 9;
  return edges.map((e, i) => ({
    width:   MIN_W + ((scores[i] - minS) / range) * (MAX_W - MIN_W),
    opacity: 0.18 + ((scores[i] - minS) / range) * 0.62,  // 0.18 → 0.80
    score:   scores[i],
    degree,
  }));
}

// ─── INIT ─────────────────────────────────────────────────────────────
async function init() {
  await loadDrugs();
  setupSliders();
  setupDrugSearch();
  setupEventSearch();
}

// ─── LOAD DRUG LIST ───────────────────────────────────────────────────
async function loadDrugs() {
  try {
    state.drugs = await apiFetch("/drugs");
    renderDrugList(state.drugs);
  } catch (err) {
    document.getElementById("drug-list").innerHTML =
      `<div class="list-loading" style="color:#dc143c">Failed: ${err.message}</div>`;
  }
}

function renderDrugList(drugs) {
  const container = document.getElementById("drug-list");
  container.innerHTML = "";

  if (!drugs.length) {
    container.innerHTML = `<div class="list-loading">No drugs found.</div>`;
    return;
  }

  drugs.forEach(d => {
    const item = document.createElement("div");
    item.className = "drug-item" + (d.drug_name === state.selectedDrug ? " active" : "");
    item.dataset.name = d.drug_name;
    item.innerHTML = `
      <div class="drug-item-name">${d.drug_name}</div>
      <div class="drug-item-meta">
        <span>${d.drug_class}</span>
        <span>${d.n_companies} co.</span>
        <span>${d.n_adverse} events</span>
      </div>`;
    item.addEventListener("click", () => selectDrug(d.drug_name));
    container.appendChild(item);
  });
}

function setupDrugSearch() {
  document.getElementById("drug-search").addEventListener("input", function() {
    const q = this.value.toLowerCase();
    const filtered = state.drugs.filter(d =>
      d.drug_name.toLowerCase().includes(q) ||
      d.drug_class.toLowerCase().includes(q)
    );
    renderDrugList(filtered);
  });
}

// ─── SELECT DRUG ──────────────────────────────────────────────────────
async function selectDrug(drugName) {
  if (state.selectedDrug === drugName) return;
  state.selectedDrug = drugName;
  state.selectedNode = null;

  // Highlight in list
  document.querySelectorAll(".drug-item").forEach(el => {
    el.classList.toggle("active", el.dataset.name === drugName);
  });

  showGraphLoading("Loading adverse events…");
  hideGraphError();

  try {
    // Load adverse events first (fast)
    state.adverseData = await apiFetch(`/drugs/${encodeURIComponent(drugName)}/adverse-events`);

    // Pre-check all events
    state.checkedEvents = new Set(state.adverseData.all_events);

    renderEventList();
    showEventPanel(drugName, state.adverseData);
    showControlsPanel();

    // Then build graph (slower)
    updateLoadingMsg("Building co-occurrence graph…");
    await loadGraph();

  } catch (err) {
    hideGraphLoading();
    showGraphError(err.message);
  }
}

// ─── EVENT LIST ───────────────────────────────────────────────────────
function renderEventList() {
  const data    = state.adverseData;
  const n_comp  = data.n_companies;
  const filter  = state.filterText.toLowerCase();
  const synMap  = data.synonyms_map || {};   // canon -> [variants]

  const list = document.getElementById("event-list");
  list.innerHTML = "";

  const events = data.all_events.filter(e =>
    !filter ||
    e.includes(filter) ||
    (synMap[e] || []).some(v => v.includes(filter))
  );

  events.forEach(evt => {
    const count    = data.event_prevalence[evt] || 0;
    const frac     = count / n_comp;
    const checked  = state.checkedEvents.has(evt);
    const variants = synMap[evt] || [];
    const hasVars  = variants.length > 0;

    const item = document.createElement("div");
    item.className = "event-item" + (checked ? " checked" : "");
    item.dataset.event = evt;

    const varBadge = hasVars
      ? `<span class="event-var-badge" title="${variants.join(", ")}">+${variants.length}</span>`
      : "";

    item.innerHTML = `
      <div class="event-checkbox"></div>
      <span class="event-name">${evt}${varBadge}</span>
      <div class="event-prev-bar">
        <div class="event-prev-fill" style="width:${Math.round(frac*100)}%;background:${nodeColor(count,n_comp)}"></div>
      </div>`;
    item.addEventListener("click", () => toggleEvent(evt, item));
    list.appendChild(item);
  });

  document.getElementById("event-count").textContent = `${events.length}`;

  // Show how many of the sidebar events appear in the graph (prevalence-filtered)
  updateGraphCoverageHint(data);
}

function updateGraphCoverageHint(data) {
  const n_comp = data.n_companies;
  const minC   = Math.max(2, Math.round(n_comp * state.prevThresh));
  const maxC   = Math.round(n_comp * 0.95);
  const inGraph = data.all_events.filter(e => {
    const c = data.event_prevalence[e] || 0;
    return c >= minC && c <= maxC;
  }).length;
  const hint = document.getElementById("graph-coverage-hint");
  if (hint) {
    hint.textContent = `${inGraph} of ${data.all_events.length} events qualify for graph (${Math.round(inGraph/data.all_events.length*100)}%)`;
  }
}

function setupEventSearch() {
  document.getElementById("event-search").addEventListener("input", function() {
    state.filterText = this.value.toLowerCase();
    if (state.adverseData) renderEventList();
  });
}

function toggleEvent(evt, item) {
  if (state.checkedEvents.has(evt)) {
    state.checkedEvents.delete(evt);
    item.classList.remove("checked");
  } else {
    state.checkedEvents.add(evt);
    item.classList.add("checked");
  }
  // Re-filter graph in place (no API call needed)
  applyEventFilter();
}

function selectAllEvents() {
  if (!state.adverseData) return;
  state.checkedEvents = new Set(state.adverseData.all_events);
  renderEventList();
  applyEventFilter();
}

function clearEvents() {
  state.checkedEvents = new Set();
  renderEventList();
  applyEventFilter();
}

// Filter already-rendered graph nodes/links based on checkedEvents
function applyEventFilter() {
  const svg = d3.select("#graph-svg");
  const checked = state.checkedEvents;

  svg.selectAll(".node")
    .attr("display", d => checked.has(d.id) ? null : "none");

  svg.selectAll(".link")
    .attr("display", d =>
      checked.has(d.source.id || d.source) && checked.has(d.target.id || d.target)
        ? null : "none"
    );
}

// ─── SHOW / HIDE PANELS ───────────────────────────────────────────────
function showEventPanel(drugName, data) {
  const panel = document.getElementById("event-panel");
  panel.style.display = "";
  document.getElementById("event-panel-title").textContent =
    `Events (${data.n_companies} companies)`;
}

function showControlsPanel() {
  document.getElementById("controls-panel").style.display = "";
}

// ─── LOAD GRAPH FROM API ──────────────────────────────────────────────
async function loadGraph() {
  const params = new URLSearchParams({
    jaccard_threshold: state.jaccardThresh,
    min_prevalence:    state.prevThresh,
  });
  const data = await apiFetch(
    `/drugs/${encodeURIComponent(state.selectedDrug)}/cooccurrence?${params}`
  );
  state.graphData = data;

  hideGraphLoading();

  // ML badge
  const badge = document.getElementById("ml-badge");
  badge.style.display = data.ml_active ? "flex" : "none";

  // Render
  renderGraph(data);
  renderCompanyBreakdown(state.adverseData);
  renderAnomalies(data.anomalies, data.company_events);
  hideNodeDetail();
}

async function rebuildGraph() {
  if (state.mode === "global") {
    await loadGlobalGraph();
    return;
  }
  if (!state.selectedDrug) return;
  showGraphLoading("Rebuilding graph…");
  try {
    await loadGraph();
  } catch (err) {
    hideGraphLoading();
    showGraphError(err.message);
  }
}

// ─── GLOBAL VIEW ──────────────────────────────────────────────────────
async function switchToGlobal() {
  state.mode = "global";
  state.selectedDrug = null;
  state.selectedNode = null;

  // Update toggle button states
  document.getElementById("btn-drug-view").classList.remove("view-toggle-active");
  document.getElementById("btn-global-view").classList.add("view-toggle-active");

  // Show/hide left column sections
  document.getElementById("drug-selector-panel").style.display = "none";
  document.getElementById("event-panel").style.display = "";
  document.getElementById("controls-panel").style.display = "";
  document.getElementById("event-panel-title").textContent = "Events (dataset-wide)";

  // Update breadcrumb
  document.getElementById("graph-drug-name").textContent = "All Drugs — Dataset-wide";

  await loadGlobalGraph();
}

async function switchToDrug() {
  state.mode = "drug";
  state.selectedNode = null;

  document.getElementById("btn-drug-view").classList.add("view-toggle-active");
  document.getElementById("btn-global-view").classList.remove("view-toggle-active");

  document.getElementById("drug-selector-panel").style.display = "";
  document.getElementById("event-panel").style.display = "none";
  document.getElementById("controls-panel").style.display = "none";

  // Clear graph
  d3.select("#graph-svg").selectAll("*").remove();
  document.getElementById("graph-topbar").style.display = "none";
  document.getElementById("graph-legend").style.display = "none";
  document.getElementById("graph-empty").style.display = "";
  document.getElementById("graph-empty").querySelector(".empty-title").textContent = "No drug selected";
  document.getElementById("graph-empty").querySelector(".empty-sub").textContent = "Choose a drug from the list on the left to see its adverse event co-occurrence network";
  document.getElementById("anomaly-panel").style.display = "none";
  document.getElementById("company-panel").style.display = "none";
  hideNodeDetail();
}

async function loadGlobalGraph() {
  showGraphLoading("Loading dataset-wide events…");
  hideGraphError();
  try {
    // Load global adverse events for the checklist
    state.adverseData = await apiFetch("/global/adverse-events");
    state.checkedEvents = new Set(state.adverseData.all_events);
    renderEventList();
    showEventPanel("Dataset-wide", state.adverseData);

    updateLoadingMsg("Building global co-occurrence graph — this may take a moment…");
    const params = new URLSearchParams({
      jaccard_threshold: state.jaccardThresh,
      min_prevalence:    state.prevThresh,
    });
    state.graphData = await apiFetch("/global/cooccurrence?" + params);

    hideGraphLoading();
    const mlBadge = document.getElementById("ml-badge");
    mlBadge.style.display = "none"; // ML is skipped for global view (too slow)

    renderGraph(state.graphData);
    renderCompanyBreakdown(state.adverseData);
    renderAnomalies(state.graphData.anomalies, state.graphData.company_events);
    hideNodeDetail();
  } catch (err) {
    hideGraphLoading();
    showGraphError(err.message);
  }
}

// ─── STATIC LAYOUT HELPERS ────────────────────────────────────────────

/**
 * Assign initial positions in a deterministic sunflower/phyllotaxis spiral.
 * This spreads nodes evenly across the canvas before collision resolution,
 * avoiding the "all-nodes-start-at-centre" pile-up of random seeding.
 */
function phyllotaxisLayout(nodes, cx, cy, minSpacing) {
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~137.5°
  nodes.forEach((n, i) => {
    const r     = minSpacing * Math.sqrt(i + 0.5);
    const theta = i * GOLDEN_ANGLE;
    n.x = cx + r * Math.cos(theta);
    n.y = cy + r * Math.sin(theta);
  });
}

/**
 * Iterative collision resolution — no forces, no spring, no movement after
 * this function returns.  Nodes are nudged apart until none overlap, then
 * the whole layout is re-centred and scaled to fit the viewport.
 *
 * MIN_GAP pixels of breathing room between circle edges.
 */
function resolveCollisions(nodes, nComp, MIN_GAP = 18) {
  const ITERS = 300;
  for (let iter = 0; iter < ITERS; iter++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a  = nodes[i], b = nodes[j];
        const ri = nodeRadius(a.count, nComp);
        const rj = nodeRadius(b.count, nComp);
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist    = Math.hypot(dx, dy) || 0.001;
        const minDist = ri + rj + MIN_GAP;
        if (dist < minDist) {
          const push = (minDist - dist) / dist * 0.5;
          a.x -= dx * push;  a.y -= dy * push;
          b.x += dx * push;  b.y += dy * push;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
}

/**
 * Scale + translate the final positions so the graph fills the viewport
 * with comfortable padding on all sides.
 */
function fitToViewport(nodes, W, H, padding = 60) {
  if (!nodes.length) return;
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const layoutW = x1 - x0 || 1, layoutH = y1 - y0 || 1;
  const scale = Math.min(
    (W - padding * 2) / layoutW,
    (H - padding * 2) / layoutH,
    1.2    // don't upscale tiny graphs beyond 120%
  );
  const offX = (W - layoutW * scale) / 2 - x0 * scale;
  const offY = (H - layoutH * scale) / 2 - y0 * scale;
  nodes.forEach(n => {
    n.x = n.x * scale + offX;
    n.y = n.y * scale + offY;
  });
}

// ─── D3 GRAPH ─────────────────────────────────────────────────────────
function renderGraph(data) {
  const svgEl = document.getElementById("graph-svg");
  const W     = svgEl.clientWidth  || svgEl.getBoundingClientRect().width  || 700;
  const H     = svgEl.clientHeight || svgEl.getBoundingClientRect().height || 520;
  const nComp = data.company_events ? Object.keys(data.company_events).length : 1;

  // Stop any previous simulation (kept in state for safety, though we no longer run one)
  if (state.simulation) { state.simulation.stop(); state.simulation = null; }
  d3.select("#graph-svg").selectAll("*").remove();

  const svg = d3.select("#graph-svg").attr("width", W).attr("height", H);

  if (!data.nodes.length) {
    svg.append("text")
      .attr("x", W / 2).attr("y", H / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#9ca3af").attr("font-size", "13")
      .attr("font-family", "Inter,sans-serif")
      .text("No co-occurrence edges found — try lowering the Jaccard threshold");
    showGraphTopbar(data);
    return;
  }

  // ── Zoom (pan + scale only — nodes are static) ──
  const zoomBehaviour = d3.zoom()
    .scaleExtent([0.08, 10])
    .on("zoom", e => gAll.attr("transform", e.transform));
  svg.call(zoomBehaviour);
  state.zoom = zoomBehaviour;

  document.getElementById("zoom-in-btn").onclick  = () => svg.transition().call(zoomBehaviour.scaleBy, 1.4);
  document.getElementById("zoom-out-btn").onclick = () => svg.transition().call(zoomBehaviour.scaleBy, 0.71);
  document.getElementById("reset-btn").onclick    = () => svg.transition().call(zoomBehaviour.transform, d3.zoomIdentity);

  const gAll   = svg.append("g");
  const gLinks = gAll.append("g").attr("class", "links");
  const gNodes = gAll.append("g").attr("class", "nodes");

  // Deep-copy data so layout mutations don't touch the original
  const nodes = data.nodes.map(n => ({ ...n }));
  const edges = data.edges.map(e => ({ ...e }));

  // ── Build an id→node index for edge resolution ──
  const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]));

  // ── STATIC LAYOUT ────────────────────────────────────────────────
  // 1. Seed positions in a phyllotaxis spiral so nodes start spread out
  phyllotaxisLayout(nodes, W / 2, H / 2, nodeRadius(nComp * 0.5, nComp) * 3.2);

  // 2. Push overlapping nodes apart (no forces — purely geometric)
  resolveCollisions(nodes, nComp, 20);

  // 3. Scale & centre the result to fill the viewport
  fitToViewport(nodes, W, H, 55);

  // ── EDGES ──────────────────────────────────────────────────────
  // Resolve source/target strings → node objects now (no simulation to do it)
  const resolvedEdges = edges.map(e => ({
    ...e,
    source: nodeById[e.source] || nodeById[e.source?.id] || e.source,
    target: nodeById[e.target] || nodeById[e.target?.id] || e.target,
  })).filter(e => e.source?.x !== undefined && e.target?.x !== undefined);

  // Store on state so selectNode can reach the resolved edges
  state.resolvedEdges = resolvedEdges;

  // Build per-edge visual scales (width + opacity based on Jaccard × degree)
  const edgeScales = buildEdgeScales(resolvedEdges, nodeById);

  const link = gLinks.selectAll(".link")
    .data(resolvedEdges)
    .enter().append("line")
    .attr("class", "link")
    .attr("x1", e => e.source.x).attr("y1", e => e.source.y)
    .attr("x2", e => e.target.x).attr("y2", e => e.target.y)
    .attr("stroke-width", (e, i) => edgeScales[i].width)
    .attr("opacity",      (e, i) => edgeScales[i].opacity)
    // Store scale on datum so tooltip can read it
    .each(function(e, i) { e._scale = edgeScales[i]; })
    .on("mouseenter", function(evt, e) {
      d3.select(this).classed("highlighted", true);
      const deg = e._scale?.degree || {};
      const s = e.source?.id ?? e.source;
      const t = e.target?.id ?? e.target;
      showTip(evt,
        `<div class="tt-title" style="color:#dc143c">${s} ↔ ${t}</div>
         <div class="tt-grid">
           <span>Jaccard</span><span class="tt-val">${e.weight.toFixed(3)}</span>
           <span>Co-occurs in</span><span class="tt-val">${e.co_count} companies</span>
           <div class="tt-sep"></div>
           <span>${s} connections</span><span class="tt-val">${deg[s] || 0}</span>
           <span>${t} connections</span><span class="tt-val">${deg[t] || 0}</span>
         </div>`
      );
    })
    .on("mousemove", moveTip)
    .on("mouseleave", function() {
      d3.select(this).classed("highlighted", false);
      hideTip();
    });

  // ── NODES ──────────────────────────────────────────────────────
  const node = gNodes.selectAll(".node")
    .data(nodes)
    .enter().append("g")
    .attr("class", "node")
    .attr("transform", d => `translate(${d.x},${d.y})`)
    // Allow manual repositioning via drag (positions stay wherever dropped)
    .call(d3.drag()
      .on("drag", function(evt, d) {
        d.x += evt.dx;
        d.y += evt.dy;
        d3.select(this).attr("transform", `translate(${d.x},${d.y})`);
        // Update attached edges live
        link
          .filter(e => e.source === d)
          .attr("x1", d.x).attr("y1", d.y);
        link
          .filter(e => e.target === d)
          .attr("x2", d.x).attr("y2", d.y);
      })
    )
    .on("mouseenter", function(evt, d) {
      if (!state.selectedNode) highlightNeighbours(d, nodes, resolvedEdges);
      showTip(evt,
        `<div class="tt-title" style="color:${nodeColor(d.count,nComp)};text-transform:capitalize">${d.id}</div>
         <div class="tt-grid">
           <span>Companies reporting</span><span class="tt-val">${d.count} / ${nComp}</span>
           <span>Prevalence</span><span class="tt-val">${Math.round(d.count / nComp * 100)}%</span>
           ${d.synonyms?.length
             ? `<div class="tt-sep"></div>
                <span style="grid-column:1/-1;color:rgba(255,255,255,.5);font-size:10px">Also listed as:</span><span></span>
                ${d.synonyms.slice(0,3).map(s => `<span style="color:rgba(255,255,255,.7)">${s}</span><span></span>`).join("")}`
             : ""}
         </div>`
      );
    })
    .on("mousemove", moveTip)
    .on("mouseleave", () => {
      // Only reset highlight if no node is persistently selected
      if (!state.selectedNode) { resetHighlight(); }
      hideTip();
    })
    .on("click", (evt, d) => {
      evt.stopPropagation();
      selectNode(d, nComp, data.company_events);
    });

  node.append("circle")
    .attr("r",            d => nodeRadius(d.count, nComp))
    .attr("fill",         d => nodeColor(d.count, nComp))
    .attr("stroke",       "#fff")
    .attr("stroke-width", 2);

  node.append("text")
    .attr("dy", d => nodeRadius(d.count, nComp) + 12)
    .text(d => d.id.length > 24 ? d.id.slice(0, 22) + "…" : d.id)
    .attr("font-size",    "10")
    .attr("fill",         "#374151")
    .attr("text-anchor",  "middle")
    .attr("font-family",  "Inter,sans-serif")
    .attr("font-weight",  "500");

  // Background click = deselect
  svg.on("click", () => { deselectNode(); });

  applyEventFilter();
  showGraphTopbar(data);
  document.getElementById("graph-legend").style.display = "";
  document.getElementById("graph-empty").style.display  = "none";
}

// ─── HIGHLIGHT / DIM ──────────────────────────────────────────────────
function highlightNeighbours(d, nodes, edges) {
  const neighbourIds = new Set([d.id]);
  edges.forEach(e => {
    // After static layout, source/target may be node objects or id strings
    const sid = e.source?.id ?? e.source;
    const tid = e.target?.id ?? e.target;
    if (sid === d.id) neighbourIds.add(tid);
    if (tid === d.id) neighbourIds.add(sid);
  });

  d3.selectAll(".node")
    .classed("highlighted", n => n.id === d.id)
    .classed("dimmed",      n => !neighbourIds.has(n.id));

  d3.selectAll(".link")
    .classed("highlighted", e => {
      const s = e.source?.id ?? e.source, t = e.target?.id ?? e.target;
      return s === d.id || t === d.id;
    })
    .classed("dimmed", e => {
      const s = e.source?.id ?? e.source, t = e.target?.id ?? e.target;
      return s !== d.id && t !== d.id;
    });
}

function resetHighlight() {
  d3.selectAll(".node").classed("highlighted",false).classed("dimmed",false);
  d3.selectAll(".link").classed("highlighted",false).classed("dimmed",false);
}

// ─── NODE DETAIL PANEL ────────────────────────────────────────────────
function selectNode(d, nComp, companyEvents) {
  // If clicking the already-selected node, deselect
  if (state.selectedNode?.id === d.id) {
    deselectNode();
    return;
  }

  state.selectedNode = d;

  // ── Persistent selection ring on the circle ──
  d3.selectAll(".node circle")
    .attr("stroke",       n => n.id === d.id ? "#1a1a2e" : "#fff")
    .attr("stroke-width", n => n.id === d.id ? 3.5       : 2);

  // ── Highlight neighbours (stay highlighted while selected) ──
  highlightNeighbours(d, state.graphData.nodes, state.resolvedEdges || state.graphData.edges);

  // ── Right panel ──
  const panel = document.getElementById("node-detail");
  panel.style.display = "";

  document.getElementById("nd-name").textContent = d.id;

  const frac = d.count / nComp;
  document.getElementById("nd-stats").innerHTML = `
    <span class="nd-chip">${d.count} / ${nComp} companies</span>
    <span class="nd-chip" style="color:${nodeColor(d.count,nComp)}">${Math.round(frac*100)}% prevalence</span>`;

  // ── Companies that report this event ──
  // Build a set of all raw terms that map to this canonical node
  // Sources: node.synonyms (from ML grouping) + sidebar synonyms_map
  const synMap   = state.adverseData?.synonyms_map || {};
  const variants = new Set([
    d.id,
    ...(d.synonyms || []),
    ...(synMap[d.id] || []),
  ]);
  const reporters = Object.entries(companyEvents)
    .filter(([, evts]) => evts.some(e => variants.has(e)))
    .map(([company]) => company);

  const reporterLimit = 20;
  document.getElementById("nd-companies").innerHTML =
    `<strong>Reported by (${reporters.length}):</strong><br>` +
    reporters.slice(0, reporterLimit).map(c => `• ${c}`).join("<br>") +
    (reporters.length > reporterLimit ? `<br><em>… and ${reporters.length - reporterLimit} more</em>` : "");

  // ── Connected nodes, sorted by Jaccard (strongest first) ──
  const edges     = state.resolvedEdges || [];
  const connected = [];
  edges.forEach(e => {
    const sid = e.source?.id ?? e.source;
    const tid = e.target?.id ?? e.target;
    if (sid === d.id) connected.push({ id: tid,  weight: e.weight, co_count: e.co_count });
    if (tid === d.id) connected.push({ id: sid,  weight: e.weight, co_count: e.co_count });
  });
  connected.sort((a, b) => b.weight - a.weight);

  const ndConnEl = document.getElementById("nd-connected");
  if (connected.length) {
    ndConnEl.style.display = "";
    ndConnEl.innerHTML = `
      <div class="nd-conn-header">
        <strong>Connected events</strong>
        <span class="nd-conn-count">${connected.length}</span>
      </div>
      <div class="nd-conn-list">
        ${connected.map(c => {
          const bar = Math.round(c.weight * 100);
          const col = c.weight >= 0.7 ? COL_HIGH : c.weight >= 0.45 ? COL_MED : COL_LOW;
          return `
            <div class="nd-conn-item">
              <div class="nd-conn-name">${c.id}</div>
              <div class="nd-conn-meta">
                <div class="nd-conn-bar-track">
                  <div class="nd-conn-bar-fill" style="width:${bar}%;background:${col}"></div>
                </div>
                <span class="nd-conn-pct" style="color:${col}">${bar}%</span>
              </div>
            </div>`;
        }).join("")}
      </div>`;
  } else {
    ndConnEl.style.display = "none";
  }

  // ── Synonyms ──
  const synEl = document.getElementById("nd-synonyms");
  if (d.synonyms?.length) {
    synEl.style.display = "";
    synEl.innerHTML = `<strong>Also listed as:</strong>${d.synonyms.slice(0, 5).map(s => `<br>• ${s}`).join("")}`;
  } else {
    synEl.style.display = "none";
  }
}

function deselectNode() {
  state.selectedNode = null;
  // Remove selection ring
  d3.selectAll(".node circle")
    .attr("stroke",       "#fff")
    .attr("stroke-width", 2);
  resetHighlight();
  hideNodeDetail();
}

function hideNodeDetail() {
  document.getElementById("node-detail").style.display = "none";
}

// ─── GRAPH TOPBAR ─────────────────────────────────────────────────────
function showGraphTopbar(data) {
  document.getElementById("graph-topbar").style.display = "";
  document.getElementById("graph-drug-name").textContent = state.selectedDrug;
  document.getElementById("graph-stats").innerHTML = `
    <span class="graph-stat-chip">${data.nodes.length} events</span>
    <span class="graph-stat-chip">${data.edges.length} edges</span>
    <span class="graph-stat-chip">${Object.keys(data.company_events||{}).length} companies</span>`;
}

// ─── ANOMALY PANEL ────────────────────────────────────────────────────
function renderAnomalies(anomalies, companyEvents) {
  const panel = document.getElementById("anomaly-panel");
  const list  = document.getElementById("anomaly-list");
  document.getElementById("anomaly-count").textContent = anomalies.length || "";

  if (!anomalies.length) {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "";
  list.innerHTML = "";

  // Group by company
  const byCompany = {};
  anomalies.forEach(a => {
    if (!byCompany[a.company]) byCompany[a.company] = [];
    byCompany[a.company].push(a);
  });

  Object.entries(byCompany)
    .sort((a,b) => b[1].length - a[1].length)
    .slice(0, 8)
    .forEach(([company, items]) => {
      const el = document.createElement("div");
      el.className = "anomaly-item";
      el.innerHTML = `
        <div class="anomaly-company">⚠ ${company}</div>
        ${items.slice(0,3).map(a => `
          <div class="anomaly-detail">
            Has <em>${a.has.slice(0,40)}</em> but missing <em>${a.missing.slice(0,40)}</em>
          </div>
          <div class="anomaly-rate">${Math.round(a.pattern_rate*100)}% of peers have both</div>
        `).join("")}
        ${items.length > 3 ? `<div class="anomaly-rate">…and ${items.length-3} more breaks</div>` : ""}`;
      list.appendChild(el);
    });
}

// ─── COMPANY BREAKDOWN ────────────────────────────────────────────────
function renderCompanyBreakdown(adverseData) {
  const panel = document.getElementById("company-panel");
  if (!adverseData) { panel.style.display="none"; return; }
  panel.style.display = "";

  const companies = Object.entries(adverseData.company_events)
    .map(([c, evts]) => ({ company: c, count: evts.length }))
    .sort((a,b) => b.count - a.count);

  document.getElementById("company-panel-count").textContent = companies.length;

  const container = document.getElementById("company-breakdown");
  container.innerHTML = companies.slice(0,15).map(c => `
    <div class="co-company">
      <span class="co-company-name">${c.company}</span>
      <span class="co-company-count">${c.count} events</span>
    </div>`).join("") +
    (companies.length > 15
      ? `<div style="font-size:11px;color:#9ca3af;padding:4px 8px">… and ${companies.length-15} more</div>`
      : "");
}

// ─── CONTROLS: SLIDERS ────────────────────────────────────────────────
function setupSliders() {
  const jSlider  = document.getElementById("jaccard-slider");
  const jVal     = document.getElementById("jaccard-val");
  const pSlider  = document.getElementById("prev-slider");
  const pVal     = document.getElementById("prev-val");

  jSlider.addEventListener("input", function() {
    state.jaccardThresh = parseFloat(this.value);
    jVal.textContent    = this.value;
  });
  pSlider.addEventListener("input", function() {
    state.prevThresh = parseFloat(this.value);
    pVal.textContent = Math.round(this.value * 100) + "%";
  });
}

// ─── LOADING / ERROR HELPERS ──────────────────────────────────────────
function showGraphLoading(msg) {
  document.getElementById("graph-loading").style.display = "flex";
  document.getElementById("graph-empty").style.display   = "none";
  document.getElementById("graph-topbar").style.display  = "none";
  document.getElementById("graph-legend").style.display  = "none";
  updateLoadingMsg(msg);
}
function updateLoadingMsg(msg) {
  document.getElementById("loading-msg").textContent = msg;
}
function hideGraphLoading() {
  document.getElementById("graph-loading").style.display = "none";
}
function showGraphError(msg) {
  const el = document.getElementById("graph-error");
  el.style.display = "flex";
  document.getElementById("graph-error-msg").textContent = msg;
}
function hideGraphError() {
  document.getElementById("graph-error").style.display = "none";
}

// ─── BOOT ─────────────────────────────────────────────────────────────
init();
