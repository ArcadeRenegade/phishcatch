"""Persistent, deduplicated training-data archive.

`dataset_archive.json` is committed to git and accumulates every labeled raw
entry over the lifetime of the model. When a fresh `dataset.json` is downloaded
from the extension, `ingest()` appends only the genuinely new entries.

Dedup is content-based: each entry is hashed by its canonical JSON with timestamp
keys removed, so the same DOM element captured at different times is treated as a
duplicate. A labeled-data guard rejects any entry whose `is_ai_prompt` is null.
"""

import hashlib
import json
import os

from .schema import TARGET_KEY, TIMESTAMP_KEYS


def entry_hash(entry: dict) -> str:
    """Stable content hash of an entry, ignoring timestamp keys."""
    filtered = {k: v for k, v in entry.items() if k not in TIMESTAMP_KEYS}
    canonical = json.dumps(filtered, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def load_json_array(path: str) -> list:
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, list):
        raise ValueError(f"{path} must contain a JSON array of entries.")
    return data


def assert_all_labeled(entries: list, source: str) -> None:
    """Raise if any entry is unlabeled (is_ai_prompt null/missing)."""
    for index, entry in enumerate(entries):
        if entry.get(TARGET_KEY) is None:
            raise ValueError(
                f"Unlabeled entry at index {index} in {source}: '{TARGET_KEY}' is null/missing. "
                f"Every entry must be labeled true/false before it can be archived."
            )


def ingest(data_path: str, archive_path: str) -> list:
    """Append new (non-duplicate) labeled entries from data_path into the archive.

    Returns the full archive list. Raises if any inbound entry is unlabeled.
    """
    inbound = load_json_array(data_path)
    assert_all_labeled(inbound, data_path)

    archive = load_json_array(archive_path)
    seen = {entry_hash(entry) for entry in archive}

    added = 0
    duplicates = 0
    for entry in inbound:
        digest = entry_hash(entry)
        if digest in seen:
            duplicates += 1
            continue
        seen.add(digest)
        archive.append(entry)
        added += 1

    parent = os.path.dirname(archive_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(archive_path, "w", encoding="utf-8") as handle:
        json.dump(archive, handle, indent=2)

    print(
        f"Ingest: {len(inbound)} inbound, {added} new, {duplicates} duplicate(s) skipped; "
        f"archive now holds {len(archive)} entries."
    )
    return archive
