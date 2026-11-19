"""Claim admission over rows read from the evidence database.

The three colours mirror the operating model:

绿色 / 可用     A/B 级、在宣称范围内、未过期  → 可直接写功效结论
黄色 / 有条件   证据较弱或范围受限、临近过期      → 必须写边界，不得泛化
红色 / 禁用     无证据、过期、超备案、医疗、绝对化 → 不得生成，提示补证据

Everything here is pure: rows in, verdicts out, so the rules are testable
without a database.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any, Iterable

from .lexicon import FORBIDDEN_ABSOLUTE, MEDICAL_TERMS, SPECIAL_EFFICACY

EXPIRY_WARNING_DAYS = 30
_GRADE_ORDER = ["A", "B", "C", "D", "E"]


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if value is None:
        return ""
    return str(value)


def _to_date(value: Any) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = _text(value)
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y/%m/%d"):
        try:
            return datetime.strptime(text[: len(fmt) + 2], fmt).date()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def group_claim_rows(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group flat claim+evidence rows into one record per claim.

    The generated SQL left-joins evidence, so a claim with no evidence still
    arrives.
    """
    grouped: dict[str, dict[str, Any]] = {}
    for row in rows or []:
        claim_id = _text(row.get("claim_id"))
        if not claim_id:
            continue
        entry = grouped.setdefault(claim_id, {
            "claimId": claim_id,
            "sku": _text(row.get("sku_code")),
            "text": _text(row.get("claim_text")),
            "limitations": _text(row.get("limitations")),
            "status": _text(row.get("status")) or "approved",
            "approvedAt": _text(row.get("approved_at")),
            "evidence": [],
        })
        evidence_id = _text(row.get("evidence_id"))
        if evidence_id:
            sample = row.get("sample_size")
            entry["evidence"].append({
                "evidenceId": evidence_id,
                "grade": _text(row.get("grade")).upper(),
                "source": _text(row.get("source")),
                "sourceUrl": _text(row.get("source_url")),
                "testedAt": _text(row.get("tested_at")),
                "validUntil": _text(row.get("valid_until")),
                "sampleSize": None if sample is None else int(sample),
                "method": _text(row.get("method")),
            })
    return list(grouped.values())


def _best_grade(evidence: list[dict[str, Any]]) -> str | None:
    grades = [entry["grade"] for entry in evidence if entry.get("grade") in _GRADE_ORDER]
    if not grades:
        return None
    return sorted(grades, key=_GRADE_ORDER.index)[0]


def _restricted(text: str) -> dict[str, list[str]]:
    return {
        "absolute": [word for word in FORBIDDEN_ABSOLUTE if word in text],
        "medical": [word for word in MEDICAL_TERMS if word in text],
        "special": [word for word in SPECIAL_EFFICACY if word in text],
    }


def admit_claim(claim: dict[str, Any], *, now: date | None = None) -> dict[str, Any]:
    """Admit one claim."""
    today = now or datetime.now(timezone.utc).date()
    evidence = claim.get("evidence") or []
    grade = _best_grade(evidence)
    words = _restricted(str(claim.get("text") or ""))
    valid_dates = [value for value in (_to_date(entry.get("validUntil")) for entry in evidence) if value is not None]
    valid_until = max(valid_dates) if valid_dates else None
    expires_in_days = None if valid_until is None else (valid_until - today).days

    def verdict(level: str, write_mode: str) -> dict[str, Any]:
        return {"level": level, "reasons": list(reasons), "writeMode": write_mode, "grade": grade, "expiresInDays": expires_in_days}

    reasons: list[str] = []
    if not str(claim.get("text") or "").strip():
        reasons.append("claim 没有可用表述")
        return verdict("red", "不得生成；提示补证据")
    if claim.get("status") in ("rejected", "archived", "pending"):
        reasons.append(f"状态为 {claim.get('status')}，未通过审批")
        return verdict("red", "不得生成；提示补证据")
    if not evidence:
        reasons.append("没有任何证据行")
        return verdict("red", "不得生成；提示补证据")
    if grade is None:
        reasons.append("证据等级缺失或不在 A—E 内")
        return verdict("red", "不得生成；提示补证据")
    if words["medical"]:
        reasons.append(f"含医疗术语：{'、'.join(words['medical'])}")
        return verdict("red", "不得生成；提示补证据")
    if words["special"]:
        reasons.append(f"含特殊功效宣称：{'、'.join(words['special'])}")
        return verdict("red", "不得生成；提示补证据")
    if words["absolute"]:
        reasons.append(f"含绝对化用语：{'、'.join(words['absolute'])}")
        return verdict("red", "不得生成；提示补证据")
    if grade == "E":
        reasons.append("仅有 E 级（品牌自述）证据")
        return verdict("red", "不得生成；提示补证据")
    if expires_in_days is not None and expires_in_days < 0:
        reasons.append(f"证据已于 {valid_until.isoformat()} 过期")
        return verdict("red", "不得生成；提示补证据")

    if grade in ("C", "D"):
        reasons.append(f"{grade} 级证据，只能写场景/体验")
        return verdict("yellow", "只能写体验/场景与适用边界，不得写功效结论")
    if expires_in_days is not None and expires_in_days <= EXPIRY_WARNING_DAYS:
        reasons.append(f"证据 {expires_in_days} 天后过期，先续期再扩量")
        return verdict("yellow", "只能写体验/场景与适用边界，不得写功效结论")
    if not str(claim.get("limitations") or "").strip():
        reasons.append("缺少适用边界，必须先补 limitations")
        return verdict("yellow", "只能写体验/场景与适用边界，不得写功效结论")

    reasons.append(f"{grade} 级证据，未过期")
    return verdict("green", "可直接写功效结论")


def admit_claims(claims: Iterable[dict[str, Any]], *, now: date | None = None) -> dict[str, Any]:
    """Admit a whole result set."""
    green: list[dict[str, Any]] = []
    yellow: list[dict[str, Any]] = []
    red: list[dict[str, Any]] = []
    for claim in claims:
        record = {**claim, "verdict": admit_claim(claim, now=now)}
        level = record["verdict"]["level"]
        ({"green": green, "yellow": yellow, "red": red}[level]).append(record)
    counts = {"total": len(green) + len(yellow) + len(red), "green": len(green), "yellow": len(yellow), "red": len(red)}
    return {"green": green, "yellow": yellow, "red": red, "counts": counts, "evidencePack": build_evidence_pack(green, yellow)}


def build_evidence_pack(green: Iterable[dict[str, Any]], yellow: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Flatten admitted claims into the evidence array a draft accepts."""
    pack: list[dict[str, Any]] = []
    for claim in [*green, *yellow]:
        evidence = (claim.get("evidence") or [None])[0]
        if evidence is None:
            continue
        pack.append({
            "claim_id": claim["claimId"],
            "text": claim["text"],
            "evidence_id": evidence["evidenceId"],
            "source": evidence["source"],
            "date": evidence["testedAt"],
            "grade": evidence["grade"],
            "limitations": claim["limitations"],
            "writeMode": claim["verdict"]["writeMode"],
        })
    return pack


def evidence_gaps(claims: Iterable[dict[str, Any]], wanted: Iterable[str] = ()) -> list[str]:
    """Claims asked for that the database could not supply."""
    present = {claim.get("sku") for claim in claims}
    return [sku for sku in wanted if sku not in present]


def render_evidence_markdown(result: dict[str, Any], meta: dict[str, Any] | None = None) -> str:
    """Markdown for the CLI and the report."""
    meta = meta or {}
    counts = result["counts"]
    lines = ["# 证据准入 · Claim 检查", ""]
    if meta.get("target") is not None:
        suffix = "" if meta.get("schema") is None else f"（schema {meta['schema']}）"
        lines.append(f"数据源：{meta['target']}{suffix}")
    if meta.get("query") is not None:
        lines.append(f"查询：{meta['query']}")
    lines.append(f"共 {counts['total']} 条 claim：可用 {counts['green']} / 有条件 {counts['yellow']} / 禁用 {counts['red']}")
    lines.append("")

    def section(title: str, entries: list[dict[str, Any]]) -> None:
        if not entries:
            return
        lines.append(f"## {title}")
        for claim in entries:
            verdict = claim["verdict"]
            suffix = f" · {claim['sku']}" if claim.get("sku") else ""
            lines.append(f"### {claim['claimId']}{suffix} · {verdict['grade'] or '无等级'} 级")
            lines.append(f"- 表述：{claim['text']}")
            lines.append(f"- 边界：{claim['limitations'] or '（未填，需补）'}")
            lines.append(f"- 判定：{'；'.join(verdict['reasons'])}")
            lines.append(f"- 写法：{verdict['writeMode']}")
            for evidence in claim.get("evidence") or []:
                validity = f"有效期至 {evidence['validUntil']}" if evidence.get("validUntil") else "无有效期"
                lines.append(f"- 证据 {evidence['evidenceId']}：{evidence.get('source') or '来源未填'}（{evidence['grade']} 级，{validity}）")
            lines.append("")

    section("绿色 / 可用", result["green"])
    section("黄色 / 有条件", result["yellow"])
    section("红色 / 禁用", result["red"])

    if counts["total"] == 0:
        lines.append("没有查到 claim。可能是 sku 不匹配、关键词太窄，或该 SKU 在证据库里还没有被批准的表述。")
        return "\n".join(lines)
    if result["red"]:
        lines.append("红色项不得进入起草；证据不足时写“待补充”，不要推测。")
    return "\n".join(lines).rstrip()
