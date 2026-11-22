# Pharma Monograph Visualization

An interactive explorer for clinical data extracted from 1,433 Health Canada
drug product monographs. Compare drug classes, drugs and manufacturers by their
adverse events, contraindications, warnings and interactions, and spot where a
manufacturer's monograph leaves out something the others report.

**[Live demo](https://pharmamonographvisualization-production.up.railway.app/)**

> MSc research, Western University. Two papers in preparation.

## What you can do with it

- **Compare drug classes at a glance.** Each class is a bubble on a scatter
  plot; choose what the axes show (number of medicines, average severity,
  average number of contraindications, warnings, interactions or adverse
  events). Click a class to see its manufacturers plotted the same way.
- **Find gaps in a manufacturer's monograph.** For one drug, build a network of
  adverse events that tend to be reported together across manufacturers. When
  most companies list two events together and one company lists only one of
  them, it is flagged as an anomaly: "Company X reports A but not B".
- **See which adverse events belong to which class.** A heatmap of the top 50
  adverse events across all 19 drug classes shows how often each is reported and
  how much more common it is in that class than overall. A treemap drills into
  one class, drug by drug.
- **Trace event, drug and company together.** A three-way view links each
  adverse event to the drugs and companies that report it.
- **Go back to the source.** The Sources page lists every product by class and
  drug, with a link to its Health Canada monograph PDF where one could be
  matched.

## Pages

| Page | URL | Shows |
|---|---|---|
| Explorer | `/` | Scatter plot of drug classes, drill-down to manufacturers |
| Adverse event co-occurrence | `/adverse` | Event network per drug, with the anomaly panel |
| Event, drug, company | `/connections` | Links between events, drugs and companies |
| Heatmap and treemap | `/heatmap` | Adverse-event prevalence by class, drill-down by drug |
| Sources | `/source` | Products by class and drug, with monograph PDF links |

## The project

| Repository | Role |
|---|---|
| [Pharma_Feature_Extractor](https://github.com/BerlinTheWall/Pharma_Feature_Extractor) | **Extraction.** LLM pipeline that turns the monograph PDFs into structured data |
| [pharma_pattern_models](https://github.com/BerlinTheWall/pharma_pattern_models) | **Experiments.** Clustering, prediction and anomaly detection over the extracted data |
| **Pharma_Monograph_Visualization** *(this repo)* | **The interface.** Flask API and D3.js views |

## Architecture

```
final__monograph_extractions.xlsx      pdf_links_cache.json
               │                               │
               ▼                               ▼
        pandas (load, clean, aggregate)  ◄─────┘
               │
               ▼
        Flask REST API  ──►  JSON  ──►  D3.js pages in static/
```

- **Backend:** Flask reads the spreadsheet with pandas, cleans the adverse-event
  lists, and computes everything the pages need (class aggregates, co-occurrence
  graphs with NetworkX, prevalence matrices) on request.
- **Frontend:** plain HTML, CSS and JavaScript with D3.js in `static/`. No build
  step.
- **PDF links:** the dataset has no DIN or PDF link, so `enrich_pdf_links.py`
  matches each row to Health Canada's Drug Product Database by drug name,
  company and strength, and saves the result in `pdf_links_cache.json`. The app
  never calls the network itself. Matches are best effort.

## How the anomaly detection works

For one drug, each manufacturer's monograph is a set of adverse events.

1. Events reported by almost every manufacturer, or by almost none, are left
   out, since they cannot reveal a gap.
2. Two events are linked when they are often reported together, measured by
   their Jaccard similarity across manufacturers.
3. For each strongly linked pair, any manufacturer that reports one event but
   not the other is flagged, with the share of manufacturers that report both.

If `sentence-transformers` is installed, near-identical event names (for example
different wordings of the same reaction) are merged first using PubMedBERT
embeddings. Without it, the app matches event names exactly.

## API

All endpoints return JSON.

| Endpoint | Returns |
|---|---|
| `GET /api/summary` | Totals and the distributions of severity, pregnancy and breastfeeding categories |
| `GET /api/classes` | One aggregate per drug class |
| `GET /api/classes/<class>/companies` | Aggregates per company within a class |
| `GET /api/classes/<class>/drugs` | Drugs within a class |
| `GET /api/companies` | Aggregates per company within each class |
| `GET /api/drugs` | All drugs with basic stats |
| `GET /api/drugs/<drug>/adverse-events` | Adverse events of one drug across companies |
| `GET /api/drugs/<drug>/products` | Products of one drug, with PDF links where matched |
| `GET /api/drugs/<drug>/cooccurrence` | Co-occurrence graph and anomalies for one drug (query: `jaccard_threshold`, `min_prevalence`) |
| `GET /api/global/adverse-events` | Adverse events across the whole dataset |
| `GET /api/global/cooccurrence` | Co-occurrence graph across the whole dataset |
| `GET /api/connections` | Event, drug and company links |
| `GET /api/heatmap` | Prevalence matrix of the top 50 events by class |
| `GET /api/treemap/<class>` | Drug-level breakdown of one class |
| `GET /api/reload` | Reloads the spreadsheet |

## Running it

```bash
git clone https://github.com/BerlinTheWall/Pharma_Monograph_Visualization.git
cd Pharma_Monograph_Visualization
pip install -r requirements.txt
python app.py
```

Then open http://localhost:5000.

Optional, for semantic merging of event names:

```bash
pip install sentence-transformers
```

The live demo is deployed on Railway with gunicorn (`railway.json`).

## Data

`final__monograph_extractions.xlsx` has one row per monograph: 1,433 Health
Canada monographs covering 19 therapeutic classes, 53 generic drugs and 62
manufacturers. It was produced by the
[extraction pipeline](https://github.com/BerlinTheWall/Pharma_Feature_Extractor)
from public Health Canada regulatory filings.

**The data was extracted automatically by a language model and contains
errors.** It is for research only and must not be used for clinical decisions.
The monograph itself remains the reference. See the
[extractor's evaluation](https://github.com/BerlinTheWall/Pharma_Feature_Extractor#evaluation).
