"""CLI entry point: load -> preprocess -> train -> evaluate -> export.

Usage:
    python -m pipeline.train --data /path/to/dataset.json
"""

import argparse
import os

from sklearn.metrics import accuracy_score, classification_report, f1_score
from sklearn.model_selection import train_test_split

from .archive import ingest
from .export_onnx import export_artifacts
from .model import build_pipeline
from .preprocessing import load_dataframe, preprocess


def parse_args():
    parser = argparse.ArgumentParser(
        description="Ingest new labeled data into the persistent archive, then train "
        "the AI-prompt field classifier and export ONNX artifacts.",
    )
    parser.add_argument(
        "--data",
        default=None,
        help="Path to a freshly downloaded dataset.json to ingest into the archive "
        "(optional; omit to retrain on the existing archive).",
    )
    parser.add_argument(
        "--archive",
        default=os.path.join("pipeline", "dataset_archive.json"),
        help="Persistent, git-tracked, deduplicated training-data archive.",
    )
    parser.add_argument(
        "--export",
        default=os.path.join("pipeline", "export"),
        help="Output directory for artifacts",
    )
    parser.add_argument("--test-size", type=float, default=0.2)
    parser.add_argument("--random-state", type=int, default=42)
    # min_df defaults to 2 per spec; lower to 1 only for tiny smoke-test datasets.
    parser.add_argument("--min-df", type=int, default=2)
    parser.add_argument("--max-df", type=float, default=0.9)
    return parser.parse_args()


def main():
    args = parse_args()

    # Append new labeled data into the persistent archive (dedup + label guard),
    # then always train on the full archive (the entire lifetime of data).
    if args.data:
        ingest(args.data, args.archive)

    if not os.path.exists(args.archive):
        raise SystemExit(
            f"No archive at {args.archive}. Provide --data pointing at a labeled "
            f"dataset.json to seed it."
        )

    df = load_dataframe(args.archive)
    X, y = preprocess(df)
    positives = int(y.sum())
    print(f"Loaded {len(X)} labeled rows ({positives} positive / {len(X) - positives} negative)")

    if len(X) < 2 or y.nunique() < 2:
        raise SystemExit("Need at least two labeled rows spanning both classes to train.")

    # Prefer a stratified split; fall back gracefully on very small datasets
    # where the test fold cannot hold one sample per class.
    split_kwargs = dict(test_size=args.test_size, random_state=args.random_state)
    try:
        X_train, X_test, y_train, y_test = train_test_split(X, y, stratify=y, **split_kwargs)
    except ValueError:
        print("Dataset too small to stratify; falling back to a non-stratified split.")
        X_train, X_test, y_train, y_test = train_test_split(X, y, **split_kwargs)

    pipeline = build_pipeline(min_df=args.min_df, max_df=args.max_df)
    pipeline.fit(X_train, y_train)

    y_pred = pipeline.predict(X_test)
    print(f"Accuracy: {accuracy_score(y_test, y_pred):.4f}")
    print(f"F1:       {f1_score(y_test, y_pred, zero_division=0):.4f}")
    print(classification_report(y_test, y_pred, zero_division=0))

    export_artifacts(pipeline, X_test, args.export)


if __name__ == "__main__":
    main()
