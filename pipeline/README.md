# PhishCatch ML Training Pipeline

Trains a lightweight scikit-learn classifier that predicts whether a DOM element
is an AI prompt, from the structural/semantic attributes collected by the
extension, and exports it to ONNX for local in-browser inference.

## Feature engineering

The schema ([`schema.py`](schema.py)) splits every field into three groups:

- `BOOLEAN_KEYS` -> passthrough float32 (`1.0`/`0.0`)
- `CATEGORICAL_KEYS` -> `OneHotEncoder` (programmatic, finite-vocabulary values
  like `tag_name`, `type`, `role`, `aria_haspopup`)
- `TEXT_KEYS` -> `TfidfVectorizer` over a single space-joined `combined_text`
  column (genuinely human-readable strings)

TF-IDF and the one-hot encoder are embedded in the ONNX graph, so the browser
passes raw strings and ONNX does tokenization/encoding (no training-serving
skew). The browser only needs to replicate the `combined_text` build rule
(TEXT_KEYS order, strip, drop empties, single-space join) and the categorical
empty-string fill.

## Prerequisites

Python >= 3.10. If Python is missing on macOS:

```bash
brew install python@3.12   # or use the python.org installer
```

## Setup

```bash
cd pipeline
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Persistent dataset archive

`dataset_archive.json` (git-tracked) accumulates every labeled raw entry over the
lifetime of the model. Each time you download a fresh `dataset.json` from the
extension, point the trainer at it: new entries are appended to the archive and
the model is (re)trained on the **entire** archive.

- Dedup is content-based: each entry is hashed by its canonical JSON with
  timestamp keys (`collected_at`) removed, so the same element captured at a
  different time is treated as a duplicate and skipped.
- Label guard: ingestion errors out if any inbound entry has `is_ai_prompt: null`
  (or missing), so unlabeled raw captures cannot pollute the archive. Label every
  entry `true`/`false` before ingesting.

## Run

```bash
# from the repo root, with the venv active

# Ingest a new download into the archive, then train on the whole archive:
python -m pipeline.train --data /path/to/dataset.json

# Retrain on the existing archive without ingesting anything new:
python -m pipeline.train
```

Useful flags:

- `--data FILE` new download to ingest (optional; omit to retrain on the archive)
- `--archive FILE` persistent archive (default `pipeline/dataset_archive.json`)
- `--export DIR` output directory (default `pipeline/export`)
- `--min-df N` TF-IDF minimum document frequency (default `2`; use `1` for tiny
  smoke-test datasets or TF-IDF may prune to an empty vocabulary)
- `--max-df F` TF-IDF maximum document frequency (default `0.9`)
- `--test-size`, `--random-state`

## Outputs (`export/`)

- `feature_schema.json` - `boolean_keys`, `categorical_keys`, `text_keys` (exact
  order the TS client must use), plus `target_key` and `combined_text_column`
- `tfidf_state.json` - fitted `vocabulary_` + `idf_`
- `encoder_categories.json` - fitted `OneHotEncoder` `categories_` per key
- `model.onnx` - the full pipeline; three inputs: `booleans` (float `[N, B]`),
  `categorical` (string `[N, C]`), `combined_text` (string `[N, 1]`)

A parity check runs the exported ONNX through `onnxruntime` and asserts it matches
the sklearn pipeline on the held-out rows.
