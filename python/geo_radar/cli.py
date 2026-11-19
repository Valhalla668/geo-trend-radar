"""Command line entry point.

    geo-radar scan --label daily
    geo-radar topics --days 3 --export
    geo-radar baseline next --size 10
    geo-radar draft skeleton --topic-id GT-20260101-001

Every subcommand prints the Markdown a human reads; pass ``--json`` for the
structured result, which is what the library returns.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence

from . import api
from .config import load_config, merged_config


def _load_json_file(path: str | None) -> Any:
    if not path:
        return None
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="geo-radar", description="GEO 热点雷达：热榜 → 选题卡 / 预警 / 声量 / 草稿校验")
    parser.add_argument("--config", help="配置文件（JSON；装了 PyYAML 也支持 YAML）")
    parser.add_argument("--data-dir", help="覆盖数据目录，默认 ~/.dsh/geo-trend-radar")
    parser.add_argument("--json", action="store_true", help="输出结构化 JSON 而不是 Markdown")
    subparsers = parser.add_subparsers(dest="command", required=True)

    scan = subparsers.add_parser("scan", help="采集热榜并生成选题卡、预警、声量与日历")
    scan.add_argument("--label", default="scan")
    scan.add_argument("--platforms", nargs="+")
    scan.add_argument("--limit", type=int, default=60)
    scan.add_argument("--min-score", type=float, default=0.0)
    scan.add_argument("--topic-limit", type=int, default=20)
    scan.add_argument("--candidate", action="append", help="额外候选问题，可重复")
    scan.add_argument("--no-save", action="store_true")

    topics = subparsers.add_parser("topics", help="从快照重建选题卡")
    topics.add_argument("--days", type=int, default=3)
    topics.add_argument("--cluster")
    topics.add_argument("--priority", choices=["P0", "P1", "P2"])
    topics.add_argument("--limit", type=int, default=20)
    topics.add_argument("--export", action="store_true")

    alerts = subparsers.add_parser("alerts", help="负面与合规预警")
    alerts.add_argument("--days", type=int, default=3)
    alerts.add_argument("--level", choices=["high", "medium", "low"])
    alerts.add_argument("--limit", type=int, default=40)

    sov = subparsers.add_parser("sov", help="竞品公开热榜声量份额")
    sov.add_argument("--days", type=int, default=7)

    report = subparsers.add_parser("report", help="日报 / 周报")
    report.add_argument("--period", choices=["daily", "weekly"], default="daily")
    report.add_argument("--days", type=int)
    report.add_argument("--no-export", action="store_true")

    calendar = subparsers.add_parser("calendar", help="公关日历窗口")
    calendar.add_argument("--horizon-days", type=int, default=60)
    calendar.add_argument("--no-live", action="store_true")

    baseline = subparsers.add_parser("baseline", help="基线审计网格")
    baseline.add_argument("action", choices=["init", "next", "record", "metrics", "status"])
    baseline.add_argument("--size", type=int, default=10)
    baseline.add_argument("--cluster")
    baseline.add_argument("--engine")
    baseline.add_argument("--prompt")
    baseline.add_argument("--reset", action="store_true")
    baseline.add_argument("--record-file", help="答案条目 JSON 文件（数组）")

    draft = subparsers.add_parser("draft", help="生成骨架与契约校验")
    draft.add_argument("action", choices=["skeleton", "validate", "render"])
    draft.add_argument("--topic-id")
    draft.add_argument("--question")
    draft.add_argument("--cluster")
    draft.add_argument("--product")
    draft.add_argument("--format")
    draft.add_argument("--evidence-file", help="证据包 JSON 文件（数组）")
    draft.add_argument("--draft-file", help="草稿 JSON 文件")
    draft.add_argument("--content-id")
    draft.add_argument("--sku")
    draft.add_argument("--auto-evidence", action="store_true")
    draft.add_argument("--no-save", action="store_true")

    evidence = subparsers.add_parser("evidence", help="证据库准入 / 商品事实卡")
    evidence.add_argument("action", nargs="?", choices=["lookup", "sku"], default="lookup")
    evidence.add_argument("--sku")
    evidence.add_argument("--keyword")
    evidence.add_argument("--limit", type=int, default=50)

    db = subparsers.add_parser("db", help="PostgreSQL 只读通道")
    db.add_argument("action", choices=["status", "template", "env", "test", "schema", "sample"])
    db.add_argument("--instance", choices=["evidence", "product"], default="evidence")
    db.add_argument("--tables", nargs="+")
    db.add_argument("--sku")

    status = subparsers.add_parser("status", help="运行条件自检")
    status.add_argument("--probe", action="store_true")

    return parser


def _dispatch(args: argparse.Namespace, config: dict[str, Any]) -> dict[str, Any]:
    command = args.command
    if command == "scan":
        return api.run_scan(
            config,
            platforms=args.platforms,
            limit=args.limit,
            min_score=args.min_score,
            topic_limit=args.topic_limit,
            candidates=args.candidate,
            save=not args.no_save,
            label=args.label,
        )
    if command == "topics":
        return api.list_topics(config, days=args.days, cluster=args.cluster, priority=args.priority, limit=args.limit, export=args.export)
    if command == "alerts":
        return api.list_alerts(config, days=args.days, level=args.level, limit=args.limit)
    if command == "sov":
        return api.get_sov(config, days=args.days)
    if command == "report":
        return api.build_report(config, period=args.period, days=args.days, export=not args.no_export)
    if command == "calendar":
        return api.calendar_view(config, horizon_days=args.horizon_days, live=not args.no_live)
    if command == "baseline":
        entries = _load_json_file(args.record_file)
        return api.baseline_action(
            config,
            action=args.action,
            size=args.size,
            cluster=args.cluster,
            engine=args.engine,
            prompt_id=args.prompt,
            entries=entries if isinstance(entries, list) else None,
            reset=args.reset,
        )
    if command == "draft":
        evidence = _load_json_file(args.evidence_file)
        draft = _load_json_file(args.draft_file) if args.draft_file else None
        return api.draft_action(
            config,
            action=args.action,
            topic_id=args.topic_id,
            question=args.question,
            cluster=args.cluster,
            product=args.product,
            fmt=args.format,
            evidence=evidence if isinstance(evidence, list) else None,
            draft=draft,
            content_id=args.content_id,
            sku=args.sku,
            auto_evidence=args.auto_evidence,
            save=not args.no_save,
        )
    if command == "evidence":
        return api.evidence_action(config, action=args.action, sku=args.sku, keyword=args.keyword, limit=args.limit)
    if command == "db":
        return api.db_action(config, action=args.action, instance=args.instance, tables=args.tables, sku=args.sku)
    if command == "status":
        return api.status(config, probe=args.probe)
    return {"ok": False, "message": f"未知命令：{command}"}


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        config = load_config(args.config)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"配置读取失败：{error}", file=sys.stderr)
        return 2
    if args.data_dir:
        config = {**config, "dataDir": args.data_dir}
    config = merged_config(config)

    try:
        result = _dispatch(args, config)
    except KeyboardInterrupt:
        return 130
    except Exception as error:  # noqa: BLE001 - CLI boundary
        if args.json:
            print(json.dumps({"ok": False, "message": str(error)}, ensure_ascii=False, indent=2))
        else:
            print(f"执行失败：{error}", file=sys.stderr)
        return 1

    if args.json:
        payload = {key: value for key, value in result.items() if key != "message"}
        payload["ok"] = result.get("ok", False)
        print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
    else:
        print(result.get("message", ""))
        if not result.get("ok", True) and result.get("hint"):
            print(f"\n提示：{result['hint']}")
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
