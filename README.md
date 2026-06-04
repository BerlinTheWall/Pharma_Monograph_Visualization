# Drug Monograph Explorer

An interactive D3.js scatter-plot that reads live from your Excel dataset
via a Flask API. Drill into any drug class to explore individual manufacturers.

---

## Project structure

```
drug-explorer/
├── app.py              ← Flask API server  (edit EXCEL_PATH here)
├── README.md
└── static/
    ├── index.html      ← Page shell + sidebar controls
    ├── style.css       ← All styling
    └── chart.js        ← D3 chart logic + API calls
```

---

## Quick start

### 1. Install dependencies

```bash
pip install flask flask-cors pandas openpyxl
```

### 2. Place your Excel file

Copy your spreadsheet into the `drug-explorer/` folder and name it **`data.xlsx`**.

OR open `app.py` and change the `EXCEL_PATH` variable at the top:

```python
EXCEL_PATH = "/absolute/path/to/your/file.xlsx"
```

### 3. Run the server

```bash
cd drug-explorer
python app.py
```

You'll see:

```
============================================================
  Drug Monograph Explorer
============================================================
  Data file : /path/to/drug-explorer/data.xlsx
  Frontend  : http://localhost:5000
  API base  : http://localhost:5000/api/
============================================================
```

### 4. Open in browser

Navigate to **http://localhost:5000**

---

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/summary` | Dataset-wide stats (entry count, unique classes, etc.) |
| GET | `/api/classes` | One record per drug class with averaged metrics |
| GET | `/api/classes/<class>/companies` | Companies within a specific drug class |
| GET | `/api/companies` | All company–class combinations in one call |
| GET | `/api/drugs` | Flat list of unique drugs with severity stats |
| GET | `/api/reload` | Confirm the Excel file loads correctly |

All endpoints return JSON. CORS is enabled, so you can call the API
from a separately hosted frontend if needed.

---

## Customisation

### Change the Excel column names

If your spreadsheet uses different column headers, update the `COL_*`
constants near the top of `app.py`:

```python
COL_CLASS    = "Drug  Class"   # ← change to match your column header
COL_COMPANY  = "Company"
COL_SEVERITY = "severity_score_percent"
# ... etc.
```

### Change chart colours

Edit the `CLASS_COLORS` and `COMPANY_COLORS` arrays in `static/chart.js`.

### Change the transition speed

Edit the `DUR` constant in `static/chart.js` (milliseconds):

```js
const DUR = 520;   // ← increase for slower, decrease for faster
```

### Add a new axis option

1. Add a new `<label>` inside `#y-opts` or `#x-opts` in `index.html`.
2. Make sure the `data-val` attribute matches a field returned by the API.
3. Add a human-readable label in the `AXIS_LABELS` object in `chart.js`.

### Live-reloading the dataset

The server re-reads the Excel file on every API request, so simply saving
an updated spreadsheet is enough — no server restart required.

To verify a new file was picked up:

```
http://localhost:5000/api/reload
```

---

## Production deployment

For production use, run with a proper WSGI server instead of Flask's
built-in development server:

```bash
pip install gunicorn
gunicorn -w 4 -b 0.0.0.0:5000 app:app
```
