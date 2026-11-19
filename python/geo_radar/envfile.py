"""Minimal ``.env`` reader for database credentials.

Deliberately small, so a credentials file behaves the same way on every machine
and nothing is ever expanded or executed:

* one ``KEY=VALUE`` per line, ``#`` starts a comment, ``export `` is ignored
* matching single or double quotes are stripped; ``\\n`` and ``\\"`` unescape
  only inside double quotes
* blank values are kept as empty strings, malformed lines are reported
* no variable interpolation — a password containing ``${...}`` stays literal

Precedence lives in :func:`resolve_password`: the process environment wins over
the file, and the file wins over a plaintext value in the plugin config.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

_FILE_CACHE: dict[tuple[str, int, float], dict[str, Any]] = {}

_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_QUOTED_RE = re.compile(r"^(['\"])([\s\S]*)\1$")


def parse_dotenv(text: Any) -> tuple[dict[str, str], list[str]]:
    """Parse ``.env`` text; returns ``(values, errors)``."""
    values: dict[str, str] = {}
    errors: list[str] = []
    for index, raw_line in enumerate(str(text or "").splitlines()):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        body = line[7:].strip() if line.startswith("export ") else line
        separator = body.find("=")
        if separator <= 0:
            errors.append(f"第 {index + 1} 行不是 KEY=VALUE：{line[:40]}")
            continue
        key = body[:separator].strip()
        value = body[separator + 1:].strip()
        if not _KEY_RE.match(key):
            errors.append(f"第 {index + 1} 行变量名非法：{key[:40]}")
            continue
        quoted = _QUOTED_RE.match(value)
        if quoted:
            value = quoted.group(2)
            if quoted.group(1) == '"':
                value = value.replace("\\n", "\n").replace('\\"', '"')
        elif " #" in value:
            value = value[: value.find(" #")].strip()
        values[key] = value
    return values, errors


def read_env_file(file: str | Path | None) -> dict[str, Any]:
    """Read and parse a ``.env`` file; a missing file is not an error."""
    if file is None:
        return {"exists": False, "values": {}, "errors": [], "path": None}
    path = Path(file)
    try:
        info = path.stat()
    except OSError:
        return {"exists": False, "values": {}, "errors": [], "path": str(path)}
    key = (str(path), info.st_size, info.st_mtime)
    cached = _FILE_CACHE.get(key)
    if cached is not None:
        return cached
    try:
        values, errors = parse_dotenv(path.read_text(encoding="utf-8"))
        result = {"exists": True, "values": values, "errors": errors, "path": str(path)}
        _FILE_CACHE.clear()
        _FILE_CACHE[key] = result
        return result
    except OSError as error:
        return {"exists": True, "values": {}, "errors": [f"读取失败：{error}"], "path": str(path)}


def clear_env_cache() -> None:
    """Clear the parsed-file cache (tests and manual reloads)."""
    _FILE_CACHE.clear()


def default_password_variable(instance_label: str | None) -> str:
    """Default variable name for an instance, e.g. ``GEO_EVIDENCE_PASSWORD``."""
    cleaned = re.sub(r"[^A-Z0-9]+", "_", str(instance_label or "db").upper())
    return f"GEO_{cleaned}_PASSWORD"


def resolve_password(
    config: dict[str, Any] | None,
    instance_label: str,
    *,
    env: dict[str, str] | None = None,
    env_file: str | Path | None = None,
) -> dict[str, Any]:
    """Resolve one instance password.

    Order: ``passwordEnv`` (or ``password: env:NAME``) → process environment →
    ``.env`` file → a literal ``password`` in config, accepted for backwards
    compatibility and reported as plaintext.
    """
    env = os.environ if env is None else env
    raw = config if isinstance(config, dict) else {}
    explicit = raw.get("passwordEnv").strip() if isinstance(raw.get("passwordEnv"), str) else ""
    config_password = raw.get("password") if isinstance(raw.get("password"), str) else ""
    prefixed = config_password[4:].strip() if config_password.startswith("env:") else ""
    variable = explicit or prefixed or default_password_variable(instance_label)

    from_process = env.get(variable) if env else None
    if isinstance(from_process, str) and from_process:
        return {"value": from_process, "source": "environment", "variable": variable, "warning": None}

    file_values = read_env_file(env_file)
    from_file = file_values["values"].get(variable)
    if isinstance(from_file, str) and from_file:
        return {"value": from_file, "source": "env-file", "variable": variable, "warning": None}

    if config_password and not prefixed:
        return {
            "value": config_password,
            "source": "config-plaintext",
            "variable": None,
            "warning": f"口令写在插件 config 里（明文）。建议改用 {variable}，写在 .env 或环境变量中。",
        }

    where = ".env 或环境变量" if env_file is None else f"{env_file} 或环境变量"
    return {"value": "", "source": "none", "variable": variable, "warning": f"未找到口令：请在 {where} 中设置 {variable}"}


def env_template() -> str:
    """The ``.env`` lines a user can copy, with names only."""
    return "\n".join([
        "# 数据库口令。放到 .env 里，或直接配成真实环境变量（环境变量优先）。",
        "# 该文件不要提交到仓库。",
        "GEO_EVIDENCE_PASSWORD=",
        "GEO_PRODUCT_PASSWORD=",
    ])
