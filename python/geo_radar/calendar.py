"""PR-calendar coupling.

The calendar fixes a year of nodes, but a node only becomes a GEO window if
questions about it are being asked right now. This module reports where today
sits on that calendar, which node opens next, and what to draft for it.
"""

from __future__ import annotations

import math
from datetime import date as Date, datetime
from typing import Any, Iterable

from .lexicon import CALENDAR, CLUSTER_BY_ID

DAY_MS = 24 * 60 * 60 * 1000


def _days_until_month_start(current: Date, month: int) -> int:
    year = current.year if current.month <= month else current.year + 1
    target = Date(year, month, 1)
    diff_ms = (target - current).days * DAY_MS
    return math.floor(diff_ms / DAY_MS + 0.5)


def calendar_status(moment: datetime | None = None, *, horizon_days: int = 60) -> dict[str, Any]:
    moment = moment or datetime.now()
    today = moment.date()
    month = today.month
    current = [node for node in CALENDAR if month in node["months"]]

    upcoming: list[dict[str, Any]] = []
    for node in CALENDAR:
        if month in node["months"]:
            continue
        soonest = min(
            ({"month": node_month, "days": _days_until_month_start(today, node_month)} for node_month in node["months"]),
            key=lambda entry: entry["days"],
            default=None,
        )
        if soonest is None or soonest["days"] > horizon_days:
            continue
        upcoming.append({
            "id": node["id"],
            "theme": node["theme"],
            "content": node["content"],
            "engines": node["engines"],
            "months": node["months"],
            "startsInDays": soonest["days"],
        })
    upcoming.sort(key=lambda entry: entry["startsInDays"])

    nodes = [
        *(
            {
                "id": node["id"],
                "theme": node["theme"],
                "content": node["content"],
                "engines": node["engines"],
                "clusters": [CLUSTER_BY_ID.get(cluster_id, {}).get("name", cluster_id) for cluster_id in node["clusters"]],
                "phase": "current",
                "startsInDays": 0,
            }
            for node in current
        ),
        *({**node, "phase": "upcoming"} for node in upcoming),
    ]

    return {
        "today": f"{today:%Y-%m-%d}",
        "month": month,
        "current": [node for node in nodes if node["phase"] == "current"],
        "upcoming": [node for node in nodes if node["phase"] == "upcoming"],
        "nodes": nodes,
    }


def annotate_calendar(status: dict[str, Any], cluster_volume: Iterable[dict[str, Any]] = ()) -> dict[str, Any]:
    """Mark each node as hot when recent scans contain its clusters."""
    volume = {entry["clusterId"]: entry["count"] for entry in cluster_volume}

    def volume_of(cluster_id: str) -> int:
        return volume.get(cluster_id, 0)

    nodes = []
    for node in status["nodes"]:
        clusters = node.get("clusters") or []
        hot = False
        for name in clusters:
            entry = next((value for value in CLUSTER_BY_ID.values() if value["name"] == name), None)
            if entry is not None and volume_of(entry["id"]) > 0:
                hot = True
                break
        nodes.append({**node, "hot": hot})
    return {**status, "nodes": nodes}


def render_calendar_markdown(status: dict[str, Any]) -> str:
    lines = [f"# 公关日历窗口 · {status['today']}", ""]
    if not status["current"]:
        lines.append("当前月份没有固定节点；按常态节奏做周更答案资产与月度复测。")
    else:
        lines.append("## 进行中的节点")
        for node in status["current"]:
            lines.append(f"- **{node['theme']}**：{node['content']}")
            clusters = "、".join(node.get("clusters") or [])
            hot = "　🔥 热榜已有对应讨论" if node.get("hot") is True else ""
            lines.append(f"  - 重点引擎：{'、'.join(node['engines'])}　关联内容簇：{clusters}{hot}")
    lines.append("")
    if not status["upcoming"]:
        lines.append("未来 60 天没有日历节点需要提前准备。")
    else:
        lines.append("## 即将开启")
        for node in status["upcoming"]:
            lines.append(f"- **{node['theme']}**（{node['startsInDays']} 天后）：{node['content']}")
            lines.append(f"  - 重点引擎：{'、'.join(node['engines'])}")
    return "\n".join(lines).rstrip()
