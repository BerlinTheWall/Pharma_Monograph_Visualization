# Pharma Monograph Visualization

An interactive explorer for clinical data extracted from 1,435 Health Canada
drug product monographs. Filter, compare and cluster drugs by indication,
adverse-event profile, contraindications and dosing guidance — data that
otherwise sits locked in thousands of PDFs.

**The final product of a three-repository MSc research project.**

**[FILL: put a screenshot or short GIF of the scatter-plot here. This is the
only repo of the three a non-specialist understands at a glance, and an image is
what makes that happen.]**

> MSc research, Western University. Two papers in preparation.

## What you can do with it

**[FILL: 3–5 bullets. What questions can someone actually answer here? Written
as what a user does, not what the code does. For example: "compare
adverse-event profiles across a therapeutic class", "find drugs whose
contraindication sets overlap", "see how dosing guidance varies by
manufacturer". Keep only what the interface really supports.]**

## The project

| Repository | Role |
|---|---|
| [Pharma_Feature_Extractor](https://github.com/BerlinTheWall/Pharma_Feature_Extractor) | **Extraction.** LLM pipeline over 1,435 monograph PDFs — Llama 3.1-8B (Cerebras), Mistral 7B, Qwen 2.5 7B |
| [pharma_pattern_models](https://github.com/BerlinTheWall/pharma_pattern_models) | **Experiments.** Clustering, prediction and anomaly detection over the extracted data |
| **Pharma_Monograph_Visualization** *(this repo)* | **The product.** Flask API serving an interactive D3.js interface |

## Architecture

```
final__monograph_extractions.xlsx
            │
            ▼
   pandas / openpyxl
            │
            ▼
    Flask REST API  ── CORS ──►  static front-end
            │                     (D3.js scatter-plot)
            ▼
      JSON endpoints
```

**Backend** — Flask with Flask-CORS, reading the extracted dataset through
pandas and openpyxl, exposing it as JSON.

**Frontend** — D3.js scatter-plot with supporting HTML, CSS and JavaScript in
`static/`. No build step; the page is served directly.

## API

**[FILL: your existing README already documents the endpoints — keep that
section as it is, it's good.]**

## Running it

```bash
git clone https://github.com/BerlinTheWall/Pharma_Monograph_Visualization.git
cd Pharma_Monograph_Visualization
pip install -r requirements.txt
python app.py
```

Then open http://localhost:5000.

## Data

`final__monograph_extractions.xlsx` — ~1,434 structured records drawn from 1,435
Health Canada monographs across 19 therapeutic classes, 53 generic drugs and 62
manufacturers. Produced by the extraction pipeline; source documents are public
Health Canada regulatory filings.

**Note on extraction reliability:** categorical field accuracy in the underlying
pipeline ranges from 16.7% to 55% depending on field and model — see the
[extractor's evaluation](https://github.com/BerlinTheWall/Pharma_Feature_Extractor#evaluation).
This interface visualises extracted data, not verified clinical data, and should
not be used for clinical decision-making.

**[Confirm with your supervisor that this dataset should be public before the
papers are submitted.]**

## Notes

**[FILL: the real engineering decisions. Serving a dataset of this shape to D3
efficiently, choosing the projection for the scatter plot, deciding what to
encode in position versus colour. This is where a reviewer sees you think.]**
