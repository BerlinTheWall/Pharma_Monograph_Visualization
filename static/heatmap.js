/* =====================================================================
   AE Heatmap + Treemap — heatmap.js
   Two linked D3 visualisations sharing a drug-class selection
   ===================================================================== */

const API_BASE = window.location.protocol + "//" + window.location.host + "/api";

// ═══════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════

const CLASS_COLORS = [
  "#dc143c","#2563eb","#059669","#d97706","#7c3aed",
  "#0891b2","#db2777","#65a30d","#ea580c","#6366f1",
  "#0f766e","#b45309","#9333ea","#0369a1","#be123c",
  "#15803d","#c2410c","#4338ca","#0e7490","#92400e",
];

const HM = { ROW_PAD: 186, COL_PAD: 96, CELL_H: 32, CELL_W: 76, FONT: 11 };

const DRUG_CLASS_DOMAINS = {
  "ace inhibitor":                    "novartis.com",
  "angiotensin ii receptor blockers": "astrazeneca.com",
  "anticoagulant":                    "bayer.com",
  "antidepressant":                   "gsk.com",
  "antidiabetic – sglt2 inhibitors":  "boehringer-ingelheim.com",
  "benzodiazepine":                   "roche.com",
  "beta blockers":                    "astrazeneca.com",
  "biguanides":                       "merck.com",
  "calcium channel blocker":          "pfizer.com",
  "cephalosporines":                  "lilly.com",
  "fluoroquinolones":                 "bayer.com",
  "glp-receptor agonist":             "novonordisk.com",
  "loop diuretics":                   "sanofi.com",
  "macrolides":                       "pfizer.com",
  "penicillin antibiotic class":      "gsk.com",
  "proton pump inhibitors":           "astrazeneca.com",
  "statin":                           "pfizer.com",
  "sulphonamide":                     "roche.com",
  "urinary anti-infectives":          "merck.com",
};

// ═══════════════════════════════════════════════════════════════════════
// SHARED STATE
// ═══════════════════════════════════════════════════════════════════════

const state = {
  // Data
  hmData:       null,   // /api/heatmap response
  tmData:       null,   // /api/treemap/<class> response
  // Filters
  topN:         20,
  sortMode:     "alpha",
  eventFilter:  "",
  // Selection — these are the cross-view linkers
  activeClass:  null,   // row-label click in heatmap OR sidebar click
  activeEvent:  null,   // column-label click in heatmap
  selectedCell: null,   // { drugClass, event }  — heatmap cell pin
  selectedLeaf: null,   // { drug, event }        — treemap leaf pin
  // Maps
  colorScale:   null,
  classColorMap: {},
};

// ═══════════════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════════════

async function apiFetch(path) {
  const r = await fetch(`${API_BASE}${path}`);
  if (!r.ok) { const b = await r.json().catch(()=>({})); throw new Error(b.error||`HTTP ${r.status}`); }
  return r.json();
}

// ═══════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════

async function loadHeatmap() {
  showHmLoading(true);
  hideHmError();
  try {
    const data = await apiFetch("/heatmap");
    state.hmData = data;
    data.drug_classes.forEach((cls, i) => {
      state.classColorMap[cls] = CLASS_COLORS[i % CLASS_COLORS.length];
    });
    renderClassSidebar(data);
    renderSummaryStats(data);
    renderHeatmap();
    drawLegend();
    showHmLoading(false);
  } catch (err) {
    showHmLoading(false);
    showHmError(`Failed to load: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HEATMAP — DERIVE DATA
// ═══════════════════════════════════════════════════════════════════════

function deriveHmData() {
  const d = state.hmData;
  if (!d) return null;

  let events = d.top_events.filter(e =>
    !state.eventFilter || e.toLowerCase().includes(state.eventFilter.toLowerCase())
  ).slice(0, state.topN);

  let rows = [...d.drug_classes];
  if (state.sortMode === "alpha") {
    rows.sort((a,b) => a.localeCompare(b));
  } else {
    rows.sort((a,b) => {
      const sA = events.reduce((s,e) => s + (d.matrix[a]?.[e]?.pct||0), 0);
      const sB = events.reduce((s,e) => s + (d.matrix[b]?.[e]?.pct||0), 0);
      return sB - sA;
    });
  }

  const cells = [];
  rows.forEach(cls => {
    events.forEach(evt => {
      const c = d.matrix[cls]?.[evt] || { pct:0, count:0, total:0, enrichment:0 };
      cells.push({ drugClass:cls, event:evt, pct:c.pct, count:c.count, total:c.total, value:c.pct });
    });
  });

  return { rows, cols: events, cells };
}

// ═══════════════════════════════════════════════════════════════════════
// HEATMAP — RENDER
// ═══════════════════════════════════════════════════════════════════════

function renderHeatmap() {
  const display = deriveHmData();
  if (!display) return;
  const { rows, cols, cells } = display;

  const svgW = HM.ROW_PAD + cols.length * HM.CELL_W + 20;
  const svgH = HM.COL_PAD + rows.length * HM.CELL_H + 20;

  const svg = d3.select("#heatmap-svg").attr("width", svgW).attr("height", svgH);
  svg.selectAll("*").remove();

  // Color scale (shared with treemap)
  const maxVal = d3.max(cells, c => c.value) || 1;
  const colorScale = d3.scaleSequential(d3.interpolateYlOrRd).domain([0, maxVal]);
  state.colorScale = { scale: colorScale, maxVal };

  const xSc = d3.scaleBand().domain(cols).range([HM.ROW_PAD, HM.ROW_PAD + cols.length * HM.CELL_W]).padding(0.04);
  const ySc = d3.scaleBand().domain(rows).range([HM.COL_PAD, HM.COL_PAD + rows.length * HM.CELL_H]).padding(0.04);

  svg.append("rect").attr("width", svgW).attr("height", svgH).attr("fill", "#fafafa");

  // ── Row labels (drug classes) with logos ─────────────────────────────
  const LOGO = 18, TX = LOGO + 8;

  const rowG = svg.selectAll(".hm-row-label")
    .data(rows).join("g")
    .attr("class", d => "hm-row-label" + (d === state.activeClass ? " active" : ""))
    .attr("transform", d => `translate(0,${ySc(d) + ySc.bandwidth()/2})`)
    .style("cursor", "pointer")
    .on("click", (evt, d) => {
      const same = state.activeClass === d;
      state.activeClass  = same ? null : d;
      state.activeEvent  = null;
      state.selectedCell = null;
      showDetailPanel(null);
      renderHeatmap();
      if (!same) loadTreemap(d); else clearTreemap();
      renderClassSidebar(state.hmData);
    })
    .on("mouseover", (e,d) => showTooltip(e, buildRowTooltip(d)))
    .on("mousemove", moveTooltip)
    .on("mouseout", hideTooltip);

  // Logo
  rowG.append("foreignObject")
    .attr("x", 3).attr("y", -LOGO/2).attr("width", LOGO).attr("height", LOGO)
    .append("xhtml:div")
    .style("width", LOGO+"px").style("height", LOGO+"px")
    .style("display","flex").style("align-items","center").style("justify-content","center")
    .each(function(d) {
      const domain = getDrugClassDomain(d);
      const color  = state.classColorMap[d] || "#6b7280";
      if (domain) {
        const img = document.createElement("img");
        img.src = `https://logo.clearbit.com/${domain}?size=36`;
        img.width = LOGO; img.height = LOGO;
        img.style.borderRadius = "3px";
        img.style.objectFit   = "contain";
        img.onerror = function() { this.replaceWith(makeInitialBadge(d, color, LOGO)); };
        this.appendChild(img);
      } else {
        this.appendChild(makeInitialBadge(d, color, LOGO));
      }
    });

  // Label
  rowG.append("text")
    .attr("x", TX).attr("dy", ".35em")
    .attr("text-anchor", "start")
    .attr("font-size", HM.FONT).attr("font-family", "Inter,sans-serif")
    .attr("fill", d => d === state.activeClass ? "#dc143c" : "#374151")
    .attr("font-weight", d => d === state.activeClass ? "600" : "400")
    .text(d => { const max = Math.floor((HM.ROW_PAD - TX - 8)/6.2); return d.length>max ? d.slice(0,max-1)+"…" : d; })
    .append("title").text(d => d);

  // ── Column labels ─────────────────────────────────────────────────────
  svg.selectAll(".hm-col-label")
    .data(cols).join("g")
    .attr("class", d => "hm-col-label" + (d === state.activeEvent ? " active" : ""))
    .attr("transform", d => `translate(${xSc(d)+xSc.bandwidth()/2},${HM.COL_PAD-6})`)
    .style("cursor","pointer")
    .on("click", (evt,d) => {
      state.activeEvent  = state.activeEvent===d ? null : d;
      state.selectedCell = null;
      showDetailPanel(null);
      renderHeatmap();
    })
    .on("mouseover", (e,d) => showTooltip(e, buildColTooltip(d)))
    .on("mousemove", moveTooltip).on("mouseout", hideTooltip)
    .append("text")
    .attr("transform","rotate(-45)").attr("text-anchor","start")
    .attr("font-size", HM.FONT-0.5).attr("font-family","Inter,sans-serif")
    .attr("fill", d => d===state.activeEvent ? "#dc143c" : "#374151")
    .attr("font-weight", d => d===state.activeEvent ? "600" : "400")
    .text(d => d.length>15 ? d.slice(0,14)+"…" : d)
    .append("title").text(d => d);

  // ── Cells ─────────────────────────────────────────────────────────────
  const cellsG = svg.append("g");
  const rW = xSc.bandwidth(), rH = ySc.bandwidth();

  const sel = cellsG.selectAll(".hm-cell")
    .data(cells, d => `${d.drugClass}||${d.event}`)
    .join(
      enter => enter.append("rect").attr("class","hm-cell")
        .attr("x", d => xSc(d.event)).attr("y", d => ySc(d.drugClass))
        .attr("width", rW).attr("height", rH).attr("rx", 3)
        .attr("fill", d => d.value===0 ? "#f3f4f6" : colorScale(d.value))
        .attr("opacity",0).call(e=>e.transition().duration(350).attr("opacity",1)),
      update => update.call(u=>u.transition().duration(260)
        .attr("x", d=>xSc(d.event)).attr("y", d=>ySc(d.drugClass))
        .attr("width", rW).attr("height", rH)
        .attr("fill", d=>d.value===0?"#f3f4f6":colorScale(d.value)))
    );

  sel.classed("selected", d =>
      state.selectedCell &&
      d.drugClass===state.selectedCell.drugClass && d.event===state.selectedCell.event)
    .classed("dimmed", d => {
      if (state.selectedCell)
        return !(d.drugClass===state.selectedCell.drugClass && d.event===state.selectedCell.event);
      if (!state.activeClass && !state.activeEvent) return false;
      if (state.activeClass && state.activeClass!==d.drugClass) return true;
      if (state.activeEvent && state.activeEvent!==d.event) return true;
      return false;
    })
    .on("mouseover", (e,d) => showTooltip(e, buildCellTooltip(d)))
    .on("mousemove", moveTooltip).on("mouseout", hideTooltip)
    .on("click", (e,d) => {
      e.stopPropagation();
      const same = state.selectedCell &&
        state.selectedCell.drugClass===d.drugClass && state.selectedCell.event===d.event;
      if (same) {
        state.selectedCell = null;
        showDetailPanel(null);
      } else {
        state.selectedCell = { drugClass: d.drugClass, event: d.event };
        state.activeClass  = null;
        state.activeEvent  = null;
        showDetailPanel(d);
        // Also load treemap for the clicked class if not already loaded
        if (state.activeClass !== d.drugClass) loadTreemap(d.drugClass);
      }
      renderHeatmap();
    });

  // Cell text
  if (rW >= 44 && rH >= 18) {
    cellsG.selectAll(".hm-cell-text")
      .data(cells.filter(c=>c.pct>0), d=>`${d.drugClass}||${d.event}`)
      .join("text").attr("class","hm-cell-text")
      .attr("x", d=>xSc(d.event)+rW/2).attr("y", d=>ySc(d.drugClass)+rH/2)
      .attr("text-anchor","middle").attr("dominant-baseline","middle")
      .attr("font-size",9.5).attr("font-family","Inter,sans-serif")
      .attr("font-weight","500")
      .attr("fill", d => (d.value/state.colorScale.maxVal)>0.55 ? "#fff" : "#1a1a2e")
      .attr("pointer-events","none")
      .text(d => Math.round(d.pct)+"%");
  }

  drawLegend();
  updateEventMatchCount(cols.length, state.hmData.top_events.length);
}

// ═══════════════════════════════════════════════════════════════════════
// TREEMAP — LOAD DATA
// ═══════════════════════════════════════════════════════════════════════

async function loadTreemap(drugClass) {
  document.getElementById("tm-loading").style.display = "flex";
  document.getElementById("tm-empty").style.display   = "none";
  document.getElementById("treemap-svg").style.display = "none";
  document.getElementById("tm-legend").style.display   = "none";
  document.getElementById("tm-breadcrumb").style.display = "none";
  document.getElementById("tm-depth-info").style.display = "none";

  try {
    const data = await apiFetch("/treemap/" + encodeURIComponent(drugClass));
    state.tmData = data;
    document.getElementById("tm-loading").style.display = "none";
    renderTreemap(data, drugClass);
  } catch(err) {
    document.getElementById("tm-loading").style.display = "none";
    document.getElementById("tm-empty").style.display = "";
    document.querySelector(".tm-empty-title").textContent = "Could not load treemap";
    document.querySelector(".tm-empty-sub").textContent = err.message;
  }
}

function clearTreemap() {
  document.getElementById("tm-loading").style.display   = "none";
  document.getElementById("treemap-svg").style.display  = "none";
  document.getElementById("tm-empty").style.display     = "";
  document.getElementById("tm-legend").style.display    = "none";
  document.getElementById("tm-breadcrumb").style.display = "none";
  document.getElementById("tm-depth-info").style.display = "none";
  document.querySelector(".tm-empty-title").textContent  = "No class selected";
  document.querySelector(".tm-empty-sub").textContent    = "Click a drug class row label in the heatmap above to see its medicines and adverse events";
  document.getElementById("tm-title").textContent        = "Treemap — Select a drug class above to drill in";
  document.getElementById("tm-subtitle").textContent     = "Click any row label in the heatmap to explore that class";
  state.tmData = null; state.selectedLeaf = null;
}

// ═══════════════════════════════════════════════════════════════════════
// TREEMAP — RENDER (D3 treemap)
// ═══════════════════════════════════════════════════════════════════════

function renderTreemap(data, drugClass) {
  const color     = state.classColorMap[drugClass] || "#dc143c";
  const cs        = state.colorScale?.scale || d3.scaleSequential(d3.interpolateYlOrRd).domain([0,100]);
  const container = document.getElementById("tm-scroll");
  const W = container.clientWidth  || 800;
  const H = container.clientHeight || 340;

  // Update header
  document.getElementById("tm-title").textContent    = drugClass;
  document.getElementById("tm-subtitle").textContent = `${data.medicines.length} medicines · ${data.total_ae_types} unique adverse events`;
  document.getElementById("tm-bc-class").textContent = drugClass;
  document.getElementById("tm-breadcrumb").style.display  = "flex";
  document.getElementById("tm-depth-info").style.display  = "flex";
  document.getElementById("tm-legend").style.display      = "flex";

  // Build hierarchy:
  // root → drug → ae (leaf)
  const root = {
    name: drugClass,
    children: data.medicines.map(med => ({
      name: med.drug_name,
      n_products: med.n_products,
      children: med.adverse_events.map(ae => ({
        name: ae.event,
        pct:  ae.pct,
        count: ae.count,
        total: med.n_products,
        drugClass,
        drug: med.drug_name,
        value: Math.max(ae.pct, 1),  // size = prevalence (min 1 so zero-AEs still show)
      }))
    }))
  };

  const hierarchy = d3.hierarchy(root)
    .sum(d => d.value || 0)
    .sort((a,b) => b.value - a.value);

  d3.treemap()
    .size([W, H])
    .padding(2)
    .paddingTop(22)   // space for medicine label
    .paddingInner(1)
    (hierarchy);

  const svg = d3.select("#treemap-svg")
    .attr("width", W).attr("height", H)
    .style("display","block");
  svg.selectAll("*").remove();

  const drugNodes = hierarchy.children || [];

  // ── Drug-level tiles (parent blocks) ─────────────────────────────────
  const drugG = svg.selectAll(".tm-drug-group")
    .data(drugNodes).join("g").attr("class","tm-drug-group");

  // Background fill (drug class colour, muted)
  drugG.append("rect")
    .attr("class","tm-node-drug")
    .attr("x", d => d.x0).attr("y", d => d.y0)
    .attr("width",  d => Math.max(0, d.x1-d.x0))
    .attr("height", d => Math.max(0, d.y1-d.y0))
    .attr("rx", 5)
    .attr("fill", hexTint(color, 0.88))
    .attr("stroke","#fff").attr("stroke-width",2);

  // Drug name label at top of each tile
  drugG.append("text")
    .attr("x", d => d.x0 + 5)
    .attr("y", d => d.y0 + 14)
    .attr("font-size", 10).attr("font-family","Inter,sans-serif")
    .attr("font-weight","700").attr("fill", "#1a1a2e")
    .attr("pointer-events","none")
    .text(d => {
      const w = d.x1 - d.x0;
      const max = Math.floor(w / 6.2);
      return d.data.name.length > max ? d.data.name.slice(0,max-1)+"…" : d.data.name;
    });

  // Drug product count badge
  drugG.append("text")
    .attr("x", d => d.x1 - 4)
    .attr("y", d => d.y0 + 14)
    .attr("font-size", 9).attr("font-family","Inter,sans-serif")
    .attr("font-weight","500").attr("fill","#6b7280")
    .attr("text-anchor","end").attr("pointer-events","none")
    .text(d => `${d.data.n_products} prods`);

  // ── AE leaf tiles ─────────────────────────────────────────────────────
  const allLeaves = hierarchy.leaves();

  const leafG = svg.selectAll(".tm-ae-leaf")
    .data(allLeaves).join("g").attr("class","tm-ae-leaf");

  leafG.append("rect")
    .attr("class", d => {
      let cls = "tm-node-ae";
      if (state.selectedLeaf) {
        cls += (state.selectedLeaf.drug===d.data.drug && state.selectedLeaf.event===d.data.name)
          ? " tm-ae-selected" : " tm-ae-dimmed";
      }
      return cls;
    })
    .attr("x", d => d.x0+1).attr("y", d => d.y0+1)
    .attr("width",  d => Math.max(0, d.x1-d.x0-2))
    .attr("height", d => Math.max(0, d.y1-d.y0-2))
    .attr("rx", 3)
    .attr("fill", d => d.data.pct===0 ? "#e5e7eb" : cs(d.data.pct))
    .on("mouseover", (e,d) => showTooltip(e, buildLeafTooltip(d.data)))
    .on("mousemove", moveTooltip)
    .on("mouseout", hideTooltip)
    .on("click", (e,d) => {
      e.stopPropagation();
      const same = state.selectedLeaf &&
        state.selectedLeaf.drug===d.data.drug && state.selectedLeaf.event===d.data.name;
      state.selectedLeaf = same ? null : { drug: d.data.drug, event: d.data.name };
      if (state.selectedLeaf) showDetailPanelFromLeaf(d.data);
      else showDetailPanel(null);
      renderTreemap(state.tmData, drugClass); // re-render with new selection
    });

  // AE name text (only if tile is big enough)
  leafG.filter(d => (d.x1-d.x0) > 28 && (d.y1-d.y0) > 14)
    .append("text")
    .attr("x", d => d.x0 + (d.x1-d.x0)/2)
    .attr("y", d => d.y0 + (d.y1-d.y0)/2)
    .attr("text-anchor","middle").attr("dominant-baseline","middle")
    .attr("font-size", d => Math.min(11, Math.max(8, (d.x1-d.x0)/8)))
    .attr("font-family","Inter,sans-serif").attr("font-weight","500")
    .attr("fill", d => d.data.pct > (state.colorScale?.maxVal||100)*0.55 ? "#fff" : "#1a1a2e")
    .attr("pointer-events","none")
    .text(d => {
      const w = d.x1-d.x0, h = d.y1-d.y0;
      const max = Math.floor(w / 5.5);
      const label = d.data.pct > 0 ? `${d.data.name} ${Math.round(d.data.pct)}%` : d.data.name;
      return label.length > max ? label.slice(0,max-1)+"…" : label;
    });

  // Draw treemap legend gradient
  drawTmLegend();
}

// ═══════════════════════════════════════════════════════════════════════
// TREEMAP — NAV
// ═══════════════════════════════════════════════════════════════════════

function tmDrillUp() {
  state.activeClass  = null;
  state.selectedLeaf = null;
  showDetailPanel(null);
  clearTreemap();
  renderClassSidebar(state.hmData);
  renderHeatmap();
}

// ═══════════════════════════════════════════════════════════════════════
// LEGEND
// ═══════════════════════════════════════════════════════════════════════

function drawLegend() {
  const canvas = document.getElementById("legend-canvas");
  if (!canvas || !state.colorScale) return;
  const ctx = canvas.getContext("2d");
  const { scale, maxVal } = state.colorScale;
  for (let x=0; x<canvas.width; x++) {
    ctx.fillStyle = scale((x/canvas.width)*maxVal);
    ctx.fillRect(x,0,1,canvas.height);
  }
  const ticks = document.getElementById("legend-ticks");
  ticks.innerHTML = `<span>${Math.round(maxVal*0.25)}%</span><span>${Math.round(maxVal*0.50)}%</span><span>${Math.round(maxVal*0.75)}%</span><span>${Math.round(maxVal)}%</span>`;
}

function drawTmLegend() {
  const canvas = document.getElementById("tm-legend-canvas");
  if (!canvas || !state.colorScale) return;
  const ctx = canvas.getContext("2d");
  const { scale, maxVal } = state.colorScale;
  for (let x=0; x<canvas.width; x++) {
    ctx.fillStyle = scale((x/canvas.width)*maxVal);
    ctx.fillRect(x,0,1,canvas.height);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// DETAIL PANEL
// ═══════════════════════════════════════════════════════════════════════

function showDetailPanel(d) {
  document.getElementById("detail-empty").style.display   = d ? "none" : "";
  document.getElementById("detail-content").style.display = d ? ""     : "none";
  if (!d) return;

  const color = state.classColorMap[d.drugClass] || "#6b7280";
  document.getElementById("det-event-name").textContent = d.event;
  const tag = document.getElementById("det-class-tag");
  tag.textContent = d.drugClass; tag.style.background = color;

  document.getElementById("det-pct").textContent   = d.pct.toFixed(1)+"%";
  document.getElementById("det-count").textContent = d.count;
  document.getElementById("det-total").textContent = d.total;

  const rank = (state.hmData?.top_events||[]).indexOf(d.event)+1;
  document.getElementById("det-rank").textContent  = rank>0 ? `#${rank}` : "–";

  const bar = document.getElementById("det-bar");
  bar.style.width = d.pct+"%"; bar.style.background = color;

  // Cross-class breakdown
  const bd = document.getElementById("det-class-breakdown");
  bd.innerHTML = "";
  const rows = (state.hmData?.drug_classes||[])
    .map(cls => ({ cls, pct: state.hmData.matrix[cls]?.[d.event]?.pct||0 }))
    .filter(r=>r.pct>0).sort((a,b)=>b.pct-a.pct).slice(0,6);
  const maxP = rows[0]?.pct || 1;
  rows.forEach(r => {
    const active = r.cls===d.drugClass;
    const c = state.classColorMap[r.cls]||"#6b7280";
    const el = document.createElement("div");
    el.className = "enriched-class-row";
    el.innerHTML = `
      <span class="ecr-name" style="${active?`color:${c};font-weight:700`:""}">${r.cls.length>20?r.cls.slice(0,18)+"…":r.cls}</span>
      <span class="ecr-pct" style="color:${c}">${r.pct.toFixed(0)}%</span>
      <div class="ecr-bar-wrap"><div class="ecr-bar" style="width:${(r.pct/maxP)*100}%;background:${c}"></div></div>`;
    bd.appendChild(el);
  });
  if (!rows.length) { bd.textContent="Not reported in any class."; bd.style.color="#9ca3af"; }
}

function showDetailPanelFromLeaf(leaf) {
  // leaf = { drug, event, pct, count, total, drugClass }
  showDetailPanel({
    event: leaf.event,
    drugClass: leaf.drugClass,
    pct: leaf.pct,
    count: leaf.count,
    total: leaf.total,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// CLASS SIDEBAR
// ═══════════════════════════════════════════════════════════════════════

function renderClassSidebar(data) {
  const list  = document.getElementById("class-filter-list");
  const badge = document.getElementById("class-count-badge");
  badge.textContent = data.drug_classes.length;
  list.innerHTML = "";

  const allEl = document.createElement("div");
  allEl.className = "class-filter-item" + (!state.activeClass ? " active" : "");
  allEl.innerHTML = `<span class="class-dot" style="background:#6b7280"></span><span class="class-name">All Classes</span>`;
  allEl.addEventListener("click", () => {
    state.activeClass=null; state.selectedCell=null; state.selectedLeaf=null;
    showDetailPanel(null); clearTreemap();
    renderClassSidebar(data); renderHeatmap();
  });
  list.appendChild(allEl);

  data.drug_classes.forEach(cls => {
    const count = Object.values(data.matrix[cls]||{}).filter(c=>c.pct>0).length;
    const color = state.classColorMap[cls]||"#6b7280";
    const el = document.createElement("div");
    el.className = "class-filter-item"+(cls===state.activeClass?" active":"");
    el.innerHTML = `
      <span class="class-dot" style="background:${color}"></span>
      <span class="class-name" title="${cls}">${cls}</span>
      <span class="class-count">${count}</span>`;
    el.addEventListener("click", () => {
      const same = state.activeClass===cls;
      state.activeClass  = same ? null : cls;
      state.activeEvent  = null;
      state.selectedCell = null;
      state.selectedLeaf = null;
      showDetailPanel(null);
      if (!same) loadTreemap(cls); else clearTreemap();
      renderClassSidebar(data); renderHeatmap();
    });
    list.appendChild(el);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// SUMMARY STATS
// ═══════════════════════════════════════════════════════════════════════

function renderSummaryStats(data) {
  const el = document.getElementById("summary-stats");
  el.innerHTML = [
    ["Drug Classes",   data.drug_classes.length],
    ["Unique Events",  data.top_events.length],
    ["Total Products", data.total_products],
    ["Top Event",      data.top_events[0]||"–"],
  ].map(([l,v]) =>
    `<div class="summary-stat-row"><span class="ss-label">${l}</span>
     <span class="ss-value">${typeof v==="string"&&v.length>17?v.slice(0,15)+"…":v}</span></div>`
  ).join("");
}

// ═══════════════════════════════════════════════════════════════════════
// TOOLTIP BUILDERS
// ═══════════════════════════════════════════════════════════════════════

function buildCellTooltip(d) {
  const color = state.classColorMap[d.drugClass]||"#6b7280";
  return `<div class="tt-title" style="color:${color}">${d.event}</div>
    <div class="tt-grid">
      <span>Drug Class</span><span class="tt-val" style="font-size:10.5px">${d.drugClass}</span>
      <div class="tt-sep"></div>
      <span>Prevalence</span><span class="tt-val">${d.pct.toFixed(1)}%</span>
      <span>Products</span><span class="tt-val">${d.count} / ${d.total}</span>
      <div class="tt-hint">Click to pin details →</div>
    </div>`;
}

function buildRowTooltip(drugClass) {
  const color = state.classColorMap[drugClass]||"#6b7280";
  const top3 = Object.entries(state.hmData.matrix[drugClass]||{})
    .sort((a,b)=>b[1].pct-a[1].pct).slice(0,3)
    .map(([e,c])=>`<span>${e.length>16?e.slice(0,14)+"…":e}</span><span class="tt-val">${c.pct.toFixed(0)}%</span>`)
    .join("");
  return `<div class="tt-title" style="color:${color}">${drugClass}</div>
    <div class="tt-grid"><span>Top events:</span><span></span><div class="tt-sep"></div>
    ${top3}<div class="tt-hint">Click to load treemap →</div></div>`;
}

function buildColTooltip(event) {
  const top3 = (state.hmData.drug_classes||[])
    .map(cls=>({cls,pct:state.hmData.matrix[cls]?.[event]?.pct||0}))
    .filter(r=>r.pct>0).sort((a,b)=>b.pct-a.pct).slice(0,3)
    .map(r=>`<span style="color:${state.classColorMap[r.cls]||"#6b7280"}">${r.cls.length>16?r.cls.slice(0,14)+"…":r.cls}</span><span class="tt-val">${r.pct.toFixed(0)}%</span>`)
    .join("");
  const base = state.hmData.event_baseline?.[event]||0;
  return `<div class="tt-title">${event}</div>
    <div class="tt-grid"><span>Overall</span><span class="tt-val">${base.toFixed(1)}%</span>
    <div class="tt-sep"></div>${top3||"<span style='color:#9ca3af'>No data</span><span></span>"}
    <div class="tt-hint">Click to highlight column →</div></div>`;
}

function buildLeafTooltip(d) {
  const color = state.classColorMap[d.drugClass]||"#6b7280";
  return `<div class="tt-title" style="color:${color}">${d.name}</div>
    <div class="tt-grid">
      <span>Medicine</span><span class="tt-val" style="font-size:10.5px">${d.drug.length>18?d.drug.slice(0,16)+"…":d.drug}</span>
      <div class="tt-sep"></div>
      <span>Prevalence</span><span class="tt-val">${d.pct.toFixed(1)}%</span>
      <span>Products</span><span class="tt-val">${d.count} / ${d.total}</span>
      <div class="tt-sub">in ${d.drugClass}</div>
      <div class="tt-hint">Click to pin details →</div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════
// UI CONTROLS
// ═══════════════════════════════════════════════════════════════════════

function setTopN(n) {
  state.topN = n==="All"?9999:n;
  document.querySelectorAll(".count-chip").forEach(el =>
    el.classList.toggle("active", parseInt(el.textContent)===n||(el.textContent==="All"&&n===9999)));
  renderHeatmap();
}

function setSortMode(m) {
  state.sortMode = m;
  document.getElementById("sort-alpha").classList.toggle("active", m==="alpha");
  document.getElementById("sort-total").classList.toggle("active", m==="total");
  renderHeatmap();
}

function clearEventFilter() {
  document.getElementById("event-filter").value="";
  state.eventFilter="";
  document.getElementById("btn-clear-filter").style.display="none";
  renderHeatmap();
}

function updateEventMatchCount(shown, total) {
  const el = document.getElementById("event-match-count");
  el.textContent = state.eventFilter ? `${shown} of ${total}` : "";
}

// ═══════════════════════════════════════════════════════════════════════
// LOGO / BADGE HELPERS
// ═══════════════════════════════════════════════════════════════════════

function getDrugClassDomain(cls) {
  return DRUG_CLASS_DOMAINS[cls.toLowerCase().trim()] || null;
}

function makeInitialBadge(cls, color, size) {
  const div = document.createElement("div");
  div.style.cssText = `width:${size}px;height:${size}px;border-radius:4px;background:${color};
    display:flex;align-items:center;justify-content:center;
    font-size:${Math.round(size*0.46)}px;font-weight:700;color:#fff;
    font-family:Inter,sans-serif;user-select:none;`;
  div.textContent = (cls||"?")[0].toUpperCase();
  return div;
}

// Tint a hex colour toward white by `amount` (0=original, 1=white)
function hexTint(hex, amount) {
  let r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  r = Math.round(r + (255-r)*amount);
  g = Math.round(g + (255-g)*amount);
  b = Math.round(b + (255-b)*amount);
  return `rgb(${r},${g},${b})`;
}

// ═══════════════════════════════════════════════════════════════════════
// TOOLTIP MECHANICS
// ═══════════════════════════════════════════════════════════════════════

const tipEl = document.getElementById("tooltip");
function showTooltip(evt, html) { tipEl.innerHTML=html; tipEl.classList.add("show"); moveTooltip(evt); }
function moveTooltip(evt) {
  tipEl.style.left = Math.min(evt.clientX+16, window.innerWidth-270)+"px";
  tipEl.style.top  = Math.min(evt.clientY-8,  window.innerHeight-260)+"px";
}
function hideTooltip() { tipEl.classList.remove("show"); }

// ═══════════════════════════════════════════════════════════════════════
// LOADING / ERROR
// ═══════════════════════════════════════════════════════════════════════

function showHmLoading(on)  { document.getElementById("hm-loading").style.display = on?""  :"none"; }
function showHmError(msg)   { document.getElementById("hm-error").style.display=""; document.getElementById("hm-error-msg").textContent=msg; }
function hideHmError()      { document.getElementById("hm-error").style.display="none"; }

// ═══════════════════════════════════════════════════════════════════════
// EVENT WIRING
// ═══════════════════════════════════════════════════════════════════════

document.getElementById("event-filter").addEventListener("input", function() {
  state.eventFilter = this.value.trim();
  document.getElementById("btn-clear-filter").style.display = state.eventFilter ? "" : "none";
  renderHeatmap();
});

document.addEventListener("keydown", e => {
  if (e.key==="Escape") {
    let changed = false;
    if (state.selectedCell) { state.selectedCell=null; changed=true; }
    if (state.selectedLeaf) { state.selectedLeaf=null; changed=true; }
    if (changed) { showDetailPanel(null); renderHeatmap(); if (state.tmData) renderTreemap(state.tmData, state.activeClass||state.tmData.drug_class); }
  }
});

document.getElementById("hm-scroll").addEventListener("click", function(e) {
  if (e.target===this||e.target.id==="heatmap-svg") {
    if (state.selectedCell) { state.selectedCell=null; showDetailPanel(null); renderHeatmap(); }
  }
});

// ═══════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════
loadHeatmap();
