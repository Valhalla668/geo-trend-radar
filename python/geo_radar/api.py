"""The pipeline: what the DSH tools do, callable from Python.

Every function returns a dict with at least ``ok`` and ``message`` (Markdown),
mirroring the plugin's tool results, plus the structured data behind it. The CLI
in :mod:`geo_radar.cli` is a thin wrapper over these.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from ._numeric import round_1k
from .alerts import build_alerts, render_alerts_markdown, summarize_alerts
from .baseline import (
    compute_metrics,
    create_audit,
    next_batch,
    record_answers,
    render_baseline_markdown,
)
from .calendar import annotate_calendar, calendar_status, render_calendar_markdown
from .config import merged_config, prompts_from
from .draft import (
    CONTENT_CONTRACT,
    build_prompt_pack,
    pick_template,
    render_draft_markdown,
    TEMPLATES,
    validate_draft,
)
from .envfile import env_template
from .evidence import admit_claims, group_claim_rows, render_evidence_markdown
from .hotlist import collect_hotlists, DEFAULT_API_URL, DEFAULT_PLATFORMS, SOURCE_CATALOG
from .lexicon import CLUSTER_BY_NAME, CLUSTERS, DEFAULT_KEYWORD_GROUPS, PRODUCTS
from .match import match_items, merge_scored, parse_keyword_groups
from .pgdb import (
    build_claims_query,
    build_sku_query,
    config_template,
    describe_db_error,
    describe_instance,
    introspect_schema,
    resolve_databases,
    resolve_env_file_path,
    test_connection,
    with_client,
)
from .report import cluster_volume, render_report, render_scan_summary, unique_by_title
from .snapshots import MAX_STORED_ITEMS, compact_item, load_snapshots, save_snapshot
from .sov import build_sov, compute_mentions, render_sov_markdown
from .store import (
    ensure_dir,
    iso_now,
    layout,
    list_files,
    local_date,
    make_stamp,
    parse_iso,
    read_json,
    resolve_data_root,
    sanitize_id,
    write_json,
    write_text,
)
from .topics import build_topics, clean_title, closest_prompt, render_topics_markdown, similarity

PACKAGE_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_ROOT.parent

PASSWORD_SOURCE_LABEL = {
    "environment": "环境变量",
    "env-file": ".env 文件",
    "config-plaintext": "插件 config（明文，建议改掉）",
    "none": "未提供",
}

_ENGINE_LIST = ["doubao", "yuanbao", "quark", "baidu-ai", "xiaohongshu-diandian", "deepseek"]


# --------------------------------------------------------------------------- #
# shared helpers
# --------------------------------------------------------------------------- #

def _paths(config: dict[str, Any]) -> dict[str, Path]:
    return layout(resolve_data_root(config))


def _groups(config: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    text = config.get("keywordGroups")
    return parse_keyword_groups(text if isinstance(text, str) and text.strip() else DEFAULT_KEYWORD_GROUPS)


def _platforms(config: dict[str, Any], requested: Iterable[str] | None = None) -> list[str]:
    configured = config.get("platforms") if isinstance(config.get("platforms"), list) else DEFAULT_PLATFORMS
    wanted = [platform for platform in (requested or configured) if isinstance(platform, str)]
    known = {entry["id"] for entry in SOURCE_CATALOG}
    accepted = [platform for platform in wanted if platform in known]
    return list(dict.fromkeys(accepted)) or list(DEFAULT_PLATFORMS)


def _recent_snapshots(paths: dict[str, Path], days: int, moment: datetime | None = None, scan_limit: int = 120) -> list[dict[str, Any]]:
    snapshots = load_snapshots(paths, scan_limit)
    now = moment or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.astimezone()
    start = (now - timedelta(days=max(1, days))).timestamp() * 1000
    end = now.timestamp() * 1000
    recent = []
    for snapshot in snapshots:
        parsed = parse_iso(snapshot.get("scannedAt"))
        if parsed is None:
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        if start <= parsed.timestamp() * 1000 <= end:
            recent.append(snapshot)
    return recent


def normalize_candidates(entries: Iterable[Any] | None) -> list[dict[str, Any]]:
    """Normalize operator-supplied candidate questions."""
    output: list[dict[str, Any]] = []
    for index, entry in enumerate(entries or []):
        if isinstance(entry, str):
            title = entry.strip()
            if title:
                output.append({"platform": "candidate", "platformName": "候选问题", "rank": index + 1, "title": title, "url": "", "hot": "", "summary": ""})
            continue
        if not isinstance(entry, dict):
            continue
        title = entry.get("title")
        if not isinstance(title, str) or not title.strip():
            continue
        platform = entry.get("platform") if isinstance(entry.get("platform"), str) and entry.get("platform") else "candidate"
        rank = entry.get("rank")
        output.append({
            "platform": platform,
            "platformName": platform,
            "rank": int(rank) if isinstance(rank, (int, float)) else index + 1,
            "title": title.strip(),
            "url": entry.get("url") if isinstance(entry.get("url"), str) else "",
            "hot": entry.get("hot") if isinstance(entry.get("hot"), str) else "",
            "summary": entry.get("summary") if isinstance(entry.get("summary"), str) else "",
        })
    return output[:200]


def _sov_from(paths: dict[str, Path], days: int, moment: datetime | None = None) -> dict[str, Any]:
    snapshots = load_snapshots(paths, 120)
    return build_sov(
        [{"scannedAt": entry.get("scannedAt"), "mentions": entry.get("mentions")} for entry in snapshots],
        days=days,
        now=moment,
    )


# --------------------------------------------------------------------------- #
# scan
# --------------------------------------------------------------------------- #

def run_scan(
    config: dict[str, Any] | None = None,
    *,
    platforms: Iterable[str] | None = None,
    limit: int = 60,
    min_score: float = 0.0,
    topic_limit: int = 20,
    candidates: Iterable[Any] | None = None,
    save: bool = True,
    label: str = "scan",
    moment: datetime | None = None,
    fetcher: Any = None,
) -> dict[str, Any]:
    """Collect hot lists, score them, and build the boards."""
    config = merged_config(config)
    paths = _paths(config)
    selected = _platforms(config, platforms)
    interval_ms = int(config.get("intervalMs") or 600)
    timeout_ms = int(config.get("timeoutMs") or 15000)

    collected = collect_hotlists(
        platforms=selected,
        api_url=config.get("apiUrl") if isinstance(config.get("apiUrl"), str) else DEFAULT_API_URL,
        interval_ms=interval_ms,
        timeout_ms=timeout_ms,
        fetcher=fetcher,
        now=(lambda: moment) if moment is not None else None,
    )
    candidate_items = normalize_candidates(candidates)
    if not collected["items"] and not candidate_items:
        errors = "；".join(f"{entry['name']}: {entry['message']}" for entry in collected["errors"])
        return {
            "ok": False,
            "code": "NO_ITEMS",
            "message": f"没有从任何平台取到热榜（{errors}）",
            "hint": "检查网络或代理，或把 config.apiUrl 指向自建的 newsnow 实例；也可以用 --candidate 传入客服问题与站内搜索词。",
            "platforms": collected["platforms"],
        }

    groups, keyword_warnings = _groups(config)
    scanned_at = iso_now(moment)
    limit = min(200, max(1, limit))
    topic_limit = min(60, max(1, topic_limit))

    hot_matched = match_items(collected["items"], groups=groups, min_score=min_score, limit=limit)
    candidate_matched = match_items(candidate_items, groups=groups, min_score=0.0, limit=200, require_anchor=False)
    matched = [{**item, "scannedAt": scanned_at} for item in merge_scored([candidate_matched, hot_matched], limit)]

    prompts = prompts_from(config)
    topics = build_topics(matched, limit=topic_limit, moment=moment, prompts=prompts)
    alerts = build_alerts(matched, moment=moment)
    mentions = compute_mentions(collected["items"])
    calendar = annotate_calendar(
        calendar_status(moment, horizon_days=int(config.get("horizonDays") or 60)),
        cluster_volume(topics),
    )

    captured = moment or datetime.now()
    snapshot = {
        "id": f"{make_stamp(captured)}-{captured.second:02d}",
        "version": 1,
        "label": sanitize_id(label, "scan"),
        "scannedAt": scanned_at,
        "sources": "newsnow 公开热榜",
        "apiUrl": collected["apiUrl"],
        "platforms": collected["platforms"],
        "platformTotal": len(collected["platforms"]),
        "platformOk": len([entry for entry in collected["platforms"] if entry["status"] != "error"]),
        "errors": collected["errors"],
        "items": len(collected["items"]),
        "candidates": len(candidate_items),
        "matched": len(matched),
        "matchedItems": [compact_item(item) for item in matched[:MAX_STORED_ITEMS]],
        "topicIds": [card["id"] for card in topics],
        "alertIds": [alert["id"] for alert in alerts],
        "mentions": mentions,
    }

    snapshot_path = None
    if save:
        ensure_dir(paths["snapshots"])
        snapshot_path = save_snapshot(paths, snapshot, int(config.get("keepSnapshots") or 60))
        ensure_dir(paths["topics"])
        write_text(paths["topics"] / f"{snapshot['id']}.md", render_topics_markdown(topics, {
            "date": local_date(captured),
            "scannedAt": scanned_at[:16].replace("T", " "),
            "sources": snapshot["sources"],
        }))
        ensure_dir(paths["alerts"])
        write_json(paths["alerts"] / f"{snapshot['id']}.json", {"snapshotId": snapshot["id"], "scannedAt": scanned_at, "alerts": alerts})

    sov = _sov_from(paths, int(config.get("sovDays") or 7), moment) if save else build_sov([], days=int(config.get("sovDays") or 7), now=moment)
    message = render_scan_summary(
        snapshot=snapshot,
        topics=topics,
        alerts=alerts,
        sov=sov,
        calendar=calendar,
        platforms=collected["platforms"],
    )
    return {
        "ok": True,
        "message": message,
        "snapshot": {**{key: snapshot[key] for key in ("id", "scannedAt", "items", "candidates", "matched", "platformOk", "platformTotal", "errors")}, "path": None if snapshot_path is None else str(snapshot_path)},
        "topics": topics,
        "alerts": alerts,
        "sov": sov,
        "calendar": calendar,
        "keywordWarnings": keyword_warnings,
    }


# --------------------------------------------------------------------------- #
# boards
# --------------------------------------------------------------------------- #

def list_topics(
    config: dict[str, Any] | None = None,
    *,
    days: int = 3,
    cluster: str | None = None,
    priority: str | None = None,
    limit: int = 20,
    export: bool = False,
    moment: datetime | None = None,
) -> dict[str, Any]:
    config = merged_config(config)
    paths = _paths(config)
    recent = _recent_snapshots(paths, days, moment, 60)
    if not recent:
        return {"ok": False, "code": "NO_SNAPSHOT", "message": "没有可用的扫描快照。先运行 scan。", "hint": f"数据目录：{paths['snapshots']}"}
    items = unique_by_title(item for snapshot in recent for item in snapshot.get("matchedItems") or [])
    filtered = [
        item for item in items
        if (not cluster or (item.get("cluster") or {}).get("name") == cluster)
        and (not priority or item.get("priority") == priority)
    ]
    cards = build_topics(filtered, limit=min(60, max(1, limit)), moment=moment, prompts=prompts_from(config))
    markdown = render_topics_markdown(cards, {
        "date": local_date(moment),
        "scannedAt": str(recent[0].get("scannedAt"))[:16].replace("T", " "),
        "sources": f"最近 {days} 天的 {len(recent)} 次扫描",
    })
    export_path = None
    if export:
        ensure_dir(paths["reports"])
        moment = moment or datetime.now()
        export_path = write_text(paths["reports"] / f"topics-{local_date(moment)}-{make_stamp(moment)}.md", markdown)
    return {"ok": True, "message": markdown, "topics": cards, "scans": len(recent), "exportPath": None if export_path is None else str(export_path)}


def list_alerts(
    config: dict[str, Any] | None = None,
    *,
    days: int = 3,
    level: str | None = None,
    limit: int = 40,
    moment: datetime | None = None,
) -> dict[str, Any]:
    config = merged_config(config)
    paths = _paths(config)
    recent = _recent_snapshots(paths, days, moment, 60)
    if not recent:
        return {"ok": False, "code": "NO_SNAPSHOT", "message": "没有可用的扫描快照。先运行 scan。", "hint": f"数据目录：{paths['snapshots']}"}
    items = unique_by_title(item for snapshot in recent for item in snapshot.get("matchedItems") or [])
    alerts = [alert for alert in build_alerts(items, moment=moment) if not level or alert["level"] == level][: min(200, max(1, limit))]
    return {
        "ok": True,
        "message": render_alerts_markdown(alerts, {"date": local_date(moment)}),
        "alerts": alerts,
        "summary": summarize_alerts(alerts),
    }


def get_sov(config: dict[str, Any] | None = None, *, days: int = 7, moment: datetime | None = None) -> dict[str, Any]:
    config = merged_config(config)
    paths = _paths(config)
    if not load_snapshots(paths, 1):
        return {"ok": False, "code": "NO_SNAPSHOT", "message": "没有可用的扫描快照。先运行 scan 建立基线。", "hint": f"数据目录：{paths['snapshots']}"}
    sov = _sov_from(paths, max(1, days), moment)
    return {"ok": True, "message": render_sov_markdown(sov), "sov": sov}


def build_report(
    config: dict[str, Any] | None = None,
    *,
    period: str = "daily",
    days: int | None = None,
    export: bool = True,
    moment: datetime | None = None,
) -> dict[str, Any]:
    config = merged_config(config)
    paths = _paths(config)
    days = max(1, days if days is not None else (7 if period == "weekly" else 1))
    recent = _recent_snapshots(paths, days, moment)
    if not recent:
        return {"ok": False, "code": "NO_SNAPSHOT", "message": f"最近 {days} 天没有扫描快照。先运行 scan。", "hint": f"数据目录：{paths['snapshots']}"}
    items = unique_by_title(item for snapshot in recent for item in snapshot.get("matchedItems") or [])
    topics = build_topics(items, limit=20, moment=moment, prompts=prompts_from(config))
    alerts = build_alerts(items, moment=moment)
    sov = _sov_from(paths, max(days, 7), moment)
    calendar = annotate_calendar(calendar_status(moment, horizon_days=60), cluster_volume(topics))
    audit = read_json(paths["baseline"] / "audit.json")
    markdown = render_report(
        period=period,
        moment=moment,
        snapshot={
            "scannedAt": str(recent[0].get("scannedAt")),
            "matched": len(items),
            "sources": f"最近 {days} 天的 {len(recent)} 次扫描",
        },
        topics=topics,
        alerts=alerts,
        sov=sov,
        calendar=calendar,
        audit=audit if isinstance(audit, dict) else None,
        history=[
            {
                "scannedAt": snapshot.get("scannedAt"),
                "items": snapshot.get("items"),
                "matched": snapshot.get("matched"),
                "errors": len(snapshot.get("errors") or []),
            }
            for snapshot in recent[:5]
        ],
    )
    export_path = None
    if export:
        ensure_dir(paths["reports"])
        moment = moment or datetime.now()
        export_path = write_text(paths["reports"] / f"geo-{period}-{local_date(moment)}.md", markdown)
    return {"ok": True, "message": markdown, "topicsCount": len(topics), "alertsCount": len(alerts), "exportPath": None if export_path is None else str(export_path)}


def calendar_view(
    config: dict[str, Any] | None = None,
    *,
    horizon_days: int = 60,
    live: bool = True,
    moment: datetime | None = None,
) -> dict[str, Any]:
    config = merged_config(config)
    paths = _paths(config)
    volume: list[dict[str, Any]] = []
    if live:
        snapshots = load_snapshots(paths, 10)
        items = [item for snapshot in snapshots for item in snapshot.get("matchedItems") or []]
        if items:
            volume = cluster_volume(build_topics(items, limit=40, moment=moment, prompts=prompts_from(config)))
    status = annotate_calendar(calendar_status(moment, horizon_days=max(1, horizon_days)), volume)
    return {"ok": True, "message": render_calendar_markdown(status), "calendar": status}


# --------------------------------------------------------------------------- #
# baseline
# --------------------------------------------------------------------------- #

def baseline_action(
    config: dict[str, Any] | None = None,
    *,
    action: str = "status",
    size: int = 10,
    cluster: str | None = None,
    engine: str | None = None,
    prompt_id: str | None = None,
    entries: Iterable[dict[str, Any]] | None = None,
    reset: bool = False,
    moment: datetime | None = None,
) -> dict[str, Any]:
    config = merged_config(config)
    paths = _paths(config)
    file = paths["baseline"] / "audit.json"

    if action == "init":
        existing = read_json(file)
        if isinstance(existing, dict) and not reset:
            return {
                "ok": True,
                "message": f"审计网格已存在：{existing.get('total')} 行（建立于 {str(existing.get('createdAt'))[:10]}）。如需重建请传 reset=true。",
                "created": False,
                "total": existing.get("total"),
            }
        audit = create_audit(prompts_from(config), created_at=iso_now(moment))
        write_json(file, audit)
        metrics = compute_metrics(audit)
        return {
            "ok": True,
            "message": f"已生成审计网格：{audit['promptCount']} 条提示词 × 平均 {round(audit['total'] / audit['promptCount'], 1)} 个引擎 = {audit['total']} 行。\n\n"
                       + render_baseline_markdown(audit, metrics),
            "created": True,
            "total": audit["total"],
        }

    audit = read_json(file)
    if not isinstance(audit, dict):
        return {"ok": False, "code": "NO_AUDIT", "message": "还没有审计网格。先运行 baseline init。", "hint": f"数据目录：{paths['baseline']}"}

    if action == "next":
        batch = next_batch(audit, max(1, size), cluster=cluster, engine=engine, prompt_id=prompt_id)
        lines = [f"# 待采集批次（{len(batch['batch'])} 条，剩余 {batch['remaining']} 条）", ""]
        if not batch["batch"]:
            lines.append("没有符合条件的待采集行。改用 metrics 看结果，或放宽过滤。")
        else:
            lines.append("| 行 ID | 提示词 ID | 簇 | 提示词 | 引擎 | 优先级 |")
            lines.append("| --- | --- | --- | --- | --- | --- |")
            for row in batch["batch"]:
                lines.append(f"| {row['id']} | {row['promptId']} | {row['cluster']} | {row['prompt']} | {row['engineName']} | {row['priority']} |")
            lines.append("")
            lines.append("把每条引擎答案用 `baseline record` 传回，答案原文会自动派生提及/首选/引用/负面标记。")
        return {"ok": True, "message": "\n".join(lines), "batch": batch["batch"], "remaining": batch["remaining"], "total": batch["total"]}

    if action == "record":
        payload = list(entries or [])
        if not payload:
            return {"ok": False, "code": "MISSING_ENTRIES", "message": "record 需要答案条目，每项含 promptId / engine / answer。"}
        result = record_answers(audit, payload, recorded_at=iso_now(moment))
        write_json(file, audit)
        metrics = compute_metrics(audit)
        skipped = ""
        if result["skipped"]:
            skipped = "，跳过 " + str(len(result["skipped"])) + " 条（" + "；".join(
                f"{entry['promptId']}/{entry['engine']}: {entry['reason']}" for entry in result["skipped"]
            ) + "）"
        return {
            "ok": True,
            "message": f"已录入 {result['recorded']} 条{skipped}。\n\n"
                       + render_baseline_markdown(audit, metrics, {"remaining": audit["total"] - metrics["audited"]}),
            "recorded": result["recorded"],
            "skipped": result["skipped"],
            "metrics": metrics,
        }

    metrics = compute_metrics(audit)
    remaining = audit["total"] - metrics["audited"]
    lines = [render_baseline_markdown(audit, metrics, {"remaining": remaining})]
    if action == "status":
        done = [row for row in audit["rows"] if row.get("status") == "done"]
        last = sorted(row["recordedAt"] for row in done if isinstance(row.get("recordedAt"), str))
        lines.extend(["", f"网格建立：{str(audit.get('createdAt'))[:19].replace('T', ' ')}　最后录入："
                          + ("尚未录入" if not last else last[-1][:19].replace("T", " "))])
    return {"ok": True, "message": "\n".join(lines), "metrics": metrics, "remaining": remaining}


# --------------------------------------------------------------------------- #
# draft
# --------------------------------------------------------------------------- #

def _topic_from_args(args: dict[str, Any]) -> dict[str, Any]:
    cluster_name = args.get("cluster") if isinstance(args.get("cluster"), str) and args.get("cluster") else "品类推荐"
    cluster = CLUSTER_BY_NAME.get(cluster_name, CLUSTERS[0])
    product_name = args.get("product") if isinstance(args.get("product"), str) else ""
    product = next((entry for entry in PRODUCTS if entry["name"] == product_name or product_name in entry["aliases"]), None)
    return {
        "id": None,
        "question": str(args.get("question") or "").strip(),
        "cluster": cluster["name"],
        "clusterId": cluster["id"],
        "product": product["name"] if product else (product_name or "—"),
        "productId": product["id"] if product else None,
        "format": args.get("format") if isinstance(args.get("format"), str) and args.get("format") else cluster["format"],
        "evidenceGap": "未从选题卡继承（直接给定的问题），请人工确认证据缺口",
        "evidence": f"目标证据等级：{_EVIDENCE_HINT.get(cluster['id'], 'B/C + 产品事实卡')}",
        "priority": "P1",
        "source": {"platform": "手动", "rank": None, "url": "", "hot": "", "scannedAt": ""},
    }


_EVIDENCE_HINT = {"compare": "A/B（同规格同时点）", "skin": "A（检测 / 斑贴 / 人体功效）"}


def resolve_topic_card(config: dict[str, Any], args: dict[str, Any], *, moment: datetime | None = None) -> dict[str, Any]:
    """Find a stored topic card by id, or fall back to explicit arguments."""
    wanted = str(args.get("topic_id") or args.get("topicId") or "").strip()
    if not wanted:
        return {"card": _topic_from_args(args), "source": "args"}
    paths = _paths(config)
    recent = _recent_snapshots(paths, 3, moment, 60)
    if not recent:
        return {"error": "没有可用的扫描快照，无法按 id 定位选题卡", "available": []}
    items = unique_by_title(item for snapshot in recent for item in snapshot.get("matchedItems") or [])
    cards = build_topics(items, limit=60, moment=moment, prompts=prompts_from(config))
    card = next((entry for entry in cards if entry["id"] == wanted), None)
    if card is None:
        return {"error": f"最近 3 天的选题卡里没有 {wanted}", "available": [entry["id"] for entry in cards[:12]]}
    product = next((entry for entry in PRODUCTS if entry["name"] == card.get("product")), None)
    return {"card": {**card, "productId": product["id"] if product else None}, "source": "topic"}


def _content_id(moment: datetime | None = None) -> str:
    moment = moment or datetime.now()
    return f"gen_{moment:%Y%m%d_%H%M%S}"


def draft_action(
    config: dict[str, Any] | None = None,
    *,
    action: str = "skeleton",
    topic_id: str | None = None,
    question: str | None = None,
    cluster: str | None = None,
    product: str | None = None,
    fmt: str | None = None,
    evidence: Iterable[dict[str, Any]] | None = None,
    draft: Any = None,
    content_id: str | None = None,
    sku: str | None = None,
    auto_evidence: bool = False,
    save: bool = True,
    moment: datetime | None = None,
) -> dict[str, Any]:
    config = merged_config(config)
    paths = _paths(config)
    args = {"topic_id": topic_id, "question": question, "cluster": cluster, "product": product, "format": fmt}
    identifier = content_id or _content_id(moment)

    if action == "skeleton":
        resolved = resolve_topic_card(config, args, moment=moment)
        if resolved.get("error"):
            return {"ok": False, "code": "TOPIC_NOT_FOUND", "message": resolved["error"],
                    "hint": f"可用选题卡：{'、'.join(resolved.get('available') or [])}" if resolved.get("available") else None}
        card = resolved["card"]
        if not card.get("question"):
            return {"ok": False, "code": "MISSING_QUESTION", "message": "需要 topicId（已有选题卡），或直接给出 question。"}
        template = pick_template(card.get("clusterId"), card.get("format"))
        risk = "high" if card.get("clusterId") in ("skin", "compare", "price") else "medium"
        warnings: list[str] = []
        evidence_items = list(evidence or [])
        evidence_source = "调用方直接提供" if evidence_items else ""
        if auto_evidence:
            databases = _read_databases(config, paths)
            if databases["evidence"] is None:
                warnings.append("证据库未配置，autoEvidence 已跳过；L3 仍是占位符")
            else:
                try:
                    admitted = _pull_admitted(databases["evidence"], sku=sku, keyword=None, limit=80)
                    evidence_items = admitted["evidencePack"]
                    info = describe_instance(databases["evidence"])
                    evidence_source = f"证据库 {info['target']}（准入：可用 {admitted['counts']['green']} 条 / 有条件 {admitted['counts']['yellow']} 条 / 禁用 {admitted['counts']['red']} 条）"
                    if not sku:
                        warnings.append("未指定 sku，已取该库前 80 条 claim；建议按 SKU 收紧，避免 L3 混入无关表述")
                    if admitted["counts"]["red"]:
                        warnings.append(f"证据库有 {admitted['counts']['red']} 条 claim 被判禁用，未进入 L3")
                except Exception as error:  # noqa: BLE001 - surfaced to the caller
                    warnings.append(describe_db_error(error, databases["evidence"]))
        pack = build_prompt_pack(card, evidence_items, template)
        lines = [f"## 生成骨架 · {identifier}", ""]
        lines.append(f"- 选题：{card['question']}")
        lines.append(f"- 内容簇：{card.get('cluster')}　产品：{card.get('product')}　形态：{card.get('format')}")
        lines.append(f"- 模板：{template['id']} {template['name']}（{template['words']}，content_type={template['content_type']}）")
        lines.append(f"- 建议风险等级：{risk}")
        if pack["evidenceMissing"]:
            lines.append("- 证据：⚠️ 未提供证据包，L3 已留下占位符，起草前必须补齐")
        else:
            lines.append(f"- 证据：已提供 {pack['evidenceCount']} 条 claim")
        if evidence_source:
            lines.append(f"- 证据来源：{evidence_source}")
        for warning in warnings:
            lines.append(f"- ⚠️ {warning}")
        if card.get("evidenceGap"):
            lines.append(f"- 证据缺口（选题卡）：{card['evidenceGap']}")
        lines.extend(["", "### 四层 Prompt（复制给模型）", "```text", pack["text"], "```", "", "### JSON 契约", "```json",
                      json.dumps(CONTENT_CONTRACT, ensure_ascii=False, indent=2), "```", "", "### 交付前必过",
                      "- G1 Schema / G2 证据绑定 / G4 合规：模型回传后运行 `draft validate`",
                      "- G3 事实蕴含、G5 品牌语气、三签：人审，插件不判定"])
        prompt_path = None
        if save:
            ensure_dir(paths["drafts"])
            prompt_path = write_text(paths["drafts"] / f"{sanitize_id(identifier, 'draft')}.prompt.md", "\n".join(lines) + "\n")
        return {
            "ok": True,
            "message": "\n".join(lines),
            "contentId": identifier,
            "template": {"id": template["id"], "name": template["name"], "contentType": template["content_type"], "words": template["words"]},
            "suggestedRisk": risk,
            "warnings": warnings,
            "evidenceSource": evidence_source,
            "prompt": pack["layers"],
            "contract": CONTENT_CONTRACT,
            "promptPath": None if prompt_path is None else str(prompt_path),
        }

    if draft is None:
        return {"ok": False, "code": "MISSING_DRAFT", "message": "validate / render 需要 draft（契约的 JSON 对象或其字符串）。"}
    if isinstance(draft, str):
        try:
            draft = json.loads(draft)
        except json.JSONDecodeError:
            return {"ok": False, "code": "DRAFT_NOT_JSON", "message": "draft 不是合法 JSON，请只回传契约里的 JSON 本身。"}

    resolved = resolve_topic_card(config, args, moment=moment)
    template = (
        pick_template(resolved["card"].get("clusterId"), resolved["card"].get("format"))
        if resolved.get("source") == "topic"
        else next((entry for entry in TEMPLATES if entry["content_type"] == draft.get("content_type")), TEMPLATES[0])
    )
    report = validate_draft(draft)
    header = [f"## 契约校验 · {draft.get('content_id') or identifier}", ""]
    header.append(f"结果：**通过**（警告 {len(report['warnings'])} 条）" if report["ok"] else f"结果：**未通过**（错误 {len(report['errors'])} 条，警告 {len(report['warnings'])} 条）")
    header.append("")
    if report["errors"]:
        header.append("### 阻断项")
        header.extend(f"- {error}" for error in report["errors"])
        header.append("")
    if report["warnings"]:
        header.append("### 警告")
        header.extend(f"- {warning}" for warning in report["warnings"])
        header.append("")
    stats = report["stats"]
    header.append("### 统计")
    header.append(f"blocks {stats['blocks']}（已绑定 claim {stats['claimBoundBlocks']}）｜claims {stats['claims']}｜citations {stats['citations']}")
    header.extend(["", "G3 事实蕴含、G5 品牌语气与三签不由本工具判定，仍需人审。"])

    if action == "render":
        if not report["ok"]:
            return {"ok": False, "code": "CONTRACT_FAILED", "message": "\n".join(header),
                    "hint": "先按阻断项改写草稿，再重新 render。", "report": report}
        markdown = render_draft_markdown(draft, template_id=template["id"], content_id=str(draft.get("content_id") or identifier))
        json_path = markdown_path = None
        if save:
            ensure_dir(paths["drafts"])
            base = sanitize_id(str(draft.get("content_id") or identifier), "draft")
            json_path = write_json(paths["drafts"] / f"{base}.json", draft)
            markdown_path = write_text(paths["drafts"] / f"{base}.md", markdown + "\n")
        return {
            "ok": True,
            "message": markdown,
            "contentId": str(draft.get("content_id") or identifier),
            "template": {"id": template["id"], "name": template["name"]},
            "report": report,
            "jsonPath": None if json_path is None else str(json_path),
            "markdownPath": None if markdown_path is None else str(markdown_path),
        }

    json_path = None
    if report["ok"] and save:
        ensure_dir(paths["drafts"])
        json_path = write_json(paths["drafts"] / f"{sanitize_id(str(draft.get('content_id') or identifier), 'draft')}.json", draft)
    return {
        "ok": report["ok"],
        "message": "\n".join(header),
        "report": report,
        "jsonPath": None if json_path is None else str(json_path),
    }


# --------------------------------------------------------------------------- #
# evidence and database
# --------------------------------------------------------------------------- #

def _read_databases(config: dict[str, Any], paths: dict[str, Path]) -> dict[str, Any]:
    env_file = resolve_env_file_path(config, paths["root"], PROJECT_ROOT)
    return resolve_databases(config, env_file=env_file)


def _pull_admitted(instance: dict[str, Any], *, sku: str | None, keyword: str | None, limit: int) -> dict[str, Any]:
    text, params = build_claims_query(instance, {"sku": sku, "keyword": keyword, "limit": limit})
    rows = with_client(instance, lambda cursor: cursor.execute(text, params))
    claims = group_claim_rows(rows)
    admitted = admit_claims(claims)
    return {**admitted, "claims": claims, "rowCount": len(rows)}


def evidence_action(
    config: dict[str, Any] | None = None,
    *,
    action: str = "lookup",
    sku: str | None = None,
    keyword: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    config = merged_config(config)
    paths = _paths(config)
    databases = _read_databases(config, paths)
    limit = min(200, max(1, limit))

    if action == "sku":
        if databases["product"] is None:
            return _not_configured(databases, "product")
        instance = databases["product"]
        text, params = build_sku_query(instance, {"sku": sku, "keyword": keyword, "limit": limit})
        try:
            rows = with_client(instance, lambda cursor: cursor.execute(text, params))
        except Exception as error:  # noqa: BLE001
            return {"ok": False, "code": "DB_QUERY_FAILED", "message": describe_db_error(error, instance),
                    "hint": "先用 `db schema` 核对商品表字段名。"}
        lines = [f"# 商品事实卡 · {len(rows)} 条", ""]
        if not rows:
            lines.append("没有查到 SKU。确认 sku_code 拼写，或到商品库核对。")
        else:
            lines.append("| SKU | 产品 | 规格 | 价格 | 备案号 | 适用肤质 |")
            lines.append("| --- | --- | --- | --- | --- | --- |")
            for row in rows:
                lines.append(f"| {row.get('sku_code', '—')} | {row.get('product_name', '—')} | {row.get('spec', '—')} | {row.get('price_cny', '—')} | {row.get('filing_no', '—')} | {row.get('skin_types', '—')} |")
        return {"ok": True, "message": "\n".join(lines), "skus": rows}

    if databases["evidence"] is None:
        return _not_configured(databases, "evidence")
    instance = databases["evidence"]
    try:
        admitted = _pull_admitted(instance, sku=sku, keyword=keyword, limit=limit)
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "code": "DB_QUERY_FAILED", "message": describe_db_error(error, instance),
                "hint": "先用 `db schema` 核对证据表的表名与字段名。"}
    info = describe_instance(instance) or {}
    query_parts = ["不限 SKU" if not sku else f"SKU {sku}"]
    if keyword:
        query_parts.append(f"关键词「{keyword}」")
    query_parts.append(f"上限 {limit}")
    query = "，".join(query_parts)
    return {
        "ok": True,
        "message": render_evidence_markdown(admitted, {"target": info.get("target"), "schema": info.get("schema"), "query": query}),
        "counts": admitted["counts"],
        "evidencePack": admitted["evidencePack"],
        "claims": admitted["claims"],
    }


def _not_configured(databases: dict[str, Any], name: str) -> dict[str, Any]:
    label = "证据库" if name == "evidence" else "商品库"
    own = [problem for problem in databases["problems"] if problem.startswith(f"databases.{name}")]
    detail = "；".join(own) if own else f"databases.{name} 未配置"
    return {"ok": False, "code": "DB_NOT_CONFIGURED", "message": f"{label}未配置：{detail}",
            "hint": "运行 `db template` 取配置模板，填好后重试。"}


def db_action(
    config: dict[str, Any] | None = None,
    *,
    action: str = "status",
    instance: str = "evidence",
    tables: Iterable[str] | None = None,
    sku: str | None = None,
) -> dict[str, Any]:
    config = merged_config(config)
    paths = _paths(config)
    databases = _read_databases(config, paths)
    name = "product" if instance == "product" else "evidence"
    label = "证据库" if name == "evidence" else "商品库"

    if action == "template":
        body = config_template()
        return {"ok": True, "message": "```yaml\n" + body + "\n```", "template": body}

    if action == "env":
        body = env_template()
        lines = ["## 数据库凭据", ""]
        lines.append(f"- 凭据文件：{databases['envFile'] or '未指定（只读环境变量）'}")
        if databases["envFile"] is not None:
            lines.append(f"- 文件状态：{'存在' if databases['envFileExists'] else '不存在，按下面内容新建即可'}")
        lines.append("- 优先级：真实环境变量 > .env 文件 > 插件 config 里的明文口令（兼容用，不建议）")
        for key in ("evidence", "product"):
            info = describe_instance(databases[key])
            piece = "证据库" if key == "evidence" else "商品库"
            if info is None:
                lines.append(f"- {piece}：未配置连接")
                continue
            source = PASSWORD_SOURCE_LABEL.get(info["passwordSource"], info["passwordSource"])
            variable = "" if not info["passwordVariable"] else f"（变量 {info['passwordVariable']}）"
            lines.append(f"- {piece} 口令：{source}{variable}")
            if info["passwordWarning"]:
                lines.append(f"  - ⚠️ {info['passwordWarning']}")
        lines.extend(["", "把下面两行写进凭据文件，或用同名环境变量注入：", "", "```dotenv", body, "```"])
        return {"ok": True, "message": "\n".join(lines), "template": body}

    if action == "status":
        driver = "ok"
        try:
            import psycopg  # noqa: F401
        except ModuleNotFoundError:
            driver = "missing"
        lines = ["# GEO 数据库通道", ""]
        lines.append(f"- psycopg 驱动：{'已安装' if driver == 'ok' else '未安装（pip install psycopg[binary]）'}")
        existence = "" if databases["envFileExists"] else "（不存在）"
        lines.append(f"- 凭据文件：{(databases['envFile'] or '未指定')}{existence if databases['envFile'] else ''}")
        for key in ("evidence", "product"):
            info = describe_instance(databases[key])
            piece = "证据库" if key == "evidence" else "商品库"
            if info is None:
                lines.append(f"- {piece}：未配置")
                continue
            lines.append(f"- {piece}：{info['target']}　user={info['user']}　ssl={info['ssl']}　schema={info['schema']}　表={'、'.join(info['tables'].values())}")
            source = PASSWORD_SOURCE_LABEL.get(info["passwordSource"], info["passwordSource"])
            variable = "" if not info["passwordVariable"] else f"（变量 {info['passwordVariable']}）"
            lines.append(f"  - 口令：{source}{variable}")
            if info["passwordWarning"]:
                lines.append(f"  - ⚠️ {info['passwordWarning']}")
        if databases["problems"]:
            lines.append(f"- 待补配置：{'；'.join(databases['problems'])}")
        lines.extend(["", "下一步：`db template` 取连接模板、`db env` 取凭据说明 → 填好后 `db test`。"])
        return {"ok": True, "message": "\n".join(lines), "driver": driver, "databases": {key: describe_instance(databases[key]) for key in ("evidence", "product")}}

    selected = databases[name]
    if selected is None:
        return _not_configured(databases, name)
    info = describe_instance(selected) or {}

    if action == "test":
        try:
            result = test_connection(selected)
        except Exception as error:  # noqa: BLE001
            return {"ok": False, "code": "DB_CONNECT_FAILED", "message": describe_db_error(error, selected),
                    "hint": "确认端口已放开、账号可登录、pg_hba 允许该来源。"}
        lines = [f"## {label}连通", "", f"- 目标：{info.get('target')}", f"- 数据库：{result['database']}　账号：{result['user']}",
                 f"- 版本：{result['version']}", "- 会话：只读（set session characteristics as transaction read only）"]
        return {"ok": True, "message": "\n".join(lines), "result": result}

    if action == "schema":
        try:
            found = introspect_schema(selected, [table for table in (tables or []) if table])
        except Exception as error:  # noqa: BLE001
            return {"ok": False, "code": "DB_SCHEMA_FAILED", "message": describe_db_error(error, selected),
                    "hint": "只读账号通常可以读 information_schema；若被禁，请让 DBA 放开。"}
        lines = [f"## {label} · schema {found['schema']}", "", f"表（{len(found['tables'])}）：{'、'.join(found['tables']) or '（空）'}", ""]
        by_table: dict[str, list[dict[str, Any]]] = {}
        for column in found["columns"]:
            by_table.setdefault(column["table"], []).append(column)
        for table, columns in by_table.items():
            lines.append(f"### {table}")
            lines.append("| 字段 | 类型 | 可空 |")
            lines.append("| --- | --- | --- |")
            for column in columns:
                lines.append(f"| {column['column']} | {column['type']} | {'是' if column['nullable'] else '否'} |")
            lines.append("")
        lines.append("把上面的表名与字段名填进 `databases.*.mapping`，或在 config 里用 `sql` 覆盖查询。")
        return {"ok": True, "message": "\n".join(lines), "introspection": found}

    builder = build_claims_query if name == "evidence" else build_sku_query
    text, params = builder(selected, {"sku": sku, "keyword": None, "limit": 5})
    try:
        rows = with_client(selected, lambda cursor: cursor.execute(text, params))
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "code": "DB_QUERY_FAILED", "message": describe_db_error(error, selected),
                "hint": "若报“表/列不存在”，先用 `db schema` 导出真实字段名再改 mapping。"}
    fields = list(rows[0].keys()) if rows else []
    lines = [f"## {label} · 取样 {len(rows)} 行", ""]
    if not rows:
        lines.append("查询执行成功，但没有返回行。可能是过滤条件过窄，或该表为空。")
    else:
        lines.append(f"返回字段：{'、'.join(fields)}")
        lines.extend(["", "```json", json.dumps(rows[:3], ensure_ascii=False, indent=2, default=str), "```"])
    lines.extend(["", "用它核对 mapping 里的字段名是否拼对。"])
    return {"ok": True, "message": "\n".join(lines), "fields": fields, "rows": rows[:5]}


# --------------------------------------------------------------------------- #
# status
# --------------------------------------------------------------------------- #

def status(config: dict[str, Any] | None = None, *, probe: bool = False) -> dict[str, Any]:
    config = merged_config(config)
    paths = _paths(config)
    groups, warnings = _groups(config)
    snapshots = list_files(paths["snapshots"], lambda name: name.endswith(".json"))
    latest = read_json(paths["latest"])
    audit = read_json(paths["baseline"] / "audit.json")
    metrics = compute_metrics(audit) if isinstance(audit, dict) else None
    databases = _read_databases(config, paths)

    lines = ["# GEO 雷达状态", ""]
    lines.append(f"- 数据目录：{paths['root']}")
    latest_text = "" if not isinstance(latest, dict) else f"，最近一次 {str(latest.get('scannedAt'))[:16].replace('T', ' ')}"
    lines.append(f"- 扫描快照：{len(snapshots)} 个{latest_text}")
    group_text = "、".join(f"{group['name']}:{len(group['terms'])}" for group in groups)
    lines.append(f"- 关键词分组：{len(groups)} 组（{group_text}）")
    if warnings:
        warning_text = "；".join(f"{entry['line']} → {entry['message']}" for entry in warnings)
        lines.append(f"- ⚠️ 正则告警：{warning_text}")
    if metrics is None:
        lines.append("- 基线审计：尚未建立（`baseline init`）")
    else:
        lines.append(f"- 基线审计：{metrics['audited']}/{metrics['total']} 已采集（{metrics['coverage']}%）")
    lines.append(f"- 热榜接口：{config.get('apiUrl') or '默认 newsnow 公共接口（可配置 apiUrl）'}")
    lines.append(f"- 默认平台：{'、'.join(_platforms(config))}")
    for key in ("evidence", "product"):
        info = describe_instance(databases[key])
        piece = "证据库" if key == "evidence" else "商品库"
        lines.append(f"- {piece}：未配置" if info is None else f"- {piece}：{info['target']}（口令：{PASSWORD_SOURCE_LABEL.get(info['passwordSource'], info['passwordSource'])}）")
    probe_result = None
    if probe:
        platform = _platforms(config)[0]
        try:
            result = collect_hotlists(platforms=[platform], interval_ms=0)
            probe_result = {"platform": platform, "ok": bool(result["items"]), "items": len(result["items"]), "errors": result["errors"]}
            lines.append(f"- 连通性实测（{platform}）：" + (f"成功，取到 {len(result['items'])} 条" if result["items"] else f"失败：{result['errors']}"))
        except Exception as error:  # noqa: BLE001
            probe_result = {"platform": platform, "ok": False, "items": 0, "errors": [{"message": str(error)}]}
            lines.append(f"- 连通性实测（{platform}）：失败 {error}")
    return {
        "ok": True,
        "message": "\n".join(lines),
        "dataRoot": str(paths["root"]),
        "snapshots": len(snapshots),
        "keywordGroups": [{"name": group["name"], "terms": len(group["terms"])} for group in groups],
        "baseline": None if metrics is None else {"audited": metrics["audited"], "total": metrics["total"], "coverage": metrics["coverage"]},
        "probe": probe_result,
    }
