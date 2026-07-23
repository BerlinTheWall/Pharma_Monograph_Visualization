"""
Health Canada Product Monograph PDF-link enrichment
====================================================
Our dataset (final__monograph_extractions.xlsx) has no DIN and no PDF link for
any row, and the extracted monograph text itself doesn't contain the DIN either.
Health Canada's Drug Product Database (DPD) API doesn't expose a monograph PDF
field, but the DPD web page for a product links to one (hosted separately at
pdf.hres.ca). So getting from our row -> PDF requires:

  1. Search DPD's "active ingredient" API by our Drug Name to get candidate
     drug_codes (+ strengths).
  2. Look up each candidate's drugproduct record (company name, DIN).
  3. Score candidates against our row's Company (+ strength parsed from ID)
     and pick the best match (best-effort — not a guaranteed-correct match).
  4. Fetch that drug_code's DPD info page and scrape the pdf.hres.ca link,
     if one is listed.

Results are cached to pdf_links_cache.json, keyed by row ID, so app.py never
has to hit the network and re-running this script only fills in rows that
are missing or previously failed (pass --force to redo everything).

Usage:
    pip install requests
    python enrich_pdf_links.py [--force] [--limit N] [--sleep 0.15]
"""

import argparse
import difflib
import json
import os
import re
import sys
import time

import pandas as pd
import requests

EXCEL_PATH = os.path.join(os.path.dirname(__file__), "final__monograph_extractions.xlsx")
CACHE_PATH = os.path.join(os.path.dirname(__file__), "pdf_links_cache.json")

API_BASE = "https://health-products.canada.ca/api/drug"
INFO_PAGE_URL = "https://health-products.canada.ca/dpd-bdpp/info?lang=eng&code={code}"
PDF_LINK_RE = re.compile(r"https?://pdf\.hres\.ca/dpd_pm/[^\s\"'<>)]+\.PDF", re.IGNORECASE)

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "monograph-visualization-research/1.0"})

SLEEP = 0.15  # politeness delay between HTTP requests to a public gov API


def _request_with_retry(method, url, retries=2, **kwargs):
    last_exc = None
    for attempt in range(retries + 1):
        try:
            return method(url, timeout=20, **kwargs)
        except requests.RequestException as e:
            last_exc = e
            if attempt < retries:
                time.sleep(1.0 * (attempt + 1))
    raise last_exc


def _get_json(path, params):
    params = {**params, "lang": "en", "type": "json"}
    r = _request_with_retry(SESSION.get, f"{API_BASE}/{path}/", params=params)
    r.raise_for_status()
    time.sleep(SLEEP)
    if not r.text.strip():
        return []
    return r.json()


def _normalise_company(name):
    name = (name or "").casefold()
    name = re.sub(r"[.,'’]", "", name)
    name = re.sub(r"\b(inc|ltd|ltée|ulc|corp|corporation|co|company|llc)\b", "", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name


def _company_score(a, b):
    a, b = _normalise_company(a), _normalise_company(b)
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def _parse_strength_from_id(row_id):
    """Pull the trailing strength token(s) out of an ID like 'ach-amlodipine 10mg' or
    'amlodipine 10mg-2' (the '-2' is a de-dup suffix, not part of the strength)."""
    row_id = re.sub(r"-\d+$", "", row_id.strip())
    m = re.search(r"([\d.]+(?:\s*-\s*[\d.]+)*)\s*(mg|mcg|g|ml|%|units?)\b", row_id, re.IGNORECASE)
    if not m:
        return None
    nums = re.findall(r"[\d.]+", m.group(1))
    return set(nums)


# DPD's ingredient naming occasionally differs from our dataset's INN/common
# spelling. Extend as new mismatches turn up.
_INGREDIENT_ALIASES = {
    "cefalexin": "cephalexin",
    "penicillin potassium": "penicillin v potassium",
}


def _primary_ingredient(drug_name):
    """For a combination-drug name like 'Amoxicillin & clavulanic acid potassium'
    or 'Trimethoprim–sulfamethoxazole', return just the first component —
    DPD's activeingredient search matches on a single ingredient at a time, but
    a combo product still shows up when searched by any one of its components."""
    part = re.split(r"\s*[&–—]\s*|\s+and\s+", drug_name, maxsplit=1)[0].strip()
    return _INGREDIENT_ALIASES.get(part.lower(), part)


def active_ingredient_candidates(drug_name):
    data = _get_json("activeingredient", {"ingredientname": drug_name})
    if not data:
        fallback = _primary_ingredient(drug_name)
        if fallback.lower() != drug_name.lower():
            data = _get_json("activeingredient", {"ingredientname": fallback})
    by_code = {}
    for entry in data:
        by_code.setdefault(entry["drug_code"], []).append(entry)
    return by_code


def drug_product_info(drug_code):
    data = _get_json("drugproduct", {"id": drug_code})
    if isinstance(data, list):
        return data[0] if data else None
    return data or None


def fetch_monograph_pdf_url(drug_code):
    r = _request_with_retry(SESSION.get, INFO_PAGE_URL.format(code=drug_code))
    time.sleep(SLEEP)
    if r.status_code != 200:
        return None
    m = PDF_LINK_RE.search(r.text)
    return m.group(0) if m else None


def main():
    global SLEEP

    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="Re-process rows already in the cache")
    ap.add_argument("--limit", type=int, default=None, help="Only process the first N unprocessed rows")
    ap.add_argument("--sleep", type=float, default=SLEEP, help="Delay between HTTP requests (seconds)")
    args = ap.parse_args()

    SLEEP = args.sleep

    df = pd.read_excel(EXCEL_PATH)
    df.columns = [re.sub(r"\s+", " ", c).strip() for c in df.columns]

    cache = {}
    if os.path.exists(CACHE_PATH) and not args.force:
        with open(CACHE_PATH, "r", encoding="utf-8") as f:
            cache = json.load(f)

    # In-memory memos so repeated rows for the same drug/company (e.g. every
    # strength of "amlodipine") don't refetch the same candidate list, product
    # info, or monograph page over and over.
    ai_memo = {}
    product_info_memo = {}
    pdf_url_memo = {}
    processed_this_run = 0

    for _, row in df.iterrows():
        row_id = str(row["ID"])
        if row_id in cache and not args.force and cache[row_id].get("status") != "error":
            continue
        if args.limit is not None and processed_this_run >= args.limit:
            break

        drug_name = str(row["Drug Name"]).strip()
        company = str(row["Company"]).strip()

        print(f"[{processed_this_run+1}] {row_id!r}  (drug={drug_name!r}, company={company!r})", end=" ... ")
        sys.stdout.flush()

        try:
            if drug_name not in ai_memo:
                ai_memo[drug_name] = active_ingredient_candidates(drug_name)
            candidates = ai_memo[drug_name]

            if not candidates:
                cache[row_id] = {"status": "no_ingredient_match"}
                print("no ingredient match")
                processed_this_run += 1
                continue

            target_strengths = _parse_strength_from_id(row_id)
            scored = []
            for drug_code, ai_rows in candidates.items():
                if drug_code not in product_info_memo:
                    product_info_memo[drug_code] = drug_product_info(drug_code)
                info = product_info_memo[drug_code]
                if not info:
                    continue
                company_score = _company_score(company, info.get("company_name", ""))
                strength_score = 0.0
                if target_strengths:
                    candidate_strengths = {a["strength"] for a in ai_rows if a.get("strength")}
                    if target_strengths & candidate_strengths:
                        strength_score = 1.0
                score = 0.7 * company_score + 0.3 * strength_score
                scored.append((score, drug_code, info))

            if not scored:
                cache[row_id] = {"status": "no_product_match"}
                print("no product match")
                processed_this_run += 1
                continue

            scored.sort(key=lambda t: t[0], reverse=True)
            best_score, best_code, best_info = scored[0]

            if best_code not in pdf_url_memo:
                pdf_url_memo[best_code] = fetch_monograph_pdf_url(best_code)
            pdf_url = pdf_url_memo[best_code]

            cache[row_id] = {
                "status": "matched",
                "din": best_info.get("drug_identification_number"),
                "drug_code": best_code,
                "matched_company": best_info.get("company_name"),
                "brand_name": best_info.get("brand_name"),
                "match_score": round(best_score, 3),
                "pdf_url": pdf_url,
                "dpd_info_url": INFO_PAGE_URL.format(code=best_code),
            }
            print(f"-> DIN {best_info.get('drug_identification_number')} "
                  f"score={best_score:.2f} pdf={'yes' if pdf_url else 'no'}")

        except requests.RequestException as e:
            cache[row_id] = {"status": "error", "message": str(e)}
            print(f"HTTP error: {e}")

        processed_this_run += 1

        if processed_this_run % 20 == 0:
            with open(CACHE_PATH, "w", encoding="utf-8") as f:
                json.dump(cache, f, indent=2)

    with open(CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2)

    statuses = {}
    for v in cache.values():
        statuses[v.get("status", "?")] = statuses.get(v.get("status", "?"), 0) + 1
    print("\n--- Summary ---")
    for status, count in sorted(statuses.items()):
        print(f"  {status}: {count}")
    matched_with_pdf = sum(1 for v in cache.values() if v.get("pdf_url"))
    print(f"  rows with a PDF link: {matched_with_pdf} / {len(df)}")


if __name__ == "__main__":
    main()
