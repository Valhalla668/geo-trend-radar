"""Baseline audit — the collection plan and its five headline metrics.

The package does not drive the six AI engines; it manages the audit a human (or a
later automation) fills in. It expands the prompt library into the full grid,
hands out batches, records answers, and computes the metrics with fixed
definitions so numbers from different rounds stay comparable.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable

from ._numeric import round_1k
from .lexicon import COMPETITORS, ENGINES, ENTITY, NEGATIVE_TERMS
from .store import iso_now

OWNED_SOURCES = ["funnyelves.com", "官网", "官方旗舰", "天猫", "京东", "抖音商城", "微信公众号", "视频号", "官方"]
AUTHORITY_SOURCES = ["新华网", "人民网", "中新网", "36氪", "36 氪", "界面新闻", "C2CC", "化妆品报", "Vogue Business", "中国化妆品学术研讨会"]

TARGETS = {"mentionRate": 55, "firstChoiceRate": 20, "citationRate": 30, "factAccuracy": 95, "negativeRate": 5}


def engines_for(prompt: dict[str, Any]) -> list[dict[str, str]]:
    """Resolve the engines one prompt must be audited on."""
    declared = str(prompt.get("engines") or "").strip()
    if not declared or "全部" in declared:
        return ENGINES
    matched = [engine for engine in ENGINES if engine["name"] in declared or engine["id"].lower() in declared.lower()]
    return matched or ENGINES


def create_audit(prompts: Iterable[dict[str, Any]], *, created_at: str | None = None) -> dict[str, Any]:
    """Expand the prompt library into one audit grid."""
    rows: list[dict[str, Any]] = []
    prompts = list(prompts)
    for prompt in prompts:
        for engine in engines_for(prompt):
            rows.append({
                "id": f"{prompt['id']}-{engine['id']}",
                "promptId": prompt["id"],
                "cluster": prompt.get("cluster") or "",
                "prompt": prompt.get("prompt") or "",
                "priority": prompt.get("priority") or "",
                "frequency": prompt.get("frequency") or "",
                "product": prompt.get("product") or "",
                "engineId": engine["id"],
                "engineName": engine["name"],
                "status": "pending",
                "answer": "",
                "flags": None,
                "factsTotal": 0,
                "factsCorrect": 0,
                "recordedAt": None,
                "note": "",
            })
    return {
        "version": 1,
        "createdAt": created_at or iso_now(),
        "brand": ENTITY["brand"],
        "promptCount": len(prompts),
        "engines": ENGINES,
        "rows": rows,
        "total": len(rows),
    }


def derive_flags(answer: Any) -> dict[str, Any]:
    """Derive the mechanical flags from a pasted answer."""
    text = str(answer or "")
    brand_mentioned = any(alias in text for alias in ENTITY["brandAliases"])
    head = text[:120]
    first_choice = brand_mentioned and any(alias in head for alias in ENTITY["brandAliases"])
    owned = [source for source in OWNED_SOURCES if source in text]
    authority = [source for source in AUTHORITY_SOURCES if source in text]
    negative = [term for term in NEGATIVE_TERMS if term in text]
    competitors = [entry["name"] for entry in COMPETITORS if any(alias in text for alias in entry["aliases"])]
    return {
        "brandMentioned": brand_mentioned,
        "firstChoice": first_choice,
        "ownedCited": owned,
        "authorityCited": authority,
        "negative": negative,
        "competitors": competitors,
    }


_PRIORITY_ORDER = {"A": 0, "B": 1, "C": 2}


def next_batch(
    audit: dict[str, Any],
    size: int = 10,
    *,
    cluster: str | None = None,
    engine: str | None = None,
    prompt_id: str | None = None,
) -> dict[str, Any]:
    """Return the next pending rows, highest priority and lowest id first."""
    pending = [
        row for row in audit["rows"]
        if row.get("status") != "done"
        and (not cluster or row.get("cluster") == cluster)
        and (not engine or row.get("engineId") == engine or row.get("engineName") == engine)
        and (not prompt_id or row.get("promptId") == prompt_id)
    ]
    pending.sort(key=lambda row: (_PRIORITY_ORDER.get(row.get("priority"), 9), row["id"]))
    return {
        "batch": pending[: max(1, size)],
        "remaining": len(pending),
        "total": audit["total"],
    }


def record_answers(
    audit: dict[str, Any],
    entries: Iterable[dict[str, Any]],
    *,
    recorded_at: str | None = None,
) -> dict[str, Any]:
    """Record answers; ``engine`` accepts the engine id or its Chinese name."""
    recorded_at = recorded_at or iso_now()
    recorded = 0
    skipped: list[dict[str, str]] = []
    rows: list[dict[str, Any]] = []
    for entry in entries:
        engine_token = str(entry.get("engine") or "").strip()
        engine = next((candidate for candidate in ENGINES if candidate["id"] == engine_token or candidate["name"] == engine_token), None)
        prompt_id = str(entry.get("promptId") or "").strip()
        if engine is None:
            skipped.append({"promptId": prompt_id, "engine": engine_token, "reason": "未知引擎"})
            continue
        row = next((candidate for candidate in audit["rows"] if candidate["promptId"] == prompt_id and candidate["engineId"] == engine["id"]), None)
        if row is None:
            skipped.append({"promptId": prompt_id, "engine": engine_token, "reason": "提示词不在审计网格内"})
            continue
        answer = entry.get("answer")
        if not isinstance(answer, str) or not answer.strip():
            skipped.append({"promptId": prompt_id, "engine": engine_token, "reason": "答案为空"})
            continue
        row["answer"] = answer.strip()
        row["flags"] = derive_flags(row["answer"])
        facts_total = entry.get("factsTotal")
        facts_correct = entry.get("factsCorrect")
        row["factsTotal"] = max(0, int(facts_total)) if isinstance(facts_total, (int, float)) else 0
        row["factsCorrect"] = max(0, int(facts_correct)) if isinstance(facts_correct, (int, float)) else 0
        row["note"] = entry.get("note") if isinstance(entry.get("note"), str) else ""
        row["status"] = "done"
        row["recordedAt"] = recorded_at
        recorded += 1
        rows.append({"id": row["id"], "promptId": row["promptId"], "engine": engine["name"], "flags": row["flags"]})
    return {"recorded": recorded, "skipped": skipped, "rows": rows}


def _ratio(numerator: int, denominator: int) -> float | None:
    return None if denominator == 0 else round_1k(numerator / denominator)


def compute_metrics(audit: dict[str, Any]) -> dict[str, Any]:
    """Compute the five headline metrics plus per-engine and per-cluster breakdowns."""
    done = [row for row in audit["rows"] if row.get("status") == "done"]
    audited = len(done)
    mentioned = sum(1 for row in done if (row.get("flags") or {}).get("brandMentioned") is True)
    first_choice = sum(1 for row in done if (row.get("flags") or {}).get("firstChoice") is True)
    owned_cited = sum(1 for row in done if ((row.get("flags") or {}).get("ownedCited") or []))
    authority_cited = sum(1 for row in done if ((row.get("flags") or {}).get("authorityCited") or []))
    negative = sum(1 for row in done if ((row.get("flags") or {}).get("negative") or []))
    facts_total = sum(int(row.get("factsTotal") or 0) for row in done)
    facts_correct = sum(int(row.get("factsCorrect") or 0) for row in done)

    def group_by(key: Any, label: Any) -> list[dict[str, Any]]:
        buckets: dict[str, dict[str, Any]] = {}
        for row in done:
            bucket_key = key(row)
            entry = buckets.setdefault(bucket_key, {
                "key": bucket_key,
                "label": label(row),
                "audited": 0,
                "mentioned": 0,
                "firstChoice": 0,
                "ownedCited": 0,
                "negative": 0,
            })
            entry["audited"] += 1
            flags = row.get("flags") or {}
            if flags.get("brandMentioned") is True:
                entry["mentioned"] += 1
            if flags.get("firstChoice") is True:
                entry["firstChoice"] += 1
            if flags.get("ownedCited"):
                entry["ownedCited"] += 1
            if flags.get("negative"):
                entry["negative"] += 1
        result = []
        for entry in buckets.values():
            result.append({
                **entry,
                "mentionRate": _ratio(entry["mentioned"], entry["audited"]),
                "firstChoiceRate": _ratio(entry["firstChoice"], entry["audited"]),
                "citationRate": _ratio(entry["ownedCited"], entry["mentioned"]),
            })
        return result

    by_engine = group_by(lambda row: row["engineId"], lambda row: row["engineName"])
    by_engine.sort(key=lambda entry: entry["label"])
    by_cluster = group_by(lambda row: row["cluster"], lambda row: row["cluster"])

    return {
        "audited": audited,
        "total": audit["total"],
        "coverage": _ratio(audited, audit["total"]),
        "mentionRate": _ratio(mentioned, audited),
        "firstChoiceRate": _ratio(first_choice, audited),
        "citationRate": _ratio(owned_cited, mentioned),
        "authorityRate": _ratio(authority_cited, mentioned),
        "factAccuracy": _ratio(facts_correct, facts_total),
        "negativeRate": _ratio(negative, audited),
        "counts": {
            "mentioned": mentioned,
            "firstChoice": first_choice,
            "ownedCited": owned_cited,
            "authorityCited": authority_cited,
            "negative": negative,
            "factsTotal": facts_total,
            "factsCorrect": facts_correct,
        },
        "targets": TARGETS,
        "byEngine": by_engine,
        "byCluster": by_cluster,
        "needsFactCheck": sum(1 for row in done if int(row.get("factsTotal") or 0) == 0),
    }


def _format_rate(value: float | None) -> str:
    return "待测" if value is None else f"{value}%"


def render_baseline_markdown(audit: dict[str, Any], metrics: dict[str, Any], meta: dict[str, Any] | None = None) -> str:
    meta = meta or {}
    lines = [f"# T0 基线审计 · {audit['promptCount']} 提示词 × {len(audit['engines'])} 引擎（共 {audit['total']} 行）", ""]
    lines.append(f"品牌：{audit['brand']}　建立于：{audit['createdAt'][:19].replace('T', ' ')}")
    lines.append(f"进度：{metrics['audited']} / {metrics['total']}（{_format_rate(metrics['coverage'])}）")
    lines.append("")
    lines.append("## 五个核心指标")
    lines.append("| 指标 | 当前 | 12 个月目标 |")
    lines.append("| --- | --- | --- |")
    lines.append(f"| AI 提及率 | {_format_rate(metrics['mentionRate'])} | ≥ {metrics['targets']['mentionRate']}% |")
    lines.append(f"| AI 首选率 | {_format_rate(metrics['firstChoiceRate'])} | ≥ {metrics['targets']['firstChoiceRate']}% |")
    lines.append(f"| 引用率 | {_format_rate(metrics['citationRate'])} | ≥ {metrics['targets']['citationRate']}% |")
    lines.append(f"| 事实准确率 | {_format_rate(metrics['factAccuracy'])} | ≥ {metrics['targets']['factAccuracy']}% |")
    lines.append(f"| 负面/错误信息 | {_format_rate(metrics['negativeRate'])} | ≤ {metrics['targets']['negativeRate']}% |")
    lines.append("")
    lines.append(f"权威信源引用率：{_format_rate(metrics['authorityRate'])}（口径为提及答案中引用权威信源的比例）")
    lines.append("")
    if metrics["audited"] == 0:
        lines.append("还没有录入任何答案。用 `baseline next` 领取批次，逐条把引擎答案粘回来，指标才会出现。")
        return "\n".join(lines).rstrip()
    if metrics["needsFactCheck"] > 0:
        lines.append(f"⚠️ 有 {metrics['needsFactCheck']} 条答案尚未填写事实核查结果（factsTotal / factsCorrect），事实准确率暂不完整。")
        lines.append("")
    lines.append("## 按引擎")
    lines.append("| 引擎 | 已采集 | 提及率 | 首选率 | 引用率 |")
    lines.append("| --- | --- | --- | --- | --- |")
    for entry in metrics["byEngine"]:
        lines.append(f"| {entry['label']} | {entry['audited']} | {_format_rate(entry['mentionRate'])} | {_format_rate(entry['firstChoiceRate'])} | {_format_rate(entry['citationRate'])} |")
    lines.append("")
    lines.append("## 按内容簇")
    lines.append("| 内容簇 | 已采集 | 提及率 | 首选率 |")
    lines.append("| --- | --- | --- | --- |")
    for entry in metrics["byCluster"]:
        lines.append(f"| {entry['label']} | {entry['audited']} | {_format_rate(entry['mentionRate'])} | {_format_rate(entry['firstChoiceRate'])} |")
    if meta.get("remaining") is not None:
        lines.append("")
        lines.append(f"剩余待采集：{meta['remaining']} 条。")
    return "\n".join(lines).rstrip()
