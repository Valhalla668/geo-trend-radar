/**
 * Topic cards — the 01 选题 workshop of the AI content factory (§4.2).
 *
 * A card converts one hot-list hit into the shape §3.2 uses for the twenty
 * high-priority topics: 选题 / 簇 / 产品 / 形态, plus the priority, the evidence
 * gap that must be closed before drafting, and the closest prompt from the
 * prompt library so the card links back to the baseline audit.
 */
import { CLUSTER_BY_NAME, ENTITY, PRODUCT_BY_ID } from './lexicon.js'

const CJK = /[\u4e00-\u9fff]/u

/** Character bigrams, used as a language-agnostic token set for Chinese text. */
function bigrams(text) {
  const cleaned = String(text ?? '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/gu, '')
  const set = new Set()
  for (let index = 0; index < cleaned.length - 1; index += 1) {
    set.add(cleaned.slice(index, index + 2))
  }
  return set
}

/** Jaccard similarity over character bigrams. */
export function similarity(a, b) {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

/** Closest prompt of the same cluster; falls back to any cluster. */
export function closestPrompt(text, clusterName, prompts) {
  if (!Array.isArray(prompts) || prompts.length === 0) return null
  const sameCluster = prompts.filter(prompt => prompt.cluster === clusterName)
  const pool = sameCluster.length > 0 ? sameCluster : prompts
  let best = null
  for (const prompt of pool) {
    const score = similarity(text, prompt.prompt)
    if (best === null || score > best.score) best = { prompt, score }
  }
  if (best === null || best.score < 0.05) {
    return sameCluster.length > 0 ? { prompt: sameCluster[0], score: 0 } : null
  }
  return best
}

/** Strip the trailing hot-list boilerplate so a title reads like a question seed. */
export function cleanTitle(value) {
  return String(value ?? '')
    .replace(/\s*[-–—|｜]\s*(微博|知乎|抖音|百度|今日头条|B 站|哔哩哔哩).*$/u, '')
    .replace(/^#+|#+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

const firstCue = (entry, ...lists) => {
  for (const list of lists) {
    if (Array.isArray(list) && list.length > 0) return list[0]
  }
  return ''
}

/**
 * Turn a scored item into a user question. The rewrite is template-driven and
 * always keeps the original title, so a human can judge it without trusting the
 * model's phrasing.
 */
export function toQuestion(item) {
  const title = cleanTitle(item.title)
  if (/[?？]$/u.test(title)) return title
  const cue = firstCue(item, item.clusters?.[0]?.cues, item.negative)
  const shortBrand = '方里'
  switch (item.cluster?.id) {
    case 'compare': {
      const rival = item.entities?.competitors?.[0]?.name
      if (rival !== undefined) return `${shortBrand}和${rival}怎么选？`
      return `${title}，谁更适合？`
    }
    case 'skin':
      return cue.length > 0 ? `${cue}能用${shortBrand}吗？怎么选？` : `${title}，方里适合吗？`
    case 'scene':
      return cue.length > 0 ? `${cue}场景下底妆怎么选？` : `${title}，底妆怎么选？`
    case 'product':
      return cue.length > 0 ? `${shortBrand}${cue}怎么选、怎么用？` : `${title}，方里怎么选？`
    case 'price':
      return `${shortBrand}多少钱？哪里买便宜、怎么辨真假？`
    case 'category':
      return cue.length > 0 ? `${cue}推荐，哪个不容易踩雷？` : `${title}，有什么推荐？`
    case 'brand':
      return `${shortBrand}是哪个公司？是国货吗、靠谱吗？`
    case 'global':
      return 'Funny Elves 日本版和中国版有什么区别？'
    default:
      return `${title}，方里怎么答？`
  }
}

/** Build one topic card. */
export function buildCard(item, index, options = {}) {
  const { date = new Date(), prompts = [] } = options
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  const clusterName = item.cluster?.name ?? '品类推荐'
  const cluster = CLUSTER_BY_NAME[clusterName] ?? { id: 'category', name: clusterName, assets: 40, format: '选购指南' }
  const productEntry = PRODUCT_BY_ID[item.product?.id] ?? PRODUCT_BY_ID.powder
  const promptMatch = closestPrompt(`${item.title} ${toQuestion(item)}`, clusterName, prompts)
  const title = cleanTitle(item.title)
  return {
    id: `GT-${stamp}-${String(index + 1).padStart(3, '0')}`,
    title: CJK.test(title) ? title.slice(0, 60) : title.slice(0, 90),
    question: toQuestion(item),
    cluster: clusterName,
    clusterId: cluster.id,
    product: productEntry.name,
    format: item.format ?? cluster.format,
    priority: item.priority ?? 'P2',
    score: item.score ?? 0,
    evidenceGap: item.evidenceGap ?? '',
    why: item.reasons ?? [],
    quota: `本簇首年资产 ${cluster.assets} 条`,
    promptRef: promptMatch === null
      ? null
      : { id: promptMatch.prompt.id, prompt: promptMatch.prompt.prompt, cluster: promptMatch.prompt.cluster, priority: promptMatch.prompt.priority, similarity: Math.round(promptMatch.score * 100) / 100 },
    evidence: `目标证据等级：${cluster.id === 'compare' ? 'A/B（同规格同时点公开参数）' : cluster.id === 'skin' ? 'A（检测 / 斑贴 / 人体功效）' : 'B/C + 产品事实卡'}`,
    source: {
      platform: item.platformName ?? item.platform,
      rank: item.rank,
      url: item.url ?? '',
      hot: item.hot ?? '',
      scannedAt: item.scannedAt ?? '',
    },
    owner: '内容策略',
    status: 'draft',
    createdAt: new Date().toISOString(),
    brand: ENTITY.brand,
  }
}

const priorityWeight = { P0: 3, P1: 2, P2: 1 }

/**
 * Build a deduplicated topic board.
 * Near-duplicate titles collapse, and each cluster keeps at most `perCluster`
 * cards so one trending subject cannot fill the board.
 */
export function buildTopics(items, options = {}) {
  const { limit = 20, perCluster = 6, date = new Date(), prompts = [] } = options
  const cards = []
  const perClusterCount = new Map()
  for (const item of items) {
    const clusterName = item.cluster?.name ?? '品类推荐'
    const used = perClusterCount.get(clusterName) ?? 0
    if (used >= perCluster) continue
    if (cards.some(card => similarity(card.title, cleanTitle(item.title)) > 0.72)) continue
    perClusterCount.set(clusterName, used + 1)
    cards.push(buildCard(item, cards.length, { date, prompts }))
    if (cards.length >= limit) break
  }
  cards.sort((a, b) => {
    const byPriority = priorityWeight[b.priority] - priorityWeight[a.priority]
    return byPriority !== 0 ? byPriority : b.score - a.score
  })
  return cards.map((card, index) => ({ ...card, id: card.id.replace(/-\d{3}$/u, `-${String(index + 1).padStart(3, '0')}`) }))
}

/** Render a topic board as the Markdown a strategist can act on. */
export function renderTopicsMarkdown(cards, meta = {}) {
  const lines = []
  lines.push(`# GEO 选题卡 · ${meta.date ?? new Date().toISOString().slice(0, 10)}`)
  lines.push('')
  if (meta.scannedAt !== undefined) lines.push(`扫描时间：${meta.scannedAt}　来源：${meta.sources ?? '公开热榜'}`)
  lines.push(`共 ${cards.length} 条，按 P0 → P2、分数从高到低排序。`)
  lines.push('')
  if (cards.length === 0) {
    lines.push('本次扫描没有命中与方里、竞品或底妆品类相关的热点。可放宽 `minScore`，或增加平台与关键词分组。')
    return lines.join('\n')
  }
  for (const card of cards) {
    lines.push(`## ${card.priority} · ${card.cluster} · ${card.question}`)
    lines.push(`- 选题编号：${card.id}　形态：${card.format}　产品：${card.product}`)
    lines.push(`- 分数：${card.score}　来源：${card.source.platform} 第 ${card.source.rank} 位${card.source.hot === '' ? '' : `（${card.source.hot}）`}`)
    if (card.source.url !== '') lines.push(`- 原帖：${card.source.url}`)
    lines.push(`- 证据缺口：${card.evidenceGap}`)
    lines.push(`- 目标证据：${card.evidence}`)
    if (card.promptRef !== null) lines.push(`- 关联提示词：${card.promptRef.id}（${card.promptRef.cluster}，${card.promptRef.priority} 级）${card.promptRef.prompt}`)
    if (card.why.length > 0) lines.push(`- 判定依据：${card.why.join('；')}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
