"""Classification and scoring of hot-list items.

Three deterministic passes, in order:

1. keyword groups — TrendRadar ``frequency_words.txt`` dialect, for display
2. entity layer — brand / related parties / competitor / product mentions
3. GEO clusters — route the title into one of the eight answer clusters

plus the risk vocabulary that feeds the alert pipeline. Everything is
rule-based and reproducible: the same scan always yields the same labels, which
is what makes the derived topic board auditable.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

from ._numeric import round_1k, round_2, round_3
from .lexicon import (
    CLUSTERS,
    COMPETITOR_ACTIONS,
    COMPETITORS,
    DOMAIN_ANCHORS,
    ENTITY,
    FORBIDDEN_ABSOLUTE,
    MEDICAL_TERMS,
    NEGATIVE_TERMS,
    PRODUCTS,
    SPECIAL_EFFICACY,
)

CATEGORY_DAMPING = 0.55
_DEFAULT_GROUPS: list[dict[str, Any]] = []

_SPECIAL = r"[.*+?^${}()|\[\]\\]"


def escape_regex(value: str) -> str:
    return re.sub(_SPECIAL, lambda match: "\\" + match.group(0), value)


def _any_includes(text: str, words: Iterable[str]) -> list[str]:
    return [word for word in words if word in text]


def has_domain_anchor(text: Any) -> bool:
    """True when the text carries a beauty or skin-type anchor."""
    haystack = str(text or "")
    return any(anchor in haystack for anchor in DOMAIN_ANCHORS)


def _compile_flags(flags: str) -> int:
    value = 0
    if "i" in flags:
        value |= re.IGNORECASE
    if "m" in flags:
        value |= re.MULTILINE
    if "s" in flags:
        value |= re.DOTALL
    return value


def parse_keyword_groups(text: Any) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Parse the TrendRadar keyword dialect.

    ``[group]`` opens a group, ``#`` starts a comment, ``/re/flags => label`` is a
    regular expression, and any other line is a literal substring. An invalid
    regular expression is reported instead of silently dropped.
    """
    groups: list[dict[str, Any]] = []
    warnings: list[dict[str, str]] = []
    current: dict[str, Any] | None = None

    def ensure() -> dict[str, Any]:
        nonlocal current
        if current is None:
            current = {"name": "默认", "terms": []}
            groups.append(current)
        return current

    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        header = re.fullmatch(r"\[(.+)\]", line)
        if header:
            current = {"name": header.group(1).strip(), "terms": []}
            groups.append(current)
            continue
        group = ensure()
        regex_form = re.fullmatch(r"/(.+)/([a-z]*)\s*(?:=>\s*(.+))?", line)
        if regex_form:
            pattern, flags, label = regex_form.group(1), regex_form.group(2) or "", regex_form.group(3)
            try:
                compiled = re.compile(pattern, _compile_flags(flags))
            except re.error as error:
                warnings.append({"line": line, "message": str(error)})
                continue
            group["terms"].append({
                "type": "regex",
                "value": pattern,
                "flags": flags,
                "label": (label or pattern).strip(),
                "compiled": compiled,
            })
            continue
        literal = re.sub(r"\s*=>\s*.+$", "", line).strip()
        if not literal:
            continue
        group["terms"].append({
            "type": "literal",
            "value": literal,
            "label": literal,
            "compiled": re.compile(escape_regex(literal), re.IGNORECASE),
        })

    return [group for group in groups if group["terms"]], warnings


def match_keyword_groups(text: Any, groups: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Match one text against every group; returns the labels that fired."""
    haystack = str(text or "")
    hits: list[dict[str, Any]] = []
    for group in groups:
        labels: list[str] = []
        for term in group["terms"]:
            if term["compiled"].search(haystack):
                labels.append(term["label"])
        if labels:
            unique = list(dict.fromkeys(labels))
            hits.append({"group": group["name"], "labels": unique})
    return hits


def detect_entities(text: Any) -> dict[str, Any]:
    """Brand, related-party, founder and competitor mentions with surface forms."""
    haystack = str(text or "")
    brand_hits = _any_includes(haystack, ENTITY["brandAliases"])
    parent_hits = _any_includes(haystack, ENTITY["parentAliases"])
    founder_hits = _any_includes(haystack, ENTITY["founderAliases"])
    competitors: list[dict[str, Any]] = []
    for entry in COMPETITORS:
        hits = _any_includes(haystack, entry["aliases"])
        if hits:
            competitors.append({
                "id": entry["id"],
                "name": entry["name"],
                "hits": hits,
                "actions": _any_includes(haystack, COMPETITOR_ACTIONS),
            })
    mentions = bool(brand_hits or parent_hits or founder_hits)
    return {
        "isBrand": bool(brand_hits),
        "brandHits": brand_hits,
        "parentHits": parent_hits,
        "founderHits": founder_hits,
        "competitors": competitors,
        "isCompetitor": bool(competitors),
        "mentionsEntity": mentions,
    }


def detect_products(text: Any) -> list[dict[str, Any]]:
    """Products of the plan mentioned in the text."""
    haystack = str(text or "")
    found: list[dict[str, Any]] = []
    for product in PRODUCTS:
        hits = _any_includes(haystack, product["aliases"])
        if hits:
            found.append({"id": product["id"], "name": product["name"], "hits": hits})
    return found


def classify_clusters(text: Any) -> list[dict[str, Any]]:
    """Score every cluster for the text; sorted by score then definition order.

    Naming a product is not by itself a category question: 「方里柔焦蜜粉饼适合油皮吗」
    is a skin-type question. When the title also matches a more specific cluster,
    the generic category cluster is damped so the qualifier wins.
    """
    haystack = str(text or "")
    scored: list[dict[str, Any]] = []
    for index, cluster in enumerate(CLUSTERS):
        cues = _any_includes(haystack, cluster["cues"])
        score = 0.0 if not cues else min(1.0, len(cues) * 0.4) * cluster["weight"]
        scored.append({
            "id": cluster["id"],
            "name": cluster["name"],
            "weight": cluster["weight"],
            "cues": cues,
            "score": score,
            "index": index,
        })
    if any(entry["score"] > 0 and entry["id"] != "category" for entry in scored):
        for entry in scored:
            if entry["id"] == "category":
                entry["score"] = round_3(entry["score"] * CATEGORY_DAMPING)
    kept = [entry for entry in scored if entry["score"] > 0]
    kept.sort(key=lambda entry: (-entry["score"], entry["index"]))
    return kept


def pick_cluster(text: Any, entities: dict[str, Any] | None = None) -> dict[str, Any]:
    """The single cluster a topic belongs to."""
    scored = classify_clusters(text)
    comparison = next((entry for entry in scored if entry["id"] == "compare"), None)
    if entities and entities.get("competitors") and entities.get("mentionsEntity") and comparison is not None:
        return next(cluster for cluster in CLUSTERS if cluster["id"] == "compare")
    if scored:
        return next(cluster for cluster in CLUSTERS if cluster["id"] == scored[0]["id"])
    fallback = "compare" if entities and (entities.get("mentionsEntity") or entities.get("isCompetitor")) else "category"
    return next(cluster for cluster in CLUSTERS if cluster["id"] == fallback)


def detect_negative(text: Any) -> list[str]:
    return _any_includes(str(text or ""), NEGATIVE_TERMS)


def detect_compliance(text: Any) -> dict[str, Any]:
    """Compliance vocabulary, split by the rule it would break."""
    haystack = str(text or "")
    absolute = _any_includes(haystack, FORBIDDEN_ABSOLUTE)
    medical = _any_includes(haystack, MEDICAL_TERMS)
    special = _any_includes(haystack, SPECIAL_EFFICACY)
    return {
        "absolute": absolute,
        "medical": medical,
        "special": special,
        "total": len(absolute) + len(medical) + len(special),
    }


def rank_score(rank: int) -> float:
    if rank <= 3:
        return 1.0
    if rank <= 10:
        return 0.75
    if rank <= 20:
        return 0.5
    if rank <= 30:
        return 0.3
    return 0.15


def _priority_of(entities: dict[str, Any], cluster: dict[str, Any], risk_score: float, cluster_score: float) -> str:
    high_value = cluster["id"] in ("compare", "product", "skin")
    if risk_score >= 1 and entities["mentionsEntity"]:
        return "P0"
    if (entities["mentionsEntity"] or entities["isCompetitor"]) and high_value:
        return "P0"
    if cluster_score >= 0.75 or (entities["mentionsEntity"] and risk_score > 0):
        return "P1"
    return "P2"


_HAS_STUDY = re.compile(r"检测|临床|专利|斑贴|白皮书|报告")


def _evidence_gap_of(cluster: dict[str, Any], text: Any) -> str:
    haystack = str(text or "")
    has_study = bool(_HAS_STUDY.search(haystack))
    if cluster["id"] == "skin" and not has_study:
        return "缺 A 级证据：斑贴 / 人体功效评价 / 检测报告，先补证据再写功效结论"
    if cluster["id"] == "compare" and not has_study:
        return "缺 A/B 级证据：竞品公开参数需同规格同时点，结论需可验证"
    if cluster["id"] == "product" and not has_study:
        return "缺产品事实卡：色号、规格、备案号、适用肤质需与产品页一致"
    if cluster["id"] == "price" and not has_study:
        return "缺价格/渠道口径：价格与备案号需标注日期，避免过期信息"
    if cluster["id"] == "brand" and not has_study:
        return "缺实体一致性素材：主体、成立时间、股权关系需与营业执照一致"
    if cluster["id"] == "global" and not has_study:
        return "缺日本市场资料：@cosme / 亚马逊页面与日文口径需先行"
    return "证据齐备度待核查：确认每条 claim 都绑定 claim_id 与 evidence_id"


def score_item(item: dict[str, Any], *, groups: Iterable[dict[str, Any]] = _DEFAULT_GROUPS) -> dict[str, Any]:
    """Annotate and score one hot-list item."""
    title = str(item.get("title") or "")
    summary = item.get("summary")
    context = f"{title} {summary or ''}"
    entities = detect_entities(context)
    products = detect_products(title)
    clusters = classify_clusters(title)
    cluster = pick_cluster(title, entities)
    cluster_score = clusters[0]["score"] if clusters else 0.2
    negative = detect_negative(title)
    compliance = detect_compliance(title)
    risk_score = 1.0 if (negative or compliance["medical"]) else (0.6 if compliance["absolute"] else 0.0)
    entity_score = 1.0 if entities["mentionsEntity"] else (0.6 if entities["isCompetitor"] else 0.0)

    rank = item.get("rank")
    rank = rank if isinstance(rank, int) else 50
    raw = 0.3 * rank_score(rank) + 0.4 * cluster_score + 0.2 * entity_score + 0.1 * risk_score

    if products:
        product_entry = next(entry for entry in PRODUCTS if entry["id"] == products[0]["id"])
    else:
        wanted = "powder" if cluster["product"] == "brand" else cluster["product"]
        product_entry = next((entry for entry in PRODUCTS if entry["id"] == wanted), PRODUCTS[0])

    reasons: list[str] = []
    if entities["mentionsEntity"]:
        reasons.append(f"提及{'方里' if entities['brandHits'] else '关联主体'}")
    if entities["competitors"]:
        reasons.append("提及竞品：" + "、".join(entry["name"] for entry in entities["competitors"]))
    if clusters:
        described = " / ".join(f"{entry['name']}({'、'.join(entry['cues'])})" for entry in clusters[:3])
        reasons.append(f"内容簇：{described}")
    if negative:
        reasons.append(f"负面词：{'、'.join(negative)}")
    if compliance["absolute"]:
        reasons.append(f"绝对化用语：{'、'.join(compliance['absolute'])}")
    if compliance["medical"]:
        reasons.append(f"医疗术语：{'、'.join(compliance['medical'])}")
    if compliance["special"]:
        reasons.append(f"特殊功效词：{'、'.join(compliance['special'])}")

    return {
        **item,
        "score": round_1k(raw),
        "priority": _priority_of(entities, cluster, risk_score, cluster_score),
        "cluster": {"id": cluster["id"], "name": cluster["name"]},
        "clusterScore": round_2(cluster_score),
        "clusters": [{"id": entry["id"], "name": entry["name"], "cues": entry["cues"]} for entry in clusters],
        "product": {"id": product_entry["id"], "name": product_entry["name"]},
        "format": cluster["format"],
        "entities": entities,
        "negative": negative,
        "compliance": compliance,
        "riskScore": risk_score,
        "keywordGroups": match_keyword_groups(title, groups),
        "evidenceGap": _evidence_gap_of(cluster, title),
        "reasons": reasons,
    }


def match_items(
    items: Iterable[dict[str, Any]],
    *,
    groups: Iterable[dict[str, Any]] = _DEFAULT_GROUPS,
    min_score: float = 0.1,
    limit: int = 200,
    require_anchor: bool = True,
) -> list[dict[str, Any]]:
    """Score every item and keep the ones that matter to GEO.

    A hot-list title is kept when it mentions the brand or a competitor, or when
    it carries a beauty anchor together with a cluster or risk cue. A bare
    seasonal word is not enough.
    """
    scored: list[dict[str, Any]] = []
    for item in items:
        entry = score_item(item, groups=groups)
        entities = entry["entities"]
        relevant = (
            not require_anchor
            or entities["mentionsEntity"]
            or entities["isCompetitor"]
            or (has_domain_anchor(entry["title"]) and (entry["clusters"] or entry["negative"]))
        )
        if not relevant:
            continue
        if entry["score"] < min_score:
            continue
        scored.append(entry)
    scored.sort(key=lambda entry: (-entry["score"], entry.get("rank") if isinstance(entry.get("rank"), int) else 50))
    return scored[: max(1, limit)]


def _title_key(value: Any) -> str:
    return re.sub(r"[\s\W_]+", "", str(value or ""))


def merge_scored(lists: Iterable[Iterable[dict[str, Any]]], limit: int = 200) -> list[dict[str, Any]]:
    """Merge scored lists, dropping the same headline and keeping the highest score."""
    by_title: dict[str, dict[str, Any]] = {}
    for entries in lists:
        for entry in entries:
            key = _title_key(entry.get("title"))
            existing = by_title.get(key)
            if existing is None or entry["score"] > existing["score"]:
                by_title[key] = entry
    merged = list(by_title.values())
    merged.sort(key=lambda entry: (-entry["score"], entry.get("rank") if isinstance(entry.get("rank"), int) else 50))
    return merged[: max(1, limit)]
