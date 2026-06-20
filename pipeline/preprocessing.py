"""Load dataset.json and turn it into model-ready features.

Output column order is fixed as [*BOOLEAN_KEYS, *CATEGORICAL_KEYS, combined_text]
because the ColumnTransformer (model.py) and the ONNX input layout
(export_onnx.py) both rely on this positional order.
"""

import math

import pandas as pd

from .schema import (
    BOOLEAN_KEYS,
    CATEGORICAL_KEYS,
    COMBINED_TEXT_COLUMN,
    TARGET_KEY,
    TEXT_KEYS,
)

ALL_FEATURE_KEYS = BOOLEAN_KEYS + CATEGORICAL_KEYS + TEXT_KEYS


def load_dataframe(path: str) -> pd.DataFrame:
    df = pd.read_json(path)

    # Guarantee every expected column exists even if a capture omitted it.
    for key in ALL_FEATURE_KEYS + [TARGET_KEY]:
        if key not in df.columns:
            df[key] = None

    return df


def _is_missing(value) -> bool:
    if value is None:
        return True
    if isinstance(value, float) and math.isnan(value):
        return True
    return False


def _row_combined_text(row: pd.Series) -> str:
    parts = []
    for key in TEXT_KEYS:
        value = row.get(key)
        if _is_missing(value):
            continue
        text = str(value).strip()
        if text:
            parts.append(text)
    return " ".join(parts)


def preprocess(df: pd.DataFrame):
    """Return (X, y). Drops unlabeled rows, casts booleans to float32, cleans
    categoricals to strings, and builds the combined_text column."""

    # Drop un-labeled raw captures (is_ai_prompt is null).
    df = df[df[TARGET_KEY].notna()].copy()

    # Booleans -> float32 (1.0 / 0.0).
    for key in BOOLEAN_KEYS:
        df[key] = df[key].fillna(False).astype(bool).astype("float32")

    # Categoricals -> clean, non-null strings. The OneHotEncoder learns "" as a
    # category; handle_unknown="ignore" covers novel values at inference.
    for key in CATEGORICAL_KEYS:
        df[key] = df[key].fillna("").astype(str)

    # Text -> single combined column (strip, drop empties, space-join).
    df[COMBINED_TEXT_COLUMN] = df.apply(_row_combined_text, axis=1)

    y = df[TARGET_KEY].astype(bool).astype("int64").reset_index(drop=True)
    X = (
        df[BOOLEAN_KEYS + CATEGORICAL_KEYS + [COMBINED_TEXT_COLUMN]]
        .reset_index(drop=True)
    )
    return X, y
