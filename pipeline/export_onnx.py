"""Export the trained pipeline to the artifacts the browser client consumes.

Outputs (to the export dir):
  - feature_schema.json     : key arrays (order matters for the TS client)
  - tfidf_state.json        : fitted vocabulary_ + idf_
  - encoder_categories.json : fitted OneHotEncoder categories_
  - model.onnx              : the full pipeline (TF-IDF + OHE embedded)

A parity check runs the ONNX model through onnxruntime and asserts it matches the
sklearn pipeline on the held-out rows, so conversion drift fails loudly.
"""

import json
import os

import numpy as np
import onnx
import onnxruntime as ort
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType, StringTensorType

from .schema import (
    BOOLEAN_KEYS,
    CATEGORICAL_KEYS,
    COMBINED_TEXT_COLUMN,
    write_feature_schema,
)


def _export_tfidf_state(pipeline, path: str) -> None:
    vectorizer = pipeline.named_steps["features"].named_transformers_["text"]
    state = {
        "vocabulary": {token: int(index) for token, index in vectorizer.vocabulary_.items()},
        "idf": vectorizer.idf_.tolist(),
    }
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2)


def _export_encoder_categories(pipeline, path: str) -> None:
    encoder = pipeline.named_steps["features"].named_transformers_["cat"]
    # encoder.categories_ is aligned to CATEGORICAL_KEYS order. The TS client
    # builds the one-hot block by concatenating per-key arrays in this order;
    # an unseen value yields an all-zero block (handle_unknown="ignore").
    categories = {
        key: [str(category) for category in cats]
        for key, cats in zip(CATEGORICAL_KEYS, encoder.categories_)
    }
    payload = {"categorical_keys": CATEGORICAL_KEYS, "categories": categories}
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def split_inputs(X):
    """Split the feature DataFrame into the three grouped ONNX input tensors."""
    boolean_count = len(BOOLEAN_KEYS)
    categorical_count = len(CATEGORICAL_KEYS)

    booleans = X.iloc[:, 0:boolean_count].to_numpy().astype(np.float32)
    categorical = X.iloc[:, boolean_count : boolean_count + categorical_count].to_numpy().astype(object)
    combined_text = X[COMBINED_TEXT_COLUMN].to_numpy().astype(object).reshape(-1, 1)
    return booleans, categorical, combined_text


def export_onnx(pipeline, path: str):
    initial_types = [
        ("booleans", FloatTensorType([None, len(BOOLEAN_KEYS)])),
        ("categorical", StringTensorType([None, len(CATEGORICAL_KEYS)])),
        ("combined_text", StringTensorType([None, 1])),
    ]
    onnx_model = convert_sklearn(
        pipeline,
        initial_types=initial_types,
        options={id(pipeline): {"zipmap": False}},
    )
    onnx.save_model(onnx_model, path)
    return onnx_model


def verify_parity(pipeline, X_test, onnx_path: str) -> None:
    booleans, categorical, combined_text = split_inputs(X_test)

    session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    feeds = {
        "booleans": booleans,
        "categorical": categorical,
        "combined_text": combined_text,
    }
    onnx_labels = session.run(None, feeds)[0].ravel().astype(int)
    sklearn_labels = pipeline.predict(X_test).astype(int)

    if not np.array_equal(onnx_labels, sklearn_labels):
        raise AssertionError(
            "ONNX/sklearn prediction mismatch (training-serving skew):\n"
            f"  onnx   = {onnx_labels.tolist()}\n"
            f"  sklearn= {sklearn_labels.tolist()}"
        )
    print(f"Parity check passed on {len(X_test)} held-out rows.")


def export_artifacts(pipeline, X_test, export_dir: str) -> None:
    os.makedirs(export_dir, exist_ok=True)

    write_feature_schema(os.path.join(export_dir, "feature_schema.json"))
    _export_tfidf_state(pipeline, os.path.join(export_dir, "tfidf_state.json"))
    _export_encoder_categories(pipeline, os.path.join(export_dir, "encoder_categories.json"))

    onnx_path = os.path.join(export_dir, "model.onnx")
    export_onnx(pipeline, onnx_path)
    verify_parity(pipeline, X_test, onnx_path)

    size_mb = os.path.getsize(onnx_path) / (1024 * 1024)
    print(f"Artifacts written to {export_dir} (model.onnx = {size_mb:.2f} MB)")
