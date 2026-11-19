# geo-trend-radar

把公开热榜接成 GEO 产线的一个 DSH 插件：热榜负责回答「现在用户在问什么」，插件回答「这件事该不该进产线、归到哪个内容簇、证据还缺什么、要不要今天处置」。

`方里 FUNNY ELVES` 只是仓库里的示例品牌。把 `lib/lexicon.js` 的 `ENTITY` 换成你自己的品牌，或整份替换，就能复用到别的品牌。

## 七个能力

| 工具 | 作用 |
| --- | --- |
| `geo_scan` | 采集热榜 → 按实体与八类内容簇过滤打分 → 选题卡 + 风险预警 + 声量 + 日历窗口，并保存快照 |
| `geo_topics` | 从快照重建选题卡，可按簇/优先级/天数过滤并导出 Markdown |
| `geo_alerts` | 负面与合规预警，按风险登记表分级，带责任人与处置建议 |
| `geo_sov` | 竞品在公开热榜上的提及份额，含窗口环比与平台分布 |
| `geo_report` | 日报 / 周报 Markdown |
| `geo_draft` | 生成骨架（四层 Prompt + 模板 + JSON 契约）与契约校验（Schema / 证据绑定 / 合规） |
| `geo_evidence` | 从证据库取 claim 并做准入：绿（可用）/ 黄（有条件）/ 红（禁用） |
| `geo_db` | 外部 PostgreSQL 只读通道：状态 / 配置模板 / 连通性 / 字段清单 / 取样 |
| `geo_baseline` | 基线审计网格：建表、领批次、录答案、算五个核心指标 |
| `geo_calendar` | 公关日历窗口 |
| `geo_status` | 运行条件自检 |

Web 侧：每个工具在对话里渲染成看板卡片（指标块、选题列表、预警分级、声量条形、准入三色、进度条）。

## 安装

这是本地目录形式的 DSH bundle：

```bash
cd geo-trend-radar
pnpm install
```

然后在 DSH 的 **Plugins** 里添加本地目录，或由插件管理器安装该目录。启用后重载插件即可。

## 数据与配置

- 热榜默认走与 TrendRadar 同源的 newsnow 接口；自建实例请配 `apiUrl`。
- 提示词库是 `assets/prompts.json`（示例 20 条，覆盖八类内容簇），替换成你自己的题库即可。
- 外部证据库与商品库的连接写在插件 config，**口令走 `.env` 或环境变量**：`docs/config.template.yml` 给连接与字段映射，`.env.example` 给口令变量名。
- 数据默认写在 `~/.dsh/geo-trend-radar`，可用 `dataDir` 覆盖。

> 口令优先级：真实环境变量 > `.env` 文件 > 插件 config 里的明文（仅兼容，会在状态里标警告）。`.env` 已被 `.gitignore` 排除，别提交。

## 规则与门槛

- 采集与打分是**确定性规则**，同一次输入永远同一份判断，每条选题卡与预警都能逐行解释。
- `geo_draft` 不调用模型：它出骨架、校验契约。三道机械闸门是 G1 Schema、G2 证据绑定、G4 合规；G3 事实蕴含、G5 品牌语气与「三签」仍需人审。
- 合规规则会识别否定语境（「不是最适合」放行并告警），但谐音、拆字、图片内文字拦不住，不能替代法务。

## Python 版

`python/` 是同一套规则的 Python 实现：CLI + 可导入库，零运行时依赖（连 PostgreSQL 时才需要 `psycopg`）。它**与插件共用同一个数据目录和 JSON 格式**，两个实现可以交替跑、结果逐行对比。

```bash
cd python
pip install -e .            # 可选；也可以直接 python -m geo_radar
geo-radar status
geo-radar scan --label daily
geo-radar topics --days 3
```

细节见 [`python/README.md`](python/README.md)。

## 测试

```bash
pnpm test
```

当前 65 个测试，覆盖打分、选题卡、预警、准入、SQL 生成、快照读写、契约校验。
Python 版另有 46 个 pytest 用例：`cd python && python -m pytest tests -q`。

## 许可

MIT，见 `LICENSE`。
