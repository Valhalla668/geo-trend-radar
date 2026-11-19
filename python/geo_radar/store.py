"""Filesystem helpers for the shared data directory.

The layout matches the JavaScript implementation file for file, so both
implementations can read each other's snapshots, audits and reports.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

DEFAULT_ROOT: Path = Path.home() / ".dsh" / "geo-trend-radar"


def resolve_data_root(config: dict[str, Any] | None = None) -> Path:
    """Resolve the data root from config, defaulting to the user profile."""
    configured = ""
    if isinstance(config, dict):
        value = config.get("dataDir")
        if isinstance(value, str):
            configured = value.strip()
    if not configured:
        return DEFAULT_ROOT
    path = Path(os.path.expanduser(configured))
    return path if path.is_absolute() else Path.home() / path


def layout(root: Path) -> dict[str, Path]:
    """Directory layout under the data root."""
    return {
        "root": root,
        "snapshots": root / "snapshots",
        "latest": root / "latest.json",
        "topics": root / "topics",
        "alerts": root / "alerts",
        "sov": root / "sov",
        "baseline": root / "baseline",
        "reports": root / "reports",
        "drafts": root / "drafts",
    }


def ensure_dir(target: Path) -> Path:
    target.mkdir(parents=True, exist_ok=True)
    return target


def read_json(file: Path) -> Any:
    """Read JSON, returning ``None`` for a missing or unreadable file."""
    try:
        raw = file.read_text(encoding="utf-8")
    except OSError:
        return None
    if not raw.strip():
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def write_json(file: Path, value: Any) -> Path:
    """Write JSON atomically (temp file + rename), two-space indent."""
    ensure_dir(file.parent)
    payload = json.dumps(value, ensure_ascii=False, indent=2, separators=(",", ": ")) + "\n"
    handle, temp_name = tempfile.mkstemp(dir=str(file.parent), prefix=file.name, suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(payload)
        os.replace(temp_name, file)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temp_name)
        raise
    return file


def write_text(file: Path, value: str) -> Path:
    """Write UTF-8 text atomically."""
    ensure_dir(file.parent)
    handle, temp_name = tempfile.mkstemp(dir=str(file.parent), prefix=file.name, suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(value)
        os.replace(temp_name, file)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temp_name)
        raise
    return file


def append_jsonl(file: Path, value: Any) -> Path:
    ensure_dir(file.parent)
    with file.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, ensure_ascii=False) + "\n")
    return file


def read_jsonl(file: Path) -> list[Any]:
    try:
        raw = file.read_text(encoding="utf-8")
    except OSError:
        return []
    rows: list[Any] = []
    for line in raw.splitlines():
        trimmed = line.strip()
        if not trimmed:
            continue
        try:
            rows.append(json.loads(trimmed))
        except json.JSONDecodeError:
            continue
    return rows


def list_files(directory: Path, predicate: Any = None) -> list[Path]:
    """List files newest first; a missing directory is empty rather than an error."""
    try:
        entries = [entry for entry in directory.iterdir() if entry.is_file()]
    except OSError:
        return []
    if predicate is not None:
        entries = [entry for entry in entries if predicate(entry.name)]
    entries.sort(key=lambda entry: entry.stat().st_mtime, reverse=True)
    return entries


_UNSAFE = re.compile(r'[\\/:*?"<>|\s]+')


def sanitize_id(value: Any, fallback: str = "item") -> str:
    """Make a filesystem-safe identifier."""
    cleaned = _UNSAFE.sub("-", str(value if value is not None else "").strip())
    cleaned = re.sub(r"-{2,}", "-", cleaned).strip("-")[:80]
    return cleaned or fallback


def make_stamp(moment: datetime | None = None) -> str:
    """Timestamp id such as ``20261117-2145``."""
    moment = moment or datetime.now()
    return f"{moment:%Y%m%d-%H%M}"


def local_date(moment: datetime | None = None) -> str:
    moment = moment or datetime.now()
    return f"{moment:%Y-%m-%d}"


def iso_now(moment: datetime | None = None) -> str:
    """UTC ISO-8601 with milliseconds, matching ``Date.toISOString()``."""
    moment = moment or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.astimezone()
    utc = moment.astimezone(timezone.utc)
    return f"{utc:%Y-%m-%dT%H:%M:%S}.{utc.microsecond // 1000:03d}Z"


def parse_iso(value: Any) -> datetime | None:
    """Parse an ISO timestamp; ``None`` when it is not one."""
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def epoch_ms(moment: datetime) -> float:
    return moment.timestamp() * 1000.0


def unique_by_title(items: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop repeated headlines collected across several scans of one window."""
    seen: dict[str, dict[str, Any]] = {}
    for item in items:
        key = re.sub(r"[\s\W_]+", "", str(item.get("title") or ""))
        if key not in seen:
            seen[key] = item
    return list(seen.values())
