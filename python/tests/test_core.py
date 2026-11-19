"""Rules, scoring, boards and calendars."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from geo_radar.alerts import build_alerts, render_alerts_markdown, summarize_alerts
from geo_radar.calendar import annotate_calendar, calendar_status, render_calendar_markdown
from geo_radar.lexicon import CLUSTERS, ENGINES, ENTITY, FORBIDDEN_ABSOLUTE
from geo_radar.match import (
    classify_clusters,
    detect_compliance,
    detect_entities,
    detect_negative,
    has_domain_anchor,
    match_items,
    match_keyword_groups,
    merge_scored,
    parse_keyword_groups,
    pick_cluster,
    score_item,
)
from geo_radar.lexicon import DEFAULT_KEYWORD_GROUPS
from geo_radar.sov import build_sov, compute_mentions, render_sov_markdown
from geo_radar.topics import build_topics, render_topics_markdown, to_question


def test_lexicon_ships_an_example_brand_without_personal_data() -> None:
    assert ENTITY["brand"] == "方里 FUNNY ELVES"
    assert ENTITY["brandAliases"]
    for removed in ("legalName", "creditCode", "legalRepresentative", "founded"):
        assert removed not in ENTITY
    assert ENTITY["parentAliases"] == []
    assert ENTITY["founderAliases"] == []
    assert len(ENGINES) == 6
    assert len(CLUSTERS) == 8
    assert all(cluster["assets"] > 0 for cluster in CLUSTERS)


def test_keyword_groups_parse_literals_and_regexes() -> None:
    groups, warnings = parse_keyword_groups(DEFAULT_KEYWORD_GROUPS)
    assert warnings == []
    assert len(groups) >= 6
    brand = next(group for group in groups if group["name"] == "品牌")
    labels = [term["label"] for term in brand["terms"]]
    assert "方里" in labels
    assert "FUNNY ELVES" in labels
    competitor = next(group for group in groups if group["name"] == "竞品")
    assert any(term["type"] == "regex" and term["label"] == "blankme" for term in competitor["terms"])


def test_invalid_regex_is_reported_not_raised() -> None:
    groups, warnings = parse_keyword_groups("[坏组]\n/[/\n方里")
    assert len(warnings) == 1
    assert len(groups[0]["terms"]) == 1
    assert groups[0]["terms"][0]["value"] == "方里"


def test_keyword_groups_match_across_groups() -> None:
    groups, _ = parse_keyword_groups(DEFAULT_KEYWORD_GROUPS)
    hits = match_keyword_groups("方里柔焦蜜粉饼和花西子哪个好", groups)
    names = [hit["group"] for hit in hits]
    assert "品牌" in names
    assert "竞品" in names
    assert "品类" in names


def test_entity_detection_separates_brand_and_competitors() -> None:
    brand = detect_entities("方里是国货底妆品牌")
    assert brand["isBrand"] is True
    assert brand["mentionsEntity"] is True
    assert brand["founderHits"] == []
    assert brand["parentHits"] == []

    rival = detect_entities("花西子新品官宣")
    assert rival["isBrand"] is False
    assert rival["isCompetitor"] is True
    assert [entry["name"] for entry in rival["competitors"]] == ["花西子"]
    assert rival["competitors"][0]["actions"] == ["官宣"]


def test_cluster_routing_prefers_comparison_and_skin() -> None:
    entities = detect_entities("方里和花西子怎么选")
    assert pick_cluster("方里和花西子怎么选", entities)["id"] == "compare"
    assert classify_clusters("敏感肌夏天用方里会闷痘吗")[0]["id"] == "skin"


def test_compliance_and_negative_vocabulary() -> None:
    compliance = detect_compliance("这款粉底液治疗敏感肌，零毛孔，永久不脱妆")
    assert "治疗" in compliance["medical"]
    assert "零毛孔" in compliance["absolute"]
    assert "永久" in compliance["absolute"]
    assert len(detect_negative("用户投诉方里烂脸，疑似假货")) >= 2


def test_scoring_promotes_brand_hits_in_high_value_clusters() -> None:
    scored = score_item({"platform": "zhihu", "platformName": "知乎", "rank": 3, "title": "方里柔焦蜜粉饼适合油皮吗"})
    assert scored["cluster"]["id"] == "skin"
    assert scored["priority"] == "P0"
    assert scored["score"] > 50
    assert scored["product"]["name"] == "方里柔焦蜜粉饼"
    assert "A 级证据" in scored["evidenceGap"]


def test_anchor_gate_keeps_seasonal_noise_out() -> None:
    assert has_domain_anchor("冬天羽绒服怎么选") is False
    assert has_domain_anchor("敏感肌换季泛红") is True
    seasonal = match_items([
        {"platform": "baidu", "rank": 1, "title": "冬天羽绒服怎么选"},
        {"platform": "baidu", "rank": 2, "title": "开学前家长需要准备什么"},
        {"platform": "baidu", "rank": 3, "title": "敏感肌换季怎么选底妆"},
    ])
    assert [entry["title"] for entry in seasonal] == ["敏感肌换季怎么选底妆"]


def test_candidates_bypass_the_gate_and_merge_without_duplicates() -> None:
    pool = [
        {"platform": "客服", "platformName": "客服", "rank": 1, "title": "色号怎么挑"},
        {"platform": "站内搜索", "platformName": "站内搜索", "rank": 2, "title": "方里粉饼会卡粉吗"},
    ]
    forced = match_items(pool, require_anchor=False)
    gated = match_items(pool)
    assert len(forced) == 2
    assert len(gated) < len(forced)
    merged = merge_scored([forced, gated])
    assert len(merged) == 2


def test_question_templates_by_cluster() -> None:
    assert to_question({"title": "方里和花西子怎么选", "cluster": {"id": "compare"}, "entities": {"competitors": [{"name": "花西子"}]}}) == "方里和花西子怎么选？"
    assert to_question({"title": "夏天通勤底妆", "cluster": {"id": "scene"}, "clusters": [{"cues": ["通勤"]}]}) == "通勤场景下底妆怎么选？"
    assert to_question({"title": "安全吗？", "cluster": {"id": "category"}}) == "安全吗？"


def test_topic_board_dedupes_and_numbers_cards() -> None:
    items = [
        score_item({"platform": "zhihu", "platformName": "知乎", "rank": 2, "title": "方里柔焦蜜粉饼适合油皮吗"}),
        score_item({"platform": "zhihu", "platformName": "知乎", "rank": 3, "title": "方里柔焦蜜粉饼适合油皮吗？"}),
        score_item({"platform": "weibo", "platformName": "微博", "rank": 1, "title": "花西子蜜粉饼上新，和方里怎么选"}),
    ]
    cards = build_topics(items, limit=10, moment=datetime(2026, 11, 17, tzinfo=timezone.utc))
    assert len(cards) == 2
    assert all(card["id"].startswith("GT-20261117-") for card in cards)
    assert [card["id"][-3:] for card in cards] == ["001", "002"]
    assert cards[0]["priority"] == "P0"
    markdown = render_topics_markdown(cards, {"date": "2026-11-17", "scannedAt": "2026-11-17 09:00"})
    assert "# GEO 选题卡" in markdown
    assert "证据缺口" in markdown


def test_topic_board_caps_one_cluster() -> None:
    items = [
        score_item({"platform": "zhihu", "platformName": "知乎", "rank": index + 1, "title": f"敏感肌底妆问题编号{index}", "summary": "油皮 干皮 敏感肌 卡粉"})
        for index in range(12)
    ]
    cards = build_topics(items, limit=12, per_cluster=4)
    assert len([card for card in cards if card["cluster"] == "肤质肤况"]) <= 4


def test_alerts_escalate_brand_negative_and_block_red_lines() -> None:
    dirty = [
        score_item({"platform": "weibo", "platformName": "微博", "rank": 1, "title": "方里粉饼烂脸投诉，网友称假货"}),
        score_item({"platform": "weibo", "platformName": "微博", "rank": 2, "title": "某粉底液宣称治疗敏感肌"}),
    ]
    alerts = build_alerts(dirty)
    assert len(alerts) >= 2
    brand_alert = next(alert for alert in alerts if alert["ruleId"] == "competitor-poisoning")
    assert brand_alert["level"] == "high"
    assert brand_alert["owner"] == "公关/法务"
    claim_alert = next(alert for alert in alerts if alert["ruleId"] == "compliance-claim")
    assert "治疗" in claim_alert["terms"]
    summary = summarize_alerts(alerts)
    assert summary["total"] == len(alerts)
    assert build_alerts([score_item({"platform": "zhihu", "rank": 5, "title": "油皮粉底液怎么选"})]) == []
    assert "未触发负面或合规信号" in render_alerts_markdown([], {"date": "2026-11-17"})


def test_a_brand_question_is_a_topic_not_an_entity_error() -> None:
    question = score_item({"platform": "candidate", "platformName": "客服", "rank": 1, "title": "方里是哪个公司的品牌？是国货吗？"})
    assert build_alerts([question]) == []
    wrong = score_item({"platform": "weibo", "platformName": "微博", "rank": 1, "title": "网传方里成立于 2015 年，官方辟谣：成立时间写错了"})
    alerts = build_alerts([wrong])
    assert alerts[0]["ruleId"] == "brand-hallucination"
    assert alerts[0]["level"] == "high"


def test_mentions_count_each_brand_once() -> None:
    items = [
        {"title": "方里和花西子怎么选", "platformName": "知乎", "platform": "zhihu", "rank": 1},
        {"title": "方里柔焦蜜粉饼测评", "platformName": "微博", "platform": "weibo", "rank": 2},
        {"title": "毛戈平粉膏上新", "platformName": "微博", "platform": "weibo", "rank": 3},
        {"title": "天气预警", "platformName": "百度", "platform": "baidu", "rank": 4},
    ]
    mentions = compute_mentions(items)
    assert mentions["totalItems"] == 4
    self_entry = next(entry for entry in mentions["brands"] if entry["self"])
    assert self_entry["mentions"] == 2
    assert self_entry["byPlatform"] == {"知乎": 1, "微博": 1}


def test_sov_shares_and_gap() -> None:
    now = datetime(2026, 11, 17, 12, tzinfo=timezone.utc)
    snapshot = {
        "scannedAt": "2026-11-17T02:00:00.000Z",
        "mentions": compute_mentions([
            {"title": "方里柔焦蜜粉饼测评", "platformName": "知乎", "platform": "zhihu", "rank": 1},
            {"title": "花西子蜜粉饼上新", "platformName": "微博", "platform": "weibo", "rank": 2},
            {"title": "花西子官宣代言人", "platformName": "微博", "platform": "weibo", "rank": 3},
        ]),
    }
    sov = build_sov([snapshot], days=7, now=now)
    assert sov["window"]["scans"] == 1
    assert sov["window"]["items"] == 3
    assert sov["self"]["mentions"] == 1
    assert sov["leader"]["name"] == "花西子"
    assert sov["self"]["share"] + sov["leader"]["share"] == pytest.approx(100, abs=0.11)
    assert sov["gap"] > 0
    assert "口径说明" in render_sov_markdown(sov)


def test_sov_empty_window_does_not_invent_numbers() -> None:
    sov = build_sov([], days=7, now=datetime(2026, 11, 17, tzinfo=timezone.utc))
    assert sov["window"]["scans"] == 0
    assert sov["brands"] == []
    assert sov["self"] is None
    assert "还没有扫描记录" in render_sov_markdown(sov)


def test_calendar_covers_every_month_and_orders_upcoming() -> None:
    status = calendar_status(datetime(2026, 11, 17, 12, tzinfo=timezone.utc), horizon_days=90)
    assert status["month"] == 11
    assert status["current"]
    assert any(node["theme"] == "双 11" for node in status["current"])
    distances = [node["startsInDays"] for node in status["upcoming"]]
    assert distances == sorted(distances)
    annotated = annotate_calendar(status, [{"clusterId": "price", "count": 2}])
    assert any(node["theme"] == "双 11" and node["hot"] for node in annotated["nodes"])
    assert "公关日历窗口" in render_calendar_markdown(annotated)
