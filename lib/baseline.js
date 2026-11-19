/**
 * T0 baseline audit — the collection plan and its five headline metrics.
 *
 * The plugin does not drive the six AI engines; it manages the audit that a
 * human (or a later automation) fills in. It expands the prompt library into
 * the full grid, hands out batches, records answers, and computes the five
 * headline metrics with the definitions the master plan fixes, so numbers from
 * different rounds stay comparable.
 *
 *   AI 提及率   = 提及方里的答案数 ÷ 目标问题数
 *   AI 首选率   = 方里为第一推荐的答案数 ÷ 目标问题数
 *   引用率     = 引用方里可控信源的答案数 ÷ 提及方里的答案数
 *   事实准确率 = 事实正确的陈述数 ÷ 被核查的陈述数
 *   负面率     = 明显负面或事实错误的答案数 ÷ 目标问题数
 */
import { COMPETITORS, ENGINES, ENTITY, NEGATIVE_TERMS } from './lexicon.js'

const OWNED_SOURCES = ['funnyelves.com', '官网', '官方旗舰', '天猫', '京东', '抖音商城', '微信公众号', '视频号', '官方']
const AUTHORITY_SOURCES = ['新华网', '人民网', '中新网', '36氪', '36 氪', '界面新闻', 'C2CC', '化妆品报', 'Vogue Business', '中国化妆品学术研讨会']

/** Resolve the engines one prompt must be audited on. */
export function enginesFor(prompt) {
  const declared = String(prompt?.engines ?? '').trim()
  if (declared.length === 0 || declared.includes('全部')) return ENGINES
  const matched = ENGINES.filter(engine => declared.includes(engine.name) || declared.toLowerCase().includes(engine.id))
  return matched.length > 0 ? matched : ENGINES
}

/** Expand the prompt library into one audit grid. */
export function createAudit(prompts, options = {}) {
  const { createdAt = new Date().toISOString() } = options
  const rows = []
  for (const prompt of prompts) {
    for (const engine of enginesFor(prompt)) {
      rows.push({
        id: `${prompt.id}-${engine.id}`,
        promptId: prompt.id,
        cluster: prompt.cluster,
        prompt: prompt.prompt,
        priority: prompt.priority,
        frequency: prompt.frequency,
        product: prompt.product,
        engineId: engine.id,
        engineName: engine.name,
        status: 'pending',
        answer: '',
        flags: null,
        factsTotal: 0,
        factsCorrect: 0,
        recordedAt: null,
        note: '',
      })
    }
  }
  return {
    version: 1,
    createdAt,
    brand: ENTITY.brand,
    promptCount: prompts.length,
    engines: ENGINES,
    rows,
    total: rows.length,
  }
}

/** Derive the mechanical flags from a pasted answer. */
export function deriveFlags(answer) {
  const text = String(answer ?? '')
  const brandMentioned = ENTITY.brandAliases.some(alias => text.includes(alias))
  const head = text.slice(0, 120)
  const firstChoice = brandMentioned && ENTITY.brandAliases.some(alias => head.includes(alias))
  const ownedCited = OWNED_SOURCES.filter(source => text.includes(source))
  const authorityCited = AUTHORITY_SOURCES.filter(source => text.includes(source))
  const negative = NEGATIVE_TERMS.filter(term => text.includes(term))
  const competitors = COMPETITORS.filter(entry => entry.aliases.some(alias => text.includes(alias))).map(entry => entry.name)
  return {
    brandMentioned,
    firstChoice,
    ownedCited,
    authorityCited,
    negative,
    competitors,
  }
}

/** Return the next `size` pending rows, highest priority and lowest id first. */
export function nextBatch(audit, size = 10, options = {}) {
  const { cluster, engine, promptId } = options
  const order = { A: 0, B: 1, C: 2 }
  const pending = audit.rows
    .filter(row => row.status !== 'done')
    .filter(row => cluster === undefined || cluster === '' || row.cluster === cluster)
    .filter(row => engine === undefined || engine === '' || row.engineId === engine || row.engineName === engine)
    .filter(row => promptId === undefined || promptId === '' || row.promptId === promptId)
    .sort((a, b) => {
      const byPriority = (order[a.priority] ?? 9) - (order[b.priority] ?? 9)
      return byPriority !== 0 ? byPriority : a.id.localeCompare(b.id)
    })
  return {
    batch: pending.slice(0, Math.max(1, size)),
    remaining: pending.length,
    total: audit.total,
  }
}

/**
 * Record answers. Each entry is `{ promptId, engine, answer, factsTotal?,
 * factsCorrect?, note? }`; `engine` accepts the engine id or its Chinese name.
 */
export function recordAnswers(audit, entries, options = {}) {
  const { recordedAt = new Date().toISOString() } = options
  const results = { recorded: 0, skipped: [], rows: [] }
  for (const entry of entries) {
    const engineToken = String(entry.engine ?? '').trim()
    const engine = ENGINES.find(candidate => candidate.id === engineToken || candidate.name === engineToken)
    const promptId = String(entry.promptId ?? '').trim()
    if (engine === undefined) {
      results.skipped.push({ promptId, engine: engineToken, reason: '未知引擎' })
      continue
    }
    const row = audit.rows.find(candidate => candidate.promptId === promptId && candidate.engineId === engine.id)
    if (row === undefined) {
      results.skipped.push({ promptId, engine: engineToken, reason: '提示词不在审计网格内' })
      continue
    }
    if (typeof entry.answer !== 'string' || entry.answer.trim().length === 0) {
      results.skipped.push({ promptId, engine: engineToken, reason: '答案为空' })
      continue
    }
    row.answer = entry.answer.trim()
    row.flags = deriveFlags(row.answer)
    row.factsTotal = Number.isFinite(Number(entry.factsTotal)) ? Math.max(0, Number(entry.factsTotal)) : 0
    row.factsCorrect = Number.isFinite(Number(entry.factsCorrect)) ? Math.max(0, Number(entry.factsCorrect)) : 0
    row.note = typeof entry.note === 'string' ? entry.note : ''
    row.status = 'done'
    row.recordedAt = recordedAt
    results.recorded += 1
    results.rows.push({ id: row.id, promptId: row.promptId, engine: engine.name, flags: row.flags })
  }
  return results
}

const ratio = (numerator, denominator) => (denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 10)

/** Compute the five headline metrics plus per-engine and per-cluster breakdowns. */
export function computeMetrics(audit) {
  const done = audit.rows.filter(row => row.status === 'done')
  const audited = done.length
  const mentioned = done.filter(row => row.flags?.brandMentioned === true).length
  const firstChoice = done.filter(row => row.flags?.firstChoice === true).length
  const ownedCited = done.filter(row => (row.flags?.ownedCited ?? []).length > 0).length
  const authorityCited = done.filter(row => (row.flags?.authorityCited ?? []).length > 0).length
  const negative = done.filter(row => (row.flags?.negative ?? []).length > 0).length
  const factsTotal = done.reduce((sum, row) => sum + (row.factsTotal ?? 0), 0)
  const factsCorrect = done.reduce((sum, row) => sum + (row.factsCorrect ?? 0), 0)

  const groupBy = (key, labelKey) => {
    const map = new Map()
    for (const row of done) {
      const keyValue = key(row)
      const entry = map.get(keyValue) ?? { key: keyValue, label: labelKey(row), audited: 0, mentioned: 0, firstChoice: 0, ownedCited: 0, negative: 0 }
      entry.audited += 1
      if (row.flags?.brandMentioned === true) entry.mentioned += 1
      if (row.flags?.firstChoice === true) entry.firstChoice += 1
      if ((row.flags?.ownedCited ?? []).length > 0) entry.ownedCited += 1
      if ((row.flags?.negative ?? []).length > 0) entry.negative += 1
      map.set(keyValue, entry)
    }
    return [...map.values()].map(entry => ({
      ...entry,
      mentionRate: ratio(entry.mentioned, entry.audited),
      firstChoiceRate: ratio(entry.firstChoice, entry.audited),
      citationRate: ratio(entry.ownedCited, entry.mentioned),
    }))
  }

  return {
    audited,
    total: audit.total,
    coverage: ratio(audited, audit.total),
    mentionRate: ratio(mentioned, audited),
    firstChoiceRate: ratio(firstChoice, audited),
    citationRate: ratio(ownedCited, mentioned),
    authorityRate: ratio(authorityCited, mentioned),
    factAccuracy: ratio(factsCorrect, factsTotal),
    negativeRate: ratio(negative, audited),
    counts: { mentioned, firstChoice, ownedCited, authorityCited, negative, factsTotal, factsCorrect },
    targets: { mentionRate: 55, firstChoiceRate: 20, citationRate: 30, factAccuracy: 95, negativeRate: 5 },
    byEngine: groupBy(row => row.engineId, row => row.engineName).sort((a, b) => a.label.localeCompare(b.label)),
    byCluster: groupBy(row => row.cluster, row => row.cluster),
    needsFactCheck: done.filter(row => (row.factsTotal ?? 0) === 0).length,
  }
}

const formatRate = value => (value === null ? '待测' : `${value}%`)

/** Markdown rendering of the audit state. */
export function renderBaselineMarkdown(audit, metrics, meta = {}) {
  const lines = [`# T0 基线审计 · ${audit.promptCount} 提示词 × ${audit.engines.length} 引擎（共 ${audit.total} 行）`, '']
  lines.push(`品牌：${audit.brand}　建立于：${audit.createdAt.slice(0, 19).replace('T', ' ')}`)
  lines.push(`进度：${metrics.audited} / ${metrics.total}（${formatRate(metrics.coverage)}）`)
  lines.push('')
  lines.push('## 五个核心指标')
  lines.push('| 指标 | 当前 | 12 个月目标 |')
  lines.push('| --- | --- | --- |')
  lines.push(`| AI 提及率 | ${formatRate(metrics.mentionRate)} | ≥ ${metrics.targets.mentionRate}% |`)
  lines.push(`| AI 首选率 | ${formatRate(metrics.firstChoiceRate)} | ≥ ${metrics.targets.firstChoiceRate}% |`)
  lines.push(`| 引用率 | ${formatRate(metrics.citationRate)} | ≥ ${metrics.targets.citationRate}% |`)
  lines.push(`| 事实准确率 | ${formatRate(metrics.factAccuracy)} | ≥ ${metrics.targets.factAccuracy}% |`)
  lines.push(`| 负面/错误信息 | ${formatRate(metrics.negativeRate)} | ≤ ${metrics.targets.negativeRate}% |`)
  lines.push('')
  lines.push(`权威信源引用率：${formatRate(metrics.authorityRate)}（口径为提及答案中引用权威信源的比例）`)
  lines.push('')
  if (metrics.audited === 0) {
    lines.push('还没有录入任何答案。用 `geo_baseline` 的 `next` 领取批次，逐条把引擎答案粘回来，指标才会出现。')
    return lines.join('\n').trimEnd()
  }
  if (metrics.needsFactCheck > 0) {
    lines.push(`⚠️ 有 ${metrics.needsFactCheck} 条答案尚未填写事实核查结果（factsTotal / factsCorrect），事实准确率暂不完整。`)
    lines.push('')
  }
  lines.push('## 按引擎')
  lines.push('| 引擎 | 已采集 | 提及率 | 首选率 | 引用率 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const entry of metrics.byEngine) {
    lines.push(`| ${entry.label} | ${entry.audited} | ${formatRate(entry.mentionRate)} | ${formatRate(entry.firstChoiceRate)} | ${formatRate(entry.citationRate)} |`)
  }
  lines.push('')
  lines.push('## 按内容簇')
  lines.push('| 内容簇 | 已采集 | 提及率 | 首选率 |')
  lines.push('| --- | --- | --- | --- |')
  for (const entry of metrics.byCluster) {
    lines.push(`| ${entry.label} | ${entry.audited} | ${formatRate(entry.mentionRate)} | ${formatRate(entry.firstChoiceRate)} |`)
  }
  if (meta.remaining !== undefined) {
    lines.push('')
    lines.push(`剩余待采集：${meta.remaining} 条。`)
  }
  return lines.join('\n').trimEnd()
}
