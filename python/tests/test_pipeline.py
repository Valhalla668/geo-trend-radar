"""Storage, audit, drafts, credentials and the end-to-end pipeline."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from geo_radar import api
from geo_radar.baseline import compute_metrics, create_audit, derive_flags, engines_for, next_batch, record_answers
from geo_radar.config import load_prompts
from geo_radar.draft import build_prompt_pack, pick_template, scan_words, validate_draft, render_draft_markdown
from geo_radar.envfile import clear_env_cache, default_password_variable, parse_dotenv, resolve_password
from geo_radar.lexicon import FORBIDDEN_ABSOLUTE
from geo_radar.pgdb import build_claims_query, build_sku_query, describe_db_error, describe_instance, normalize_instance
from geo_radar.snapshots import compact_item, load_snapshots, save_snapshot
from geo_radar.store import layout, resolve_data_root, write_json


def config_for(tmp_path: Path) -> dict:
    return {"dataDir": str(tmp_path)}


# --------------------------------------------------------------------------- #
# storage
# --------------------------------------------------------------------------- #

def test_snapshot_round_trip_keeps_the_shape_the_js_reader_expects(tmp_path: Path) -> None:
    paths = layout(tmp_path)
    snapshot = {
        "id": "20261117-1200-01",
        "version": 1,
        "scannedAt": "2026-11-17T12:00:01.000Z",
        "items": 3,
        "candidates": 1,
        "matched": 1,
        "matchedItems": [compact_item({"title": "方里粉饼适合干皮吗", "platform": "candidate", "score": 69.2, "cluster": {"id": "skin", "name": "肤质肤况"}})],
        "mentions": {"totalItems": 3, "totalMentions": 1, "brands": []},
    }
    save_snapshot(paths, snapshot, 60)
    loaded = load_snapshots(paths, 10)
    assert len(loaded) == 1
    assert isinstance(loaded[0]["matched"], int)
    assert isinstance(loaded[0]["matchedItems"], list)
    assert loaded[0]["matchedItems"][0]["cluster"]["name"] == "肤质肤况"


def test_snapshots_are_newest_first_and_pruning_keeps_the_newest(tmp_path: Path) -> None:
    paths = layout(tmp_path)
    for index in (1, 2, 3):
        save_snapshot(paths, {"id": f"20261117-1200-0{index}", "scannedAt": f"2026-11-17T12:00:0{index}.000Z", "matchedItems": []}, 2)
    loaded = load_snapshots(paths, 10)
    assert [entry["id"] for entry in loaded] == ["20261117-1200-03", "20261117-1200-02"]


def test_data_root_defaults_to_the_shared_directory() -> None:
    assert str(resolve_data_root({})).endswith(str(Path(".dsh/geo-trend-radar")))
    assert str(resolve_data_root({"dataDir": "~/geo"})) == str(Path.home() / "geo")


# --------------------------------------------------------------------------- #
# interop with the JavaScript writer
# --------------------------------------------------------------------------- #

def test_reads_a_snapshot_written_by_the_javascript_implementation(tmp_path: Path) -> None:
    paths = layout(tmp_path)
    paths["snapshots"].mkdir(parents=True, exist_ok=True)
    js_snapshot = {
        "id": "20261117-1401-28",
        "version": 1,
        "label": "verify-clean",
        "scannedAt": "2026-11-17T14:01:28.018Z",
        "sources": "newsnow 公开热榜",
        "apiUrl": "https://newsnow.busiyi.world/api/s",
        "platforms": [],
        "platformTotal": 6,
        "platformOk": 3,
        "errors": [],
        "items": 90,
        "candidates": 7,
        "matched": 7,
        "matchedItems": [
            {
                "platform": "站内搜索",
                "platformName": "站内搜索",
                "rank": 3,
                "title": "方里粉底液色号怎么选 黄一白",
                "url": "",
                "hot": "",
                "score": 94,
                "priority": "P0",
                "cluster": {"id": "product", "name": "产品决策"},
                "clusters": [{"id": "product", "name": "产品决策", "cues": ["色号", "怎么选"]}],
                "product": {"id": "longwear-5", "name": "方里持妆粉底液 5.0"},
                "format": "FAQ / 短答案",
                "entities": {"isBrand": True, "brandHits": ["方里"], "parentHits": [], "founderHits": [], "competitors": [], "isCompetitor": False, "mentionsEntity": True},
                "negative": [],
                "compliance": {"absolute": [], "medical": [], "special": [], "total": 0},
                "riskScore": 0,
                "evidenceGap": "缺产品事实卡：色号、规格、备案号、适用肤质需与产品页一致",
                "reasons": ["提及方里"],
                "scannedAt": "2026-11-17T14:01:28.018Z",
            }
        ],
        "topicIds": ["GT-20261117-001"],
        "alertIds": [],
        "mentions": {"totalItems": 90, "totalMentions": 0, "brands": [], "platforms": []},
    }
    write_json(paths["snapshots"] / f"{js_snapshot['id']}.json", js_snapshot)
    write_json(paths["latest"], {"id": js_snapshot["id"], "scannedAt": js_snapshot["scannedAt"]})

    result = api.list_topics(config_for(tmp_path), days=3650, moment=datetime(2026, 11, 17, 15, tzinfo=timezone.utc))
    assert result["ok"] is True
    assert len(result["topics"]) == 1
    card = result["topics"][0]
    assert card["cluster"] == "产品决策"
    assert card["product"] == "方里持妆粉底液 5.0"
    assert card["score"] == 94


# --------------------------------------------------------------------------- #
# scan pipeline with an injected fetcher
# --------------------------------------------------------------------------- #

def test_scan_builds_boards_and_saves_a_snapshot(tmp_path: Path) -> None:
    payloads = {
        "zhihu": {"items": [{"title": "方里柔焦蜜粉饼适合油皮吗", "url": "https://www.zhihu.com/question/1"}]},
        "weibo": {"items": [{"title": "冬天羽绒服怎么选", "url": "https://s.weibo.com/weibo?q=2"}]},
    }

    def fetcher(url: str) -> dict:
        platform = url.split("id=")[-1]
        return payloads.get(platform, {"items": []})

    result = api.run_scan(
        config_for(tmp_path),
        platforms=["zhihu", "weibo"],
        candidates=[{"title": "方里粉饼适合干皮吗", "platform": "客服"}],
        fetcher=fetcher,
        moment=datetime(2026, 11, 17, 12, 0, 5, tzinfo=timezone.utc),
    )
    assert result["ok"] is True
    snapshot = result["snapshot"]
    assert snapshot["items"] == 2
    assert snapshot["candidates"] == 1
    assert snapshot["matched"] == 2, "the seasonal headline is filtered out"
    assert Path(snapshot["path"]).exists()
    assert "GEO 雷达扫描" in result["message"]
    assert {card["cluster"] for card in result["topics"]} <= {"肤质肤况", "场景需求", "品类推荐", "产品决策", "竞品对比", "品牌认知", "价格渠道", "出海/英文"}


def test_scan_reports_a_total_failure_without_faking_data(tmp_path: Path) -> None:
    def fetcher(url: str) -> dict:
        raise RuntimeError("HTTP 500 · Server Error")

    result = api.run_scan(config_for(tmp_path), platforms=["zhihu"], fetcher=fetcher)
    assert result["ok"] is False
    assert result["code"] == "NO_ITEMS"
    assert "HTTP 500" in result["message"]


# --------------------------------------------------------------------------- #
# baseline audit
# --------------------------------------------------------------------------- #

def test_audit_grid_expands_and_counts(tmp_path: Path) -> None:
    prompts = load_prompts()
    audit = create_audit(prompts)
    expected = sum(len(engines_for(prompt)) for prompt in prompts)
    assert audit["promptCount"] == 20
    assert audit["total"] == expected
    assert len({row["id"] for row in audit["rows"]}) == audit["total"]
    assert engines_for({"engines": "全部"}) == engines_for({"engines": ""})


def test_recording_answers_moves_the_metrics() -> None:
    audit = create_audit(load_prompts())
    empty = compute_metrics(audit)
    assert empty["audited"] == 0
    assert empty["mentionRate"] is None, "no audited row means no rate, not zero"

    result = record_answers(audit, [{
        "promptId": "P001",
        "engine": "DeepSeek",
        "answer": "方里属于某某控股，官网 funnyelves.com 可查。",
        "factsTotal": 2,
        "factsCorrect": 1,
    }])
    assert result["recorded"] == 1
    skipped = record_answers(audit, [
        {"promptId": "P001", "engine": "不存在的引擎", "answer": "x"},
        {"promptId": "P999", "engine": "DeepSeek", "answer": "x"},
        {"promptId": "P002", "engine": "DeepSeek", "answer": "   "},
    ])
    assert skipped["recorded"] == 0
    assert len(skipped["skipped"]) == 3

    record_answers(audit, [{"promptId": "P002", "engine": "豆包", "answer": "底妆品牌很多，按肤质挑选。", "factsTotal": 1, "factsCorrect": 1}])
    metrics = compute_metrics(audit)
    assert metrics["audited"] == 2
    assert metrics["mentionRate"] == 50.0
    assert metrics["firstChoiceRate"] == 50.0
    assert metrics["citationRate"] == 100.0
    assert metrics["factAccuracy"] == 66.7


def test_next_batch_orders_by_priority() -> None:
    audit = create_audit(load_prompts())
    batch = next_batch(audit, 5)
    assert len(batch["batch"]) == 5
    assert all(row["priority"] == "A" for row in batch["batch"])
    filtered = next_batch(audit, 3, cluster="竞品对比")
    assert all(row["cluster"] == "竞品对比" for row in filtered["batch"])


def test_derived_flags_respect_position() -> None:
    flags = derive_flags("方里由某某控股持有，官网 funnyelves.com 有备案，天猫旗舰店同步。")
    assert flags["brandMentioned"] is True
    assert flags["firstChoice"] is True
    assert "funnyelves.com" in flags["ownedCited"]
    late = derive_flags("底妆测评内容" * 30 + "方里粉饼")
    assert late["brandMentioned"] is True
    assert late["firstChoice"] is False


def test_baseline_cli_actions_round_trip(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    init = api.baseline_action(config, action="init", moment=datetime(2026, 11, 17, tzinfo=timezone.utc))
    assert init["ok"] is True and init["created"] is True
    assert "20 提示词" in init["message"]
    again = api.baseline_action(config, action="init")
    assert again["created"] is False and "已存在" in again["message"]
    batch = api.baseline_action(config, action="next", size=3)
    assert len(batch["batch"]) == 3
    assert "待采集批次" in batch["message"]


# --------------------------------------------------------------------------- #
# drafts
# --------------------------------------------------------------------------- #

TOPIC = {
    "question": "方里柔焦蜜粉饼适合干皮吗？",
    "cluster": "肤质肤况",
    "clusterId": "skin",
    "product": "方里柔焦蜜粉饼",
    "productId": "powder",
    "format": "深度答案页",
    "evidenceGap": "缺 A 级证据：斑贴 / 人体功效评价 / 检测报告",
    "evidence": "目标证据等级：A（检测 / 斑贴 / 人体功效）",
}


def valid_draft() -> dict:
    return {
        "content_id": "gen_20261117_001",
        "content_type": "answer_page",
        "title": "方里粉饼适合干皮吗",
        "summary": "不是最适合，但可以用。它更偏油皮/混油，干皮秋冬全脸使用可能拔干。",
        "blocks": [
            {"type": "paragraph", "text": "方里柔焦蜜粉饼主打控油与柔焦，更偏油皮/混油。[C01]", "claim_ids": ["C01"]},
            {"type": "paragraph", "text": "干皮秋冬全脸使用可能拔干；建议局部定妆。[C02]", "claim_ids": ["C02"]},
        ],
        "claims": [
            {"claim_id": "C01", "text": "控油柔焦", "evidence_ids": ["E01"], "limitations": "油皮/混油"},
            {"claim_id": "C02", "text": "干皮局部使用", "evidence_ids": ["E02"], "limitations": "不建议全脸"},
        ],
        "citations": [
            {"evidence_id": "E01", "source": "第三方检测报告", "date": "2025-06-01"},
            {"evidence_id": "E02", "source": "消费者测试", "date": "2025-06-01"},
        ],
        "risk_level": "high",
        "review_required": True,
    }


def test_template_selection_follows_the_topic_format() -> None:
    assert pick_template("skin", "深度答案页")["id"] == "G01"
    assert pick_template("category", "FAQ / 短答案")["id"] == "G02"
    assert pick_template("compare", "对比表 / 选购指南")["id"] == "G03"
    assert pick_template("category", "选购指南")["id"] == "G04"
    assert pick_template("scene", "视频脚本")["id"] == "G06"
    assert pick_template("product", "数据图 / 信息图")["id"] == "G11"


def test_prompt_pack_carries_the_rules_and_marks_missing_evidence() -> None:
    pack = build_prompt_pack(TOPIC)
    assert pack["evidenceMissing"] is True
    for rule in ("只能使用【证据包】", "必须绑定 claim_id 与 evidence_id", "证据强度低于 B", "适用边界", "零毛孔", "待补充", "只输出 JSON"):
        assert rule in pack["layers"]["L1"]
    assert TOPIC["question"] in pack["layers"]["L2"]
    assert "待填" in pack["layers"]["L3"]

    filled = build_prompt_pack(TOPIC, [{"claim_id": "C01", "text": "控油柔焦", "evidence_id": "E01", "source": "检测", "date": "2025-06-01", "grade": "A", "limitations": "油皮"}])
    assert filled["evidenceMissing"] is False
    assert "C01 | 控油柔焦 | E01 | 检测 | 2025-06-01 | A | 油皮" in filled["layers"]["L3"]


def test_negated_words_pass_with_a_warning() -> None:
    assert scan_words("不是最适合干皮", FORBIDDEN_ABSOLUTE) == {"hits": [], "negated": ["最"]}
    assert scan_words("最服帖的粉饼", FORBIDDEN_ABSOLUTE)["hits"] == ["最"]
    mixed = scan_words("不追求第一，但这是最稳的选择", FORBIDDEN_ABSOLUTE)
    assert "最" in mixed["hits"]
    assert "第一" in mixed["negated"]


def test_a_conforming_draft_passes_all_mechanical_gates() -> None:
    report = validate_draft(valid_draft())
    assert report["ok"] is True, report["errors"]
    assert report["stats"]["claims"] == 2
    assert report["stats"]["claimBoundBlocks"] == 2


def test_schema_gate_rejects_missing_fields_and_bad_enums() -> None:
    missing = valid_draft()
    del missing["citations"]
    assert any("citations" in error for error in validate_draft(missing)["errors"])

    bad_type = valid_draft()
    bad_type["content_type"] = "blog_post"
    assert any("content_type" in error for error in validate_draft(bad_type)["errors"])

    long_title = valid_draft()
    long_title["title"] = "方" * 31
    assert any("30 字" in error for error in validate_draft(long_title)["errors"])

    assert validate_draft(None)["ok"] is False


def test_evidence_binding_refuses_an_open_chain() -> None:
    dangling_claim = valid_draft()
    dangling_claim["blocks"][0]["claim_ids"] = ["C99"]
    assert any("未声明的 claim_id" in error for error in validate_draft(dangling_claim)["errors"])

    dangling_evidence = valid_draft()
    dangling_evidence["claims"][0]["evidence_ids"] = ["E99"]
    assert any("E99" in error for error in validate_draft(dangling_evidence)["errors"])

    unbound = valid_draft()
    unbound["claims"][0]["evidence_ids"] = []
    assert any("没有绑定任何 evidence_id" in error for error in validate_draft(unbound)["errors"])


def test_compliance_gate_blocks_red_lines_and_allows_negation() -> None:
    medical = valid_draft()
    medical["blocks"][0]["text"] = "这款粉饼可以治疗敏感肌。[C01]"
    report = validate_draft(medical)
    assert report["ok"] is False
    assert any("医疗术语" in error for error in report["errors"])

    hedged = valid_draft()
    hedged["summary"] = "不是最适合干皮，但油皮可用。"
    assert validate_draft(hedged)["ok"] is True


def test_render_produces_body_table_and_review_note() -> None:
    markdown = render_draft_markdown(valid_draft(), template_id="G01", content_id="gen_20261117_001")
    assert markdown.startswith("# 方里粉饼适合干皮吗")
    assert "| C01 | 控油柔焦 | E01 | 油皮/混油 |" in markdown
    assert "三签" in markdown


def test_draft_actions_write_artifacts(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    skeleton = api.draft_action(config, action="skeleton", question="方里粉饼适合干皮吗？", cluster="肤质肤况")
    assert skeleton["ok"] is True
    assert Path(skeleton["promptPath"]).exists()

    bad = valid_draft()
    bad["title"] = "方" * 40
    refused = api.draft_action(config, action="render", draft=bad, question="x")
    assert refused["ok"] is False
    assert refused["code"] == "CONTRACT_FAILED"

    rendered = api.draft_action(config, action="render", draft=valid_draft(), question="x")
    assert rendered["ok"] is True
    assert Path(rendered["jsonPath"]).exists()
    assert Path(rendered["markdownPath"]).exists()


# --------------------------------------------------------------------------- #
# credentials
# --------------------------------------------------------------------------- #

def test_dotenv_parser_handles_quotes_comments_and_errors() -> None:
    values, errors = parse_dotenv(
        "# 注释\n\nPLAIN=value\nexport EXPORTED=from-export\nSINGLE='quoted # not a comment'\n"
        'DOUBLE="line\\nbreak"\nINLINE=secret # trailing\nEMPTY=\nnot-a-pair\n9BAD=value'
    )
    assert values["PLAIN"] == "value"
    assert values["EXPORTED"] == "from-export"
    assert values["SINGLE"] == "quoted # not a comment"
    assert values["DOUBLE"] == "line\nbreak"
    assert values["INLINE"] == "secret"
    assert values["EMPTY"] == ""
    assert len(errors) == 2


def test_password_precedence_and_redaction(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("GEO_EVIDENCE_PASSWORD=from-file\n", encoding="utf-8")
    clear_env_cache()
    connection = {"host": "10.0.0.10", "port": 5432, "database": "geo_evidence", "user": "geo_ro"}

    from_env = resolve_password(connection, "evidence", env={"GEO_EVIDENCE_PASSWORD": "from-env"}, env_file=env_file)
    assert from_env["source"] == "environment"
    from_file = resolve_password(connection, "evidence", env={}, env_file=env_file)
    assert from_file["value"] == "from-file"
    assert from_file["source"] == "env-file"
    plain = resolve_password({**connection, "password": "in-config"}, "evidence", env={}, env_file=None)
    assert plain["source"] == "config-plaintext"

    instance, problems = normalize_instance("evidence", connection, env={}, env_file=env_file)
    assert problems == []
    info = describe_instance(instance)
    assert info["passwordSet"] is True
    assert info["passwordSource"] == "env-file"
    assert "from-file" not in json.dumps(info, ensure_ascii=False)


def test_password_variable_naming() -> None:
    assert default_password_variable("evidence") == "GEO_EVIDENCE_PASSWORD"
    assert default_password_variable("product") == "GEO_PRODUCT_PASSWORD"


def test_generated_queries_follow_the_mapping() -> None:
    instance, _ = normalize_instance(
        "evidence",
        {"host": "h", "database": "d", "user": "u", "schema": "geo"},
        env={"GEO_EVIDENCE_PASSWORD": "x"},
    )
    text, params = build_claims_query(instance, {"sku": "FL-01", "keyword": "控油", "limit": 25})
    assert '"geo"."geo_claim"' in text
    assert "as valid_until" in text
    assert params == ["FL-01", "控油", 25]
    assert text.strip().endswith("limit $3::int")

    product, _ = normalize_instance("product", {"host": "h", "database": "d", "user": "u"}, env={"GEO_PRODUCT_PASSWORD": "x"})
    sku_text, sku_params = build_sku_query(product, {"sku": "FL-01", "limit": 10})
    assert 'as filing_no' in sku_text.replace('"', "")
    assert sku_params == ["FL-01", None, 10]


def test_driver_error_messages_stay_actionable() -> None:
    instance, _ = normalize_instance("evidence", {"host": "10.0.0.10", "database": "d", "user": "u"}, env={"GEO_EVIDENCE_PASSWORD": "x"})

    class Refused(Exception):
        sqlstate = ""

    message = describe_db_error(Refused("connection refused"), instance)
    assert "端口未监听" in message

    class MissingTable(Exception):
        sqlstate = "42P01"

    assert "mapping.tables" in describe_db_error(MissingTable("relation does not exist"), instance)


def test_db_actions_report_configuration_without_a_server(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    status = api.db_action(config, action="status")
    assert status["ok"] is True
    assert "未配置" in status["message"]
    template = api.db_action(config, action="template")
    assert "passwordEnv: GEO_EVIDENCE_PASSWORD" in template["template"]
    credential = api.db_action(config, action="env")
    assert "GEO_EVIDENCE_PASSWORD=" in credential["template"]
    missing = api.evidence_action(config, sku="FL-01")
    assert missing["ok"] is False and missing["code"] == "DB_NOT_CONFIGURED"


def test_status_and_calendar_run_end_to_end(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    state = api.status(config)
    assert state["ok"] is True
    assert "GEO 雷达状态" in state["message"]
    calendar = api.calendar_view(config)
    assert calendar["ok"] is True
    assert "公关日历窗口" in calendar["message"]
