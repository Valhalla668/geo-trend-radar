/**
 * Share of voice — the public-signal proxy for §3.5 «声量份额 SOV».
 *
 * The plan measures SOV on AI answers; this plugin cannot read those answers
 * without a baseline audit, so it measures the adjacent public signal instead:
 * how often each brand appears in the hot lists the AI engines are trained on
 * and cite. Each snapshot stores a compact mention summary so SOV history stays
 * cheap to aggregate.
 */
import { COMPETITORS, ENTITY } from './lexicon.js'

/** Brands tracked by the SOV board: the client brand first, then its rivals. */
export const SOV_BRANDS = [
  { id: 'fangli', name: ENTITY.brand, aliases: ENTITY.brandAliases, self: true },
  ...COMPETITORS.map(entry => ({ id: entry.id, name: entry.name, aliases: entry.aliases, self: false })),
]

const PLATFORM_CAP = 8
const ITEM_CAP = 5

/**
 * Count brand mentions across the raw items of one scan.
 * An item may mention several brands; each brand counts it once.
 */
export function computeMentions(items) {
  const brands = SOV_BRANDS.map(brand => ({
    id: brand.id,
    name: brand.name,
    self: brand.self,
    mentions: 0,
    byPlatform: {},
    topItems: [],
  }))
  const index = new Map(brands.map(entry => [entry.id, entry]))
  for (const item of items) {
    const haystack = `${item.title ?? ''} ${item.summary ?? ''}`
    for (const brand of SOV_BRANDS) {
      if (!brand.aliases.some(alias => haystack.includes(alias))) continue
      const entry = index.get(brand.id)
      entry.mentions += 1
      const platform = item.platformName ?? item.platform ?? '未知'
      entry.byPlatform[platform] = (entry.byPlatform[platform] ?? 0) + 1
      if (entry.topItems.length < ITEM_CAP) {
        entry.topItems.push({ title: item.title, platform, rank: item.rank, url: item.url ?? '' })
      }
    }
  }
  return {
    totalItems: items.length,
    totalMentions: brands.reduce((sum, entry) => sum + entry.mentions, 0),
    brands: brands.filter(entry => entry.mentions > 0),
    platforms: [...new Set(items.map(item => item.platformName ?? item.platform))].slice(0, PLATFORM_CAP),
  }
}

const within = (iso, fromMs, toMs) => {
  const value = Date.parse(iso)
  return Number.isFinite(value) && value >= fromMs && value < toMs
}

/**
 * Aggregate SOV over a window and compare it with the immediately preceding
 * window of the same length, so "谁在涨" is answerable without a second scan.
 * @param {Array<{scannedAt: string, mentions: object}>} snapshots
 */
export function buildSov(snapshots, options = {}) {
  const { days = 7, now = new Date() } = options
  const windowMs = Math.max(1, days) * 24 * 60 * 60 * 1000
  const endMs = now.getTime()
  const startMs = endMs - windowMs
  const previousStartMs = startMs - windowMs

  const current = snapshots.filter(snapshot => within(snapshot.scannedAt, startMs, endMs) && snapshot.mentions !== undefined)
  const previous = snapshots.filter(snapshot => within(snapshot.scannedAt, previousStartMs, startMs) && snapshot.mentions !== undefined)

  const fold = list => {
    const totals = new Map()
    const byPlatform = new Map()
    let scans = 0
    let items = 0
    for (const snapshot of list) {
      scans += 1
      items += snapshot.mentions.totalItems ?? 0
      for (const brand of snapshot.mentions.brands ?? []) {
        totals.set(brand.id, (totals.get(brand.id) ?? 0) + brand.mentions)
        const perPlatform = byPlatform.get(brand.id) ?? {}
        for (const [platform, count] of Object.entries(brand.byPlatform ?? {})) {
          perPlatform[platform] = (perPlatform[platform] ?? 0) + count
        }
        byPlatform.set(brand.id, perPlatform)
      }
    }
    const mentionTotal = [...totals.values()].reduce((sum, value) => sum + value, 0)
    return { totals, byPlatform, mentionTotal, scans, items }
  }

  const nowFold = fold(current)
  const prevFold = fold(previous)

  const brands = [...new Map([...nowFold.totals.keys(), ...prevFold.totals.keys()].map(id => [id, id])).keys()]
    .map(id => {
      const definition = SOV_BRANDS.find(entry => entry.id === id)
      const mentions = nowFold.totals.get(id) ?? 0
      const previousMentions = prevFold.totals.get(id) ?? 0
      const share = nowFold.mentionTotal === 0 ? 0 : mentions / nowFold.mentionTotal
      const previousShare = prevFold.mentionTotal === 0 ? 0 : previousMentions / prevFold.mentionTotal
      return {
        id,
        name: definition?.name ?? id,
        self: definition?.self === true,
        mentions,
        share: Math.round(share * 1000) / 10,
        previousMentions,
        previousShare: Math.round(previousShare * 1000) / 10,
        deltaPoints: Math.round((share - previousShare) * 1000) / 10,
        byPlatform: nowFold.byPlatform.get(id) ?? {},
      }
    })
    .sort((a, b) => b.mentions - a.mentions)

  const leader = brands.find(entry => !entry.self && entry.mentions > 0) ?? null
  const self = brands.find(entry => entry.self) ?? null
  return {
    window: {
      days,
      from: new Date(startMs).toISOString(),
      to: new Date(endMs).toISOString(),
      previousFrom: new Date(previousStartMs).toISOString(),
      scans: nowFold.scans,
      previousScans: prevFold.scans,
      items: nowFold.items,
      mentionTotal: nowFold.mentionTotal,
    },
    brands,
    self,
    leader,
    gap: self !== null && leader !== null ? Math.round((leader.share - self.share) * 10) / 10 : null,
  }
}

/** Markdown rendering for the report and the tool view. */
export function renderSovMarkdown(sov) {
  const { window } = sov
  const from = String(window.from ?? '').slice(0, 10)
  const to = String(window.to ?? '').slice(0, 10)
  const lines = [`# 竞品声量 SOV · 近 ${window.days} 天`, '']
  lines.push(`数据窗口：${from || '—'} → ${to || '—'}　扫描 ${window.scans} 次，覆盖 ${window.items} 条热榜条目`)
  lines.push('')
  if (window.scans === 0) {
    lines.push('窗口内还没有扫描记录。先运行 `geo_scan` 建立基线，SOV 才有分母。')
    return lines.join('\n')
  }
  if (sov.brands.length === 0) {
    lines.push(`窗口内 ${window.items} 条热榜条目里没有出现任何被监测品牌的名称。`)
    lines.push('')
    lines.push('SOV 为空不等于没有竞争：公开热榜是低频信号，方里与同价位竞品本来就不常上榜。要判断真实的引用份额，看 T0 基线审计的提及率与首选率。')
    return lines.join('\n')
  }
  lines.push('| 品牌 | 提及 | 份额 | 环比 | 主要平台 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const brand of sov.brands) {
    const platforms = Object.entries(brand.byPlatform)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([platform, count]) => `${platform} ${count}`)
      .join('、')
    const delta = brand.deltaPoints === 0 ? '—' : `${brand.deltaPoints > 0 ? '+' : ''}${brand.deltaPoints}pp`
    lines.push(`| ${brand.name}${brand.self ? '（本方）' : ''} | ${brand.mentions} | ${brand.share}% | ${delta} | ${platforms || '—'} |`)
  }
  lines.push('')
  if (sov.gap !== null) {
    lines.push(`与声量最高竞品差距：${sov.gap} 个百分点。`)
  }
  lines.push('')
  lines.push('口径说明：SOV 在这里是「公开热榜提及份额」，是 §3.5 AI 声量份额的公开信号代理，不等同于 AI 答案里的份额；真实份额以 T0/T1 基线审计为准。')
  return lines.join('\n').trimEnd()
}
