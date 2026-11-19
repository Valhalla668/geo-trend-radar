"""Configuration and prompt-library loading.

The Python package reads a JSON config (optionally YAML when PyYAML is present)
with the same keys the DSH plugin uses, so one file can describe both. The prompt
library ships as package data and can be pointed elsewhere with ``promptsPath``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

PACKAGE_ROOT = Path(__file__).resolve().parent
DEFAULT_PROMPTS = PACKAGE_ROOT / "data" / "prompts.json"

DEFAULTS: dict[str, Any] = {
    "platforms": ["zhihu", "weibo", "douyin", "baidu", "toutiao", "bilibili-hot-search"],
    "intervalMs": 600,
    "timeoutMs": 15000,
    "sovDays": 7,
    "horizonDays": 60,
    "keepSnapshots": 60,
}


def _load_yaml(text: str) -> Any:
    try:
        import yaml  # type: ignore[import-not-found]
    except ModuleNotFoundError as error:  # pragma: no cover - depends on environment
        raise RuntimeError("配置文件是 YAML，但未安装 PyYAML：`pip install pyyaml`，或改用 JSON 配置。") from error
    return yaml.safe_load(text)


def load_config(path: str | Path | None = None) -> dict[str, Any]:
    """Load a config file; a missing file yields an empty config."""
    if path is None:
        return {}
    file = Path(path)
    if not file.exists():
        raise FileNotFoundError(f"找不到配置文件：{file}")
    text = file.read_text(encoding="utf-8")
    suffix = file.suffix.lower()
    if suffix in (".yaml", ".yml"):
        data = _load_yaml(text)
    else:
        data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("配置文件必须是一个对象")
    return data


def merged_config(config: dict[str, Any] | None = None) -> dict[str, Any]:
    """Apply defaults under a user config."""
    return {**DEFAULTS, **(config or {})}


def load_prompts(path: str | Path | None = None) -> list[dict[str, Any]]:
    """Load the prompt library; defaults to the bundled sample."""
    file = Path(path) if path is not None else DEFAULT_PROMPTS
    if not file.exists():
        raise FileNotFoundError(f"找不到提示词库：{file}")
    data = json.loads(file.read_text(encoding="utf-8"))
    prompts = data.get("prompts") if isinstance(data, dict) else data
    if not isinstance(prompts, list):
        raise ValueError("提示词库必须包含一个 prompts 数组")
    return [prompt for prompt in prompts if isinstance(prompt, dict) and prompt.get("id") and prompt.get("prompt")]


def prompts_from(config: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Resolve the prompt library from config, falling back to package data."""
    configured = (config or {}).get("promptsPath")
    return load_prompts(configured if isinstance(configured, str) and configured.strip() else None)
