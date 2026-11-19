/**
 * Host half of the GEO hot-topic radar bundle for 方里 FUNNY ELVES.
 *
 * The plugin connects two things the master plan keeps apart:
 *   · TrendRadar-style public hot-list collection (the "what is being asked now" layer)
 *   · the GEO strategy artefacts (eight answer clusters, topic cards, compliance
 *     red lines, competitor SOV, T0 baseline audit, PR calendar)
 *
 * Eight model-facing tools are registered. None of them calls an LLM: scoring is
 * deterministic so a topic board can be defended line by line, and analysis is
 * left to the agent that reads the result.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { buildAlerts, renderAlertsMarkdown, summarizeAlerts } from './lib/alerts.js'
import {
  computeMetrics,
  createAudit,
  nextBatch,
  recordAnswers,
  renderBaselineMarkdown,
} from './lib/baseline.js'
import { annotateCalendar, calendarStatus, renderCalendarMarkdown } from './lib/calendar.js'
import { buildPromptPack, CONTENT_CONTRACT, pickTemplate, renderDraftMarkdown, TEMPLATES, validateDraft } from './lib/draft.js'
import { admitClaims, groupClaimRows, renderEvidenceMarkdown } from './lib/evidence.js'
import {
  buildClaimsQuery,
  buildSkuQuery,
  configTemplate,
  describeDbError,
  describeInstance,
  introspectSchema,
  resolveDatabases,
  testConnection,
  withClient,
} from './lib/pgdb.js'
import { collectHotlists, DEFAULT_PLATFORMS, SOURCE_CATALOG } from './lib/hotlist.js'
import { CLUSTER_BY_NAME, CLUSTERS, DEFAULT_KEYWORD_GROUPS, PRODUCTS } from './lib/lexicon.js'
import { matchItems, mergeScored, parseKeywordGroups } from './lib/match.js'
import { clusterVolume, renderReport, renderScanSummary, uniqueByTitle } from './lib/report.js'
import { buildSov, computeMentions, renderSovMarkdown } from './lib/sov.js'
import { compactItem, loadSnapshots, MAX_STORED_ITEMS, saveSnapshot } from './lib/snapshots.js'
import {
  ensureDir,
  layout,
  listFiles,
  localDate,
  makeStamp,
  readJson,
  resolveDataRoot,
  sanitizeId,
  writeJson,
  writeText,
} from './lib/store.js'
import { buildTopics, renderTopicsMarkdown } from './lib/topics.js'

/** Cordis plugin name. */
export const name = 'geo-trend-radar'

/** Only the tool registry is required; no Host service is touched. */
export const inject = ['tools']

const PROMPTS_URL = new URL('./assets/prompts.json', import.meta.url)
const DEFAULT_KEEP_SNAPSHOTS = 60

let promptCache = null

/** Load the prompt library once per process. */
async function loadPrompts() {
  if (promptCache !== null) return promptCache
  const raw = await readFile(PROMPTS_URL, 'utf8')
  const parsed = JSON.parse(raw)
  promptCache = Array.isArray(parsed?.prompts) ? parsed.prompts : []
  return promptCache
}

const jsonSafe = value => JSON.parse(JSON.stringify(value))

const outputSchema = {
  type: 'object',
  additionalProperties: true,
  properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
  required: ['ok'],
}

/**
 * Render a tool result as one Markdown block plus a compact JSON block.
 * The second block is what the Web dashboard tool view parses; the first is what
 * the model reads.
 */
const render = (_args, value) => {
  const head = String(value.message ?? '')
  const hint = typeof value.hint === 'string' && value.hint.length > 0 && value.hint !== head ? `\n\n提示：${value.hint}` : ''
  const blocks = [{ type: 'text', text: `${head}${hint}`.trim() }]
  if (value.view !== undefined && value.view !== null) {
    blocks.push({ type: 'text', text: JSON.stringify(value.view) })
  }
  return blocks
}

const failure = (code, message, hint) => ({ ok: false, code, message, hint })

/** Keyword groups from config text, with a warning list instead of a throw. */
function keywordGroups(config) {
  const text = typeof config.keywordGroups === 'string' && config.keywordGroups.trim().length > 0
    ? config.keywordGroups
    : DEFAULT_KEYWORD_GROUPS
  return parseKeywordGroups(text)
}

/** Resolve and validate the platform list. */
function resolvePlatforms(config, requested) {
  const configured = Array.isArray(config.platforms) && config.platforms.length > 0 ? config.platforms : DEFAULT_PLATFORMS
  const wanted = Array.isArray(requested) && requested.length > 0 ? requested : configured
  const known = new Set(SOURCE_CATALOG.map(entry => entry.id))
  const accepted = wanted.filter(id => typeof id === 'string' && known.has(id))
  return accepted.length > 0 ? [...new Set(accepted)] : DEFAULT_PLATFORMS
}

/**
 * Normalize operator-supplied candidates — the 客服问题 / 站内搜索词 / 竞品动态
 * inputs that §4.2 车间 01 lists beside the prompt library. They are explicit
 * asks, so they bypass the public-title anchor gate.
 */
function normalizeCandidates(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const [index, entry] of input.entries()) {
    if (typeof entry === 'string') {
      const title = entry.trim()
      if (title.length === 0) continue
      out.push({ platform: 'candidate', platformName: '候选问题', rank: index + 1, title, url: '', hot: '', summary: '' })
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.title !== 'string' || entry.title.trim().length === 0) continue
    out.push({
      platform: typeof entry.platform === 'string' && entry.platform.length > 0 ? entry.platform : 'candidate',
      platformName: typeof entry.platform === 'string' && entry.platform.length > 0 ? entry.platform : '候选问题',
      rank: Number.isFinite(Number(entry.rank)) ? Number(entry.rank) : index + 1,
      title: entry.title.trim(),
      url: typeof entry.url === 'string' ? entry.url : '',
      hot: typeof entry.hot === 'string' ? entry.hot : '',
      summary: typeof entry.summary === 'string' ? entry.summary : '',
    })
  }
  return out.slice(0, 200)
}

/** One draft id per call, in the plan's `gen_YYYYMMDD_xxx` shape. */
function suggestContentId(date = new Date()) {
  const pad = number => String(number).padStart(2, '0')
  return `gen_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** Accept a draft as an object or as the JSON string a model returned. */
function parseDraftInput(input) {
  if (input === undefined || input === null) return null
  if (typeof input === 'object') return input
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (trimmed.length === 0) return null
    try {
      return JSON.parse(trimmed)
    } catch {
      return { __parseError: true }
    }
  }
  return null
}

/** Build a topic from explicit arguments when no stored card is named. */
function topicFromArgs(args) {
  const clusterName = typeof args.cluster === 'string' && args.cluster.trim().length > 0 ? args.cluster.trim() : '品类推荐'
  const cluster = CLUSTER_BY_NAME[clusterName] ?? CLUSTERS[0]
  const productName = typeof args.product === 'string' && args.product.trim().length > 0 ? args.product.trim() : ''
  const product = productName.length === 0
    ? null
    : PRODUCTS.find(entry => entry.name === productName || entry.aliases.includes(productName)) ?? null
  return {
    id: null,
    question: String(args.question ?? '').trim(),
    cluster: cluster.name,
    clusterId: cluster.id,
    product: product?.name ?? (productName.length === 0 ? '—' : productName),
    productId: product?.id ?? null,
    format: typeof args.format === 'string' && args.format.trim().length > 0 ? args.format.trim() : cluster.format,
    evidenceGap: '未从选题卡继承（直接给定的问题），请人工确认证据缺口',
    evidence: `目标证据等级：${cluster.id === 'compare' ? 'A/B（同规格同时点）' : cluster.id === 'skin' ? 'A（检测 / 斑贴 / 人体功效）' : 'B/C + 产品事实卡'}`,
    priority: 'P1',
    source: { platform: '手动', rank: null, url: '', hot: '', scannedAt: '' },
  }
}

/** Find a stored topic card by id, or fall back to explicit arguments. */
async function resolveTopicCard(paths, args) {
  const wanted = typeof args.topicId === 'string' ? args.topicId.trim() : ''
  if (wanted.length === 0) return { card: topicFromArgs(args), source: 'args' }
  const snapshots = await loadSnapshots(paths, 60)
  const from = Date.now() - 3 * 24 * 60 * 60 * 1000
  const recent = snapshots.filter(entry => Date.parse(entry.scannedAt) >= from)
  if (recent.length === 0) {
    return { error: '没有可用的扫描快照，无法按 id 定位选题卡', available: [] }
  }
  const items = uniqueByTitle(recent.flatMap(entry => entry.matchedItems ?? []))
  const prompts = await loadPrompts()
  const cards = buildTopics(items, { limit: 60, prompts })
  const card = cards.find(entry => entry.id === wanted)
  if (card === undefined) {
    return { error: `最近 3 天的选题卡里没有 ${wanted}`, available: cards.slice(0, 12).map(entry => entry.id) }
  }
  return { card: { ...card, productId: PRODUCTS.find(entry => entry.name === card.product)?.id ?? null }, source: 'topic' }
}

/** Read claims from the evidence database and run claim admission over them. */
async function pullAdmittedClaims(instance, params) {
  const query = buildClaimsQuery(instance, params)
  const rows = await withClient(instance, async client => (await client.query(query.text, query.values)).rows)
  const claims = groupClaimRows(rows)
  return { claims, result: admitClaims(claims, { now: new Date() }), query }
}

/** Resolve one configured instance, or a ready-made failure result. */
function requireInstance(databases, name) {
  const instance = databases[name]
  if (instance !== null) return { instance }
  const label = name === 'evidence' ? '证据库' : '商品库'
  const own = databases.problems.filter(problem => problem.startsWith(`databases.${name}`))
  const detail = own.length > 0 ? own.join('；') : `databases.${name} 未配置`
  return {
    failure: failure('DB_NOT_CONFIGURED', `${label}未配置：${detail}`, '调用 geo_db action=template 取配置模板，填进插件 config 后重载插件再试。'),
  }
}

/** Build the compact dashboard payload for a scan. */
function scanView(snapshot, topics, alerts, sov, calendar) {
  return {
    kind: 'geo.view',
    view: 'scan',
    scannedAt: snapshot.scannedAt,
    counts: {
      items: snapshot.items,
      matched: snapshot.matched,
      platformsOk: snapshot.platformOk,
      platformTotal: snapshot.platformTotal,
      topics: topics.length,
      alerts: alerts.length,
      highAlerts: alerts.filter(alert => alert.level === 'high').length,
    },
    topics: topics.slice(0, 6).map(card => ({
      id: card.id,
      priority: card.priority,
      cluster: card.cluster,
      question: card.question,
      score: card.score,
      platform: card.source.platform,
      rank: card.source.rank,
    })),
    alerts: alerts.slice(0, 5).map(alert => ({ id: alert.id, level: alert.level, levelLabel: alert.levelLabel, rule: alert.rule, title: alert.title })),
    sov: {
      days: sov.window.days,
      brands: sov.brands.slice(0, 6).map(brand => ({ name: brand.name, mentions: brand.mentions, share: brand.share, self: brand.self })),
    },
    calendar: calendar.nodes.map(node => ({ theme: node.theme, phase: node.phase, startsInDays: node.startsInDays, hot: node.hot === true })),
    errors: snapshot.errors,
  }
}

/** Register one tool with a lossless JSON boundary. */
function registerTool(ctx, definition) {
  return ctx.tools.register({
    ...definition,
    async execute(args, exec) {
      return jsonSafe(await definition.execute(args ?? {}, exec))
    },
  })
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig row config from `cordis.patch.yml`.
 */
export function apply(ctx, rawConfig = {}) {
  const config = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}
  const paths = layout(resolveDataRoot(config))
  const keep = Number.isFinite(Number(config.keepSnapshots)) && Number(config.keepSnapshots) > 0
    ? Number(config.keepSnapshots)
    : DEFAULT_KEEP_SNAPSHOTS
  const parsedKeywords = keywordGroups(config)
  const databases = resolveDatabases(config)

  const tools = [
    {
      name: 'geo_scan',
      description: '采集公开热榜（TrendRadar 同源 newsnow 接口），按方里 GEO 实体与八类内容簇过滤打分，产出选题卡、风险预警、竞品声量与公关日历窗口，并保存本次扫描快照。热点→选题卡、负面/合规预警、SOV 三件事一次完成。采集与打分全部是确定性规则，不做 AI 推断。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          platforms: {
            type: 'array',
            items: { type: 'string' },
            description: `要采集的平台 id：${SOURCE_CATALOG.map(entry => entry.id).join('、')}。省略时用插件配置或默认 ${DEFAULT_PLATFORMS.join('、')}。`,
          },
          limit: { type: 'integer', description: '保留多少条命中热点，默认 60，最大 200。' },
          minScore: { type: 'number', description: '命中最低分（0—100），默认 0，用于收紧结果。' },
          topicLimit: { type: 'integer', description: '生成多少张选题卡，默认 20，最大 60。' },
          candidates: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['title'],
                  properties: {
                    title: { type: 'string', description: '候选问题或标题。' },
                    platform: { type: 'string', description: '来源标签，如「客服」「站内搜索」。' },
                    url: { type: 'string' },
                    hot: { type: 'string', description: '热度或频次说明。' },
                  },
                },
              ],
            },
            description: '额外候选问题（客服问题、站内搜索词、竞品动态、KOL 选题），与热榜命中一起评分；热榜安静时靠它保持产线运转。',
          },
          save: { type: 'boolean', description: '是否保存本次扫描快照，默认 true。' },
          label: { type: 'string', description: '本次扫描的标签，写入快照与文件名，便于复盘。' },
        },
      },
      output: { schema: outputSchema, render },
      isConcurrencySafe: () => false,
      timeoutMs: 180_000,
      async execute(args) {
        const platforms = resolvePlatforms(config, args.platforms)
        const collected = await collectHotlists({
          platforms,
          apiUrl: typeof config.apiUrl === 'string' ? config.apiUrl : undefined,
          intervalMs: Number.isFinite(Number(config.intervalMs)) ? Number(config.intervalMs) : 600,
          timeoutMs: Number.isFinite(Number(config.timeoutMs)) ? Number(config.timeoutMs) : 15_000,
        })
        if (collected.items.length === 0 && normalizeCandidates(args.candidates).length === 0) {
          return {
            ...failure(
              'NO_ITEMS',
              `没有从任何平台取到热榜（${collected.errors.map(entry => `${entry.name}: ${entry.message}`).join('；')}）`,
              '检查网络或代理，或把 config.apiUrl 指向自建的 newsnow 实例；也可以先用 candidates 传入客服问题与站内搜索词。',
            ),
            platforms: collected.platforms,
          }
        }

        const scannedAt = new Date().toISOString()
        const limit = Math.min(200, Math.max(1, Number(args.limit) || 60))
        const minScore = Number.isFinite(Number(args.minScore)) ? Number(args.minScore) : 0
        const candidates = normalizeCandidates(args.candidates)
        const hotMatched = matchItems(collected.items, {
          groups: parsedKeywords.groups,
          minScore,
          limit,
        })
        const candidateMatched = matchItems(candidates, {
          groups: parsedKeywords.groups,
          minScore: 0,
          limit: 200,
          requireAnchor: false,
        })
        const matched = mergeScored([candidateMatched, hotMatched], limit).map(item => ({ ...item, scannedAt }))

        const prompts = await loadPrompts()
        const topicLimit = Math.min(60, Math.max(1, Number(args.topicLimit) || 20))
        const topics = buildTopics(matched, { limit: topicLimit, prompts })
        const alerts = buildAlerts(matched)
        const mentions = computeMentions(collected.items)
        const calendar = annotateCalendar(
          calendarStatus(new Date(), { horizonDays: Number.isFinite(Number(config.horizonDays)) ? Number(config.horizonDays) : 60 }),
          clusterVolume(topics),
        )

        const snapshot = {
          id: `${makeStamp()}-${String(new Date().getSeconds()).padStart(2, '0')}`,
          version: 1,
          label: typeof args.label === 'string' ? sanitizeId(args.label, 'scan') : 'scan',
          scannedAt,
          sources: 'newsnow 公开热榜',
          apiUrl: collected.apiUrl,
          platforms: collected.platforms,
          platformTotal: collected.platforms.length,
          platformOk: collected.platforms.filter(entry => entry.status !== 'error').length,
          errors: collected.errors,
          items: collected.items.length,
          candidates: candidates.length,
          matched: matched.length,
          matchedItems: matched.slice(0, MAX_STORED_ITEMS).map(compactItem),
          topicIds: topics.map(card => card.id),
          alertIds: alerts.map(alert => alert.id),
          mentions,
        }

        let snapshotPath = null
        if (args.save !== false) {
          await ensureDir(paths.snapshots)
          snapshotPath = await saveSnapshot(paths, snapshot, keep)
          await ensureDir(paths.topics)
          await writeText(
            path.join(paths.topics, `${snapshot.id}.md`),
            renderTopicsMarkdown(topics, { date: localDate(new Date()), scannedAt: scannedAt.slice(0, 16).replace('T', ' '), sources: snapshot.sources }),
          )
          await ensureDir(paths.alerts)
          await writeJson(path.join(paths.alerts, `${snapshot.id}.json`), { snapshotId: snapshot.id, scannedAt, alerts })
        }

        const snapshots = args.save === false ? [] : await loadSnapshots(paths, 40)
        const sov = buildSov(
          snapshots.map(entry => ({ scannedAt: entry.scannedAt, mentions: entry.mentions })),
          { days: Number.isFinite(Number(config.sovDays)) ? Number(config.sovDays) : 7 },
        )

        return {
          ok: true,
          message: renderScanSummary({ snapshot, topics, alerts, sov, calendar, platforms: collected.platforms }),
          view: scanView(snapshot, topics, alerts, sov, calendar),
          snapshot: { id: snapshot.id, scannedAt, items: snapshot.items, matched: snapshot.matched, platformOk: snapshot.platformOk, platformTotal: snapshot.platformTotal, errors: snapshot.errors, path: snapshotPath },
          topics,
          alerts,
          sov,
          calendar,
          keywordWarnings: parsedKeywords.warnings,
        }
      },
    },
    {
      name: 'geo_topics',
      description: '从已保存的扫描快照重新生成 GEO 选题卡（选题/簇/产品/形态/优先级/证据缺口/关联提示词），可按内容簇、优先级、天数过滤，并可导出 Markdown。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          days: { type: 'integer', description: '回看最近多少天的快照，默认 3。' },
          cluster: { type: 'string', description: '只看某个内容簇，如「肤质肤况」「竞品对比」。' },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2'], description: '只看某个优先级。' },
          limit: { type: 'integer', description: '最多多少张卡，默认 20，最大 60。' },
          export: { type: 'boolean', description: '是否把 Markdown 写到数据目录的 reports/ 下，默认 false。' },
        },
      },
      output: { schema: outputSchema, render },
      isConcurrencySafe: () => true,
      timeoutMs: 60_000,
      async execute(args) {
        const snapshots = await loadSnapshots(paths, 60)
        const days = Math.max(1, Number(args.days) || 3)
        const from = Date.now() - days * 24 * 60 * 60 * 1000
        const recent = snapshots.filter(entry => Date.parse(entry.scannedAt) >= from)
        if (recent.length === 0) {
          return failure('NO_SNAPSHOT', '没有可用的扫描快照。先运行 geo_scan。', `数据目录：${paths.snapshots}`)
        }
        const items = uniqueByTitle(recent.flatMap(entry => entry.matchedItems))
        const filtered = items
          .filter(item => args.cluster === undefined || args.cluster === '' || item.cluster?.name === args.cluster)
          .filter(item => args.priority === undefined || args.priority === '' || item.priority === args.priority)
        const prompts = await loadPrompts()
        const cards = buildTopics(filtered, { limit: Math.min(60, Math.max(1, Number(args.limit) || 20)), prompts })
        const markdown = renderTopicsMarkdown(cards, {
          date: localDate(new Date()),
          scannedAt: recent[0].scannedAt.slice(0, 16).replace('T', ' '),
          sources: `最近 ${days} 天的 ${recent.length} 次扫描`,
        })
        let exportPath = null
        if (args.export === true) {
          await ensureDir(paths.reports)
          exportPath = await writeText(path.join(paths.reports, `topics-${localDate(new Date())}-${makeStamp()}.md`), markdown)
        }
        return {
          ok: true,
          message: markdown,
          view: {
            kind: 'geo.view',
            view: 'topics',
            scannedAt: recent[0].scannedAt,
            days,
            scans: recent.length,
            total: cards.length,
            cards: cards.slice(0, 12).map(card => ({
              id: card.id,
              priority: card.priority,
              cluster: card.cluster,
              question: card.question,
              product: card.product,
              format: card.format,
              score: card.score,
              platform: card.source.platform,
              rank: card.source.rank,
            })),
          },
          topics: cards,
          exportPath,
        }
      },
    },
    {
      name: 'geo_alerts',
      description: '列出负面与合规风险预警：方里及竞品负面词、绝对化用语、医疗术语、特殊功效宣称、实体口径错误、竞品动作、平台变化。按风险登记表分级并给出责任人与处置建议。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          days: { type: 'integer', description: '回看最近多少天的快照，默认 3。' },
          level: { type: 'string', enum: ['high', 'medium', 'low'], description: '只看某一风险等级。' },
          limit: { type: 'integer', description: '最多返回多少条，默认 40。' },
        },
      },
      output: { schema: outputSchema, render },
      isConcurrencySafe: () => true,
      timeoutMs: 60_000,
      async execute(args) {
        const snapshots = await loadSnapshots(paths, 60)
        const days = Math.max(1, Number(args.days) || 3)
        const from = Date.now() - days * 24 * 60 * 60 * 1000
        const recent = snapshots.filter(entry => Date.parse(entry.scannedAt) >= from)
        if (recent.length === 0) {
          return failure('NO_SNAPSHOT', '没有可用的扫描快照。先运行 geo_scan。', `数据目录：${paths.snapshots}`)
        }
        const items = uniqueByTitle(recent.flatMap(entry => entry.matchedItems))
        const alerts = buildAlerts(items)
          .filter(alert => args.level === undefined || args.level === '' || alert.level === args.level)
          .slice(0, Math.min(200, Math.max(1, Number(args.limit) || 40)))
        return {
          ok: true,
          message: renderAlertsMarkdown(alerts, { date: localDate(new Date()) }),
          view: {
            kind: 'geo.view',
            view: 'alerts',
            days,
            scans: recent.length,
            summary: summarizeAlerts(alerts),
            alerts: alerts.slice(0, 10).map(alert => ({ id: alert.id, levelLabel: alert.levelLabel, rule: alert.rule, title: alert.title, owner: alert.owner, terms: alert.terms })),
          },
          alerts,
          summary: summarizeAlerts(alerts),
        }
      },
    },
    {
      name: 'geo_sov',
      description: '计算方里与竞品（花西子/毛戈平/彩棠/blankme/薇诺娜/雅诗兰黛 DW 等）在公开热榜上的提及份额 SOV，含窗口对比与平台分布。这是 AI 声量份额的公开信号代理，不是 AI 答案里的份额。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          days: { type: 'integer', description: '统计窗口天数，默认 7。' },
        },
      },
      output: { schema: outputSchema, render },
      isConcurrencySafe: () => true,
      timeoutMs: 60_000,
      async execute(args) {
        const snapshots = await loadSnapshots(paths, 120)
        if (snapshots.length === 0) {
          return failure('NO_SNAPSHOT', '没有可用的扫描快照。先运行 geo_scan 建立基线。', `数据目录：${paths.snapshots}`)
        }
        const sov = buildSov(
          snapshots.map(entry => ({ scannedAt: entry.scannedAt, mentions: entry.mentions })),
          { days: Math.max(1, Number(args.days) || 7) },
        )
        return {
          ok: true,
          message: renderSovMarkdown(sov),
          view: {
            kind: 'geo.view',
            view: 'sov',
            window: sov.window,
            brands: sov.brands.slice(0, 8).map(brand => ({ name: brand.name, mentions: brand.mentions, share: brand.share, deltaPoints: brand.deltaPoints, self: brand.self })),
            gap: sov.gap,
          },
          sov,
        }
      },
    },
    {
      name: 'geo_report',
      description: '生成方里 GEO 日报或周报（Markdown），汇总选题卡、风险预警、竞品声量、公关日历与 T0 基线进度，写入数据目录 reports/ 并返回全文。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          period: { type: 'string', enum: ['daily', 'weekly'], description: '日报或周报，默认 daily。' },
          days: { type: 'integer', description: '汇总最近多少天的快照，默认日报 1 天、周报 7 天。' },
          export: { type: 'boolean', description: '是否写入 reports/ 目录，默认 true。' },
        },
      },
      output: { schema: outputSchema, render },
      isConcurrencySafe: () => true,
      timeoutMs: 120_000,
      async execute(args) {
        const period = args.period === 'weekly' ? 'weekly' : 'daily'
        const days = Math.max(1, Number(args.days) || (period === 'weekly' ? 7 : 1))
        const snapshots = await loadSnapshots(paths, 120)
        const from = Date.now() - days * 24 * 60 * 60 * 1000
        const recent = snapshots.filter(entry => Date.parse(entry.scannedAt) >= from)
        if (recent.length === 0) {
          return failure('NO_SNAPSHOT', `最近 ${days} 天没有扫描快照。先运行 geo_scan。`, `数据目录：${paths.snapshots}`)
        }
        const items = uniqueByTitle(recent.flatMap(entry => entry.matchedItems))
        const prompts = await loadPrompts()
        const topics = buildTopics(items, { limit: 20, prompts })
        const alerts = buildAlerts(items)
        const sov = buildSov(
          snapshots.map(entry => ({ scannedAt: entry.scannedAt, mentions: entry.mentions })),
          { days: Math.max(days, 7) },
        )
        const calendar = annotateCalendar(calendarStatus(new Date(), { horizonDays: 60 }), clusterVolume(topics))
        const audit = await readJson(path.join(paths.baseline, 'audit.json'))
        const markdown = renderReport({
          period,
          date: new Date(),
          snapshot: {
            scannedAt: recent[0].scannedAt,
            matched: items.length,
            sources: `最近 ${days} 天的 ${recent.length} 次扫描`,
          },
          topics,
          alerts,
          sov,
          calendar,
          audit,
          history: recent.slice(0, 5).map(entry => ({ scannedAt: entry.scannedAt, items: entry.items, matched: entry.matched, errors: entry.errors?.length ?? 0 })),
        })
        let exportPath = null
        if (args.export !== false) {
          await ensureDir(paths.reports)
          exportPath = await writeText(path.join(paths.reports, `geo-${period}-${localDate(new Date())}.md`), markdown)
        }
        return {
          ok: true,
          message: markdown,
          view: {
            kind: 'geo.view',
            view: 'report',
            period,
            days,
            scans: recent.length,
            topics: topics.length,
            alerts: alerts.length,
            exportPath,
          },
          exportPath,
          topicsCount: topics.length,
          alertsCount: alerts.length,
        }
      },
    },
    {
      name: 'geo_draft',
      description: '内容生成骨架与 JSON 契约校验（不调用模型）。action=skeleton 时按选题卡产出四层 Prompt、附录 C 模板与附录 B 的 JSON 契约，供 agent 起草；action=validate 校验回传 JSON 的 G1 Schema、G2 证据绑定（block→claim→evidence→citation 闭合）与 G4 合规红线；action=render 把通过校验的 JSON 渲染成 Markdown 并存档。G3 事实蕴含、G5 品牌语气与三签仍需人审。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['skeleton', 'validate', 'render'], description: 'skeleton 出骨架，validate 校验，render 出稿。' },
          topicId: { type: 'string', description: '选题卡编号，如 GT-20261117-001；省略时用 question 直接构造。' },
          question: { type: 'string', description: '直接给定用户问题（无 topicId 时必填）。' },
          cluster: { type: 'string', description: '内容簇名，如「肤质肤况」「竞品对比」；无选题卡时用于决定模板与证据等级。' },
          product: { type: 'string', description: '产品名，如「方里特护粉底液」。' },
          format: { type: 'string', description: '形态，如「深度答案页」「FAQ / 短答案」「对比表 / 选购指南」。' },
          evidence: {
            type: 'array',
            description: 'skeleton 用：证据包。每条含 claim/evidence 两份 id 与来源。空数组时 L3 会留占位符并明确标注证据缺失。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                claim_id: { type: 'string', description: '如 C01。' },
                text: { type: 'string', description: 'claim 原文。' },
                evidence_id: { type: 'string', description: '如 E01。' },
                source: { type: 'string', description: '来源，如「第三方检测报告」。' },
                date: { type: 'string', description: '证据日期。' },
                grade: { type: 'string', description: '证据等级 A—E。' },
                limitations: { type: 'string', description: '限制条件，如「仅油皮/混油」。' },
              },
            },
          },
          draft: { description: 'validate / render 用：附录 B 契约的 JSON 对象，或其字符串形式。' },
          sku: { type: 'string', description: 'SKU 编码，用于从证据库自动取 claim（配合 autoEvidence）。' },
          autoEvidence: { type: 'boolean', description: '为 true 且证据库已配置时，自动把准入通过的 claim 填进 L3，省去人工粘贴。' },
          contentId: { type: 'string', description: '内容 ID；省略时自动生成 gen_日期_时间。' },
          save: { type: 'boolean', description: '是否把骨架或终稿写入数据目录 drafts/，默认 true。' },
        },
      },
      output: { schema: outputSchema, render },
      isConcurrencySafe: () => true,
      timeoutMs: 60_000,
      async execute(args) {
        const action = args.action === 'validate' ? 'validate' : args.action === 'render' ? 'render' : 'skeleton'
        const contentId = typeof args.contentId === 'string' && args.contentId.trim().length > 0 ? args.contentId.trim() : suggestContentId()

        if (action === 'skeleton') {
          const resolved = await resolveTopicCard(paths, args)
          if (resolved.error !== undefined) {
            return failure('TOPIC_NOT_FOUND', resolved.error, resolved.available.length === 0 ? undefined : `可用选题卡：${resolved.available.join('、')}`)
          }
          const card = resolved.card
          if (typeof card.question !== 'string' || card.question.length === 0) {
            return failure('MISSING_QUESTION', '需要 topicId（已有选题卡），或直接给出 question。')
          }
          const template = pickTemplate(card.clusterId, card.format)
          const risk = ['skin', 'compare', 'price'].includes(card.clusterId) ? 'high' : 'medium'
          const warnings = []
          let evidence = Array.isArray(args.evidence) ? args.evidence : []
          let evidenceSource = evidence.length > 0 ? '调用方直接提供' : ''
          if (args.autoEvidence === true) {
            const picked = requireInstance(databases, 'evidence')
            if (picked.failure !== undefined) {
              warnings.push('证据库未配置，autoEvidence 已跳过；L3 仍是占位符')
            } else {
              const sku = typeof args.sku === 'string' && args.sku.trim().length > 0 ? args.sku.trim() : null
              try {
                const { result } = await pullAdmittedClaims(picked.instance, { sku, keyword: null, limit: 80 })
                evidence = result.evidencePack
                evidenceSource = `证据库 ${describeInstance(picked.instance).target}（准入：可用 ${result.counts.green} 条 / 有条件 ${result.counts.yellow} 条 / 禁用 ${result.counts.red} 条）`
                if (sku === null) warnings.push('未指定 sku，已取该库前 80 条 claim；建议按 SKU 收紧，避免 L3 混入无关表述')
                if (result.red.length > 0) warnings.push(`证据库有 ${result.red.length} 条 claim 被判禁用，未进入 L3`)
              } catch (error) {
                warnings.push(describeDbError(error, picked.instance))
              }
            }
          }
          const pack = buildPromptPack(card, { evidence, template })
          const lines = [`## 生成骨架 · ${contentId}`, '']
          lines.push(`- 选题：${card.question}`)
          lines.push(`- 内容簇：${card.cluster}　产品：${card.product}　形态：${card.format}`)
          lines.push(`- 模板：${template.id} ${template.name}（${template.words}，content_type=${template.content_type}）`)
          lines.push(`- 建议风险等级：${risk}`)
          lines.push(`- 证据：${pack.evidenceMissing ? '⚠️ 未提供证据包，L3 已留下占位符，起草前必须补齐' : `已提供 ${pack.evidenceCount} 条 claim`}`)
          if (evidenceSource !== '') lines.push(`- 证据来源：${evidenceSource}`)
          for (const warning of warnings) lines.push(`- ⚠️ ${warning}`)
          if (card.evidenceGap !== undefined) lines.push(`- 证据缺口（选题卡）：${card.evidenceGap}`)
          lines.push('')
          lines.push('### 四层 Prompt（复制给模型）')
          lines.push('```text')
          lines.push(pack.text)
          lines.push('```')
          lines.push('')
          lines.push('### JSON 契约（附录 B）')
          lines.push('```json')
          lines.push(JSON.stringify(CONTENT_CONTRACT, null, 2))
          lines.push('```')
          lines.push('')
          lines.push('### 交付前必过')
          lines.push('- G1 Schema / G2 证据绑定 / G4 合规：模型回传后调用 `geo_draft`，action 为 validate')
          lines.push('- G3 事实蕴含、G5 品牌语气、三签：人审，插件不判定')
          let promptPath = null
          if (args.save !== false) {
            await ensureDir(paths.drafts)
            promptPath = await writeText(path.join(paths.drafts, `${sanitizeId(contentId, 'draft')}.prompt.md`), `${lines.join('\n')}\n`)
          }
          return {
            ok: true,
            message: lines.join('\n'),
            view: {
              kind: 'geo.view',
              view: 'draft',
              action: 'skeleton',
              contentId,
              template: `${template.id} ${template.name}`,
              contentType: template.content_type,
              cluster: card.cluster,
              risk,
              evidenceCount: pack.evidenceCount,
              evidenceMissing: pack.evidenceMissing,
              evidenceSource,
              warnings: warnings.length,
              promptPath,
            },
            contentId,
            template: { id: template.id, name: template.name, contentType: template.content_type, words: template.words },
            suggestedRisk: risk,
            warnings,
            evidenceSource,
            prompt: pack.layers,
            promptText: pack.text,
            contract: CONTENT_CONTRACT,
            promptPath,
          }
        }

        const draft = parseDraftInput(args.draft)
        if (draft === null) return failure('MISSING_DRAFT', 'validate / render 需要 draft（附录 B 契约的 JSON 对象或其字符串）。')
        if (draft.__parseError === true) return failure('DRAFT_NOT_JSON', 'draft 不是合法 JSON，请只回传契约里的 JSON 本身，不要带解释或代码围栏。')

        // A draft carries everything validation needs; only a real topic refines the template.
        const resolvedTopic = await resolveTopicCard(paths, args)
        const template = resolvedTopic.source === 'topic'
          ? pickTemplate(resolvedTopic.card.clusterId, resolvedTopic.card.format)
          : (TEMPLATES.find(entry => entry.content_type === draft.content_type) ?? TEMPLATES[0])

        const report = validateDraft(draft)
        const header = [`## 契约校验 · ${typeof draft.content_id === 'string' ? draft.content_id : contentId}`, '']
        header.push(report.ok ? `结果：**通过**（警告 ${report.warnings.length} 条）` : `结果：**未通过**（错误 ${report.errors.length} 条，警告 ${report.warnings.length} 条）`)
        header.push('')
        if (report.errors.length > 0) {
          header.push('### 阻断项')
          for (const error of report.errors) header.push(`- ${error}`)
          header.push('')
        }
        if (report.warnings.length > 0) {
          header.push('### 警告')
          for (const warning of report.warnings) header.push(`- ${warning}`)
          header.push('')
        }
        header.push('### 统计')
        header.push(`blocks ${report.stats.blocks}（已绑定 claim ${report.stats.claimBoundBlocks}）｜claims ${report.stats.claims}｜citations ${report.stats.citations}`)
        header.push('')
        header.push('G3 事实蕴含、G5 品牌语气与三签不由插件判定，仍需人审。')

        let jsonPath = null
        let markdownPath = null
        if (action === 'render') {
          if (!report.ok) {
            return {
              ok: false,
              code: 'CONTRACT_FAILED',
              message: header.join('\n'),
              hint: '先按阻断项改写草稿，再重新 render。',
              view: { kind: 'geo.view', view: 'draft', action: 'validate', ok: false, contentId, errors: report.errors.length, warnings: report.warnings.length },
              report,
            }
          }
          const markdown = renderDraftMarkdown(draft, { templateId: template.id, contentId: String(draft.content_id ?? contentId) })
          if (args.save !== false) {
            await ensureDir(paths.drafts)
            const base = sanitizeId(String(draft.content_id ?? contentId), 'draft')
            jsonPath = await writeJson(path.join(paths.drafts, `${base}.json`), draft)
            markdownPath = await writeText(path.join(paths.drafts, `${base}.md`), `${markdown}\n`)
          }
          return {
            ok: true,
            message: markdown,
            view: {
              kind: 'geo.view',
              view: 'draft',
              action: 'render',
              ok: true,
              contentId: String(draft.content_id ?? contentId),
              template: `${template.id} ${template.name}`,
              risk: draft.risk_level,
              claims: report.stats.claims,
              citations: report.stats.citations,
              warnings: report.warnings.length,
              jsonPath,
              markdownPath,
            },
            report,
            jsonPath,
            markdownPath,
          }
        }

        if (report.ok && args.save !== false) {
          await ensureDir(paths.drafts)
          jsonPath = await writeJson(path.join(paths.drafts, `${sanitizeId(String(draft.content_id ?? contentId), 'draft')}.json`), draft)
        }
        return {
          ok: report.ok,
          message: header.join('\n'),
          view: {
            kind: 'geo.view',
            view: 'draft',
            action: 'validate',
            ok: report.ok,
            contentId: String(draft.content_id ?? contentId),
            errors: report.errors.length,
            warnings: report.warnings.length,
            claims: report.stats.claims,
            citations: report.stats.citations,
          },
          report,
          jsonPath,
        }
      },
    },
    {
      name: 'geo_baseline',
      description: 'T0 基线审计助手：把提示词库 × 6 大引擎展开成采集网格，按批次领取待采问题、录入引擎答案并自动派生提及/首选/引用/负面标记，计算提及率、首选率、引用率、事实准确率、负面率（含分引擎与分簇）。action 取 init/next/record/metrics/status。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['init', 'next', 'record', 'metrics', 'status'], description: 'init 建网格，next 领批次，record 录答案，metrics 算指标，status 看进度。' },
          size: { type: 'integer', description: 'next 每批多少条，默认 10，最大 100。' },
          cluster: { type: 'string', description: 'next 只领某个内容簇。' },
          engine: { type: 'string', description: 'next 只领某个引擎（id 或中文名）。' },
          promptId: { type: 'string', description: 'next 只领某条提示词，如 P001。' },
          entries: {
            type: 'array',
            description: 'record 用：答案条目数组。',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['promptId', 'engine', 'answer'],
              properties: {
                promptId: { type: 'string', description: '提示词 id，如 P001。' },
                engine: { type: 'string', description: '引擎 id 或中文名，如 deepseek / DeepSeek。' },
                answer: { type: 'string', description: '引擎返回的答案原文。' },
                factsTotal: { type: 'integer', description: '该答案中被核查的事实陈述数。' },
                factsCorrect: { type: 'integer', description: '其中事实正确的陈述数。' },
                note: { type: 'string', description: '备注，如人工复核结论。' },
              },
            },
          },
          reset: { type: 'boolean', description: 'init 时是否覆盖已有网格，默认 false。' },
        },
      },
      output: { schema: outputSchema, render },
      isConcurrencySafe: () => false,
      timeoutMs: 60_000,
      async execute(args) {
        const file = path.join(paths.baseline, 'audit.json')
        const action = String(args.action ?? '')
        if (action === 'init') {
          const existing = await readJson(file)
          if (existing !== null && args.reset !== true) {
            return {
              ok: true,
              message: `审计网格已存在：${existing.total} 行（建立于 ${existing.createdAt.slice(0, 10)}）。如需重建请传 reset: true。`,
              view: { kind: 'geo.view', view: 'baseline', action: 'init', total: existing.total, audited: existing.rows.filter(row => row.status === 'done').length, created: false },
              created: false,
              total: existing.total,
            }
          }
          const prompts = await loadPrompts()
          const audit = createAudit(prompts)
          await writeJson(file, audit)
          const metrics = computeMetrics(audit)
          return {
            ok: true,
            message: `已生成 T0 审计网格：${audit.promptCount} 条提示词 × 平均 ${Math.round(audit.total / audit.promptCount * 10) / 10} 个引擎 = ${audit.total} 行。\n\n${renderBaselineMarkdown(audit, metrics)}`,
            view: { kind: 'geo.view', view: 'baseline', action: 'init', total: audit.total, audited: 0, created: true },
            created: true,
            total: audit.total,
          }
        }

        const audit = await readJson(file)
        if (audit === null) return failure('NO_AUDIT', '还没有 T0 审计网格。先调用 geo_baseline，action 为 init。', `数据目录：${paths.baseline}`)

        if (action === 'next') {
          const batch = nextBatch(audit, Math.min(100, Math.max(1, Number(args.size) || 10)), {
            cluster: args.cluster,
            engine: args.engine,
            promptId: args.promptId,
          })
          const lines = [`# 待采集批次（${batch.batch.length} 条，剩余 ${batch.remaining} 条）`, '']
          if (batch.batch.length === 0) {
            lines.push('没有符合条件的待采集行。改用 metrics 看结果，或放宽 cluster / engine 过滤。')
          } else {
            lines.push('| 行 ID | 提示词 ID | 簇 | 提示词 | 引擎 | 优先级 |')
            lines.push('| --- | --- | --- | --- | --- | --- |')
            for (const row of batch.batch) {
              lines.push(`| ${row.id} | ${row.promptId} | ${row.cluster} | ${row.prompt} | ${row.engineName} | ${row.priority} |`)
            }
            lines.push('')
            lines.push('把每条引擎答案用 `geo_baseline` 的 `record` 传回，答案原文会自动派生提及/首选/引用/负面标记。')
          }
          return {
            ok: true,
            message: lines.join('\n'),
            view: { kind: 'geo.view', view: 'baseline', action: 'next', total: audit.total, remaining: batch.remaining, batch: batch.batch.length },
            batch: batch.batch,
            remaining: batch.remaining,
            total: audit.total,
          }
        }

        if (action === 'record') {
          const entries = Array.isArray(args.entries) ? args.entries : []
          if (entries.length === 0) return failure('MISSING_ENTRIES', 'record 需要 entries 数组，每项含 promptId / engine / answer。')
          const result = recordAnswers(audit, entries)
          await writeJson(file, audit)
          const metrics = computeMetrics(audit)
          return {
            ok: true,
            message: `已录入 ${result.recorded} 条${result.skipped.length === 0 ? '' : `，跳过 ${result.skipped.length} 条（${result.skipped.map(entry => `${entry.promptId}/${entry.engine}: ${entry.reason}`).join('；')}）`}。\n\n${renderBaselineMarkdown(audit, metrics, { remaining: audit.total - metrics.audited })}`,
            view: {
              kind: 'geo.view',
              view: 'baseline',
              action: 'record',
              recorded: result.recorded,
              skipped: result.skipped.length,
              total: audit.total,
              audited: metrics.audited,
              mentionRate: metrics.mentionRate,
              firstChoiceRate: metrics.firstChoiceRate,
              citationRate: metrics.citationRate,
              coverage: metrics.coverage,
            },
            recorded: result.recorded,
            skipped: result.skipped,
            metrics,
          }
        }

        const metrics = computeMetrics(audit)
        const remaining = audit.total - metrics.audited
        const lines = [renderBaselineMarkdown(audit, metrics, { remaining })]
        if (action === 'status') {
          const done = audit.rows.filter(row => row.status === 'done')
          const last = done.map(row => row.recordedAt).filter(value => typeof value === 'string').sort().at(-1) ?? null
          lines.push('')
          lines.push(`网格建立：${audit.createdAt.slice(0, 19).replace('T', ' ')}　最后录入：${last === null ? '尚未录入' : last.slice(0, 19).replace('T', ' ')}`)
        }
        return {
          ok: true,
          message: lines.join('\n'),
          view: {
            kind: 'geo.view',
            view: 'baseline',
            action: action === 'status' ? 'status' : 'metrics',
            total: audit.total,
            audited: metrics.audited,
            coverage: metrics.coverage,
            mentionRate: metrics.mentionRate,
            firstChoiceRate: metrics.firstChoiceRate,
            citationRate: metrics.citationRate,
            factAccuracy: metrics.factAccuracy,
            negativeRate: metrics.negativeRate,
            remaining,
            byEngine: metrics.byEngine.slice(0, 6).map(entry => ({ label: entry.label, audited: entry.audited, mentionRate: entry.mentionRate })),
          },
          metrics,
          remaining,
        }
      },
    },
    {
      name: 'geo_calendar',
      description: '公关日历窗口：报出当前所处的节点、未来 60 天将开启的节点、对应重点引擎与关联内容簇，并把最近扫描里已有讨论的簇标记为热点窗口。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          horizonDays: { type: 'integer', description: '向前看多少天，默认 60。' },
          live: { type: 'boolean', description: '是否用最近扫描的热度标记节点，默认 true。' },
        },
      },
      output: { schema: outputSchema, render },
      isConcurrencySafe: () => true,
      timeoutMs: 30_000,
      async execute(args) {
        const horizonDays = Math.max(1, Number(args.horizonDays) || 60)
        let volume = []
        if (args.live !== false) {
          const snapshots = await loadSnapshots(paths, 10)
          const items = snapshots.flatMap(entry => entry.matchedItems)
          if (items.length > 0) {
            const prompts = await loadPrompts()
            volume = clusterVolume(buildTopics(items, { limit: 40, prompts }))
          }
        }
        const status = annotateCalendar(calendarStatus(new Date(), { horizonDays }), volume)
        return {
          ok: true,
          message: renderCalendarMarkdown(status),
          view: {
            kind: 'geo.view',
            view: 'calendar',
            today: status.today,
            nodes: status.nodes.map(node => ({ theme: node.theme, phase: node.phase, startsInDays: node.startsInDays, hot: node.hot === true, engines: node.engines })),
          },
          calendar: status,
        }
      },
    },
    {
      name: 'geo_status',
      description: '检查 GEO 雷达运行条件：数据目录、快照数量与最近一次扫描、失败平台、关键词分组与告警、T0 基线进度、可用热榜平台清单。首次使用或扫描失败时先调用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          probe: { type: 'boolean', description: '是否实测一个平台的连通性，默认 false。' },
        },
      },
      output: { schema: outputSchema, render },
      isConcurrencySafe: () => false,
      timeoutMs: 60_000,
      async execute(args) {
        const snapshots = await listFiles(paths.snapshots, fileName => fileName.endsWith('.json'))
        const latest = await readJson(paths.latest)
        const audit = await readJson(path.join(paths.baseline, 'audit.json'))
        const metrics = audit === null ? null : computeMetrics(audit)
        const lines = ['# GEO 雷达状态', '']
        lines.push(`- 数据目录：${paths.root}`)
        lines.push(`- 扫描快照：${snapshots.length} 个${latest === null ? '' : `，最近一次 ${String(latest.scannedAt).slice(0, 16).replace('T', ' ')}`}`)
        lines.push(`- 关键词分组：${parsedKeywords.groups.length} 组（${parsedKeywords.groups.map(group => `${group.name}:${group.terms.length}`).join('、')}）`)
        if (parsedKeywords.warnings.length > 0) lines.push(`- ⚠️ 正则告警：${parsedKeywords.warnings.map(entry => `${entry.line} → ${entry.message}`).join('；')}`)
        lines.push(`- T0 基线：${audit === null ? '尚未建立（geo_baseline init）' : `${metrics.audited}/${metrics.total} 已采集（${metrics.coverage}%）`}`)
        lines.push(`- 热榜接口：${typeof config.apiUrl === 'string' && config.apiUrl.length > 0 ? config.apiUrl : '默认 newsnow 公共接口（可配置 apiUrl 指向自建实例）'}`)
        lines.push(`- 默认平台：${resolvePlatforms(config, undefined).join('、')}`)
        let probe = null
        if (args.probe === true) {
          const platform = resolvePlatforms(config, undefined)[0]
          try {
            const result = await collectHotlists({ platforms: [platform], intervalMs: 0, apiUrl: typeof config.apiUrl === 'string' ? config.apiUrl : undefined })
            probe = { platform, ok: result.items.length > 0, items: result.items.length, errors: result.errors }
            lines.push(`- 连通性实测（${platform}）：${result.items.length > 0 ? `成功，取到 ${result.items.length} 条` : `失败：${result.errors.map(entry => entry.message).join('；')}`}`)
          } catch (error) {
            probe = { platform, ok: false, items: 0, errors: [{ message: error instanceof Error ? error.message : String(error) }] }
            lines.push(`- 连通性实测（${platform}）：失败 ${probe.errors[0].message}`)
          }
        }
        return {
          ok: true,
          message: lines.join('\n'),
          view: {
            kind: 'geo.view',
            view: 'status',
            dataRoot: paths.root,
            snapshots: snapshots.length,
            latestScan: latest === null ? null : latest.scannedAt,
            groups: parsedKeywords.groups.length,
            warnings: parsedKeywords.warnings.length,
            baseline: audit === null ? null : { audited: metrics.audited, total: metrics.total, coverage: metrics.coverage },
            platforms: resolvePlatforms(config, undefined),
            probe,
          },
          dataRoot: paths.root,
          snapshots: snapshots.length,
          latestScan: latest,
          keywordGroups: parsedKeywords.groups.map(group => ({ name: group.name, terms: group.terms.length })),
          keywordWarnings: parsedKeywords.warnings,
          baseline: audit === null ? null : { total: audit.total, audited: metrics.audited, coverage: metrics.coverage },
          availablePlatforms: SOURCE_CATALOG,
          probe,
        }
      },
    },
    {
      name: 'geo_db',
      description: '外部参考库（PostgreSQL）只读通道，支持证据库与商品库两个独立实例。action=status 看配置与驱动是否就绪；template 给出可粘贴的 config 模板；test 测连通性（只读会话 + 超时）；schema 导出表与字段清单，用于把现有表映射到插件；sample 取 5 行看真实字段名。插件只读，不建表不改数据。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['status', 'template', 'test', 'schema', 'sample'], description: 'status 状态，template 配置模板，test 连通性，schema 字段清单，sample 取样。' },
          instance: { type: 'string', enum: ['evidence', 'product'], description: '目标实例，默认 evidence（证据库）。' },
          tables: { type: 'array', items: { type: 'string' }, description: 'schema 用：只导出这些表的字段；省略则导出整个 schema。' },
          sku: { type: 'string', description: 'sample 用：按 SKU 过滤。' },
        },
      },
      output: { schema: outputSchema, render },
      isConcurrencySafe: () => false,
      timeoutMs: 40_000,
      async execute(args) {
        const action = ['status', 'template', 'test', 'schema', 'sample'].includes(args.action) ? args.action : 'status'
        const instanceName = args.instance === 'product' ? 'product' : 'evidence'

        if (action === 'template') {
          const body = configTemplate()
          return {
            ok: true,
            message: ['## 插件 config 模板', '', '把下面这段合并进插件配置的 `config` 下（与 `platforms` 同级），改掉 host/port/database/user/password 与表名字段名即可。', '', '```yaml', body, '```'].join('\n'),
            view: { kind: 'geo.view', view: 'db', action: 'template', instances: {}, problems: databases.problems },
            template: body,
          }
        }

        if (action === 'status') {
          let driverStatus = 'ok'
          try {
            await import('pg')
          } catch {
            driverStatus = 'missing'
          }
          const lines = ['# GEO 数据库通道', '']
          lines.push(`- pg 驱动：${driverStatus === 'ok' ? '已安装' : '未安装（在插件目录执行 pnpm add pg）'}`)
          for (const name of ['evidence', 'product']) {
            const info = describeInstance(databases[name])
            const label = name === 'evidence' ? '证据库' : '商品库'
            lines.push(info === null ? `- ${label}：未配置` : `- ${label}：${info.target}　user=${info.user}　ssl=${info.ssl}　schema=${info.schema}　表=${Object.values(info.tables).join('、')}`)
          }
          if (databases.problems.length > 0) lines.push(`- 待补配置：${databases.problems.join('；')}`)
          lines.push('')
          lines.push('下一步：`geo_db` action=template 取模板 → 填进插件 config → 重载插件 → action=test。凭据按你的选择写在插件 config 里，该文件是明文。')
          return {
            ok: true,
            message: lines.join('\n'),
            view: {
              kind: 'geo.view',
              view: 'db',
              action: 'status',
              driver: driverStatus,
              evidence: describeInstance(databases.evidence),
              product: describeInstance(databases.product),
              problems: databases.problems,
            },
            driver: driverStatus,
            evidence: describeInstance(databases.evidence),
            product: describeInstance(databases.product),
            problems: databases.problems,
          }
        }

        const picked = requireInstance(databases, instanceName)
        if (picked.failure !== undefined) return picked.failure
        const instance = picked.instance
        const info = describeInstance(instance)
        const label = instanceName === 'evidence' ? '证据库' : '商品库'

        if (action === 'test') {
          try {
            const result = await testConnection(instance)
            return {
              ok: true,
              message: [`## ${label}连通`, '', `- 目标：${info.target}`, `- 数据库：${result.database}　账号：${result.user}`, `- 版本：${result.version}`, '- 会话：只读（set session characteristics as transaction read only）'].join('\n'),
              view: { kind: 'geo.view', view: 'db', action: 'test', instance: instanceName, ok: true, target: info.target, database: result.database },
              result,
            }
          } catch (error) {
            return failure('DB_CONNECT_FAILED', describeDbError(error, instance), '确认端口已放开、账号可登录、pg_hba 允许该来源。')
          }
        }

        if (action === 'schema') {
          try {
            const wanted = Array.isArray(args.tables) ? args.tables.filter(value => typeof value === 'string' && value.length > 0) : []
            const found = await introspectSchema(instance, wanted)
            const lines = [`## ${label} · schema ${found.schema}`, '']
            lines.push(`表（${found.tables.length}）：${found.tables.join('、') || '（空）'}`)
            lines.push('')
            const byTable = new Map()
            for (const column of found.columns) {
              const list = byTable.get(column.table) ?? []
              list.push(column)
              byTable.set(column.table, list)
            }
            for (const [table, columns] of byTable) {
              lines.push(`### ${table}`)
              lines.push('| 字段 | 类型 | 可空 |')
              lines.push('| --- | --- | --- |')
              for (const column of columns) lines.push(`| ${column.column} | ${column.type} | ${column.nullable ? '是' : '否'} |`)
              lines.push('')
            }
            lines.push('把上面的表名与字段名填进 `databases.*.mapping`，或在 config 里用 `sql` 直接覆盖查询。')
            return {
              ok: true,
              message: lines.join('\n'),
              view: { kind: 'geo.view', view: 'db', action: 'schema', instance: instanceName, schema: found.schema, tables: found.tables.length, selected: found.selected },
              introspection: { schema: found.schema, tables: found.tables, columns: found.columns },
            }
          } catch (error) {
            return failure('DB_SCHEMA_FAILED', describeDbError(error, instance), '只读账号通常可以读 information_schema；若被禁，请让 DBA 放开。')
          }
        }

        const query = instanceName === 'evidence'
          ? buildClaimsQuery(instance, { sku: args.sku, keyword: null, limit: 5 })
          : buildSkuQuery(instance, { sku: args.sku, keyword: null, limit: 5 })
        try {
          const rows = await withClient(instance, async client => (await client.query(query.text, query.values)).rows)
          const fields = rows.length === 0 ? [] : Object.keys(rows[0])
          const lines = [`## ${label} · 取样 ${rows.length} 行`, '']
          if (rows.length === 0) {
            lines.push('查询执行成功，但没有返回行。可能是过滤条件过窄，或该表为空。')
          } else {
            lines.push(`返回字段：${fields.join('、')}`)
            lines.push('')
            lines.push('```json')
            lines.push(JSON.stringify(rows.slice(0, 3), null, 2))
            lines.push('```')
          }
          lines.push('')
          lines.push('用它核对 mapping 里的字段名是否拼对。')
          return {
            ok: true,
            message: lines.join('\n'),
            view: { kind: 'geo.view', view: 'db', action: 'sample', instance: instanceName, rows: rows.length, fields },
            fields,
            rows: rows.slice(0, 5),
          }
        } catch (error) {
          return failure('DB_QUERY_FAILED', describeDbError(error, instance), '若报“表/列不存在”，先用 geo_db action=schema 导出真实字段名再改 mapping。')
        }
      },
    },
    {
      name: 'geo_evidence',
      description: '从证据库（PostgreSQL）取某个 SKU 的 claim 与证据，并做 Claim 准入：绿色可用（A/B 级、未过期、在宣称范围内）、黄色有条件（C/D 级、临近过期、缺边界）、红色禁用（无证据、过期、医疗或绝对化表述）。返回可直接喂给 geo_draft 的 L3 证据包。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['lookup', 'sku'], description: 'lookup 查 claim 准入，sku 查商品事实卡，默认 lookup。' },
          sku: { type: 'string', description: 'SKU 编码；省略则返回该库前若干条。' },
          keyword: { type: 'string', description: 'claim 文本模糊匹配的关键词。' },
          limit: { type: 'integer', description: '最多取多少条，默认 50。' },
        },
      },
      output: { schema: outputSchema, render },
      isConcurrencySafe: () => true,
      timeoutMs: 40_000,
      async execute(args) {
        const action = args.action === 'sku' ? 'sku' : 'lookup'
        const sku = typeof args.sku === 'string' && args.sku.trim().length > 0 ? args.sku.trim() : null
        const keyword = typeof args.keyword === 'string' && args.keyword.trim().length > 0 ? args.keyword.trim() : null
        const limit = Math.min(200, Math.max(1, Number(args.limit) || 50))

        if (action === 'sku') {
          const picked = requireInstance(databases, 'product')
          if (picked.failure !== undefined) return picked.failure
          const instance = picked.instance
          const query = buildSkuQuery(instance, { sku, keyword, limit })
          try {
            const rows = await withClient(instance, async client => (await client.query(query.text, query.values)).rows)
            const lines = [`# 商品事实卡 · ${rows.length} 条`, '']
            if (rows.length === 0) {
              lines.push('没有查到 SKU。确认 sku_code 拼写，或到商品库核对。')
            } else {
              lines.push('| SKU | 产品 | 规格 | 价格 | 备案号 | 适用肤质 |')
              lines.push('| --- | --- | --- | --- | --- | --- |')
              for (const row of rows) {
                lines.push(`| ${row.sku_code ?? '—'} | ${row.product_name ?? '—'} | ${row.spec ?? '—'} | ${row.price_cny ?? '—'} | ${row.filing_no ?? '—'} | ${row.skin_types ?? '—'} |`)
              }
            }
            return {
              ok: true,
              message: lines.join('\n'),
              view: { kind: 'geo.view', view: 'evidence', action: 'sku', target: describeInstance(instance).target, rows: rows.length },
              skus: rows,
            }
          } catch (error) {
            return failure('DB_QUERY_FAILED', describeDbError(error, instance), '先用 geo_db action=schema 核对商品表字段名。')
          }
        }

        const picked = requireInstance(databases, 'evidence')
        if (picked.failure !== undefined) return picked.failure
        const instance = picked.instance
        try {
          const { claims, result } = await pullAdmittedClaims(instance, { sku, keyword, limit })
          const meta = describeInstance(instance)
          return {
            ok: true,
            message: renderEvidenceMarkdown(result, {
              target: meta.target,
              schema: meta.schema,
              query: `${sku === null ? '不限 SKU' : `SKU ${sku}`}${keyword === null ? '' : `，关键词「${keyword}」`}，上限 ${limit}`,
            }),
            view: {
              kind: 'geo.view',
              view: 'evidence',
              action: 'lookup',
              target: meta.target,
              counts: result.counts,
              green: result.green.slice(0, 5).map(claim => ({ claimId: claim.claimId, text: claim.text, grade: claim.verdict.grade })),
              red: result.red.slice(0, 5).map(claim => ({ claimId: claim.claimId, text: claim.text, reasons: claim.verdict.reasons })),
            },
            counts: result.counts,
            admitted: { green: result.green.map(claim => claim.claimId), yellow: result.yellow.map(claim => claim.claimId), red: result.red.map(claim => claim.claimId) },
            evidencePack: result.evidencePack,
            claims,
          }
        } catch (error) {
          return failure('DB_QUERY_FAILED', describeDbError(error, instance), '先用 geo_db action=schema 核对证据表的表名与字段名。')
        }
      },
    },
  ]

  for (const definition of tools) registerTool(ctx, definition)
}
