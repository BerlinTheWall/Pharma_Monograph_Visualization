"""
Drug Monograph Explorer — Flask Backend
=======================================
Run with:
    pip install flask flask-cors pandas openpyxl gunicorn sentence-transformers scikit-learn networkx
    python app.py

Then open http://localhost:5000
"""

import os, re, math, json, hashlib
from collections import defaultdict
from flask import Flask, jsonify, send_from_directory, request
from flask_cors import CORS
import pandas as pd
import numpy as np
import networkx as nx

# ─── CONFIG ───────────────────────────────────────────────────────────────────
EXCEL_PATH = os.path.join(os.path.dirname(__file__), "final__monograph_extractions.xlsx")

# Column names — update if your spreadsheet headers change
COL_ID           = "ID"
COL_DRUG         = "Drug Name"
COL_CLASS        = "Drug Class"           # normalised to single space by _normalise_columns()
COL_COMPANY      = "Company"
COL_ADVERSE      = "Adverse Events"
COL_CONTRAIND    = "Contraindications"
COL_WARNINGS     = "Serious warning and precautions"
COL_INTERACTIONS = "Drug Interactions"
COL_SEVERITY     = "severity_score_percent"
COL_SEV_CAT      = "severity_category"
COL_PREGNANCY    = "Pregnancy Recommendation"
COL_BREAST       = "Breastfeeding Recommendation"

# Co-occurrence graph tuning
MIN_COMPANY_FRACTION = 0.15   # event must appear in ≥15% of companies
MAX_COMPANY_FRACTION = 0.95   # event must be absent from ≥5% of companies
MIN_COOCCUR_COUNT    = 2      # absolute minimum co-occurrence count
JACCARD_THRESHOLD    = 0.25   # minimum Jaccard to draw an edge (lowered from 0.35)

# Semantic similarity tuning (only used when ML model is available)
SEMANTIC_THRESHOLD   = 0.78   # cosine similarity cutoff for synonym grouping
USE_ML               = False  # flipped to True at startup if model loads

# ─── ML MODEL (optional) ──────────────────────────────────────────────────────
embedding_model  = None
_embedding_cache = {}   # event_text -> np.array

def _try_load_model():
    global embedding_model, USE_ML
    try:
        from sentence_transformers import SentenceTransformer
        embedding_model = SentenceTransformer("NeuML/pubmedbert-base-embeddings")
        USE_ML = True
        print("  ✓ PubMedBERT embeddings loaded — semantic synonym merging active")
    except Exception as e:
        USE_ML = False
        print(f"  ⚠  ML model unavailable ({e.__class__.__name__}): using exact-string matching")

# ─── APP ──────────────────────────────────────────────────────────────────────
app = Flask(__name__, static_folder="static", static_url_path="/static")
CORS(app)

class _NumpyEncoder(json.JSONEncoder):
    """
    Extend the default JSON encoder so that numpy/pandas scalar types
    (int64, float64, bool_, etc.) are converted to plain Python types.
    Without this Flask raises 'Object of type int64 is not JSON serializable'.
    """
    def default(self, obj):
        if isinstance(obj, (np.integer,)):
            return int(obj)
        if isinstance(obj, (np.floating,)):
            return None if math.isnan(float(obj)) else float(obj)
        if isinstance(obj, np.bool_):
            return bool(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)

app.json_encoder = _NumpyEncoder          # Flask ≤ 2.2

# Flask 3.x replaced json_encoder with a provider system
try:
    from flask.json.provider import DefaultJSONProvider

    class _NumpyProvider(DefaultJSONProvider):
        def default(self, obj):
            if isinstance(obj, np.integer):
                return int(obj)
            if isinstance(obj, np.floating):
                return None if math.isnan(float(obj)) else float(obj)
            if isinstance(obj, np.bool_):
                return bool(obj)
            if isinstance(obj, np.ndarray):
                return obj.tolist()
            return super().default(obj)

    app.json_provider_class = _NumpyProvider
    app.json = _NumpyProvider(app)
except ImportError:
    pass   # Flask < 2.3 — the json_encoder line above is enough

# ─── DATA HELPERS ─────────────────────────────────────────────────────────────
def _count_csv(text):
    if pd.isna(text) or str(text).strip() in ("", "nan"):
        return 0
    return len([x.strip() for x in str(text).split(",") if x.strip()])

def clean_adverse_events(text):
    """
    Parse an adverse-events cell into a deduplicated list.

    Handles two common formats in the dataset:
      1. Proper CSV:  "nausea, vomiting, headache"
      2. Long prose blob joined with " and ":
         "vomiting retching and gagging with abdominal pain and diarrhea ..."

    Strategy
    --------
    * Split on commas first.
    * For any resulting chunk that looks like a prose blob (contains " and " 
      and is longer than ~40 chars), further split on " and " and " with ".
    * Strip noise stopwords and short tokens.
    * Deduplicate while preserving first-seen order.
    """
    if pd.isna(text):
        return []
    text = str(text).lower()
    # Remove characters that are not word-chars, spaces, or commas
    text = re.sub(r"[^\w\s,/]", "", text)

    STOPWORDS = {"the", "and", "for", "etc", "eg", "no", "na", "not",
                 "a", "an", "of", "in", "or", "to", "as", "at", "by",
                 "if", "it", "is", "be", "on"}

    # Leading noise words that start a chunk after splitting on "and"/"with"
    LEADING_NOISE = {"with", "including", "such", "like", "or", "also",
                     "plus", "other", "these", "those"}

    def _split_chunk(chunk):
        """Split a single comma-chunk further if it looks like a prose blob."""
        chunk = chunk.strip()
        if not chunk:
            return []
        # Prose blob heuristic: contains " and " AND is suspiciously long
        if " and " in chunk and len(chunk) > 40:
            # split on " and ", " with ", " or "
            parts = re.split(r"\s+and\s+|\s+with\s+|\s+or\s+", chunk)
        else:
            parts = [chunk]
        out = []
        for p in parts:
            p = p.strip()
            # Strip leading noise words (e.g. "with abdominal pain" → "abdominal pain")
            words = p.split()
            while words and words[0] in LEADING_NOISE:
                words = words[1:]
            p = " ".join(words).strip()
            # Drop pure stopwords or very short tokens
            if len(p) <= 2 or p in STOPWORDS:
                continue
            if all(w in STOPWORDS for w in words):
                continue
            out.append(p)
        return out

    terms = []
    for chunk in text.split(","):
        terms.extend(_split_chunk(chunk))

    return list(dict.fromkeys(terms))   # preserve order, deduplicate

def _normalise_columns(df):
    """
    Collapse runs of whitespace in column names to a single space and strip
    leading/trailing whitespace.  This makes the code resilient to spreadsheets
    that have e.g. 'Drug  Class' (two spaces) vs 'Drug Class' (one space).

    The COL_* constants at the top of this file should use single-space names
    so they always match after normalisation.
    """
    import re as _re
    df.columns = [_re.sub(r"\s+", " ", c).strip() for c in df.columns]
    return df


def load_df():
    """Load & lightly process the Excel file. Raises FileNotFoundError if missing."""
    if not os.path.exists(EXCEL_PATH):
        raise FileNotFoundError(
            f"Excel file not found at '{EXCEL_PATH}'. "
            "Copy your spreadsheet to the project folder and name it data.xlsx, "
            "or update EXCEL_PATH at the top of app.py."
        )
    df = pd.read_excel(EXCEL_PATH)
    df = _normalise_columns(df)          # ← fix any double-space column names
    df["n_contraindications"] = df[COL_CONTRAIND].apply(_count_csv)
    df["n_warnings"]          = df[COL_WARNINGS].apply(_count_csv)
    df["n_drug_interactions"] = df[COL_INTERACTIONS].apply(_count_csv)
    df["n_adverse_events"]    = df[COL_ADVERSE].apply(_count_csv)
    df["Adverse_List"]        = df[COL_ADVERSE].apply(clean_adverse_events)
    return df

def _safe(val, dec=2):
    try:
        v = float(val)
        return 0 if math.isnan(v) else round(v, dec)
    except:
        return 0

def _agg(group):
    return {
        "n_medicines":            int(group[COL_DRUG].nunique()),
        "n_entries":              int(len(group)),
        "avg_severity":           _safe(group[COL_SEVERITY].mean()),
        "avg_contraindications":  _safe(group["n_contraindications"].mean()),
        "avg_warnings":           _safe(group["n_warnings"].mean()),
        "avg_drug_interactions":  _safe(group["n_drug_interactions"].mean()),
        "avg_adverse_events":     _safe(group["n_adverse_events"].mean()),
    }

# ─── SEMANTIC HELPERS ─────────────────────────────────────────────────────────
def _embed(text):
    """Return the embedding for a text string, cached."""
    if text not in _embedding_cache:
        _embedding_cache[text] = embedding_model.encode([text])[0]
    return _embedding_cache[text]

def _cosine(a, b):
    denom = (np.linalg.norm(a) * np.linalg.norm(b))
    return float(np.dot(a, b) / denom) if denom else 0.0

def _semantically_similar(t1, t2, threshold=SEMANTIC_THRESHOLD):
    if t1 == t2:
        return True
    if not USE_ML:
        return False
    return _cosine(_embed(t1), _embed(t2)) >= threshold

def _group_synonyms(events):
    """
    Group semantically similar event strings under a single canonical label.
    Returns dict: canonical -> set of all synonyms
    """
    event_to_canonical = {}
    canonical_members  = {}

    for evt in events:
        if evt in event_to_canonical:
            continue
        # This event becomes the canonical for its group
        event_to_canonical[evt] = evt
        canonical_members[evt] = {evt}
        for other in events:
            if other == evt or other in event_to_canonical:
                continue
            if _semantically_similar(evt, other):
                event_to_canonical[other] = evt
                canonical_members[evt].add(other)

    return event_to_canonical, canonical_members

# ─── GRAPH BUILDER ────────────────────────────────────────────────────────────
def build_cooccurrence_graph(drug_name, df):
    """
    Build a co-occurrence graph for one drug across all its companies.
    Returns (nodes, edges, company_events_map, anomalies).
    """
    drug_df   = df[df[COL_DRUG] == drug_name]
    companies = drug_df[COL_COMPANY].unique().tolist()
    n_comp    = len(companies)

    # Per-company event sets
    company_events = {}
    for company in companies:
        merged = set()
        for lst in drug_df[drug_df[COL_COMPANY] == company]["Adverse_List"]:
            merged.update(lst)
        company_events[company] = merged

    # All events across all companies
    all_events = sorted(set().union(*company_events.values()))

    # Synonym grouping (ML or exact)
    event_to_canonical, canonical_members = _group_synonyms(all_events)

    # Canonical event prevalence
    all_canonicals = sorted(set(event_to_canonical.values()))
    canonical_count = {}
    for canon in all_canonicals:
        synonyms = canonical_members.get(canon, {canon})
        canonical_count[canon] = sum(
            1 for c in companies
            if any(s in company_events[c] for s in synonyms)
        )

    # Filter by prevalence
    min_c = max(MIN_COOCCUR_COUNT, int(n_comp * MIN_COMPANY_FRACTION))
    max_c = int(n_comp * MAX_COMPANY_FRACTION)
    filtered = [canon for canon, cnt in canonical_count.items()
                if min_c <= cnt <= max(min_c, max_c)]

    if not filtered:
        return [], [], {c: list(e) for c, e in company_events.items()}, []

    # Company × event binary matrix
    fl   = sorted(filtered)
    n_e  = len(fl)
    cidx = {canon: i for i, canon in enumerate(fl)}

    matrix = np.zeros((n_comp, n_e), dtype=np.int8)
    for ci, company in enumerate(companies):
        cset = company_events[company]
        for ei, canon in enumerate(fl):
            syns = canonical_members.get(canon, {canon})
            if any(s in cset for s in syns):
                matrix[ci, ei] = 1

    # Co-occurrence
    cooc = np.zeros((n_e, n_e), dtype=int)
    for i in range(n_e):
        for j in range(i + 1, n_e):
            both = int(np.sum((matrix[:, i] == 1) & (matrix[:, j] == 1)))
            cooc[i, j] = cooc[j, i] = both

    # Jaccard edges — cast to plain Python types
    edges = []
    for i in range(n_e):
        for j in range(i + 1, n_e):
            both  = int(cooc[i, j])
            union = int(np.sum((matrix[:, i] == 1) | (matrix[:, j] == 1)))
            if union > 0 and both >= MIN_COOCCUR_COUNT:
                jac = both / union
                if jac >= JACCARD_THRESHOLD:
                    edges.append({
                        "source":   str(fl[i]),
                        "target":   str(fl[j]),
                        "weight":   round(float(jac), 3),
                        "co_count": both,
                    })

    # Nodes — cast everything to plain Python types
    nodes = [
        {
            "id":       str(canon),
            "count":    int(canonical_count[canon]),
            "synonyms": [str(s) for s in canonical_members.get(canon, {canon}) - {canon}],
        }
        for canon in fl
    ]

    # ── Ensure isolated nodes (pass prevalence but no edges) are included ──
    # Without this, events that pass the prevalence filter but don't share a
    # strong Jaccard with any other event are silently excluded from the graph.
    # We keep them so the graph always matches the count the user sees in the list.
    connected_ids = set()
    for e in edges:
        connected_ids.add(e["source"])
        connected_ids.add(e["target"])

    for canon in fl:
        if canon not in connected_ids:
            # Already in nodes list, no action needed — just documenting intent.
            pass
    # (nodes list already contains all fl items; the above is a no-op safety note)

    # Anomaly detection: companies that break strong co-occurrence patterns
    ANOMALY_THRESHOLD = 0.75
    anomalies = []
    strong_pairs = [
        e for e in edges
        if e["co_count"] / n_comp >= ANOMALY_THRESHOLD
    ]
    for pair in strong_pairs:
        ei = cidx[pair["source"]]
        ej = cidx[pair["target"]]
        for ci, company in enumerate(companies):
            has_i = matrix[ci, ei]
            has_j = matrix[ci, ej]
            if has_i != has_j:
                anomalies.append({
                    "company":      str(company),
                    "has":          str(pair["source"] if has_i else pair["target"]),
                    "missing":      str(pair["target"] if has_i else pair["source"]),
                    "pattern_rate": round(float(pair["co_count"]) / n_comp, 2),
                })

    return nodes, edges, {c: sorted(e) for c, e in company_events.items()}, anomalies

# ─── ROUTES: MAIN EXPLORER ────────────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory("static", "index.html")

@app.route("/api/summary")
def api_summary():
    try:
        df = load_df()
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({
        "total_entries":            int(len(df)),
        "unique_drugs":             int(df[COL_DRUG].nunique()),
        "unique_classes":           int(df[COL_CLASS].nunique()),
        "unique_companies":         int(df[COL_COMPANY].nunique()),
        "severity_distribution":    df[COL_SEV_CAT].value_counts().to_dict(),
        "pregnancy_distribution":   df[COL_PREGNANCY].value_counts().to_dict(),
        "breastfeeding_distribution": df[COL_BREAST].value_counts().to_dict(),
    })

@app.route("/api/classes")
def api_classes():
    try:
        df = load_df()
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 500
    records = []
    for drug_class, group in df.groupby(COL_CLASS):
        rec = {"drug_class": drug_class}
        rec.update(_agg(group))
        records.append(rec)
    records.sort(key=lambda r: r["drug_class"])
    return jsonify(records)

@app.route("/api/classes/<drug_class>/companies")
def api_class_companies(drug_class):
    try:
        df = load_df()
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 500
    subset = df[df[COL_CLASS] == drug_class]
    if subset.empty:
        return jsonify({"error": f"Drug class '{drug_class}' not found."}), 404
    records = []
    for company, group in subset.groupby(COL_COMPANY):
        rec = {"drug_class": drug_class, "company": company}
        rec.update(_agg(group))
        records.append(rec)
    records.sort(key=lambda r: r["company"])
    return jsonify(records)

@app.route("/api/companies")
def api_all_companies():
    try:
        df = load_df()
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 500
    records = []
    for (drug_class, company), group in df.groupby([COL_CLASS, COL_COMPANY]):
        rec = {"drug_class": drug_class, "company": company}
        rec.update(_agg(group))
        records.append(rec)
    records.sort(key=lambda r: (r["drug_class"], r["company"]))
    return jsonify(records)

@app.route("/api/reload")
def api_reload():
    try:
        df = load_df()
        return jsonify({"status": "ok", "rows": int(len(df)), "columns": list(df.columns)})
    except FileNotFoundError as e:
        return jsonify({"status": "error", "message": str(e)}), 500

# ─── ROUTES: ADVERSE EVENT GRAPH ──────────────────────────────────────────────
@app.route("/adverse")
def adverse_index():
    """Serve the adverse event co-occurrence explorer page."""
    return send_from_directory("static", "adverse.html")

@app.route("/connections")
def connections_index():
    """Serve the Event · Drug · Company parallel connections view."""
    return send_from_directory("static", "connections.html")

@app.route("/api/drugs")
def api_drugs():
    """List all unique drugs with basic stats — used to populate the drug selector."""
    try:
        df = load_df()
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 500

    records = []
    for drug, group in df.groupby(COL_DRUG):
        # Collect all adverse events
        all_events = set()
        for lst in group["Adverse_List"]:
            all_events.update(lst)
        records.append({
            "drug_name":      drug,
            "drug_class":     group[COL_CLASS].mode()[0] if not group[COL_CLASS].empty else "",
            "n_entries":      int(len(group)),
            "n_companies":    int(group[COL_COMPANY].nunique()),
            "n_adverse":      len(all_events),
            "avg_severity":   _safe(group[COL_SEVERITY].mean()),
        })

    records.sort(key=lambda r: r["drug_name"])
    return jsonify(records)

@app.route("/api/drugs/<drug_name>/adverse-events")
def api_drug_adverse_events(drug_name):
    """
    Return per-company adverse event lists for a drug, plus
    a sorted list of all unique events for the sidebar checklist.
    """
    try:
        df = load_df()
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 500

    drug_df = df[df[COL_DRUG] == drug_name]
    if drug_df.empty:
        return jsonify({"error": f"Drug '{drug_name}' not found."}), 404

    company_events_raw = {}
    for company, group in drug_df.groupby(COL_COMPANY):
        merged = set()
        for lst in group["Adverse_List"]:
            merged.update(lst)
        company_events_raw[company] = merged

    all_events_raw = sorted(set().union(*company_events_raw.values()))
    n_comp = len(company_events_raw)

    # Apply the same synonym grouping used by the co-occurrence graph so
    # the left-panel list shows one canonical name per synonym cluster.
    event_to_canonical, canonical_members = _group_synonyms(all_events_raw)

    # Re-map each company's raw events to canonical names
    company_events = {
        company: sorted({event_to_canonical[e] for e in evts})
        for company, evts in company_events_raw.items()
    }

    all_canonicals = sorted(set(event_to_canonical.values()))

    # Prevalence: count companies that have ANY synonym of each canonical
    event_prevalence = {
        canon: sum(
            1 for evts in company_events_raw.values()
            if any(s in evts for s in canonical_members.get(canon, {canon}))
        )
        for canon in all_canonicals
    }

    # Synonym list so the UI can show "also listed as …"
    event_synonyms = {
        canon: sorted(canonical_members.get(canon, {canon}) - {canon})
        for canon in all_canonicals
    }

    return jsonify({
        "drug_name":        drug_name,
        "n_companies":      n_comp,
        "all_events":       all_canonicals,
        "event_prevalence": event_prevalence,
        "event_synonyms":   event_synonyms,
        "company_events":   company_events,
    })

@app.route("/api/drugs/<drug_name>/cooccurrence")
def api_drug_cooccurrence(drug_name):
    """
    Build and return the co-occurrence graph for a drug.
    Query params:
      - jaccard_threshold (float, default 0.35)
      - min_prevalence    (float 0-1, default 0.20)
    This is the most expensive endpoint — results are NOT cached
    so that dataset changes are always reflected.
    """
    try:
        df = load_df()
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 500

    drug_df = df[df[COL_DRUG] == drug_name]
    if drug_df.empty:
        return jsonify({"error": f"Drug '{drug_name}' not found."}), 404

    # Allow client to tune thresholds
    global JACCARD_THRESHOLD, MIN_COMPANY_FRACTION
    jt  = float(request.args.get("jaccard_threshold", JACCARD_THRESHOLD))
    mp  = float(request.args.get("min_prevalence",    MIN_COMPANY_FRACTION))
    orig_jt, orig_mp = JACCARD_THRESHOLD, MIN_COMPANY_FRACTION
    JACCARD_THRESHOLD       = jt
    MIN_COMPANY_FRACTION    = mp

    nodes, edges, company_events, anomalies = build_cooccurrence_graph(drug_name, df)

    JACCARD_THRESHOLD    = orig_jt
    MIN_COMPANY_FRACTION = orig_mp

    return jsonify({
        "drug_name":     drug_name,
        "ml_active":     USE_ML,
        "nodes":         nodes,
        "edges":         edges,
        "company_events": company_events,
        "anomalies":     anomalies,
    })


@app.route("/api/connections")
def api_connections():
    """
    Return a flat connection table for the Parallel Sets / chord visualisation.
    Aggregates across ALL drugs in the dataset.

    Response shape:
    {
      "events":    ["nausea", ...],          # sorted canonical event names
      "drugs":     ["Atorvastatin", ...],    # sorted drug names
      "companies": ["Apotex", ...],          # sorted company names
      "links": [
        {"event": "nausea", "drug": "Atorvastatin", "company": "Apotex"},
        ...
      ]
    }
    Each link represents: company X reported event Y for drug Z.
    Duplicate rows in the source data are collapsed.
    """
    try:
        df = load_df()
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 500

    links_set = set()
    for _, row in df.iterrows():
        drug    = str(row[COL_DRUG]).strip()
        company = str(row[COL_COMPANY]).strip()
        for evt in row["Adverse_List"]:
            links_set.add((evt, drug, company))

    links = [{"event": e, "drug": d, "company": c}
             for e, d, c in sorted(links_set)]

    events    = sorted({l["event"]   for l in links})
    drugs     = sorted({l["drug"]    for l in links})
    companies = sorted({l["company"] for l in links})

    return jsonify({
        "events":    events,
        "drugs":     drugs,
        "companies": companies,
        "links":     links,
    })

# ─── ENTRY POINT ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 60)
    print("  Drug Monograph Explorer")
    print("=" * 60)
    print(f"  Data file  : {EXCEL_PATH}")
    print(f"  Main app   : http://localhost:5000")
    print(f"  Adverse    : http://localhost:5000/adverse")
    print(f"  API base   : http://localhost:5000/api/")
    print("=" * 60)
    _try_load_model()
    app.run(debug=True, port=5000)
