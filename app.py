"""
Drug Monograph Explorer — Flask Backend
=======================================
Run with:
    pip install flask pandas openpyxl flask-cors
    python app.py

Then open http://localhost:5000 in your browser.

The API reads the Excel file on every request, so any
changes to the spreadsheet are reflected immediately.
You can also swap in a different file by changing EXCEL_PATH.
"""

import os
import math
from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS
import pandas as pd

# ─── CONFIG ──────────────────────────────────────────────────────────────────
# Point this at your Excel file. Use an absolute path or a path relative to
# this script's directory.
EXCEL_PATH = os.path.join(os.path.dirname(__file__), "final__monograph_extractions.xlsx")

# Column name mapping — update these if your spreadsheet columns change
COL_ID          = "ID"
COL_BRAND       = "Brand Name"
COL_DRUG        = "Drug Name"
COL_CLASS       = "Drug Class"
COL_COMPANY     = "Company"
COL_AUTH_DATE   = "Initial Authorization"
COL_REVISION    = "Revision Date"
COL_CONTRAIND   = "Contraindications"
COL_WARNINGS    = "Serious warning and precautions"
COL_ADVERSE     = "Adverse Events"
COL_INTERACTIONS = "Drug Interactions"
COL_SEVERITY    = "severity_score_percent"
COL_SEV_CAT     = "severity_category"
COL_KIDNEY      = "Kidney Function Dose Adjustment"
COL_LIVER       = "Liver Function Dose Adjustment"
COL_PREGNANCY   = "Pregnancy Recommendation"
COL_BREAST      = "Breastfeeding Recommendation"

# ─── APP ─────────────────────────────────────────────────────────────────────
app = Flask(__name__, static_folder="static", static_url_path="/static")
CORS(app)   # allow cross-origin requests (useful if you serve the HTML separately)


# ─── HELPERS ─────────────────────────────────────────────────────────────────
def count_csv_items(text):
    """Count comma-separated items in a cell, returning 0 for empty cells."""
    if pd.isna(text) or str(text).strip() in ("", "nan"):
        return 0
    return len([x.strip() for x in str(text).split(",") if x.strip()])


def load_and_process():
    """
    Load the Excel file, compute derived columns, and return the DataFrame.
    Raises FileNotFoundError if EXCEL_PATH does not exist.
    """
    if not os.path.exists(EXCEL_PATH):
        raise FileNotFoundError(
            f"Excel file not found at '{EXCEL_PATH}'. "
            "Copy your spreadsheet to the same folder as app.py and name it data.xlsx, "
            "or update the EXCEL_PATH variable at the top of app.py."
        )

    df = pd.read_excel(EXCEL_PATH)

    # Derived count columns
    df["n_contraindications"] = df[COL_CONTRAIND].apply(count_csv_items)
    df["n_warnings"]          = df[COL_WARNINGS].apply(count_csv_items)
    df["n_drug_interactions"] = df[COL_INTERACTIONS].apply(count_csv_items)
    df["n_adverse_events"]    = df[COL_ADVERSE].apply(count_csv_items)

    return df


def safe_round(val, decimals=2):
    """Round a value, returning 0 for NaN/None."""
    try:
        v = float(val)
        return 0 if math.isnan(v) else round(v, decimals)
    except (TypeError, ValueError):
        return 0


def agg_group(group):
    """Return aggregation dict for a group of rows."""
    return {
        "n_medicines":           int(group[COL_DRUG].nunique()),
        "n_entries":             int(len(group)),
        "avg_severity":          safe_round(group[COL_SEVERITY].mean()),
        "avg_contraindications": safe_round(group["n_contraindications"].mean()),
        "avg_warnings":          safe_round(group["n_warnings"].mean()),
        "avg_drug_interactions": safe_round(group["n_drug_interactions"].mean()),
        "avg_adverse_events":    safe_round(group["n_adverse_events"].mean()),
    }


# ─── ROUTES ──────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    """Serve the frontend."""
    return send_from_directory("static", "index.html")


@app.route("/api/summary")
def api_summary():
    """
    GET /api/summary
    Returns top-level dataset statistics.
    """
    try:
        df = load_and_process()
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 500

    return jsonify({
        "total_entries":   int(len(df)),
        "unique_drugs":    int(df[COL_DRUG].nunique()),
        "unique_classes":  int(df[COL_CLASS].nunique()),
        "unique_companies": int(df[COL_COMPANY].nunique()),
        "severity_distribution": df[COL_SEV_CAT].value_counts().to_dict(),
        "pregnancy_distribution": df[COL_PREGNANCY].value_counts().to_dict(),
        "breastfeeding_distribution": df[COL_BREAST].value_counts().to_dict(),
    })


@app.route("/api/classes")
def api_classes():
    """
    GET /api/classes
    Returns one record per drug class with aggregated metrics.
    This is what the top-level scatter plot uses.
    """
    try:
        df = load_and_process()
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 500

    records = []
    for drug_class, group in df.groupby(COL_CLASS):
        rec = {"drug_class": drug_class}
        rec.update(agg_group(group))
        records.append(rec)

    # Sort alphabetically for consistency
    records.sort(key=lambda r: r["drug_class"])
    return jsonify(records)


@app.route("/api/classes/<drug_class>/companies")
def api_class_companies(drug_class):
    """
    GET /api/classes/<drug_class>/companies
    Returns one record per company within the specified drug class.
    This is what the drill-down view uses.

    Example:
        GET /api/classes/Statin/companies
    """
    try:
        df = load_and_process()
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 500

    subset = df[df[COL_CLASS] == drug_class]
    if subset.empty:
        return jsonify({"error": f"Drug class '{drug_class}' not found."}), 404

    records = []
    for company, group in subset.groupby(COL_COMPANY):
        rec = {"drug_class": drug_class, "company": company}
        rec.update(agg_group(group))
        records.append(rec)

    records.sort(key=lambda r: r["company"])
    return jsonify(records)


@app.route("/api/companies")
def api_all_companies():
    """
    GET /api/companies
    Returns every company–class combination. Useful if you want to
    pre-load all drill-down data at once (alternative to lazy-loading).
    """
    try:
        df = load_and_process()
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 500

    records = []
    for (drug_class, company), group in df.groupby([COL_CLASS, COL_COMPANY]):
        rec = {"drug_class": drug_class, "company": company}
        rec.update(agg_group(group))
        records.append(rec)

    records.sort(key=lambda r: (r["drug_class"], r["company"]))
    return jsonify(records)


@app.route("/api/drugs")
def api_drugs():
    """
    GET /api/drugs
    Returns a flat list of every unique drug with its class and
    severity statistics. Useful for search / autocomplete features.
    """
    try:
        df = load_and_process()
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 500

    records = []
    for (drug, drug_class), group in df.groupby([COL_DRUG, COL_CLASS]):
        records.append({
            "drug_name":  drug,
            "drug_class": drug_class,
            "n_entries":  int(len(group)),
            "avg_severity": safe_round(group[COL_SEVERITY].mean()),
        })

    records.sort(key=lambda r: r["drug_name"])
    return jsonify(records)


@app.route("/api/reload")
def api_reload():
    """
    GET /api/reload
    Handy endpoint to confirm the file can be read and return its shape.
    Use this to verify a new Excel file was picked up correctly.
    """
    try:
        df = load_and_process()
        return jsonify({
            "status": "ok",
            "rows": int(len(df)),
            "columns": list(df.columns),
            "classes": int(df[COL_CLASS].nunique()),
            "companies": int(df[COL_COMPANY].nunique()),
        })
    except FileNotFoundError as e:
        return jsonify({"status": "error", "message": str(e)}), 500


# ─── ENTRY POINT ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 60)
    print("  Drug Monograph Explorer")
    print("=" * 60)
    print(f"  Data file : {EXCEL_PATH}")
    print(f"  Frontend  : http://localhost:5000")
    print(f"  API base  : http://localhost:5000/api/")
    print("=" * 60)
    app.run(debug=True, port=5000)
