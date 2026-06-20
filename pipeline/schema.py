"""Single source of truth for the feature schema.

These arrays are exported verbatim to feature_schema.json so the TypeScript
inference client can loop over the exact same keys in the exact same order,
preventing training-serving skew.
"""

import json

TARGET_KEY = "is_ai_prompt"

# Strict true/false DOM properties -> passthrough float32 (1.0/0.0).
BOOLEAN_KEYS = [
    "read_only",
    "disabled",
    "required",
    "is_content_editable",
]

# Programmatic, finite-vocabulary attributes -> one-hot encoded. These are NOT
# natural language (feeding them to TF-IDF would dilute strong deterministic
# signals), and ARIA tokens like aria-haspopup are not strict booleans.
CATEGORICAL_KEYS = [
    "tag_name",
    "type",
    "role",
    "aria_expanded",
    "aria_haspopup",
    "autocomplete",
]

# Genuinely human-readable strings -> TF-IDF.
TEXT_KEYS = [
    "id",
    "name",
    "class_name",
    "placeholder",
    "data_placeholder",
    "data_test_id",
    "data_testid",
    "aria_label",
    "aria_placeholder",
    "aria_roledescription",
    "title",
    "aria_labelledby",
    "aria_describedby",
    "aria_controls",
    "aria_errormessage",
    "aria_labelledby_text",
    "aria_describedby_text",
    "aria_controls_text",
    "aria_errormessage_text",
    "official_label_text",
    "fuzzy_parent_text",
    "button_text",
    "form_control_name",
    "dataset_attributes",
]

# Name of the synthesized column holding the joined TEXT_KEYS values.
COMBINED_TEXT_COLUMN = "combined_text"

# Keys excluded from an entry's identity hash (archive dedup). Timestamps must
# not affect identity: the same element captured at different times is a dup.
TIMESTAMP_KEYS = ["collected_at"]


def feature_schema() -> dict:
    return {
        "target_key": TARGET_KEY,
        "boolean_keys": BOOLEAN_KEYS,
        "categorical_keys": CATEGORICAL_KEYS,
        "text_keys": TEXT_KEYS,
        "combined_text_column": COMBINED_TEXT_COLUMN,
    }


def write_feature_schema(path: str) -> dict:
    schema = feature_schema()
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(schema, handle, indent=2)
    return schema
