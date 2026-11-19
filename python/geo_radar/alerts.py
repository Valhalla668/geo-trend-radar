"""Risk alerts — the monitoring half of the risk register and the pre-publish gate.

An alert is raised only from vocabulary that actually fired on a public
hot-list title, so every row traces back to its source item. The mitigation text
is the one the risk register assigns, so the board is actionable without a second
analysis pass.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Iterable

from .lexicon import RISK_RULE_BY_MATCH
from .store import iso_now

LEVEL_WEIGHT = {"high": 3, "medium": 2, "low": 1}
LEVEL_LABEL = {"high": "高", "medium": "中", "low": "低"}

ENTITY_ERROR_PATTERN = re.compile(r"成立|哪年|哪一年|公司|主体|母公司|股权|法人|收购|备案号|真假|官方|微商|山寨", re.IGNORECASE)
#: A trending question such as 「方里是哪个公司」 is a demand signal, not an error.
ERROR_ASSERTION = re.compile(r"写错|说错|弄错|认错|错误|不实|谣言|辟谣|混淆|张冠李戴|其实是|竟然是|冒充|假冒|山寨|自称", re.IGNORECASE)
PLATFORM_SHIFT_PATTERN = re.compile(r"算法|改版|入口|下线|新功能|公测|灰度|封禁|限流", re.IGNORECASE)
BEAUTY_CONTEXT = re.compile(r"粉底|粉饼|底妆|散粉|蜜粉|遮瑕|定妆|妆前|气垫|彩妆|护肤|敏感肌|油皮|干皮", re.IGNORECASE)


def alert_candidates(item: dict[str, Any]) -> list[dict[str, Any]]:
    """Classify one scored item into zero or more alert candidates."""
    haystack = f"{item.get('title') or ''} {item.get('summary') or ''}"
    found: list[dict[str, Any]] = []
    negative = item.get("negative") or []
    compliance = item.get("compliance") or {"absolute": [], "medical": [], "special": []}
    mentions_brand = bool((item.get("entities") or {}).get("mentionsEntity"))
    competitor_actions = [
        entry for entry in ((item.get("entities") or {}).get("competitors") or []) if entry.get("actions")
    ]

    if negative and mentions_brand:
        found.append({
            "match": "negative-brand",
            "terms": negative,
            "severity": "high" if len(negative) >= 2 else "medium",
            "note": "负面词与方里同现，按「竞品恶意投毒 / 负面聚合」处置：先核实，再评估扩散面。",
        })
    elif negative:
        found.append({
            "match": "negative-any",
            "terms": negative,
            "severity": "low",
            "note": "行业负面词命中，未直接点名方里；纳入观察，不单独对外回应。",
        })

    if mentions_brand and ENTITY_ERROR_PATTERN.search(haystack) and ERROR_ASSERTION.search(haystack):
        found.append({
            "match": "entity-error",
            "terms": ["实体一致性"],
            "severity": "high",
            "note": "涉及主体/成立时间/股权口径，是 AI 最易答错的 L1 问题；用权威页与百科口径 48 小时内对齐。",
        })

    claim_terms = [*compliance.get("medical", []), *compliance.get("special", [])]
    absolute = compliance.get("absolute", [])
    if claim_terms or (absolute and BEAUTY_CONTEXT.search(haystack)):
        found.append({
            "match": "forbidden-claim",
            "terms": [*claim_terms, *absolute],
            "severity": "high" if compliance.get("medical") else "medium",
            "note": "命中宣称红线（医疗术语 / 特殊功效 / 绝对化）。对外内容不得复用该表述，先过法务。",
        })

    if competitor_actions:
        found.append({
            "match": "competitor-action",
            "terms": [action for entry in competitor_actions for action in entry["actions"]],
            "severity": "medium" if len(competitor_actions) >= 2 else "low",
            "note": "竞品有公开动作，评估是否抢占引用池；必要时补一条对比型答案。",
        })

    if PLATFORM_SHIFT_PATTERN.search(haystack):
        found.append({
            "match": "platform-shift",
            "terms": ["平台变化"],
            "severity": "low",
            "note": "平台入口或算法信号；记录到季度重估清单，不单独行动。",
        })

    return found


def build_alerts(
    items: Iterable[dict[str, Any]],
    *,
    moment: datetime | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Expand candidates into alerts carrying the register's mitigation."""
    moment = moment or datetime.now()
    stamp = f"{moment:%Y%m%d}"
    alerts: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        for candidate in alert_candidates(item):
            rule = RISK_RULE_BY_MATCH.get(candidate["match"])
            if rule is None:
                continue
            key = f"{rule['id']}:{item.get('platform')}:{item.get('title')}"
            if key in seen:
                continue
            seen.add(key)
            terms = list(dict.fromkeys(candidate["terms"]))[:8]
            clusters = item.get("clusters") or []
            alerts.append({
                "id": f"GA-{stamp}-{len(alerts) + 1:03d}",
                "ruleId": rule["id"],
                "rule": rule["name"],
                "level": candidate["severity"],
                "levelLabel": LEVEL_LABEL.get(candidate["severity"], "低"),
                "owner": rule["owner"],
                "mitigation": rule["mitigation"],
                "note": candidate["note"],
                "terms": terms,
                "title": item.get("title"),
                "url": item.get("url") or "",
                "platform": item.get("platformName") or item.get("platform"),
                "rank": item.get("rank"),
                "hot": item.get("hot") or "",
                "cluster": (item.get("cluster") or {}).get("name", ""),
                "detectedAt": iso_now(),
                "evidence": f"同现词：{'、'.join((clusters[0].get('cues') or [])[:4])}" if clusters else "",
            })
    alerts.sort(key=lambda alert: (
        -LEVEL_WEIGHT.get(alert["level"], 0),
        alert["rank"] if isinstance(alert["rank"], int) else 99,
    ))
    return alerts[:limit]


def summarize_alerts(alerts: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """One-line summary used by status and report headers."""
    counts = {"high": 0, "medium": 0, "low": 0}
    rules: list[str] = []
    total = 0
    for alert in alerts:
        total += 1
        if alert["level"] in counts:
            counts[alert["level"]] += 1
        if alert["rule"] not in rules:
            rules.append(alert["rule"])
    return {"total": total, **counts, "rules": rules}


def render_alerts_markdown(alerts: Iterable[dict[str, Any]], meta: dict[str, Any] | None = None) -> str:
    """Render alerts as Markdown."""
    meta = meta or {}
    alerts = list(alerts)
    summary = summarize_alerts(alerts)
    stamp = meta.get("date") or datetime.now().strftime("%Y-%m-%d")
    lines = [f"# GEO 风险预警 · {stamp}", ""]
    lines.append(f"共 {summary['total']} 条：高 {summary['high']} / 中 {summary['medium']} / 低 {summary['low']}。")
    lines.append("")
    if not alerts:
        lines.append("本次扫描未触发负面或合规信号。风险为空不等于没有风险：竞品投毒与错误信息常先从长尾问题出现。")
        return "\n".join(lines)
    for alert in alerts:
        lines.append(f"## [{alert['levelLabel']}] {alert['rule']} · {alert['title']}")
        lines.append(f"- 编号：{alert['id']}　责任人：{alert['owner']}　来源：{alert['platform']} 第 {alert['rank']} 位")
        if alert["url"]:
            lines.append(f"- 原帖：{alert['url']}")
        lines.append(f"- 命中词：{'、'.join(alert['terms'])}")
        lines.append(f"- 处置：{alert['mitigation']}")
        lines.append(f"- 说明：{alert['note']}")
        lines.append("")
    return "\n".join(lines).rstrip()
