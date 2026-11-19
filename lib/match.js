/**
 * Classification and scoring of hot-list items.
 *
 * Three deterministic passes, in order:
 *   1. keyword groups  — TrendRadar `frequency_words.txt` dialect, for display grouping
 *   2. entity layer    — brand / parent / founder / competitor / product mentions
 *   3. GEO clusters    — route the title into one of the eight answer clusters
 * plus the risk vocabulary that feeds the alert pipeline.
 *
 * Everything is rule-based and reproducible: the same scan always yields the
 * same labels, which is what makes the derived topic board auditable.
 */
import {
  CLUSTERS,
  COMPETITOR_ACTIONS,
  COMPETITORS,
  DOMAIN_ANCHORS,
  ENTITY,
  FORBIDDEN_ABSOLUTE,
  MEDICAL_TERMS,
  NEGATIVE_TERMS,
  PRODUCTS,
  SPECIAL_EFFICACY,
} from './lexicon.js'

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** True when the text carries a beauty or skin-type anchor. */
export function hasDomainAnchor(text) {
  const haystack = String(text ?? '')
  return DOMAIN_ANCHORS.some(anchor => haystack.includes(anchor))
}

/**
 * Parse the TrendRadar keyword dialect:
 *   `[group]` opens a group, `#` starts a comment, `/re/flags => label` is a
 *   regular expression, and any other line is a literal substring.
 * An invalid regular expression is reported instead of silently dropped.
 */
export function parseKeywordGroups(text) {
  const groups = []
  const warnings = []
  let current = null
  const ensure = () => {
    if (current === null) {
      current = { name: '默认', terms: [] }
      groups.push(current)
    }
    return current
  }
  for (const rawLine of String(text ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (line.startsWith('#')) continue
    const header = /^\[(.+)\]$/u.exec(line)
    if (header !== null) {
      current = { name: header[1].trim(), terms: [] }
      groups.push(current)
      continue
    }
    const group = ensure()
    const regexForm = /^\/(.+)\/([a-z]*)\s*(?:=>\s*(.+))?$/u.exec(line)
    if (regexForm !== null) {
      const [, pattern, flags, label] = regexForm
      try {
        const compiled = new RegExp(pattern, flags || 'u')
        group.terms.push({ type: 'regex', value: pattern, flags: flags || 'u', label: (label ?? pattern).trim(), compiled })
      } catch (error) {
        warnings.push({ line, message: error instanceof Error ? error.message : String(error) })
      }
      continue
    }
    const literal = line.replace(/\s*=>\s*.+$/u, '').trim()
    if (literal.length === 0) continue
    group.terms.push({ type: 'literal', value: literal, label: literal, compiled: new RegExp(escapeRegex(literal), 'iu') })
  }
  return { groups: groups.filter(group => group.terms.length > 0), warnings }
}

/** Match one text against every group; returns the labels that fired. */
export function matchKeywordGroups(text, groups) {
  const haystack = String(text ?? '')
  const hits = []
  for (const group of groups) {
    const labels = []
    for (const term of group.terms) {
      if (term.compiled.test(haystack)) labels.push(term.label)
    }
    if (labels.length > 0) hits.push({ group: group.name, labels: [...new Set(labels)] })
  }
  return hits
}

const anyIncludes = (text, words) => words.filter(word => text.includes(word))

/** Brand, parent, founder and competitor mentions with the matched surface form. */
export function detectEntities(text) {
  const haystack = String(text ?? '')
  const brandHits = anyIncludes(haystack, ENTITY.brandAliases)
  const parentHits = anyIncludes(haystack, ENTITY.parentAliases)
  const founderHits = anyIncludes(haystack, ENTITY.founderAliases)
  const competitors = []
  for (const entry of COMPETITORS) {
    const hits = anyIncludes(haystack, entry.aliases)
    if (hits.length > 0) competitors.push({ id: entry.id, name: entry.name, hits, actions: anyIncludes(haystack, COMPETITOR_ACTIONS) })
  }
  return {
    isBrand: brandHits.length > 0,
    brandHits,
    parentHits,
    founderHits,
    competitors,
    isCompetitor: competitors.length > 0,
    mentionsEntity: brandHits.length > 0 || parentHits.length > 0 || founderHits.length > 0,
  }
}

/** Products of the plan mentioned in the text. */
export function detectProducts(text) {
  const haystack = String(text ?? '')
  const found = []
  for (const product of PRODUCTS) {
    const hits = anyIncludes(haystack, product.aliases)
    if (hits.length > 0) found.push({ id: product.id, name: product.name, hits })
  }
  return found
}

/**
 * Naming a product is not by itself a category question: 「方里柔焦蜜粉饼适合油皮吗」
 * is a skin-type question. When the title also matches a more specific cluster,
 * the generic category cluster is damped so the qualifier wins.
 */
const CATEGORY_DAMPING = 0.55

/** Score every cluster for the text; result is sorted by score then definition order. */
export function classifyClusters(text) {
  const haystack = String(text ?? '')
  const scored = CLUSTERS.map((cluster, index) => {
    const cues = anyIncludes(haystack, cluster.cues)
    return {
      id: cluster.id,
      name: cluster.name,
      weight: cluster.weight,
      cues,
      score: cues.length === 0 ? 0 : Math.min(1, cues.length * 0.4) * cluster.weight,
      index,
    }
  })
  const specific = scored.some(entry => entry.id !== 'category' && entry.score > 0)
  if (specific) {
    for (const entry of scored) {
      if (entry.id === 'category') entry.score = Math.round(entry.score * CATEGORY_DAMPING * 1000) / 1000
    }
  }
  return scored
    .filter(entry => entry.score > 0)
    .sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score))
}

/** The single cluster a topic belongs to, falling back to 品类推荐. */
export function pickCluster(text, entities) {
  const scored = classifyClusters(text)
  const comparison = scored.find(entry => entry.id === 'compare')
  const hasComparisonWord = comparison !== undefined
  if (entities !== undefined && entities.competitors.length > 0 && entities.mentionsEntity && hasComparisonWord) {
    return CLUSTERS.find(cluster => cluster.id === 'compare')
  }
  if (scored.length > 0) {
    const winner = scored[0]
    return CLUSTERS.find(cluster => cluster.id === winner.id)
  }
  const fallback = entities !== undefined && (entities.mentionsEntity || entities.isCompetitor)
    ? CLUSTERS.find(cluster => cluster.id === 'compare')
    : CLUSTERS.find(cluster => cluster.id === 'category')
  return fallback
}

/** Negative reputation vocabulary present in the text. */
export function detectNegative(text) {
  return anyIncludes(String(text ?? ''), NEGATIVE_TERMS)
}

/**
 * Compliance vocabulary, split by the rule it would break in 附录 D / §7.1.
 * `absolute` is only a violation in a claim context, so callers combine it with
 * the beauty-product vocabulary before raising a high-severity alert.
 */
export function detectCompliance(text) {
  const haystack = String(text ?? '')
  const absolute = anyIncludes(haystack, FORBIDDEN_ABSOLUTE)
  const medical = anyIncludes(haystack, MEDICAL_TERMS)
  const special = anyIncludes(haystack, SPECIAL_EFFICACY)
  return {
    absolute,
    medical,
    special,
    total: absolute.length + medical.length + special.length,
  }
}

const rankScore = rank => {
  if (rank <= 3) return 1
  if (rank <= 10) return 0.75
  if (rank <= 20) return 0.5
  if (rank <= 30) return 0.3
  return 0.15
}

const priorityOf = ({ entities, cluster, riskScore, clusterScore }) => {
  const highValueCluster = ['compare', 'product', 'skin'].includes(cluster.id)
  if (riskScore >= 1 && entities.mentionsEntity) return 'P0'
  if ((entities.mentionsEntity || entities.isCompetitor) && highValueCluster) return 'P0'
  if (clusterScore >= 0.75 || (entities.mentionsEntity && riskScore > 0)) return 'P1'
  return 'P2'
}

/** Explainable evidence gap for the topic card, derived from the cluster. */
const evidenceGapOf = (cluster, text) => {
  const haystack = String(text ?? '')
  const hasStudy = /检测|临床|专利|斑贴|白皮书|报告/iu.test(haystack)
  if (cluster.id === 'skin' && !hasStudy) return '缺 A 级证据：斑贴 / 人体功效评价 / 检测报告，先补证据再写功效结论'
  if (cluster.id === 'compare' && !hasStudy) return '缺 A/B 级证据：竞品公开参数需同规格同时点，结论需可验证'
  if (cluster.id === 'product' && !hasStudy) return '缺产品事实卡：色号、规格、备案号、适用肤质需与产品页一致'
  if (cluster.id === 'price' && !hasStudy) return '缺价格/渠道口径：价格与备案号需标注日期，避免过期信息'
  if (cluster.id === 'brand' && !hasStudy) return '缺实体一致性素材：主体、成立时间、股权关系需与营业执照一致'
  if (cluster.id === 'global' && !hasStudy) return '缺日本市场资料：@cosme / 亚马逊页面与日文口径需先行'
  return '证据齐备度待核查：确认每条 claim 都绑定 claim_id 与 evidence_id'
}

/**
 * Annotate and score one hot-list item.
 *
 * The title drives cluster routing, risk vocabulary and keyword groups; the
 * item's hover summary is only scanned for entity names, because a long news
 * summary mentions half the vocabulary and would route every story everywhere.
 * @returns {{score: number, priority: string, cluster: object, product: object, ...}}
 */
export function scoreItem(item, options = {}) {
  const title = String(item?.title ?? '')
  const context = `${title} ${item?.summary ?? ''}`
  const groups = options.groups ?? []
  const entities = detectEntities(context)
  const products = detectProducts(title)
  const clusters = classifyClusters(title)
  const cluster = pickCluster(title, entities)
  const clusterScore = clusters.length > 0 ? clusters[0].score : 0.2
  const negative = detectNegative(title)
  const compliance = detectCompliance(title)
  const riskScore = negative.length > 0 || compliance.medical.length > 0 ? 1 : compliance.absolute.length > 0 ? 0.6 : 0
  const entityScore = entities.mentionsEntity ? 1 : entities.isCompetitor ? 0.6 : 0

  const raw = 0.3 * rankScore(Number(item?.rank) || 50)
    + 0.4 * clusterScore
    + 0.2 * entityScore
    + 0.1 * riskScore
  const score = Math.round(raw * 1000) / 10
  const productEntry = products.length > 0
    ? PRODUCTS.find(entry => entry.id === products[0].id)
    : PRODUCTS.find(entry => entry.id === (cluster.product === 'brand' ? 'powder' : cluster.product)) ?? PRODUCTS[0]

  const reasons = []
  if (entities.mentionsEntity) reasons.push(`提及${entities.brandHits.length > 0 ? '方里' : '关联主体'}`)
  if (entities.competitors.length > 0) reasons.push(`提及竞品：${entities.competitors.map(entry => entry.name).join('、')}`)
  if (clusters.length > 0) reasons.push(`内容簇：${clusters.slice(0, 3).map(entry => `${entry.name}(${entry.cues.join('、')})`).join(' / ')}`)
  if (negative.length > 0) reasons.push(`负面词：${negative.join('、')}`)
  if (compliance.absolute.length > 0) reasons.push(`绝对化用语：${compliance.absolute.join('、')}`)
  if (compliance.medical.length > 0) reasons.push(`医疗术语：${compliance.medical.join('、')}`)
  if (compliance.special.length > 0) reasons.push(`特殊功效词：${compliance.special.join('、')}`)

  return {
    ...item,
    score,
    priority: priorityOf({ entities, cluster, riskScore, clusterScore }),
    cluster: { id: cluster.id, name: cluster.name },
    clusterScore: Math.round(clusterScore * 100) / 100,
    clusters: clusters.map(entry => ({ id: entry.id, name: entry.name, cues: entry.cues })),
    product: { id: productEntry.id, name: productEntry.name },
    format: cluster.format,
    entities,
    negative,
    compliance,
    riskScore,
    keywordGroups: matchKeywordGroups(title, groups),
    evidenceGap: evidenceGapOf(cluster, title),
    reasons,
  }
}

/**
 * Score every item and keep the ones that matter to GEO.
 *
 * A hot-list title is kept when it mentions the brand or a competitor, or when
 * it carries a beauty category anchor together with a cluster or risk cue.
 * A bare seasonal or news word is not enough: 冬天/开学/处罚 appear in plenty of
 * stories that have nothing to do with base makeup.
 */
export function matchItems(items, options = {}) {
  const {
    groups = [],
    minScore = 0.1,
    limit = 200,
    requireAnchor = true,
  } = options
  const scored = []
  for (const item of items) {
    const entry = scoreItem(item, { groups })
    const relevant = !requireAnchor
      || entry.entities.mentionsEntity
      || entry.entities.isCompetitor
      || (hasDomainAnchor(entry.title) && (entry.clusters.length > 0 || entry.negative.length > 0))
    if (!relevant) continue
    if (entry.score < minScore) continue
    scored.push(entry)
  }
  scored.sort((a, b) => (b.score === a.score ? a.rank - b.rank : b.score - a.score))
  return scored.slice(0, Math.max(1, limit))
}

/** Merge scored lists, dropping the same headline and keeping the highest score. */
export function mergeScored(lists, limit = 200) {
  const byTitle = new Map()
  for (const list of lists) {
    for (const entry of list) {
      const key = String(entry.title ?? '').replace(/[\s\p{P}]/gu, '')
      const existing = byTitle.get(key)
      if (existing === undefined || entry.score > existing.score) byTitle.set(key, entry)
    }
  }
  const merged = [...byTitle.values()]
  merged.sort((a, b) => (b.score === a.score ? a.rank - b.rank : b.score - a.score))
  return merged.slice(0, Math.max(1, limit))
}
