"""Topic cards — the 选题 workshop of the content factory.

A card converts one hot-list hit into the shape used by the plan's topic board:
选题 / 簇 / 产品 / 形态, plus the priority, the evidence gap that must be closed
before drafting, and the closest prompt from the library so the card links back
to the baseline audit.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Iterable

from ._numeric import round_2
from .lexicon import CLUSTER_BY_NAME, ENTITY, PRODUCT_BY_ID
from .store import iso_now

_CJK = re.compile(r"[\u4e00-\u9fff]")
_PLATFORM_SUFFIX = re.compile(r"\s*[-–—|｜]\s*(微博|知乎|抖音|百度|今日头条|B 站|哔哩哔哩).*$")
_NON_WORD = re.compile(r"[^\u4e00-\u9fffA-Za-z0-9]")


def _bigrams(text: Any) -> set[str]:
    cleaned = _NON_WORD.sub("", str(text or ""))
    return {cleaned[index:index + 2] for index in range(len(cleaned) - 1)}


def similarity(left: Any, right: Any) -> float:
    """Jaccard similarity over character bigrams."""
    a = _bigrams(left)
    b = _bigrams(right)
    if not a or not b:
        return 0.0
    return len(a & b) / (len(a) + len(b) - len(a & b))


def closest_prompt(text: str, cluster_name: str, prompts: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
    """Closest prompt of the same cluster; falls back to any cluster."""
    pool_all = list(prompts or [])
    if not pool_all:
        return None
    same_cluster = [prompt for prompt in pool_all if prompt.get("cluster") == cluster_name]
    pool = same_cluster or pool_all
    best: dict[str, Any] | None = None
    for prompt in pool:
        score = similarity(text, prompt.get("prompt"))
        if best is None or score > best["score"]:
            best = {"prompt": prompt, "score": score}
    if best is None or best["score"] < 0.05:
        return {"prompt": same_cluster[0], "score": 0.0} if same_cluster else None
    return best


def clean_title(value: Any) -> str:
    """Strip trailing hot-list boilerplate so a title reads like a question seed."""
    text = _PLATFORM_SUFFIX.sub("", str(value or ""))
    text = text.strip("#").strip()
    return re.sub(r"\s+", " ", text).strip()


def _first_cue(item: dict[str, Any]) -> str:
    clusters = item.get("clusters") or []
    if clusters and clusters[0].get("cues"):
        return clusters[0]["cues"][0]
    negative = item.get("negative") or []
    if negative:
        return negative[0]
    return ""


def to_question(item: dict[str, Any]) -> str:
    """Turn a scored item into a user question, template-driven."""
    title = clean_title(item.get("title"))
    if re.search(r"[?？]$", title):
        return title
    cue = _first_cue(item)
    cluster_id = (item.get("cluster") or {}).get("id")
    if cluster_id == "compare":
        competitors = (item.get("entities") or {}).get("competitors") or []
        if competitors:
            return f"方里和{competitors[0]['name']}怎么选？"
        return f"{title}，谁更适合？"
    if cluster_id == "skin":
        return f"{cue}能用方里吗？怎么选？" if cue else f"{title}，方里适合吗？"
    if cluster_id == "scene":
        return f"{cue}场景下底妆怎么选？" if cue else f"{title}，底妆怎么选？"
    if cluster_id == "product":
        return f"方里{cue}怎么选、怎么用？" if cue else f"{title}，方里怎么选？"
    if cluster_id == "price":
        return "方里多少钱？哪里买便宜、怎么辨真假？"
    if cluster_id == "category":
        return f"{cue}推荐，哪个不容易踩雷？" if cue else f"{title}，有什么推荐？"
    if cluster_id == "brand":
        return "方里是哪个公司？是国货吗、靠谱吗？"
    if cluster_id == "global":
        return "Funny Elves 日本版和中国版有什么区别？"
    return f"{title}，方里怎么答？"


_EVIDENCE_BY_CLUSTER = {
    "compare": "A/B（同规格同时点公开参数）",
    "skin": "A（检测 / 斑贴 / 人体功效）",
}


def build_card(
    item: dict[str, Any],
    index: int,
    *,
    moment: datetime | None = None,
    prompts: Iterable[dict[str, Any]] = (),
) -> dict[str, Any]:
    """Build one topic card."""
    moment = moment or datetime.now()
    stamp = f"{moment:%Y%m%d}"
    cluster_name = (item.get("cluster") or {}).get("name") or "品类推荐"
    cluster = CLUSTER_BY_NAME.get(cluster_name, {"id": "category", "name": cluster_name, "assets": 40, "format": "选购指南"})
    product_entry = PRODUCT_BY_ID.get((item.get("product") or {}).get("id"), PRODUCT_BY_ID["powder"])
    prompt_match = closest_prompt(f"{item.get('title')} {to_question(item)}", cluster_name, prompts)
    title = clean_title(item.get("title"))
    trimmed = title[:60] if _CJK.search(title) else title[:90]
    source = item.get("source") if isinstance(item.get("source"), dict) else {}
    return {
        "id": f"GT-{stamp}-{index + 1:03d}",
        "title": trimmed,
        "question": to_question(item),
        "cluster": cluster_name,
        "clusterId": cluster["id"],
        "product": product_entry["name"],
        "format": item.get("format") or cluster["format"],
        "priority": item.get("priority") or "P2",
        "score": item.get("score") or 0,
        "evidenceGap": item.get("evidenceGap") or "",
        "why": item.get("reasons") or [],
        "quota": f"本簇首年资产 {cluster['assets']} 条",
        "promptRef": None if prompt_match is None else {
            "id": prompt_match["prompt"]["id"],
            "prompt": prompt_match["prompt"]["prompt"],
            "cluster": prompt_match["prompt"]["cluster"],
            "priority": prompt_match["prompt"]["priority"],
            "similarity": round_2(prompt_match["score"]),
        },
        "evidence": f"目标证据等级：{_EVIDENCE_BY_CLUSTER.get(cluster['id'], 'B/C + 产品事实卡')}",
        "source": {
            "platform": item.get("platformName") or item.get("platform"),
            "rank": item.get("rank"),
            "url": item.get("url") or "",
            "hot": item.get("hot") or "",
            "scannedAt": item.get("scannedAt") or source.get("scannedAt") or "",
        },
        "owner": "内容策略",
        "status": "draft",
        "createdAt": iso_now(),
        "brand": ENTITY["brand"],
    }


_PRIORITY_WEIGHT = {"P0": 3, "P1": 2, "P2": 1}
_TRAILING_ID = re.compile(r"-\d{3}$")


def build_topics(
    items: Iterable[dict[str, Any]],
    *,
    limit: int = 20,
    per_cluster: int = 6,
    moment: datetime | None = None,
    prompts: Iterable[dict[str, Any]] = (),
) -> list[dict[str, Any]]:
    """Build a deduplicated topic board.

    Near-duplicate titles collapse, and each cluster keeps at most
    ``per_cluster`` cards so one trending subject cannot fill the board.
    """
    cards: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    for item in items:
        cluster_name = (item.get("cluster") or {}).get("name") or "品类推荐"
        used = counts.get(cluster_name, 0)
        if used >= per_cluster:
            continue
        if any(similarity(card["title"], clean_title(item.get("title"))) > 0.72 for card in cards):
            continue
        counts[cluster_name] = used + 1
        cards.append(build_card(item, len(cards), moment=moment, prompts=prompts))
        if len(cards) >= limit:
            break
    cards.sort(key=lambda card: (-_PRIORITY_WEIGHT.get(card["priority"], 0), -card["score"]))
    renumbered: list[dict[str, Any]] = []
    for index, card in enumerate(cards):
        renumbered.append({**card, "id": _TRAILING_ID.sub(f"-{index + 1:03d}", card["id"])})
    return renumbered


def render_topics_markdown(cards: Iterable[dict[str, Any]], meta: dict[str, Any] | None = None) -> str:
    """Render a topic board as the Markdown a strategist can act on."""
    meta = meta or {}
    cards = list(cards)
    lines: list[str] = []
    stamp = meta.get("date") or datetime.now().strftime("%Y-%m-%d")
    lines.append(f"# GEO 选题卡 · {stamp}")
    lines.append("")
    if meta.get("scannedAt") is not None:
        lines.append(f"扫描时间：{meta['scannedAt']}　来源：{meta.get('sources', '公开热榜')}")
    lines.append(f"共 {len(cards)} 条，按 P0 → P2、分数从高到低排序。")
    lines.append("")
    if not cards:
        lines.append("本次扫描没有命中与方里、竞品或底妆品类相关的热点。可放宽 `minScore`，或增加平台与关键词分组。")
        return "\n".join(lines)
    for card in cards:
        lines.append(f"## {card['priority']} · {card['cluster']} · {card['question']}")
        lines.append(f"- 选题编号：{card['id']}　形态：{card['format']}　产品：{card['product']}")
        hot = f"（{card['source']['hot']}）" if card["source"].get("hot") else ""
        lines.append(f"- 分数：{card['score']}　来源：{card['source']['platform']} 第 {card['source']['rank']} 位{hot}")
        if card["source"].get("url"):
            lines.append(f"- 原帖：{card['source']['url']}")
        lines.append(f"- 证据缺口：{card['evidenceGap']}")
        lines.append(f"- 目标证据：{card['evidence']}")
        if card.get("promptRef"):
            ref = card["promptRef"]
            lines.append(f"- 关联提示词：{ref['id']}（{ref['cluster']}，{ref['priority']} 级）{ref['prompt']}")
        if card.get("why"):
            lines.append(f"- 判定依据：{'；'.join(card['why'])}")
        lines.append("")
    return "\n".join(lines).rstrip()
