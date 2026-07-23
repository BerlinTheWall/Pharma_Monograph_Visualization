/* =====================================================================
   Sources page — drug class → drug → product drill-down
   ===================================================================== */

const API_BASE = window.location.protocol + "//" + window.location.host + "/api";

const state = {
  view:          "classes",   // "classes" | "drugs" | "products"
  selectedClass: null,
  selectedDrug:  null,
};

async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── VIEW SWITCHING ────────────────────────────────────────────────
function showLoading(text) {
  document.getElementById("src-loading-text").textContent = text;
  document.getElementById("src-loading").style.display = "flex";
  document.getElementById("src-error").style.display = "none";
  document.getElementById("classes-view").style.display = "none";
  document.getElementById("drugs-view").style.display = "none";
  document.getElementById("products-view").style.display = "none";
}

function showError(msg) {
  document.getElementById("src-loading").style.display = "none";
  document.getElementById("src-error").style.display = "flex";
  document.getElementById("src-error-msg").textContent = msg;
}

function updateBreadcrumb() {
  document.getElementById("bc-sep-1").style.display = state.view === "classes" ? "none" : "";
  document.getElementById("bc-class").style.display = state.view === "classes" ? "none" : "";
  document.getElementById("bc-class").textContent = state.selectedClass || "";
  document.getElementById("bc-class").classList.toggle("src-bc-active", state.view === "drugs");

  document.getElementById("bc-sep-2").style.display = state.view === "products" ? "" : "none";
  document.getElementById("bc-drug").style.display = state.view === "products" ? "" : "none";
  document.getElementById("bc-drug").textContent = state.selectedDrug || "";
}

function retry() {
  if (state.view === "classes") loadClasses();
  else if (state.view === "drugs") loadDrugs(state.selectedClass);
  else loadProducts(state.selectedDrug);
}

function goToClasses() {
  state.view = "classes";
  state.selectedClass = null;
  state.selectedDrug = null;
  loadClasses();
}

function goToDrugs() {
  if (!state.selectedClass) return;
  state.view = "drugs";
  state.selectedDrug = null;
  loadDrugs(state.selectedClass);
}

// ─── LEVEL 1: CLASSES ──────────────────────────────────────────────
async function loadClasses() {
  state.view = "classes";
  updateBreadcrumb();
  showLoading("Loading drug classes…");
  try {
    const classes = await apiFetch("/classes");
    renderClasses(classes);
  } catch (err) {
    showError(err.message);
  }
}

function severityTier(pct) {
  if (pct >= 60) return "high";
  if (pct >= 30) return "medium";
  return "low";
}

function renderClasses(classes) {
  const grid = document.getElementById("classes-view");
  grid.innerHTML = classes.map(c => `
    <div class="src-card" onclick="selectClass('${encodeURIComponent(c.drug_class)}')">
      <div class="src-card-title">${c.drug_class}</div>
      <div class="src-card-chips">
        <span class="src-chip">${c.n_medicines} drug${c.n_medicines === 1 ? "" : "s"}</span>
        <span class="src-chip">${c.n_entries} entries</span>
        <span class="src-chip severity-${severityTier(c.avg_severity)}">avg severity ${c.avg_severity}%</span>
      </div>
    </div>`).join("");

  document.getElementById("src-loading").style.display = "none";
  grid.style.display = "grid";
}

function selectClass(encodedClassName) {
  state.selectedClass = decodeURIComponent(encodedClassName);
  loadDrugs(state.selectedClass);
}

// ─── LEVEL 2: DRUGS IN CLASS ───────────────────────────────────────
async function loadDrugs(drugClass) {
  state.view = "drugs";
  state.selectedClass = drugClass;
  updateBreadcrumb();
  showLoading(`Loading drugs in "${drugClass}"…`);
  try {
    const data = await apiFetch(`/classes/${encodeURIComponent(drugClass)}/drugs`);
    renderDrugs(data.drugs);
  } catch (err) {
    showError(err.message);
  }
}

function renderDrugs(drugs) {
  const grid = document.getElementById("drugs-view");
  grid.innerHTML = drugs.map(d => `
    <div class="src-card" onclick="selectDrug('${encodeURIComponent(d.drug_name)}')">
      <div class="src-card-title">${d.drug_name}</div>
      <div class="src-card-chips">
        <span class="src-chip">${d.n_entries} entr${d.n_entries === 1 ? "y" : "ies"}</span>
        <span class="src-chip">${d.n_companies} compan${d.n_companies === 1 ? "y" : "ies"}</span>
        <span class="src-chip severity-${severityTier(d.avg_severity)}">avg severity ${d.avg_severity}%</span>
      </div>
    </div>`).join("");

  document.getElementById("src-loading").style.display = "none";
  grid.style.display = "grid";
}

function selectDrug(encodedDrugName) {
  state.selectedDrug = decodeURIComponent(encodedDrugName);
  loadProducts(state.selectedDrug);
}

// ─── LEVEL 3: PRODUCT ROWS FOR A DRUG ──────────────────────────────
async function loadProducts(drugName) {
  state.view = "products";
  state.selectedDrug = drugName;
  updateBreadcrumb();
  showLoading(`Loading products for "${drugName}"…`);
  try {
    const data = await apiFetch(`/drugs/${encodeURIComponent(drugName)}/products`);
    renderProducts(data.products);
  } catch (err) {
    showError(err.message);
  }
}

function tagList(text) {
  if (!text) return `<div class="src-detail-empty">Not reported</div>`;
  const parts = text.split(",").map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) return `<div class="src-detail-text">${text}</div>`;
  return `<div class="src-detail-tags">${parts.map(p => `<span class="src-detail-tag">${p}</span>`).join("")}</div>`;
}

function plainText(text) {
  return text ? `<div class="src-detail-text">${text}</div>` : `<div class="src-detail-empty">Not reported</div>`;
}

function renderProductPdfBadge(p) {
  if (p.pdf_url) {
    return `<a class="src-product-pdf-link" href="${p.pdf_url}" target="_blank" rel="noopener noreferrer"
              onclick="event.stopPropagation()" title="DIN ${p.din} · match score ${p.match_score}">View PDF ↗</a>`;
  }
  if (p.match_status === "matched") {
    return `<span class="src-product-pdf-none" title="Matched DIN ${p.din}, but Health Canada lists no monograph PDF for it">No PDF listed</span>`;
  }
  return `<span class="src-product-pdf-none" title="Could not confidently match this product to a Health Canada DIN">Not matched</span>`;
}

function renderProducts(products) {
  const container = document.getElementById("products-view");
  container.innerHTML = products.map((p, i) => {
    const d = p.detail || {};
    const label = p.brand_name ? `${p.brand_name} — ${p.company}` : p.company;
    return `
    <div class="src-product-card" id="src-product-${i}">
      <div class="src-product-head" onclick="toggleProduct(${i})">
        <div class="src-product-titles">
          <div class="src-product-name">${label}</div>
          <div class="src-product-sub">${p.id}${p.din ? ` · DIN ${p.din}` : ""}${d.revision_date ? ` · revised ${d.revision_date}` : ""}</div>
        </div>
        ${renderProductPdfBadge(p)}
        <span class="src-product-chevron">▾</span>
      </div>
      <div class="src-product-detail">
        <div class="src-detail-grid">
          <div class="src-detail-block">
            <div class="src-detail-label">Ingredients</div>
            ${tagList(d.ingredients)}
          </div>
          <div class="src-detail-block">
            <div class="src-detail-label">Dosage</div>
            ${plainText(d.dosage)}
          </div>
          <div class="src-detail-block">
            <div class="src-detail-label">Indication of Use</div>
            ${plainText(d.indication)}
          </div>
          <div class="src-detail-block">
            <div class="src-detail-label">Contraindications</div>
            ${tagList(d.contraindications)}
          </div>
          <div class="src-detail-block">
            <div class="src-detail-label">Serious Warnings &amp; Precautions</div>
            ${plainText(d.warnings)}
          </div>
          <div class="src-detail-block">
            <div class="src-detail-label">Drug Interactions</div>
            ${tagList(d.drug_interactions)}
          </div>
          <div class="src-detail-block">
            <div class="src-detail-label">Adverse Events</div>
            ${tagList(d.adverse_events)}
          </div>
          <div class="src-detail-block">
            <div class="src-detail-label">Pharmacokinetics</div>
            ${plainText(d.pharmacokinetics)}
          </div>
          <div class="src-detail-block">
            <div class="src-detail-label">Kidney / Liver Dose Adjustment</div>
            ${plainText([d.kidney_dose_adjustment, d.liver_dose_adjustment].filter(Boolean).join(" · "))}
          </div>
          <div class="src-detail-block">
            <div class="src-detail-label">Pregnancy</div>
            ${plainText([d.pregnancy_recommendation, d.pregnancy_summary].filter(Boolean).join(" — "))}
          </div>
          <div class="src-detail-block">
            <div class="src-detail-label">Breastfeeding</div>
            ${plainText([d.breastfeeding_recommendation, d.breastfeeding_summary].filter(Boolean).join(" — "))}
          </div>
          <div class="src-detail-block">
            <div class="src-detail-label">Severity</div>
            ${plainText(`${d.severity_score_percent}% — ${d.severity_category || "n/a"}`)}
          </div>
        </div>
      </div>
    </div>`;
  }).join("");

  document.getElementById("src-loading").style.display = "none";
  container.style.display = "flex";
}

function toggleProduct(i) {
  document.getElementById(`src-product-${i}`).classList.toggle("expanded");
}

// ─── INIT ──────────────────────────────────────────────────────────
loadClasses();
