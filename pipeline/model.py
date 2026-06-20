"""The three-pronged scikit-learn pipeline.

ColumnTransformer routes:
  - BOOLEAN_KEYS    -> passthrough (already float32)
  - CATEGORICAL_KEYS -> OneHotEncoder
  - combined_text   -> TfidfVectorizer

Columns are selected by INTEGER INDEX (not names) on purpose: this is what lets
skl2onnx emit exactly three grouped, typed inputs (one FloatTensorType + two
StringTensorType) instead of one input per column. The indices are derived from
the schema constant lengths and X is built in the same constant-driven order, so
adding/removing a key shifts both consistently.
"""

from sklearn.compose import ColumnTransformer
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

from .schema import BOOLEAN_KEYS, CATEGORICAL_KEYS


def build_pipeline(min_df: int = 2, max_df: float = 0.9) -> Pipeline:
    boolean_count = len(BOOLEAN_KEYS)
    categorical_count = len(CATEGORICAL_KEYS)

    boolean_cols = list(range(0, boolean_count))
    categorical_cols = list(range(boolean_count, boolean_count + categorical_count))
    text_col = boolean_count + categorical_count  # scalar index -> 1D strings

    column_transformer = ColumnTransformer(
        transformers=[
            ("bool", "passthrough", boolean_cols),
            (
                "cat",
                OneHotEncoder(handle_unknown="ignore", sparse_output=False),
                categorical_cols,
            ),
            # combined_text is built from DOM attributes (class_name, id, data-*),
            # which mix kebab-case (hyphens) and snake_case/BEM (underscores). The
            # default token_pattern treats "_" as a word char, so "prompt_textarea"
            # would stay one token and hide the keyword "prompt". Override it to
            # split on every non-alphanumeric char (underscores included).
            #
            # NOTE: no "(?u)" inline flag - skl2onnx maps token_pattern onto ONNX's
            # Tokenizer op (RE2), which rejects Perl-style inline flags. The pattern
            # is pure ASCII and uses no \w/\b, so the flag is unnecessary and Python
            # tokenization is identical without it.
            (
                "text",
                TfidfVectorizer(min_df=min_df, max_df=max_df, token_pattern=r"[a-zA-Z0-9]{2,}"),
                text_col,
            ),
        ]
    )

    return Pipeline(
        steps=[
            ("features", column_transformer),
            ("clf", LogisticRegression(max_iter=1000)),
        ]
    )
