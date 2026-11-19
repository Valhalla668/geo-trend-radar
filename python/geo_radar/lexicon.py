"""Entity and claim lexicon — the rules every other module reads.

`方里 FUNNY ELVES` is a worked example. Point :data:`ENTITY` at your own brand,
or replace this module wholesale when you vendor the project.
"""

from __future__ import annotations

from typing import Any, Final

# --------------------------------------------------------------------------- #
# L1 entity layer
# --------------------------------------------------------------------------- #

#: Public copy of the entity layer: the brand is an example, and the linked
#: legal entities and people are deliberately blank — fill them in locally.
ENTITY: Final[dict[str, Any]] = {
    "brand": "方里 FUNNY ELVES",
    "brandAliases": ["方里", "FUNNY ELVES", "Funny Elves", "funny elves", "方里FUNNY"],
    "parent": "",
    "parentAliases": [],
    "founder": "",
    "founderAliases": [],
    "positioning": "亚洲专研底妆品牌",
    "coreProducts": ["方里柔焦蜜粉饼", "方里持妆粉底液 5.0", "方里特护粉底液"],
    "channels": ["官网", "天猫", "京东", "抖音", "小红书", "微信公众号"],
}

#: The six engines the baseline audit samples.
ENGINES: Final[list[dict[str, str]]] = [
    {"id": "doubao", "name": "豆包"},
    {"id": "yuanbao", "name": "腾讯元宝"},
    {"id": "quark", "name": "夸克"},
    {"id": "baidu-ai", "name": "百度 AI"},
    {"id": "xiaohongshu-diandian", "name": "小红书点点"},
    {"id": "deepseek", "name": "DeepSeek"},
]

#: Evidence grades; a claim below B may only describe experience, never efficacy.
EVIDENCE_GRADES: Final[list[dict[str, str]]] = [
    {"grade": "A", "label": "第三方检测 / 临床仪器测试 / 专利", "use": "可直接写功效结论"},
    {"grade": "B", "label": "专家、皮肤科医生、配方师", "use": "专业解释与边界"},
    {"grade": "C", "label": "权威媒体 / 行业奖项 / 白皮书", "use": "品牌可信度与技术叙事"},
    {"grade": "D", "label": "真实用户 / KOL 测评 / UGC", "use": "场景与肤质体验"},
    {"grade": "E", "label": "品牌自述", "use": "基础信息，需其他层级佐证"},
]

PRODUCTS: Final[list[dict[str, Any]]] = [
    {"id": "powder", "name": "方里柔焦蜜粉饼", "aliases": ["柔焦蜜粉饼", "蜜粉饼", "粉饼", "柔焦"]},
    {"id": "longwear-5", "name": "方里持妆粉底液 5.0", "aliases": ["持妆粉底液", "持妆5.0", "持妆 5.0", "5.0", "持妆"]},
    {"id": "barrier", "name": "方里特护粉底液", "aliases": ["特护粉底液", "特护"]},
    {"id": "color-line", "name": "方里色彩线", "aliases": ["色彩线", "彩妆线"]},
]

COMPETITORS: Final[list[dict[str, Any]]] = [
    {"id": "huaxizi", "name": "花西子", "aliases": ["花西子"]},
    {"id": "maogeping", "name": "毛戈平", "aliases": ["毛戈平"]},
    {"id": "caitang", "name": "彩棠", "aliases": ["彩棠"]},
    {"id": "blankme", "name": "blankme", "aliases": ["blankme", "blank me"]},
    {"id": "winona", "name": "薇诺娜", "aliases": ["薇诺娜"]},
    {"id": "esteelauder-dw", "name": "雅诗兰黛 DW", "aliases": ["雅诗兰黛", "DW", "Double Wear"]},
    {"id": "puco", "name": "puco", "aliases": ["puco", "PUCO"]},
    {"id": "juduo", "name": "橘朵", "aliases": ["橘朵"]},
]

# --------------------------------------------------------------------------- #
# Anchors: what makes a public headline relevant at all
# --------------------------------------------------------------------------- #

BEAUTY_ANCHORS: Final[list[str]] = [
    "粉底液", "粉底", "粉饼", "散粉", "蜜粉", "底妆", "遮瑕", "定妆", "妆前", "气垫",
    "彩妆", "美妆", "化妆品", "化妆", "卸妆", "防晒", "腮红", "眼影", "口红", "唇釉",
    "修容", "高光", "妆面", "妆容", "持妆", "控油",
]

SKIN_ANCHORS: Final[list[str]] = ["敏感肌", "油皮", "干皮", "混油", "混干", "痘痘肌", "卡粉", "脱妆", "闷痘", "暗沉", "毛孔"]

DOMAIN_ANCHORS: Final[list[str]] = [*BEAUTY_ANCHORS, *SKIN_ANCHORS]

# --------------------------------------------------------------------------- #
# The eight answer clusters
# --------------------------------------------------------------------------- #

CLUSTERS: Final[list[dict[str, Any]]] = [
    {
        "id": "brand",
        "name": "品牌认知",
        "assets": 20,
        "weight": 0.7,
        "typical": "方里是哪个公司？是国货吗？靠谱吗？",
        "cues": ["方里", "FUNNY ELVES", "国货", "品牌", "创始人", "融资", "GMV", "营收", "成立", "收购", "上榜", "榜单"],
        "format": "深度答案页",
        "product": "brand",
    },
    {
        "id": "category",
        "name": "品类推荐",
        "assets": 40,
        "weight": 1.0,
        "typical": "油皮粉底液推荐？100 元以内粉饼推荐？",
        "cues": ["粉底液", "粉饼", "散粉", "蜜粉", "底妆", "遮瑕", "定妆", "推荐", "好用", "平价", "国货底妆", "妆前", "气垫"],
        "format": "选购指南",
        "product": "powder",
    },
    {
        "id": "skin",
        "name": "肤质肤况",
        "assets": 40,
        "weight": 1.2,
        "typical": "敏感肌能用方里吗？干皮会卡粉吗？痘痘肌呢？",
        "cues": ["油皮", "干皮", "混油", "混干", "敏感肌", "痘痘肌", "卡粉", "脱妆", "暗沉", "毛孔", "闷痘", "泛红", "拔干", "闭口", "斑贴"],
        "format": "深度答案页",
        "product": "barrier",
    },
    {
        "id": "scene",
        "name": "场景需求",
        "assets": 40,
        "weight": 1.0,
        "typical": "夏天通勤、婚礼、运动、戴口罩怎么选？",
        "cues": ["通勤", "婚礼", "面试", "口罩", "运动", "夏天", "冬天", "换季", "学生党", "开学", "军训", "出油", "补妆", "加班", "旅行"],
        "format": "FAQ / 短答案",
        "product": "powder",
    },
    {
        "id": "product",
        "name": "产品决策",
        "assets": 40,
        "weight": 1.1,
        "typical": "粉饼/粉底液 5.0/特护怎么选？色号怎么挑？",
        "cues": ["色号", "怎么选", "怎么用", "怎么挑", "补妆", "持妆", "柔焦", "控油", "5.0", "特护", "区别", "黄一白", "黄二白", "上手", "教程"],
        "format": "FAQ / 短答案",
        "product": "longwear-5",
    },
    {
        "id": "compare",
        "name": "竞品对比",
        "assets": 40,
        "weight": 1.3,
        "typical": "方里 vs 花西子/毛戈平/彩棠/blankme？",
        "cues": ["对比", "怎么选", "哪个好", "哪个更", "pk", "VS", "平替", "差距", "相比", "二选一"],
        "format": "对比表 / 选购指南",
        "product": "powder",
    },
    {
        "id": "price",
        "name": "价格渠道",
        "assets": 10,
        "weight": 0.9,
        "typical": "多少钱？哪里买？怎么辨真假？",
        "cues": ["多少钱", "价格", "便宜", "打折", "优惠", "双11", "618", "直播间", "天猫", "京东", "抖音商城", "假货", "鉴别", "涨价", "降价", "国补"],
        "format": "数据图 / 信息图",
        "product": "powder",
    },
    {
        "id": "global",
        "name": "出海/英文",
        "assets": 10,
        "weight": 0.6,
        "typical": "Funny Elves review / 日本版区别",
        "cues": ["Funny Elves", "funny elves", "cosme", "@cosme", "Amazon", "amazon", "review", "日本版", "日本市场", "出海", "跨境电商"],
        "format": "FAQ / 短答案",
        "product": "brand",
    },
]

# --------------------------------------------------------------------------- #
# Compliance and reputation vocabulary
# --------------------------------------------------------------------------- #

FORBIDDEN_ABSOLUTE: Final[list[str]] = ["最", "第一", "国家级", "顶级", "唯一", "100%", "零毛孔", "永久", "绝对", "彻底", "根治"]
MEDICAL_TERMS: Final[list[str]] = ["治疗", "修复疾病", "医美替代", "消炎", "抗炎", "祛痘印", "处方", "药妆", "痊愈", "疗效"]
SPECIAL_EFFICACY: Final[list[str]] = ["美白", "防晒", "祛斑", "防脱", "生发", "染发", "烫发", "丰胸", "瘦身"]

NEGATIVE_TERMS: Final[list[str]] = [
    "烂脸", "过敏", "投诉", "翻车", "假货", "质量", "退货", "差评", "罚款", "处罚", "违规",
    "抽检不合格", "重金属", "激素", "致癌", "虚假宣传", "割韭菜", "塌房", "维权", "曝光",
    "检出", "超标", "禁用", "下架", "召回", "约谈", "判赔",
]

COMPETITOR_ACTIONS: Final[list[str]] = ["上新", "官宣", "联名", "融资", "首发", "销量", "破亿", "明星", "代言", "大促", "榜单第一", "拿下", "收购"]

# --------------------------------------------------------------------------- #
# Risk register
# --------------------------------------------------------------------------- #

RISK_RULES: Final[list[dict[str, str]]] = [
    {
        "id": "brand-hallucination",
        "name": "AI 错误描述方里 / 公开信息错误",
        "level": "high",
        "owner": "品牌",
        "mitigation": "建立事实源与纠错流程；48 小时内更新权威页并申诉",
        "match": "entity-error",
    },
    {
        "id": "competitor-poisoning",
        "name": "竞品恶意投毒 / 负面聚合",
        "level": "high",
        "owner": "公关/法务",
        "mitigation": "舆情监测；正面证据饱和；法律手段",
        "match": "negative-brand",
    },
    {
        "id": "compliance-claim",
        "name": "合规风险：绝对化 / 医疗 / 特殊功效",
        "level": "high",
        "owner": "法务",
        "mitigation": "法务前置；宣称矩阵；季度抽检",
        "match": "forbidden-claim",
    },
    {
        "id": "negative-sentiment",
        "name": "负面信息扩散",
        "level": "medium",
        "owner": "公关/法务",
        "mitigation": "监测扩散面；准备统一口径；必要时发声明",
        "match": "negative-any",
    },
    {
        "id": "competitor-move",
        "name": "竞品动作抢占引用池",
        "level": "medium",
        "owner": "GEO Lead",
        "mitigation": "评估对引用池的影响；必要时补充对比型答案",
        "match": "competitor-action",
    },
    {
        "id": "platform-shift",
        "name": "平台算法 / 入口变化",
        "level": "low",
        "owner": "GEO Lead",
        "mitigation": "多引擎布局；自有资产优先；季度重估",
        "match": "platform-shift",
    },
]

# --------------------------------------------------------------------------- #
# Source map and PR calendar
# --------------------------------------------------------------------------- #

SOURCES_30: Final[list[dict[str, str]]] = [
    {"group": "实体", "name": "百度百科", "why": "中文 AI 最常引用的品牌定义源", "action": "品牌/创始人/产品词条"},
    {"group": "实体", "name": "维基百科 / Wikidata", "why": "海外引擎的实体锚点", "action": "英文词条、结构化实体"},
    {"group": "实体", "name": "天眼查 / 企查查", "why": "公司主体与股权关系", "action": "主体信息认领"},
    {"group": "实体", "name": "国家药监局备案", "why": "产品合规与功效边界", "action": "备案信息一致"},
    {"group": "实体", "name": "中国商标网", "why": "品牌商标与类别", "action": "商标信息完整"},
    {"group": "媒体", "name": "新华网", "why": "权威背书，AI 高权重", "action": "技术/品牌深度报道"},
    {"group": "媒体", "name": "人民网", "why": "权威背书", "action": "行业/消费选题"},
    {"group": "媒体", "name": "中新网", "why": "权威转载源", "action": "新品/出海"},
    {"group": "媒体", "name": "36 氪", "why": "商业与增长叙事", "action": "品牌案例/融资"},
    {"group": "媒体", "name": "界面新闻", "why": "消费与品牌深度", "action": "行业分析"},
    {"group": "媒体", "name": "C2CC", "why": "美妆行业垂直权威", "action": "研发/渠道/品牌"},
    {"group": "媒体", "name": "化妆品报", "why": "美妆产业专业媒体", "action": "技术/供应链"},
    {"group": "媒体", "name": "Vogue Business", "why": "高端时尚商业", "action": "品牌升级/出海"},
    {"group": "专业", "name": "知乎", "why": "长尾问题与专业回答", "action": "20 个高赞回答/月"},
    {"group": "专业", "name": "丁香医生", "why": "健康与敏感肌信任", "action": "医生科普合作"},
    {"group": "专业", "name": "美丽修行", "why": "成分与安全性查询", "action": "产品成分页认领"},
    {"group": "专业", "name": "皮肤科医生 KOL", "why": "敏感肌专业背书", "action": "3—5 位长期顾问"},
    {"group": "专业", "name": "中国化妆品学术研讨会", "why": "学术可信度", "action": "论文/报告"},
    {"group": "社媒", "name": "小红书", "why": "美妆决策第一站", "action": "专业号 + 200 篇 KOC"},
    {"group": "社媒", "name": "抖音", "why": "最大底妆流量池", "action": "搜索品专 + 达人"},
    {"group": "社媒", "name": "B 站", "why": "长测评与成分党", "action": "10 位 UP 主"},
    {"group": "社媒", "name": "微博", "why": "热搜与话题", "action": "新品/事件"},
    {"group": "社媒", "name": "微信公众号", "why": "元宝核心信源", "action": "深度长文/白皮书"},
    {"group": "社媒", "name": "视频号", "why": "微信生态", "action": "发布会/教程"},
    {"group": "社媒", "name": "什么值得买", "why": "质价比与选购", "action": "众测/榜单"},
    {"group": "电商", "name": "天猫", "why": "货架与品牌旗舰", "action": "详情页/QA/评价"},
    {"group": "电商", "name": "京东", "why": "正品与参数", "action": "属性/QA"},
    {"group": "电商", "name": "抖音商城", "why": "兴趣电商", "action": "商品卡/直播切片"},
    {"group": "电商", "name": "淘宝问问", "why": "AI 导购", "action": "商品知识库"},
    {"group": "海外", "name": "@cosme（日本）", "why": "日本美妆权威榜单", "action": "产品页/评论"},
]

CALENDAR: Final[list[dict[str, Any]]] = [
    {"id": "cny", "months": [1, 2], "theme": "新年/春节", "content": "底妆焕新、送礼场景、年度榜单", "engines": ["小红书", "抖音", "百度"], "clusters": ["scene", "category"]},
    {"id": "womens-day", "months": [3], "theme": "三八节", "content": "女性叙事、创始人 IP、底气", "engines": ["微信", "微博", "媒体"], "clusters": ["brand"]},
    {"id": "spring", "months": [4, 5], "theme": "防晒/换季", "content": "敏感肌、持妆、春夏底妆", "engines": ["知乎", "丁香", "百度"], "clusters": ["skin", "product"]},
    {"id": "618", "months": [6], "theme": "618", "content": "选购指南、对比测评、价格答疑", "engines": ["抖音", "天猫", "夸克"], "clusters": ["price", "compare"]},
    {"id": "summer", "months": [7, 8], "theme": "盛夏/暑期", "content": "控油、不脱妆、学生党", "engines": ["小红书", "抖音", "B 站"], "clusters": ["scene", "skin"]},
    {"id": "back-to-school", "months": [9], "theme": "开学/换季", "content": "第一套底妆、敏感肌修护", "engines": ["小红书", "知乎"], "clusters": ["scene", "skin"]},
    {"id": "double11", "months": [10, 11], "theme": "双 11", "content": "全品类对比、礼盒、年度白皮书", "engines": ["全引擎"], "clusters": ["price", "compare", "brand"]},
    {"id": "year-end", "months": [12], "theme": "年终/出海", "content": "年度盘点、日本市场、次年预告", "engines": ["媒体", "海外引擎"], "clusters": ["global", "brand"]},
]

# --------------------------------------------------------------------------- #
# Default keyword groups (TrendRadar `frequency_words.txt` dialect)
# --------------------------------------------------------------------------- #

DEFAULT_KEYWORD_GROUPS: Final[str] = """# GEO 雷达 · 关键词分组
# 语法对齐 TrendRadar config/frequency_words.txt：
#   [组名]      开一个新分组
#   # 开头      注释
#   /正则/ => 备注   正则匹配并给一个可读名字
#   纯文本      子串匹配
# 组名只影响展示；真正的分类由 geo_radar.lexicon 的八类内容簇完成。

[品牌]
方里
/FUNNY ?ELVES/i => FUNNY ELVES
国货底妆

[竞品]
花西子
毛戈平
彩棠
/blank ?me/i => blankme
薇诺娜
雅诗兰黛
/puco/i => puco
橘朵

[品类]
粉底液
粉饼
散粉
蜜粉
底妆
遮瑕
定妆
气垫

[肤质]
油皮
干皮
混油
混干
敏感肌
痘痘肌
卡粉
脱妆
暗沉
闷痘
毛孔

[场景]
通勤
婚礼
面试
口罩
军训
学生党
开学
换季

[风险]
烂脸
过敏
假货
翻车
处罚
抽检不合格
虚假宣传
维权
下架
召回

[节点]
618
双11
双 11
开学
换季
"""

# --------------------------------------------------------------------------- #
# Lookups
# --------------------------------------------------------------------------- #

COMPETITOR_NAMES: Final[list[str]] = [entry["name"] for entry in COMPETITORS]
CLUSTER_BY_ID: Final[dict[str, dict[str, Any]]] = {entry["id"]: entry for entry in CLUSTERS}
CLUSTER_BY_NAME: Final[dict[str, dict[str, Any]]] = {entry["name"]: entry for entry in CLUSTERS}
PRODUCT_BY_ID: Final[dict[str, dict[str, Any]]] = {entry["id"]: entry for entry in PRODUCTS}
ENGINE_BY_ID: Final[dict[str, dict[str, str]]] = {entry["id"]: entry for entry in ENGINES}
RISK_RULE_BY_MATCH: Final[dict[str, dict[str, str]]] = {entry["match"]: entry for entry in RISK_RULES}
