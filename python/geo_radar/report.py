"""Report rendering — the deliverable half of the radar.

Two shapes come from the same data:

``render_scan_summary``
    the short digest printed after a scan
``render_report``
    the daily / weekly Markdown a CMO can read as-is

Both state the measurement window and the known limits, because a proxy signal
must never be reported as if it were AI share.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Iterable

from .alerts import render_alerts_markdown, summarize_alerts
from .baseline import compute_metrics
from .calendar import render_calendar_markdown
from .sov import render_sov_markdown
from .store import unique_by_title
from .topics import render_topics_markdown

__all__ = [
    "cluster_volume",
    "count_topics",
    "demote_headings",
    "render_report",
    "render_scan_summary",
    "unique_by_title",
]


def _rate(value: Any) -> str:
    return "—" if value is None else f"{value}%"


def count_topics(cards: Iterable[dict[str, Any]]) -> dict[str, int]:
    counts = {"P0": 0, "P1": 0, "P2": 0}
    for card in cards:
        priority = card.get("priority")
        if priority in counts:
            counts[priority] += 1
    return counts


def cluster_volume(cards: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Cluster volume, used to mark calendar windows as hot."""
    volume: dict[str, int] = {}
    for card in cards:
        cluster_id = card.get("clusterId")
        if not cluster_id:
            continue
        volume[cluster_id] = volume.get(cluster_id, 0) + 1
    return sorted(
        ({"clusterId": key, "count": value} for key, value in volume.items()),
        key=lambda entry: -entry["count"],
    )


_HEADING = re.compile(r"^#{1,4}\s")


def demote_headings(markdown: str) -> str:
    """Push embedded section headings two levels down under the report's own."""
    return "\n".join(f"#{line}" if _HEADING.match(line) else line for line in str(markdown or "").split("\n"))


def render_scan_summary(
    *,
    snapshot: dict[str, Any],
    topics: list[dict[str, Any]],
    alerts: list[dict[str, Any]],
    sov: dict[str, Any],
    calendar: dict[str, Any],
    platforms: Iterable[dict[str, Any]],
) -> str:
    """Short digest printed after a scan."""
    lines: list[str] = []
    topic_counts = count_topics(topics)
    alert_summary = summarize_alerts(alerts)
    lines.append(f"## GEO 雷达扫描 · {snapshot['scannedAt'][:16].replace('T', ' ')}")
    lines.append("")
    lines.append(f"- 采集：{snapshot['platformOk']}/{snapshot['platformTotal']} 个平台成功，共 {snapshot['items']} 条热榜，命中相关 {snapshot['matched']} 条")
    if snapshot.get("candidates"):
        lines.append(f"- 候选问题：{snapshot['candidates']} 条（客服 / 站内搜索 / 竞品动态，绕过热榜锚点闸门）")
    if snapshot.get("errors"):
        shown = "；".join(f"{entry['name']}（{entry['message']}）" for entry in snapshot["errors"][:3])
        extra = f" 等 {len(snapshot['errors'])} 个平台" if len(snapshot["errors"]) > 3 else ""
        lines.append(f"- 失败平台：{shown}{extra}")
    lines.append(f"- 选题卡：{len(topics)} 张（P0 {topic_counts['P0']} / P1 {topic_counts['P1']} / P2 {topic_counts['P2']}）")
    lines.append(f"- 风险预警：{alert_summary['total']} 条（高 {alert_summary['high']} / 中 {alert_summary['medium']} / 低 {alert_summary['low']}）")
    self_entry = (sov or {}).get("self") or {}
    leader = (sov or {}).get("leader") or None
    tail = "" if leader is None else f"；最高竞品 {leader['name']} {_rate(leader['share'])}"
    lines.append(f"- 声量：方里近 {sov['window']['days']} 天公开热榜提及 {self_entry.get('mentions', 0)} 次，份额 {_rate(self_entry.get('share'))}{tail}")
    if calendar.get("current"):
        lines.append(f"- 节点：当前处于「{'、'.join(node['theme'] for node in calendar['current'])}」窗口")
    lines.append("")
    if topics:
        lines.append("### 优先处理")
        for card in topics[:5]:
            lines.append(f"{card['id']} · {card['priority']} · {card['cluster']} · {card['question']}（{card['source']['platform']} 第 {card['source']['rank']} 位，{card['score']} 分）")
        lines.append("")
    if alerts:
        lines.append("### 需要今天看一眼")
        for alert in alerts[:4]:
            lines.append(f"[{alert['levelLabel']}] {alert['rule']}：{alert['title']}")
        lines.append("")
    platform_list = "、".join(f"{entry['name']} {entry['accepted']}" for entry in platforms)
    lines.append(f"平台明细：{platform_list}")
    return "\n".join(lines)


def render_report(
    *,
    period: str = "daily",
    moment: datetime | None = None,
    snapshot: dict[str, Any],
    topics: Iterable[dict[str, Any]] = (),
    alerts: Iterable[dict[str, Any]] = (),
    sov: dict[str, Any] | None = None,
    calendar: dict[str, Any] | None = None,
    audit: dict[str, Any] | None = None,
    history: Iterable[dict[str, Any]] = (),
) -> str:
    """Full daily / weekly report."""
    topics = list(topics)
    alerts = list(alerts)
    history = list(history)
    moment = moment or datetime.now()
    metrics = None if audit is None else compute_metrics(audit)
    topic_counts = count_topics(topics)
    alert_summary = summarize_alerts(alerts)
    stamp = f"{moment:%Y-%m-%d}"
    title = f"方里 GEO 周报 · {stamp}" if period == "weekly" else f"方里 GEO 日报 · {stamp}"
    lines = [f"# {title}", ""]

    lines.append("## 一屏结论")
    lines.append(f"- 公开热榜命中 {snapshot['matched']} 条，产出 {len(topics)} 张选题卡（P0 {topic_counts['P0']} 张）")
    lines.append(f"- 风险信号 {alert_summary['total']} 条，其中高危 {alert_summary['high']} 条")
    self_entry = (sov or {}).get("self") if sov else None
    share = _rate(self_entry.get("share") if self_entry else None)
    window_days = sov["window"]["days"] if sov else 0
    mention_note = "" if not self_entry else f"，{self_entry['mentions']} 次提及"
    lines.append(f"- 方里公开声量份额 {share}（近 {window_days} 天{mention_note}）")
    if metrics is not None:
        lines.append(f"- T0 基线进度 {metrics['audited']}/{metrics['total']}，提及率 {_rate(metrics['mentionRate'])}，首选率 {_rate(metrics['firstChoiceRate'])}")
    else:
        lines.append("- T0 基线尚未建立，先用 `baseline init` 生成采集网格")
    if sov and sov["window"].get("scans") is not None and sov["window"]["scans"] <= 1:
        lines.append("- 注意：当前窗口只覆盖一次扫描，环比数据还不具备可比性")
    lines.append("")

    lines.append("## 二、选题卡")
    lines.append(demote_headings(render_topics_markdown(topics, {
        "date": stamp,
        "scannedAt": snapshot["scannedAt"][:16].replace("T", " "),
        "sources": snapshot.get("sources"),
    })))
    lines.append("")

    lines.append("## 三、风险预警")
    lines.append(demote_headings(render_alerts_markdown(alerts, {"date": stamp})))
    lines.append("")

    if sov is not None:
        lines.append("## 四、竞品声量")
        lines.append(demote_headings(render_sov_markdown(sov)))
        lines.append("")

    if calendar is not None:
        lines.append("## 五、公关日历")
        lines.append(demote_headings(render_calendar_markdown(calendar)))
        lines.append("")

    if metrics is not None:
        lines.append("## 六、基线审计")
        lines.append(f"- 已采集 {metrics['audited']} / {metrics['total']}（{_rate(metrics['coverage'])}）")
        lines.append(
            f"- 提及率 {_rate(metrics['mentionRate'])}｜首选率 {_rate(metrics['firstChoiceRate'])}"
            f"｜引用率 {_rate(metrics['citationRate'])}｜事实准确率 {_rate(metrics['factAccuracy'])}"
            f"｜负面 {_rate(metrics['negativeRate'])}"
        )
        if metrics["byEngine"]:
            joined = "；".join(f"{entry['label']} {_rate(entry['mentionRate'])}" for entry in metrics["byEngine"])
            lines.append(f"- 分引擎提及率：{joined}")
        lines.append("")

    if history:
        lines.append("## 七、近几次扫描")
        for entry in history[:5]:
            moment_text = str(entry.get("scannedAt") or "")[:16].replace("T", " ")
            lines.append(f"- {moment_text}：热榜 {entry.get('items', 0)} 条，命中 {entry.get('matched', 0)} 条，失败 {entry.get('errors', 0)} 个平台")
        lines.append("")

    lines.append("## 口径与限制")
    lines.append("- 「声量份额」是公开热榜提及占比，是 AI 声量份额的公开信号代理，不是 AI 答案里的份额。")
    lines.append("- 「提及率 / 首选率 / 引用率 / 事实准确率」只在基线录入答案后才有值，且以人工核查为准。")
    lines.append("- 热榜为各平台公开榜单，不含付费投放数据；链接与标题按采集时点快照，可能已变化。")
    lines.append("- 选题卡为规则初筛，优先级与证据缺口需内容策略确认后再进入起草车间。")
    return "\n".join(lines).rstrip()
