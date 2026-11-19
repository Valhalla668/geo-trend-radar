# geo-radar（Python）

`geo-trend-radar` 的 Python 实现。同一套规则、同一套数据格式、同一个数据目录——两个实现可以交替跑，结果能逐行对比。

- **CLI**：`geo-radar scan / topics / alerts / sov / report / calendar / baseline / draft / evidence / db / status`
- **库**：`from geo_radar import api`，每个动作就是一个函数，返回 `{ok, message, ...}`，`message` 是给人看的 Markdown
- **零运行时依赖**：核心只用标准库；只有连 PostgreSQL 时需要 `psycopg`

## 安装

```bash
cd python
python -m venv .venv && . .venv/Scripts/activate   # Windows
pip install -e .
# 可选：数据库与测试
pip install -e ".[postgres,dev]"
```

不安装也能跑：在 `python/` 目录下 `python -m geo_radar ...`。

## 快速开始

```bash
geo-radar status                       # 数据目录、快照、关键词分组、基线进度
geo-radar scan --label daily           # 采集热榜 → 选题卡 + 预警 + 声量 + 日历
geo-radar scan --candidate "方里粉饼适合干皮吗" --candidate "最好用的粉底液"
geo-radar topics --days 3 --limit 10    # 从快照重建选题卡
geo-radar alerts --days 3 --level high
geo-radar sov --days 7
geo-radar report --period weekly
geo-radar baseline init                 # 建立审计网格
geo-radar baseline next --size 10
geo-radar draft skeleton --topic-id GT-20260101-001
geo-radar db env                        # 凭据放哪、变量名是什么
```

`--json` 输出结构化结果（脚本用），默认输出 Markdown（人读）。
配置用 `--config config.json`，键与插件的 `config` 一致（`platforms`、`apiUrl`、`dataDir`、`keywordGroups`、`databases`、`promptsPath` …）。

> Windows 控制台若不是 UTF-8，中文会显示为乱码：先 `chcp 65001`，或设 `PYTHONIOENCODING=utf-8`。

## 与 JS 版共用数据

默认数据目录是 `~/.dsh/geo-trend-radar`，文件结构完全一致：

```
snapshots/<id>.json       扫描快照（matchedItems + mentions）
latest.json               最近一次快照指针
topics/<id>.md            选题卡
alerts/<id>.json          预警
baseline/audit.json       审计网格
reports/*.md              日报 / 周报
drafts/*.{json,md}        草稿与骨架
```

已双向验证：Python 能读 JS 写的快照与 1,440 行审计；JS 能读 Python 写的快照，并产出同样的选题卡（同 id、同分数、同关联提示词）。

数值格式也对齐了 JavaScript 的语义：`Math.round` 的半值向上取整、整数值打印为 `50` 而不是 `50.0`。

## 数据库口令

连接信息写配置，**口令不写配置**：

```bash
export GEO_EVIDENCE_PASSWORD=...     # 或写进 .env
```

优先级：真实环境变量 > `.env` > 配置里的明文 `password`（仅兼容，会告警）。
`.env` 查找顺序：`envFile` 配置 → `<数据目录>/.env` → `python/.env`。
用 `geo-radar db env` 看当前解析到哪、变量名是什么；`db status` 只显示来源，不显示口令。

## 与插件版的差异

| 项 | 插件版 | Python 版 |
| --- | --- | --- |
| 运行位置 | DSH Host（Node） | 你的 Python 环境 |
| 调用方式 | 11 个工具 + Web 看板 | CLI + 可导入函数 |
| 基线录入 | 工具参数 `entries` | `baseline record --record-file answers.json` |
| 草稿 | `draft` 工具三动作 | `draft skeleton/validate/render` |
| 数据库驱动 | `pg` | `psycopg`（可选） |

规则、阈值、渲染文案、JSON 结构都与插件版一致，逐条对应。

## 测试

```bash
python -m pytest tests -q
# 若临时目录不可写（受限沙箱）：
python -m pytest tests -q --basetemp=.pytest-tmp
```

当前 46 个测试，覆盖打分、选题卡、预警、声量与日历、快照读写（含 JS 快照互通）、审计指标、草稿三闸门、`.env` 解析与优先级、SQL 生成与错误映射。

## 已知限制

与插件版相同：打分是规则而非语义理解；热榜是公开榜单，不含付费投放；SOV 是公开信号代理；`draft` 的 G3 事实蕴含与 G5 品牌语气不判定；数据库口令按 `.env` 约定管理，准入的「有效期」依赖证据表 `valid_until`。

## 许可

MIT。
