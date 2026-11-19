# GEO 热点雷达（geo-trend-radar）

面向品牌 GEO 运营的监测与选题插件。它把「公开热榜」这条实时信号，接到三件日常判断上：

1. **选题**：今天的热点里哪一条值得变成可被引用的答案资产？归到哪一类内容簇，做成深度答案页、FAQ 还是对比表？
2. **风险**：有没有负面信号、绝对化用语、医疗或特殊功效表述在扩散？该谁处置、多久内处置？
3. **度量**：竞品在公开语料里的声量如何变化？基线审计（提示词 × 六大引擎）采集到哪一步，五个核心指标是多少？

插件把三件事都做成**确定性规则**，同一次扫描永远得到同一份判断，因此每条选题卡和每条预警都能逐行解释。

## 数据从哪来

- **热点**：与 TrendRadar（sansan0/TrendRadar）同源的 `newsnow` 公开热榜接口，平台 id 与域名校验规则对齐其 `config/config.yaml`。插件自带采集，不需要先部署 TrendRadar；如已自建 newsnow 实例，把插件配置的 `apiUrl` 指过去即可。
- **实体与规则**：`lib/lexicon.js` 包含实体口径、八类内容簇、A–E 证据分级、必争信源、公关日历、宣称红线与风险登记表。仓库里的实体是**示例品牌**，换成你自己的即可。
- **提示词库**：`assets/prompts.json` 是示例数据集（20 条，覆盖八类内容簇）。替换成你自己的题库，`geo_baseline` 会按实际条数展开网格。
- **外部库**：证据与商品事实不放在插件里，放在你自己的 PostgreSQL，插件只读、按端口连接。

## 十一个工具

| 工具 | 用途 |
| --- | --- |
| `geo_scan` | 热榜采集 → 过滤打分 → 选题卡 + 风险预警 + 声量 + 日历窗口，并存快照 |
| `geo_topics` | 从快照重建选题卡（选题/簇/产品/形态/优先级/证据缺口/关联提示词），可导出 Markdown |
| `geo_alerts` | 负面与合规预警，按风险登记表分级并给责任人与处置建议 |
| `geo_sov` | 品牌与竞品的公开热榜提及份额，含窗口环比与平台分布 |
| `geo_report` | 日报 / 周报 Markdown，写入数据目录 |
| `geo_draft` | 内容生成骨架与契约校验：`skeleton` 出四层 Prompt + 模板 + JSON 契约；`validate` 校验 G1/G2/G4；`render` 出稿存档 |
| `geo_evidence` | 从证据库取 claim 并按准入规则分绿/黄/红，返回可喂给 L3 的证据包 |
| `geo_db` | PostgreSQL 只读通道：`status` / `template` / `test` / `schema` / `sample` |
| `geo_baseline` | 基线审计：`init` 建网格、`next` 领批次、`record` 录答案、`metrics` 算指标、`status` 看进度 |
| `geo_calendar` | 当前与未来 60 天的公关日历窗口，并用最近扫描标记热点窗口 |
| `geo_status` | 数据目录、快照、关键词分组告警、基线进度、平台清单与连通性实测 |

## 外部数据库（证据库 + 商品库）

- **两个独立实例**：`databases.evidence` 与 `databases.product` 各自配 host/port/database/user/schema。
- **口令不落在 config 里**：用 `passwordEnv` 指定变量名（默认 `GEO_EVIDENCE_PASSWORD` / `GEO_PRODUCT_PASSWORD`），插件按「环境变量 > `.env` 文件 > config 明文（仅兼容）」解析。`.env` 默认找 `<数据目录>/.env`，其次插件目录 `.env`；也可用 `envFile` 指定路径。`geo_db` action=`env` 会打印该文件位置与所需变量名。
- **只读账号**：建议单独开只读账号，并限制到需要的表。
- **表名字段名全部可配**：`databases.*.mapping` 覆盖默认名；`databases.*.sql.claims` / `.sql.sku` 可直接换成自己的 SQL。
- **只读保证**：每次连接后执行 `set session characteristics as transaction read only`，只做 select。
- **超时**：`connectTimeoutMs`（默认 5000）与 `statementTimeoutMs`（默认 8000）。
- **驱动可选**：`pg` 通过动态 import 加载，缺依赖时其余工具照常工作，只有 `geo_db` / `geo_evidence` 报「驱动未安装」。

### 接入顺序

1. `geo_db` action=`template` 取连接模板，action=`env` 看凭据该放哪。
2. 填连接信息（先不写 mapping），把口令写进 `.env` 或设为环境变量。
3. 重载插件 → `geo_db` action=`test` 确认连通。
4. `geo_db` action=`schema` 导出真实表名与字段清单。
5. 按清单改 `mapping`，或直接用 `sql` 覆盖查询。
6. `geo_db` action=`sample` 核对字段名。
7. `geo_evidence` action=`lookup` 看准入；`action=sku` 看商品事实卡。
8. `geo_draft` 的 `skeleton` 加 `autoEvidence: true` 与 `sku`，L3 自动填充预留。

## 内容生成做到哪一步

插件**不调用模型**。`geo_draft` 是一层约束，不是生成器：它把选题卡变成完整的起草简报，再把模型回传的 JSON 拿去闸门里过。

| 环节 | 由谁负责 |
| --- | --- |
| 起草 | agent。`skeleton` 交付四层 Prompt（七条硬性规则）、模板（G01–G12 按形态选）与 JSON 契约；`autoEvidence` 时 L3 由证据库填充 |
| Claim 准入 | 插件。A/B 级且未过期、状态批准、无红线词才可写功效结论；红项不进 L3 |
| G1 Schema | 插件。必填、类型、枚举、标题 ≤30 字、blocks 非空 |
| G2 证据绑定 | 插件。block→claim→evidence→citation 必须闭合 |
| G4 合规 | 插件。绝对化 / 医疗 / 特殊功效命中即退回；否定语境放行并告警 |
| 结构化 | 插件。`render` 把通过的 JSON 转 Markdown，JSON 与 MD 一起存档 |
| G3 事实蕴含 / G5 品牌语气 / 三签 | 人审。插件明确不判定 |

没有证据包时不会阻止出骨架，但 L3 会留占位符并标注「证据缺失」——照这份骨架写出来的稿子过不了 G2，这是有意的。

## 配置项

| 键 | 说明 |
| --- | --- |
| `platforms` | 默认采集平台 id 列表 |
| `apiUrl` | 热榜接口地址，留空用默认 newsnow 公共接口 |
| `dataDir` | 数据目录，默认 `~/.dsh/geo-trend-radar` |
| `keywordGroups` | 关键词分组文本，语法对齐 TrendRadar `frequency_words.txt`（`[组名]`、`#` 注释、`/正则/ => 备注`） |
| `intervalMs` / `timeoutMs` | 平台间间隔与单次请求超时 |
| `sovDays` / `horizonDays` | 声量窗口与日历向前看的天数 |
| `keepSnapshots` | 保留几份快照，默认 60 |
| `databases` | 见上方「外部数据库」 |

## 已知限制

- 热榜是各平台公开榜单，不含付费投放，也不等于 AI 答案里的内容；「声量份额」是 AI 份额的公开信号代理。
- 插件不驱动六大 AI 引擎，基线审计需人工（或后续自动化）把答案录回；事实核查条数与正确条数也由人填写。
- 打分是规则打分，不理解语义：反讽、多义词会误判，选题卡优先级需人工确认。
- `geo_draft` 的三道闸门也是规则：否定语境是启发式（限制词前 4 字内有否定词即放行并告警），谐音、拆字、繁体、图片内文字都拦不住，不能替代法务。
- 数据库连接写在插件 config，口令写在 `.env` 或环境变量；`config` 里若残留明文 `password` 仍可用，但状态页会标为「明文，建议改掉」。准入的「有效期」依赖证据表的 `valid_until`，为空视为长期有效，这是配置约定而非法律判断。
- 公共 newsnow 接口对机器人 User-Agent 会拦截，插件因此使用浏览器 UA 并串行请求；接口不可用时会明确报出失败平台与原因，不会用缓存或示例数据冒充真实结果。
