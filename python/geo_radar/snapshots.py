"""Scan-snapshot persistence.

A snapshot keeps the annotated hits plus the compact mention summary, so topic
boards, alerts and SOV can be rebuilt without touching the network again.
``matched`` stays an integer for display; the payload lives in ``matchedItems``,
and both implementations agree on that shape.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .store import ensure_dir, list_files, read_json, write_json

#: Upper bound on annotated items kept per snapshot.
MAX_STORED_ITEMS = 200

_COMPACT_FIELDS = (
    "platform",
    "platformName",
    "rank",
    "title",
    "url",
    "hot",
    "score",
    "priority",
    "cluster",
    "clusters",
    "product",
    "format",
    "entities",
    "negative",
    "compliance",
    "riskScore",
    "evidenceGap",
    "reasons",
    "scannedAt",
)


def compact_item(item: dict[str, Any]) -> dict[str, Any]:
    """Trim one annotated item to the fields the boards and reports need."""
    return {field: item.get(field) for field in _COMPACT_FIELDS}


def save_snapshot(paths: dict[str, Path], snapshot: dict[str, Any], keep: int = 60) -> Path:
    """Persist a scan, point ``latest.json`` at it, and prune old snapshots."""
    file = paths["snapshots"] / f"{snapshot['id']}.json"
    write_json(file, snapshot)
    write_json(paths["latest"], {"id": snapshot["id"], "scannedAt": snapshot["scannedAt"], "file": str(file)})
    files = list_files(paths["snapshots"], lambda name: name.endswith(".json"))
    for stale in files[max(1, keep):]:
        try:
            stale.unlink()
        except OSError:
            pass
    return file


def load_snapshots(paths: dict[str, Path], limit: int = 30) -> list[dict[str, Any]]:
    """Read stored snapshots, newest first, ignoring files that are not snapshots."""
    files = list_files(paths["snapshots"], lambda name: name.endswith(".json"))
    snapshots: list[dict[str, Any]] = []
    for file in files[:limit]:
        value = read_json(file)
        if isinstance(value, dict) and isinstance(value.get("matchedItems"), list):
            snapshots.append(value)
    return snapshots


def ensure_snapshot_dir(paths: dict[str, Path]) -> Path:
    return ensure_dir(paths["snapshots"])
