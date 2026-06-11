/* =====================================================================
   Drug Monograph Explorer — chart.js
   All D3 chart logic. Fetches data from the Flask API at runtime.
   ===================================================================== */

// ═══════════════════════════════════════════════════════════════════════
// CONFIG — tweak these without touching the chart logic
// ═══════════════════════════════════════════════════════════════════════

/** Base URL of the Flask API. Change if your server runs on a different port. */
// const API_BASE = "http://localhost:5000/api";
const API_BASE = window.location.protocol + "//" + window.location.host + "/api";

/** Color palette for drug classes (index-matched, loops if > 19 classes). */
const CLASS_COLORS = [
  "#dc143c", "#2563eb", "#059669", "#d97706", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#ea580c", "#6366f1",
  "#0f766e", "#b45309", "#9333ea", "#0369a1", "#be123c",
  "#15803d", "#c2410c", "#4338ca", "#0e7490",
];

/** Color palette for companies inside a drill-down view. */
const COMPANY_COLORS = [
  "#dc143c", "#2563eb", "#059669", "#d97706", "#7c3aed", "#0891b2",
  "#db2777", "#65a30d", "#ea580c", "#6366f1", "#0f766e", "#b45309",
  "#9333ea", "#0369a1", "#be123c", "#15803d", "#c2410c", "#4338ca",
  "#0e7490", "#92400e", "#7f1d1d", "#1e3a5f", "#14532d", "#713f12",
  "#4c1d95", "#164e63", "#831843", "#365314", "#7c2d12", "#1e1b4b",
  "#134e4a", "#78350f", "#3b0764", "#0c4a6e", "#881337", "#1a2e05",
  "#431407", "#312e81", "#042f2e", "#451a03",
];

/** Human-readable axis labels keyed by field name. */
const AXIS_LABELS = {
  n_medicines:          "Medicines in class",
  n_entries:            "Total entries",
  avg_severity:         "Avg severity score (%)",
  avg_contraindications:"Avg contraindications",
  avg_warnings:         "Avg warnings",
  avg_drug_interactions:"Avg drug interactions",
  avg_adverse_events:   "Avg adverse events",
};

/** D3 transition duration in ms — keep non-bouncy with cubicInOut. */
const DUR = 520;
const EASE = d3.easeCubicInOut;


// ═══════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════

const state = {
  view:          "classes",   // "classes" | "companies"
  selectedClass: null,        // string | null
  xField:        "n_medicines",
  yField:        "avg_severity",

  // Data caches — populated by API calls
  classData:    [],           // array of class aggregation objects
  companyCaches: {},          // { [drugClass]: array of company objects }
  summaryData:  null,         // summary stats from /api/summary
};

/** Color map: drug class name → hex color (built once classes load). */
const classColorMap = {};

/** Color map: { [drugClass]: { [company]: hex } } — built per drill-down. */
const companyColorMaps = {};


// ═══════════════════════════════════════════════════════════════════════
// API HELPERS
// ═══════════════════════════════════════════════════════════════════════

async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Load everything needed for the initial view:
 *  1. /api/summary → header chips
 *  2. /api/classes → class bubbles
 */
async function loadAll() {
  showLoading(true);
  hideError();

  try {
    const [summary, classes] = await Promise.all([
      apiFetch("/summary"),
      apiFetch("/classes"),
    ]);

    state.summaryData = summary;
    state.classData   = classes;

    // Build class color map
    classes.forEach((d, i) => {
      classColorMap[d.drug_class] = CLASS_COLORS[i % CLASS_COLORS.length];
    });

    renderSummaryChips(summary);
    render(false);
    showLoading(false);

  } catch (err) {
    showLoading(false);
    showError(`Failed to load data: ${err.message}. Make sure the Flask server is running.`);
    console.error(err);
  }
}

/**
 * Load company data for a specific drug class on demand (lazy).
 * Caches the result so subsequent drills are instant.
 */
async function loadCompanies(drugClass) {
  if (state.companyCaches[drugClass]) return; // already cached

  const encoded = encodeURIComponent(drugClass);
  const data = await apiFetch(`/classes/${encoded}/companies`);
  state.companyCaches[drugClass] = data;

  // Build company color map
  if (!companyColorMaps[drugClass]) {
    const map = {};
    data.forEach((d, i) => {
      map[d.company] = COMPANY_COLORS[i % COMPANY_COLORS.length];
    });
    companyColorMaps[drugClass] = map;
  }
}


// ═══════════════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════════════

function showLoading(on) {
  document.getElementById("loading-overlay").style.display = on ? "flex" : "none";
}

function showError(msg) {
  document.getElementById("error-msg").textContent = msg;
  document.getElementById("error-overlay").style.display = "flex";
}

function hideError() {
  document.getElementById("error-overlay").style.display = "none";
}

function renderSummaryChips(summary) {
  const bar = document.getElementById("stats-bar");
  bar.innerHTML = [
    ["Entries",       summary.total_entries],
    ["Unique drugs",  summary.unique_drugs],
    ["Classes",       summary.unique_classes],
    ["Manufacturers", summary.unique_companies],
  ].map(([label, val]) =>
    `<div class="stat-chip"><strong>${val.toLocaleString()}</strong>${label}</div>`
  ).join("");
}

function fv(d, field) {
  return +d[field] || 0;
}


// ═══════════════════════════════════════════════════════════════════════
// SVG SETUP
// ═══════════════════════════════════════════════════════════════════════

const svg    = d3.select("#chart-svg");
let W, H, margin, iW, iH;

function computeDims() {
  const el = document.getElementById("chart-wrap");
  W  = el.clientWidth;
  H  = el.clientHeight;
  margin = { top: 24, right: 32, bottom: 52, left: 62 };
  iW = W - margin.left - margin.right;
  iH = H - margin.top  - margin.bottom;
}
computeDims();

const root   = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
const gGrid  = root.append("g").attr("class", "grid-group");
const gXAxis = root.append("g").attr("class", "axis").attr("transform", `translate(0,${iH})`);
const gYAxis = root.append("g").attr("class", "axis");
const gDots  = root.append("g").attr("class", "dots");
const gLabels= root.append("g").attr("class", "labels");

const xLabelEl = root.append("text")
  .attr("class", "axis-label-text")
  .attr("text-anchor", "middle")
  .attr("x", iW / 2)
  .attr("y", iH + 42);

const yLabelEl = root.append("text")
  .attr("class", "axis-label-text")
  .attr("text-anchor", "middle")
  .attr("transform", `translate(-48,${iH / 2})rotate(-90)`);


// ═══════════════════════════════════════════════════════════════════════
// SCALES
// ═══════════════════════════════════════════════════════════════════════

let xScale = d3.scaleLinear();
let yScale = d3.scaleLinear();

function updateScales(data) {
  const xVals = data.map(d => fv(d, state.xField));
  const yVals = data.map(d => fv(d, state.yField));
  const xExt  = d3.extent(xVals);
  const yExt  = d3.extent(yVals);
  const xPad  = ((xExt[1] - xExt[0]) * 0.15) || 1;
  const yPad  = ((yExt[1] - yExt[0]) * 0.15) || 1;

  xScale.domain([Math.max(0, xExt[0] - xPad), xExt[1] + xPad]).range([0, iW]).nice();
  yScale.domain([Math.max(0, yExt[0] - yPad), yExt[1] + yPad]).range([iH, 0]).nice();
}


// ═══════════════════════════════════════════════════════════════════════
// JITTER — separate overlapping company dots
// ═══════════════════════════════════════════════════════════════════════

/**
 * Given an array of data objects and a uniform radius, nudge any
 * overlapping screen positions apart via a simple iterative repulsion.
 * Returns an array of { d, cx, cy, r } objects in the same order.
 */
function jitterPositions(data, r) {
  const pts = data.map(d => ({
    d,
    cx: xScale(fv(d, state.xField)),
    cy: yScale(fv(d, state.yField)),
    r,
  }));

  const ITERS = 100;
  const STEP  = 0.55;

  for (let iter = 0; iter < ITERS; iter++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx   = pts[j].cx - pts[i].cx;
        const dy   = pts[j].cy - pts[i].cy;
        const dist = Math.hypot(dx, dy);
        const minD = pts[i].r + pts[j].r + 3; // 3px gap

        if (dist < minD) {
          if (dist < 0.001) {
            // Exact overlap — pick a random direction
            const angle = Math.random() * Math.PI * 2;
            pts[j].cx += Math.cos(angle) * minD * 0.5;
            pts[j].cy += Math.sin(angle) * minD * 0.5;
          } else {
            const push = ((minD - dist) / dist) * STEP;
            pts[i].cx -= dx * push * 0.5;
            pts[i].cy -= dy * push * 0.5;
            pts[j].cx += dx * push * 0.5;
            pts[j].cy += dy * push * 0.5;
          }
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return pts;
}


// ═══════════════════════════════════════════════════════════════════════
// TOOLTIP
// ═══════════════════════════════════════════════════════════════════════

const tipEl = document.getElementById("tooltip");

function showTip(evt, d) {
  const isClass = state.view === "classes";
  const name  = isClass ? d.drug_class : d.company;
  const color = isClass
    ? classColorMap[d.drug_class]
    : (companyColorMaps[state.selectedClass] || {})[d.company] || "#6b7280";

  const rows = [
    ["Entries",          d.n_entries],
    ["Medicines",        d.n_medicines],
    null, // separator
    ["Avg Severity",     fv(d, "avg_severity").toFixed(1) + "%"],
    ["Avg Contraind.",   fv(d, "avg_contraindications").toFixed(1)],
    ["Avg Warnings",     fv(d, "avg_warnings").toFixed(1)],
    ["Avg Drug Inter.",  fv(d, "avg_drug_interactions").toFixed(1)],
    ["Avg Adverse Ev.",  fv(d, "avg_adverse_events").toFixed(1)],
  ];

  let html = `<div class="tt-title" style="color:${color}">${name}</div><div class="tt-grid">`;
  rows.forEach(row => {
    if (!row) {
      html += `<div class="tt-sep"></div>`;
    } else {
      html += `<span>${row[0]}</span><span class="tt-val">${row[1]}</span>`;
    }
  });
  if (isClass) {
    html += `<div class="tt-hint">↗ Click to explore manufacturers</div>`;
  }
  html += `</div>`;

  tipEl.innerHTML = html;
  tipEl.classList.add("show");
  moveTip(evt);
}

function moveTip(evt) {
  const x = Math.min(evt.clientX + 16, window.innerWidth - 278);
  const y = Math.min(evt.clientY - 8,  window.innerHeight - 280);
  tipEl.style.left = x + "px";
  tipEl.style.top  = y + "px";
}

function hideTip() {
  tipEl.classList.remove("show");
}


// ═══════════════════════════════════════════════════════════════════════
// RENDER AXES + GRID
// ═══════════════════════════════════════════════════════════════════════

function renderAxes(animate) {
  const t = d3.transition().duration(animate ? DUR : 0).ease(EASE);

  gXAxis.transition(t).call(d3.axisBottom(xScale).ticks(6).tickSize(0).tickPadding(8));
  gYAxis.transition(t).call(d3.axisLeft(yScale).ticks(6).tickSize(0).tickPadding(8));

  // Grid lines
  let gx = gGrid.select(".gx");
  let gy = gGrid.select(".gy");
  if (gx.empty()) gx = gGrid.append("g").attr("class", "gx").attr("transform", `translate(0,${iH})`);
  if (gy.empty()) gy = gGrid.append("g").attr("class", "gy");

  gx.transition(t).call(d3.axisBottom(xScale).ticks(6).tickSize(-iH).tickFormat(""));
  gy.transition(t).call(d3.axisLeft(yScale).ticks(6).tickSize(-iW).tickFormat(""));

  gGrid.selectAll("line").classed("grid-line", true);
  gGrid.selectAll("path").attr("stroke", "none");
  gXAxis.select(".domain").classed("axis-line", true);
  gYAxis.select(".domain").classed("axis-line", true);

  xLabelEl.attr("x", iW / 2).attr("y", iH + 42).text(AXIS_LABELS[state.xField] || state.xField);
  yLabelEl.attr("transform", `translate(-48,${iH / 2})rotate(-90)`).text(AXIS_LABELS[state.yField] || state.yField);
}


// ═══════════════════════════════════════════════════════════════════════
// RENDER CLASS BUBBLES
// ═══════════════════════════════════════════════════════════════════════

function renderClasses(animate) {
  const data = state.classData;
  const t    = d3.transition().duration(animate ? DUR : 0).ease(EASE);

  const rScale = d3.scaleSqrt()
    .domain([0, d3.max(data, d => d.n_entries) || 1])
    .range([10, 36]);

  // Remove company layer
  gDots.selectAll(".company-dot").transition(t).attr("r", 0).attr("opacity", 0).remove();
  gLabels.selectAll(".company-label").transition(t).attr("opacity", 0).remove();

  // ── Bubbles ──
  const bubbles = gDots.selectAll(".class-bubble")
    .data(data, d => d.drug_class);

  bubbles.exit().transition(t).attr("r", 0).attr("opacity", 0).remove();

  const enter = bubbles.enter().append("circle")
    .attr("class", "class-bubble")
    .attr("cx", d => xScale(fv(d, state.xField)))
    .attr("cy", d => yScale(fv(d, state.yField)))
    .attr("r",  0)
    .attr("opacity", 0)
    .attr("fill",   d => classColorMap[d.drug_class] || "#6b7280")
    .attr("stroke", "#fff")
    .attr("stroke-width", 2)
    .style("cursor", "pointer")
    .on("mouseenter", function(evt, d) {
      showTip(evt, d);
      d3.select(this).raise().attr("stroke", "#1a1a2e").attr("stroke-width", 2.5);
    })
    .on("mousemove", moveTip)
    .on("mouseleave", function(evt, d) {
      hideTip();
      d3.select(this).attr("stroke", "#fff").attr("stroke-width", 2);
    })
    .on("click", (evt, d) => drillDown(d.drug_class));

  enter.merge(bubbles).transition(t)
    .attr("cx",      d => xScale(fv(d, state.xField)))
    .attr("cy",      d => yScale(fv(d, state.yField)))
    .attr("r",       d => rScale(d.n_entries))
    .attr("opacity", 0.88)
    .attr("fill",    d => classColorMap[d.drug_class] || "#6b7280");

  // ── Floating pill labels ──
  const labels = gLabels.selectAll(".class-label")
    .data(data, d => d.drug_class);

  labels.exit().transition(t).attr("opacity", 0).remove();

  const lEnter = labels.enter().append("g")
    .attr("class", "class-label")
    .attr("pointer-events", "none")
    .attr("opacity", 0);

  lEnter.append("rect");
  lEnter.append("text");

  const lMerge = lEnter.merge(labels);

  lMerge.transition(t)
    .attr("opacity", 1)
    .attr("transform", d =>
      `translate(${xScale(fv(d, state.xField))},${yScale(fv(d, state.yField)) - rScale(d.n_entries) - 8})`
    );

  lMerge.each(function(d) {
    const g     = d3.select(this);
    const label = d.drug_class.length > 20 ? d.drug_class.slice(0, 18) + "…" : d.drug_class;
    const W_CH  = 6.2; // approx width per character at font-size 10.5px
    const W_TXT = label.length * W_CH;

    g.select("rect")
      .attr("x",           -(W_TXT / 2) - 6)
      .attr("y",           -9)
      .attr("width",       W_TXT + 12)
      .attr("height",      18)
      .attr("rx",          5)
      .attr("fill",        "rgba(255,255,255,0.9)")
      .attr("stroke",      "rgba(0,0,0,0.08)")
      .attr("stroke-width", 0.5);

    g.select("text")
      .attr("text-anchor",      "middle")
      .attr("dominant-baseline","middle")
      .attr("y",           0)
      .attr("font-family", "Inter,sans-serif")
      .attr("font-size",   "10.5")
      .attr("font-weight", "500")
      .attr("fill",        "#374151")
      .text(label);
  });
}


// ═══════════════════════════════════════════════════════════════════════
// RENDER COMPANY DOTS (drill-down)
// ═══════════════════════════════════════════════════════════════════════

function renderCompanies(animate) {
  const data  = state.companyCaches[state.selectedClass] || [];
  const t     = d3.transition().duration(animate ? DUR : 0).ease(EASE);
  const cmap  = companyColorMaps[state.selectedClass] || {};

  // Remove class layer
  gDots.selectAll(".class-bubble").transition(t).attr("r", 0).attr("opacity", 0).remove();
  gLabels.selectAll(".class-label").transition(t).attr("opacity", 0).remove();

  const rScale = d3.scaleSqrt()
    .domain([0, d3.max(data, d => d.n_entries) || 1])
    .range([7, 22]);

  // Collision-free positions
  const jittered  = jitterPositions(data, 12);
  const jitMap    = {};
  data.forEach((d, i) => { jitMap[d.company] = jittered[i]; });

  const dots = gDots.selectAll(".company-dot")
    .data(data, d => d.company);

  dots.exit().transition(t).attr("r", 0).attr("opacity", 0).remove();

  const enter = dots.enter().append("circle")
    .attr("class", "company-dot")
    .attr("cx", (d, i) => jittered[i].cx)
    .attr("cy", (d, i) => jittered[i].cy)
    .attr("r",  0)
    .attr("opacity", 0)
    .attr("fill",   d => cmap[d.company] || "#6b7280")
    .attr("stroke", "#fff")
    .attr("stroke-width", 1.5)
    .style("cursor", "default")
    .on("mouseenter", function(evt, d) {
      showTip(evt, d);
      d3.select(this).raise().attr("stroke", "#1a1a2e").attr("stroke-width", 2.5);
    })
    .on("mousemove", moveTip)
    .on("mouseleave", function(evt, d) {
      hideTip();
      d3.select(this).attr("stroke", "#fff").attr("stroke-width", 1.5);
    });

  enter.merge(dots).transition(t)
    .attr("cx",      d => jitMap[d.company]?.cx ?? xScale(fv(d, state.xField)))
    .attr("cy",      d => jitMap[d.company]?.cy ?? yScale(fv(d, state.yField)))
    .attr("r",       d => rScale(d.n_entries))
    .attr("opacity", 0.85)
    .attr("fill",    d => cmap[d.company] || "#6b7280");

  // No persistent labels — tooltip covers it
  gLabels.selectAll(".company-label").transition(t).attr("opacity", 0).remove();
}


// ═══════════════════════════════════════════════════════════════════════
// MAIN RENDER
// ═══════════════════════════════════════════════════════════════════════

function render(animate = true) {
  const data = state.view === "classes"
    ? state.classData
    : (state.companyCaches[state.selectedClass] || []);

  if (!data.length) return;

  updateScales(data);
  renderAxes(animate);

  if (state.view === "classes") renderClasses(animate);
  else                          renderCompanies(animate);

  updateLegend();
}


// ═══════════════════════════════════════════════════════════════════════
// LEGEND PANEL
// ═══════════════════════════════════════════════════════════════════════

function updateLegend() {
  const list  = document.getElementById("legend-list");
  const title = document.getElementById("legend-title");

  if (state.view === "classes") {
    title.textContent = "Drug Classes";
    list.innerHTML = "";

    state.classData.forEach((d, i) => {
      const color    = CLASS_COLORS[i % CLASS_COLORS.length];
      // Count companies for this class (from cache or show "–")
      const compData = state.companyCaches[d.drug_class];
      const count    = compData ? `${compData.length} co.` : `${d.n_entries} ent.`;

      const item = document.createElement("div");
      item.className = "legend-item";
      item.title = `Click to drill into ${d.drug_class}`;
      item.innerHTML = `
        <div class="legend-swatch" style="background:${color}"></div>
        <span class="legend-name">${d.drug_class}</span>
        <span class="legend-count">${count}</span>
      `;
      item.addEventListener("click", () => drillDown(d.drug_class));
      list.appendChild(item);
    });

  } else {
    const companies = state.companyCaches[state.selectedClass] || [];
    const cmap      = companyColorMaps[state.selectedClass] || {};

    title.textContent = `${state.selectedClass} (${companies.length})`;
    list.innerHTML = "";

    companies.forEach(d => {
      const color = cmap[d.company] || "#6b7280";
      const item  = document.createElement("div");
      item.className = "legend-item";
      item.innerHTML = `
        <div class="legend-swatch" style="background:${color}"></div>
        <span class="legend-name" style="font-size:11px">${d.company}</span>
        <span class="legend-count">${d.n_entries}</span>
      `;
      list.appendChild(item);
    });
  }
}


// ═══════════════════════════════════════════════════════════════════════
// DRILL DOWN / UP
// ═══════════════════════════════════════════════════════════════════════

async function drillDown(drugClass) {
  showLoading(true);
  try {
    await loadCompanies(drugClass);
  } catch (err) {
    showLoading(false);
    showError(`Could not load companies for "${drugClass}": ${err.message}`);
    return;
  }
  showLoading(false);

  state.view          = "companies";
  state.selectedClass = drugClass;

  // Update breadcrumb + back button
  document.getElementById("bc-sep").style.display = "";
  const bcClass = document.getElementById("bc-class");
  bcClass.textContent = drugClass;
  bcClass.style.display = "";
  document.getElementById("bc-root").style.fontWeight = "400";
  document.getElementById("back-btn").classList.add("visible");
  document.getElementById("footer-hint").textContent =
    "Each dot represents a manufacturer — hover for details";

  render(true);
}

function drillUp() {
  if (state.view === "classes") return;

  state.view          = "classes";
  state.selectedClass = null;

  document.getElementById("bc-sep").style.display = "none";
  document.getElementById("bc-class").style.display = "none";
  document.getElementById("bc-root").style.fontWeight = "600";
  document.getElementById("back-btn").classList.remove("visible");
  document.getElementById("footer-hint").textContent =
    "Click a bubble to explore manufacturers";

  render(true);
}


// ═══════════════════════════════════════════════════════════════════════
// AXIS RADIO CONTROLS
// ═══════════════════════════════════════════════════════════════════════

document.querySelectorAll(".axis-opt").forEach(el => {
  el.addEventListener("click", function() {
    const axis = this.dataset.axis;
    const val  = this.dataset.val;

    document.querySelectorAll(`.axis-opt[data-axis="${axis}"]`)
      .forEach(s => s.classList.remove("active"));
    this.classList.add("active");

    if (axis === "x") state.xField = val;
    else              state.yField = val;

    render(true);
  });
});


// ═══════════════════════════════════════════════════════════════════════
// RESIZE
// ═══════════════════════════════════════════════════════════════════════

window.addEventListener("resize", () => {
  computeDims();
  gXAxis.attr("transform", `translate(0,${iH})`);
  render(false);
});


// ═══════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════

loadAll();
