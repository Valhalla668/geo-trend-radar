"""Draft scaffolding and contract validation.

The package does not call a model. It hands the caller a complete, constrained
brief (a four-layer prompt plus a template) and then checks whatever JSON comes
back against the contract and the compliance red lines. Three gates are enforced
mechanically:

G1 Schema        fields, types, enums, title length
G2 证据绑定      block → claim → evidence → citation must close
G4 合规          absolute / medical / special-efficacy vocabulary

G3 factual entailment and G5 brand voice need a human; they are flagged, never
pretended to pass.
"""

from __future__ import annotations

import json
import re
from typing import Any, Iterable

from .lexicon import CLUSTER_BY_ID, FORBIDDEN_ABSOLUTE, MEDICAL_TERMS, PRODUCT_BY_ID, SPECIAL_EFFICACY

CONTENT_CONTRACT: dict[str, Any] = {
    "type": "object",
    "required": ["content_id", "content_type", "title", "summary", "blocks", "claims", "citations", "risk_level"],
    "properties": {
        "content_id": {"type": "string"},
        "content_type": {"enum": ["answer_page", "faq", "comparison", "social", "video", "qa", "translation"]},
        "title": {"type": "string", "maxLength": 30},
        "summary": {"type": "string"},
        "blocks": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["type", "text"],
                "properties": {
                    "type": {"enum": ["paragraph", "list", "table", "faq"]},
                    "text": {"type": "string"},
                    "claim_ids": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "claims": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["claim_id", "text", "evidence_ids"],
                "properties": {
                    "claim_id": {"type": "string"},
                    "text": {"type": "string"},
                    "evidence_ids": {"type": "array", "items": {"type": "string"}},
                    "limitations": {"type": "string"},
                },
            },
        },
        "citations": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["evidence_id", "source"],
                "properties": {
                    "evidence_id": {"type": "string"},
                    "source": {"type": "string"},
                    "url": {"type": "string"},
                    "date": {"type": "string"},
                },
            },
        },
        "risk_level": {"enum": ["low", "medium", "high"]},
    },
}

TEMPLATES: list[dict[str, str]] = [
    {"id": "G01", "name": "答案页", "content_type": "answer_page", "purpose": "官网 / 知乎长答案", "words": "800—1500 字"},
    {"id": "G02", "name": "FAQ", "content_type": "faq", "purpose": "把答案拆成 5—8 条", "words": "300—600 字"},
    {"id": "G03", "name": "对比页", "content_type": "comparison", "purpose": "方里 vs 竞品", "words": "600—1000 字"},
    {"id": "G04", "name": "选购指南", "content_type": "answer_page", "purpose": "多 SKU / 场景", "words": "1000—1500 字"},
    {"id": "G05", "name": "小红书 9 图", "content_type": "social", "purpose": "卡片文案", "words": "每张 ≤40 字"},
    {"id": "G06", "name": "抖音 60 秒", "content_type": "video", "purpose": "口播脚本", "words": "250—350 字"},
    {"id": "G07", "name": "知乎回答", "content_type": "answer_page", "purpose": "专业长文", "words": "1200—1800 字"},
    {"id": "G08", "name": "B 站脚本", "content_type": "video", "purpose": "5—8 分钟测评", "words": "1500—2500 字"},
    {"id": "G09", "name": "电商 QA", "content_type": "qa", "purpose": "详情页问答", "words": "50—100 字/条"},
    {"id": "G10", "name": "客服话术", "content_type": "qa", "purpose": "3 句话", "words": "80—120 字"},
    {"id": "G11", "name": "标题/摘要", "content_type": "social", "purpose": "10 标题 + 3 摘要", "words": "≤30 字/条"},
    {"id": "G12", "name": "日文翻译", "content_type": "translation", "purpose": "日本市场", "words": "等长"},
]

HARD_RULES: list[str] = [
    "只能使用【证据包】中的 claim 与 evidence；不得补充外部知识。",
    "每个功效句必须绑定 claim_id 与 evidence_id；没有证据的句子删除。",
    "证据强度低于 B 的 claim，只能写“体验/场景”，不得写功效结论。",
    "必须写“适用边界/不适用人群”。",
    "禁止：最、第一、国家级、治疗、修复疾病、医美替代、零毛孔、永久。",
    "证据不足、过期、冲突时，写“待补充”，不得推测。",
    "只输出 JSON，不输出解释；字段缺失填 null。",
]

NEGATION = re.compile(r"[不非没无未]")
NEGATION_WINDOW = 4


def pick_template(cluster_id: str | None, fmt: str | None) -> dict[str, str]:
    """Choose the template from the topic format, not from a free choice."""
    value = str(fmt or "")
    if "FAQ" in value:
        return TEMPLATES[1]
    if "对比表" in value:
        return TEMPLATES[2]
    if "选购指南" in value:
        return TEMPLATES[2] if cluster_id == "compare" else TEMPLATES[3]
    if "视频" in value:
        return TEMPLATES[5]
    if "数据图" in value:
        return TEMPLATES[10]
    if cluster_id in ("skin", "brand"):
        return TEMPLATES[0]
    return TEMPLATES[0]


def build_prompt_pack(topic: dict[str, Any], evidence: Iterable[dict[str, Any]] | None = None, template: dict[str, str] | None = None) -> dict[str, Any]:
    """Build the four-layer prompt pack.

    L3 is deliberately a fill-in section: without a real evidence pack the draft
    must not pretend to be claim-bound.
    """
    evidence = list(evidence or [])
    template = template or TEMPLATES[0]
    cluster = CLUSTER_BY_ID.get(topic.get("clusterId") or "")
    product = PRODUCT_BY_ID.get(topic.get("productId") or "")
    audience = (
        "有明确肤质困扰、正在挑底妆的 18—28 岁消费者" if cluster and cluster["id"] == "skin"
        else "已经锁定 2 个候选品牌、需要第三方依据做决策的消费者" if cluster and cluster["id"] == "compare"
        else "在 AI 搜索里做购买决策的美妆消费者"
    )

    if evidence:
        evidence_lines = [
            " | ".join([
                str(entry.get("claim_id") or entry.get("claimId") or ""),
                str(entry.get("text") or ""),
                str(entry.get("evidence_id") or entry.get("evidenceId") or ""),
                str(entry.get("source") or ""),
                str(entry.get("date") or ""),
                str(entry.get("grade") or ""),
                str(entry.get("limitations") or ""),
            ])
            for entry in evidence
        ]
    else:
        evidence_lines = [
            "（待填）把证据包粘在这里。每条一行，格式：",
            "claim_id | claim 原文 | evidence_id | 来源 | 日期 | 证据等级(A-E) | 限制条件",
            "示例：C01 | 控油柔焦，油皮/混油适用 | E01 | 第三方检测报告 | 2025-06-01 | A | 仅油皮/混油",
        ]

    l1 = "\n".join([
        "你是方里 FUNNY ELVES 的 GEO 内容编辑。你的任务不是写营销文案，而是把【证据包】中的 claim 写成可被 AI 引用、可被人审核的答案资产。",
        "硬性规则：",
        *[f"{index + 1}. {rule}" for index, rule in enumerate(HARD_RULES)],
    ])
    l2 = "\n".join([
        f"用户问题：{topic.get('question')}",
        f"内容簇：{topic.get('cluster')}　产品：{(product or {}).get('name') or topic.get('product') or '—'}　形态：{template['name']}（{template['id']}）",
        f"目标人群：{audience}",
        f"篇幅：{template['words']}　结构：结论先行（前 60 字给出结论）→ 证据 → 适用边界 → 对比（如适用）→ 来源",
        f"输出：严格按 JSON 契约，content_type = \"{template['content_type']}\"，title ≤ 30 字。",
    ])
    l3 = "\n".join([
        f"本条选题的证据缺口（来自选题卡）：{topic.get('evidenceGap') or '—'}",
        f"目标证据等级：{topic.get('evidence') or '—'}",
        "本次未提供证据包，起草前必须补齐。" if not evidence else f"本次提供 {len(evidence)} 条 claim。",
        "",
        *evidence_lines,
    ])
    l4 = "\n".join([
        "在输出 JSON 前，逐条自检并在 note 字段写明结论：",
        "1. 每个 block 是否都绑定 claim_ids？没有绑定的段落是否属于转化句或流程说明？",
        "2. 每条 claim 的 evidence_ids 是否都存在于 citations？",
        "3. 是否存在绝对化、医疗、特殊功效表述？有则删除。",
        "4. 是否写了适用边界/不适用人群？",
        "5. 证据不足或冲突的句子，是否改写为“待补充”？",
        "6. risk_level 是否与实际风险相符（敏感肌/功效/对比/价格为 high）？",
    ])

    return {
        "template": template,
        "layers": {"L1": l1, "L2": l2, "L3": l3, "L4": l4},
        "text": "\n".join(["【L1 角色/边界】", l1, "", "【L2 任务】", l2, "", "【L3 证据】", l3, "", "【L4 自检】", l4]),
        "evidenceCount": len(evidence),
        "evidenceMissing": not evidence,
    }


def scan_words(text: Any, words: Iterable[str]) -> dict[str, list[str]]:
    """Scan for restricted words while respecting negation.

    「不是最适合」is a legitimate answer shape and must not be blocked, so an
    occurrence whose four preceding characters contain a negation is passed with
    a warning instead of an error.
    """
    source = str(text or "")
    hits: list[str] = []
    negated: list[str] = []
    for word in words:
        start = source.find(word)
        while start >= 0:
            before = source[max(0, start - NEGATION_WINDOW):start]
            if NEGATION.search(before):
                if word not in negated:
                    negated.append(word)
            elif word not in hits:
                hits.append(word)
            start = source.find(word, start + len(word))
    return {"hits": hits, "negated": negated}


def _is_object(value: Any) -> bool:
    return isinstance(value, dict)


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _draft_text(draft: dict[str, Any]) -> str:
    parts: list[str] = [draft.get("title"), draft.get("summary")]
    for block in _as_list(draft.get("blocks")):
        if isinstance(block, dict):
            parts.append(block.get("text"))
    for claim in _as_list(draft.get("claims")):
        if isinstance(claim, dict):
            parts.append(claim.get("text"))
    return "\n".join(value for value in parts if isinstance(value, str))


def validate_draft(draft: Any) -> dict[str, Any]:
    """Validate a model-returned draft against G1 / G2 / G4."""
    errors: list[str] = []
    warnings: list[str] = []

    if not _is_object(draft):
        return {
            "ok": False,
            "errors": ["G1：草稿不是 JSON 对象（只接受契约的对象）"],
            "warnings": [],
            "stats": {"blocks": 0, "claims": 0, "citations": 0},
        }

    # ---- G1 Schema
    for field in CONTENT_CONTRACT["required"]:
        if draft.get(field) is None:
            errors.append(f"G1：缺少必填字段 {field}")
    if isinstance(draft.get("content_id"), str) and not draft["content_id"].strip():
        errors.append("G1：content_id 为空")
    allowed_types = CONTENT_CONTRACT["properties"]["content_type"]["enum"]
    if draft.get("content_type") is not None and draft["content_type"] not in allowed_types:
        errors.append(f"G1：content_type 必须是 {' / '.join(allowed_types)} 之一，收到 {json.dumps(draft['content_type'], ensure_ascii=False)}")
    if isinstance(draft.get("title"), str) and len(draft["title"]) > 30:
        errors.append(f"G1：title 超过 30 字（当前 {len(draft['title'])} 字）")
    if not isinstance(draft.get("summary"), str) or not draft["summary"].strip():
        errors.append("G1：summary 不能为空")
    allowed_risk = CONTENT_CONTRACT["properties"]["risk_level"]["enum"]
    if draft.get("risk_level") is not None and draft["risk_level"] not in allowed_risk:
        errors.append(f"G1：risk_level 必须是 {' / '.join(allowed_risk)} 之一")
    if not _as_list(draft.get("blocks")):
        errors.append("G1：blocks 至少要有 1 个段落")
    block_types = CONTENT_CONTRACT["properties"]["blocks"]["items"]["properties"]["type"]["enum"]
    for index, block in enumerate(_as_list(draft.get("blocks"))):
        if not _is_object(block):
            errors.append(f"G1：blocks[{index}] 不是对象")
            continue
        if block.get("type") not in block_types:
            errors.append(f"G1：blocks[{index}].type 非法（{json.dumps(block.get('type'), ensure_ascii=False)}）")
        if not isinstance(block.get("text"), str) or not block["text"].strip():
            errors.append(f"G1：blocks[{index}].text 为空")

    # ---- G2 证据绑定
    claim_ids: set[str] = set()
    claim_by_id: dict[str, dict[str, Any]] = {}
    for index, claim in enumerate(_as_list(draft.get("claims"))):
        if not _is_object(claim):
            errors.append(f"G2：claims[{index}] 不是对象")
            continue
        claim_id = claim.get("claim_id")
        if not isinstance(claim_id, str) or not claim_id.strip():
            errors.append(f"G2：claims[{index}] 缺少 claim_id")
            continue
        if claim_id in claim_ids:
            errors.append(f"G2：claim_id 重复（{claim_id}）")
        claim_ids.add(claim_id)
        claim_by_id[claim_id] = claim
        if not _as_list(claim.get("evidence_ids")):
            errors.append(f"G2：claim {claim_id} 没有绑定任何 evidence_id")
        if not isinstance(claim.get("text"), str) or not claim["text"].strip():
            errors.append(f"G2：claim {claim_id} 的 text 为空")
        if not isinstance(claim.get("limitations"), str) or not claim["limitations"].strip():
            warnings.append(f"G2：claim {claim_id} 没写 limitations（适用范围/不适用人群）")
    if not claim_ids:
        errors.append("G2：claims 为空，等于没有任何可核验的事实")

    cited: set[str] = set()
    for index, citation in enumerate(_as_list(draft.get("citations"))):
        if not _is_object(citation):
            errors.append(f"G2：citations[{index}] 不是对象")
            continue
        evidence_id = citation.get("evidence_id")
        if not isinstance(evidence_id, str) or not evidence_id.strip():
            errors.append(f"G2：citations[{index}] 缺少 evidence_id")
            continue
        cited.add(evidence_id)
        if not isinstance(citation.get("source"), str) or not citation["source"].strip():
            errors.append(f"G2：citations[{index}] 缺少 source")
        if not isinstance(citation.get("date"), str) or not citation["date"].strip():
            warnings.append(f"G2：citations[{index}]（{evidence_id}）没写日期，无法判断是否过期")

    for claim in claim_by_id.values():
        for evidence_id in _as_list(claim.get("evidence_ids")):
            if evidence_id not in cited:
                errors.append(f"G2：claim {claim['claim_id']} 引用的 {evidence_id} 不在 citations 里")

    for index, block in enumerate(_as_list(draft.get("blocks"))):
        if not isinstance(block, dict):
            continue
        ids = _as_list(block.get("claim_ids"))
        for claim_id in ids:
            if claim_id not in claim_ids:
                errors.append(f"G2：blocks[{index}] 引用了未声明的 claim_id（{claim_id}）")
        if not ids and block.get("type") == "paragraph":
            warnings.append(f"G2：blocks[{index}] 是段落但没有 claim_ids，确认它不属于功效陈述")

    # ---- G4 合规
    text = _draft_text(draft)
    absolute = scan_words(text, FORBIDDEN_ABSOLUTE)
    medical = scan_words(text, MEDICAL_TERMS)
    special = scan_words(text, SPECIAL_EFFICACY)
    if medical["hits"]:
        errors.append(f"G4：命中医疗术语（{'、'.join(medical['hits'])}），必须删除或改写")
    if absolute["hits"]:
        errors.append(f"G4：命中绝对化用语（{'、'.join(absolute['hits'])}），必须删除或提供合法依据")
    if special["hits"]:
        errors.append(f"G4：命中特殊功效宣称（{'、'.join(special['hits'])}），普通化妆品不得宣称")
    for label, result in (("绝对化用语", absolute), ("医疗术语", medical), ("特殊功效", special)):
        if result["negated"]:
            warnings.append(f"G4：{'、'.join(result['negated'])} 出现在否定语境（{label}），已放行，请人工确认口径")

    # ---- 人审提示（G3 / G5 不在这里通过）
    if draft.get("risk_level") == "high" and draft.get("review_required") is not True:
        warnings.append("G3/G5：risk_level 为 high，但 review_required 不为 true，人审可能被跳过")
    if not _as_list(draft.get("citations")):
        warnings.append("G2：citations 为空，引用率将无法统计")

    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "stats": {
            "blocks": len(_as_list(draft.get("blocks"))),
            "claims": len(_as_list(draft.get("claims"))),
            "citations": len(_as_list(draft.get("citations"))),
            "claimBoundBlocks": sum(1 for block in _as_list(draft.get("blocks")) if isinstance(block, dict) and _as_list(block.get("claim_ids"))),
            "absolute": absolute["hits"],
            "medical": medical["hits"],
            "special": special["hits"],
            "negated": list(dict.fromkeys([*absolute["negated"], *medical["negated"], *special["negated"]])),
        },
    }


def render_draft_markdown(draft: dict[str, Any], *, template_id: str | None = None, content_id: str | None = None) -> str:
    """Render a validated draft to Markdown."""
    lines = [f"# {draft.get('title')}", ""]
    if template_id is not None:
        lines.append(f"模板：{template_id}　类型：{draft.get('content_type')}　风险：{draft.get('risk_level')}")
    if content_id is not None:
        lines.append(f"内容 ID：{content_id}")
    lines.append("")
    lines.append(f"> {draft.get('summary')}")
    lines.append("")
    for block in _as_list(draft.get("blocks")):
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        body = str(block.get("text") or "")
        if kind == "list":
            for line in re.split(r"\n+", body):
                lines.append("- " + re.sub(r"^[-*]\s*", "", line))
        elif kind == "faq":
            lines.append(f"**{body}**")
        elif kind == "table":
            lines.extend(["```", body, "```"])
        else:
            lines.append(body)
        lines.append("")
    claims = _as_list(draft.get("claims"))
    if claims:
        lines.append("## 事实与证据")
        lines.append("| claim | 表述 | 证据 | 适用边界 |")
        lines.append("| --- | --- | --- | --- |")
        for claim in claims:
            if not isinstance(claim, dict):
                continue
            evidence = "、".join(_as_list(claim.get("evidence_ids")))
            lines.append(f"| {claim.get('claim_id')} | {claim.get('text')} | {evidence} | {claim.get('limitations') or '—'} |")
        lines.append("")
    citations = _as_list(draft.get("citations"))
    if citations:
        lines.append("## 来源")
        for citation in citations:
            if not isinstance(citation, dict):
                continue
            date = f"（{citation['date']}）" if isinstance(citation.get("date"), str) and citation["date"] else ""
            url = f" {citation['url']}" if isinstance(citation.get("url"), str) and citation["url"] else ""
            lines.append(f"- {citation.get('evidence_id')} · {citation.get('source')}{date}{url}")
        lines.append("")
    lines.append("---")
    lines.append("发布前仍需三签：事实核查签、法务签、品牌/渠道签；G3 事实蕴含与 G5 品牌语气未由插件判定。")
    return "\n".join(lines).rstrip()
