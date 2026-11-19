"""Share of voice — the public-signal proxy for AI 声量份额.

The plan measures SOV on AI answers, which needs the baseline audit; this module
measures the adjacent public signal instead: how often each brand appears in the
hot lists the engines are trained on and cite. Each snapshot stores a compact
mention summary so SOV history stays cheap to aggregate.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from ._numeric import round_1k
from .lexicon import COMPETITORS, ENTITY
from .store import parse_iso

PLATFORM_CAP = 8
ITEM_CAP = 5

SOV_BRANDS: list[dict[str, Any]] = [
    {"id": "fangli", "name": ENTITY["brand"], "aliases": ENTITY["brandAliases"], "self": True},
    *({"id": entry["id"], "name": entry["name"], "aliases": entry["aliases"], "self": False} for entry in COMPETITORS),
]


def compute_mentions(items: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Count brand mentions across the raw items of one scan."""
    brands: list[dict[str, Any]] = [
        {"id": brand["id"], "name": brand["name"], "self": brand["self"], "mentions": 0, "byPlatform": {}, "topItems": []}
        for brand in SOV_BRANDS
    ]
    index = {entry["id"]: entry for entry in brands}
    items = list(items)
    for item in items:
        haystack = f"{item.get('title') or ''} {item.get('summary') or ''}"
        for brand in SOV_BRANDS:
            if not any(alias in haystack for alias in brand["aliases"]):
                continue
            entry = index[brand["id"]]
            entry["mentions"] += 1
            platform = item.get("platformName") or item.get("platform") or "未知"
            entry["byPlatform"][platform] = entry["byPlatform"].get(platform, 0) + 1
            if len(entry["topItems"]) < ITEM_CAP:
                entry["topItems"].append({
                    "title": item.get("title"),
                    "platform": platform,
                    "rank": item.get("rank"),
                    "url": item.get("url") or "",
                })
    platforms = list(dict.fromkeys(item.get("platformName") or item.get("platform") for item in items))
    return {
        "totalItems": len(items),
        "totalMentions": sum(entry["mentions"] for entry in brands),
        "brands": [entry for entry in brands if entry["mentions"] > 0],
        "platforms": platforms[:PLATFORM_CAP],
    }


def _within(value: Any, start_ms: float, end_ms: float) -> bool:
    moment = parse_iso(value)
    if moment is None:
        return False
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    stamp = moment.timestamp() * 1000.0
    return start_ms <= stamp < end_ms


def build_sov(
    snapshots: Iterable[dict[str, Any]],
    *,
    days: int = 7,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Aggregate SOV over a window and compare with the preceding window."""
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.astimezone()
    window = timedelta(days=max(1, days))
    end = now
    start = end - window
    previous_start = start - window

    snapshots = list(snapshots)
    current = [s for s in snapshots if isinstance(s.get("mentions"), dict) and _within(s.get("scannedAt"), start.timestamp() * 1000, end.timestamp() * 1000)]
    previous = [s for s in snapshots if isinstance(s.get("mentions"), dict) and _within(s.get("scannedAt"), previous_start.timestamp() * 1000, start.timestamp() * 1000)]

    def fold(rows: list[dict[str, Any]]) -> dict[str, Any]:
        totals: dict[str, int] = {}
        by_platform: dict[str, dict[str, int]] = {}
        scans = 0
        items = 0
        for snapshot in rows:
            scans += 1
            items += snapshot["mentions"].get("totalItems") or 0
            for brand in snapshot["mentions"].get("brands") or []:
                totals[brand["id"]] = totals.get(brand["id"], 0) + (brand.get("mentions") or 0)
                per = by_platform.setdefault(brand["id"], {})
                for platform, count in (brand.get("byPlatform") or {}).items():
                    per[platform] = per.get(platform, 0) + count
        return {
            "totals": totals,
            "byPlatform": by_platform,
            "mentionTotal": sum(totals.values()),
            "scans": scans,
            "items": items,
        }

    now_fold = fold(current)
    prev_fold = fold(previous)

    brand_ids = list(dict.fromkeys([*now_fold["totals"], *prev_fold["totals"]]))
    brands: list[dict[str, Any]] = []
    for brand_id in brand_ids:
        definition = next((entry for entry in SOV_BRANDS if entry["id"] == brand_id), None)
        mentions = now_fold["totals"].get(brand_id, 0)
        previous_mentions = prev_fold["totals"].get(brand_id, 0)
        share = 0.0 if now_fold["mentionTotal"] == 0 else mentions / now_fold["mentionTotal"]
        previous_share = 0.0 if prev_fold["mentionTotal"] == 0 else previous_mentions / prev_fold["mentionTotal"]
        brands.append({
            "id": brand_id,
            "name": definition["name"] if definition else brand_id,
            "self": bool(definition and definition["self"]),
            "mentions": mentions,
            "share": round_1k(share),
            "previousMentions": previous_mentions,
            "previousShare": round_1k(previous_share),
            "deltaPoints": round_1k(share - previous_share),
            "byPlatform": now_fold["byPlatform"].get(brand_id, {}),
        })
    brands.sort(key=lambda entry: -entry["mentions"])

    leader = next((entry for entry in brands if not entry["self"] and entry["mentions"] > 0), None)
    self_entry = next((entry for entry in brands if entry["self"]), None)
    return {
        "window": {
            "days": days,
            "from": _iso(start),
            "to": _iso(end),
            "previousFrom": _iso(previous_start),
            "scans": now_fold["scans"],
            "previousScans": prev_fold["scans"],
            "items": now_fold["items"],
            "mentionTotal": now_fold["mentionTotal"],
        },
        "brands": brands,
        "self": self_entry,
        "leader": leader,
        "gap": round_1k(leader["share"] - self_entry["share"]) if (self_entry and leader) else None,
    }


def _iso(moment: datetime) -> str:
    utc = moment.astimezone(timezone.utc)
    return f"{utc:%Y-%m-%dT%H:%M:%S}.{utc.microsecond // 1000:03d}Z"


def render_sov_markdown(sov: dict[str, Any]) -> str:
    """Markdown rendering for the report and the dashboard."""
    window = sov["window"]
    begin = str(window.get("from") or "")[:10]
    end = str(window.get("to") or "")[:10]
    lines = [f"# 竞品声量 SOV · 近 {window['days']} 天", ""]
    lines.append(f"数据窗口：{begin or '—'} → {end or '—'}　扫描 {window['scans']} 次，覆盖 {window['items']} 条热榜条目")
    lines.append("")
    if window["scans"] == 0:
        lines.append("窗口内还没有扫描记录。先运行 `scan` 建立基线，SOV 才有分母。")
        return "\n".join(lines)
    if not sov["brands"]:
        lines.append(f"窗口内 {window['items']} 条热榜条目里没有出现任何被监测品牌的名称。")
        lines.append("")
        lines.append("SOV 为空不等于没有竞争：公开热榜是低频信号，方里与同价位竞品本来就不常上榜。要判断真实的引用份额，看基线审计的提及率与首选率。")
        return "\n".join(lines)
    lines.append("| 品牌 | 提及 | 份额 | 环比 | 主要平台 |")
    lines.append("| --- | --- | --- | --- | --- |")
    for brand in sov["brands"]:
        platforms = "、".join(
            f"{platform} {count}"
            for platform, count in sorted(brand["byPlatform"].items(), key=lambda entry: -entry[1])[:3]
        )
        delta = "—" if brand["deltaPoints"] == 0 else f"{'+' if brand['deltaPoints'] > 0 else ''}{brand['deltaPoints']}pp"
        label = f"{brand['name']}（本方）" if brand["self"] else brand["name"]
        lines.append(f"| {label} | {brand['mentions']} | {brand['share']}% | {delta} | {platforms or '—'} |")
    lines.append("")
    if sov["gap"] is not None:
        lines.append(f"与声量最高竞品差距：{sov['gap']} 个百分点。")
    lines.append("")
    lines.append("口径说明：SOV 在这里是「公开热榜提及份额」，是 AI 声量份额的公开信号代理，不等同于 AI 答案里的份额；真实份额以基线审计为准。")
    return "\n".join(lines).rstrip()
