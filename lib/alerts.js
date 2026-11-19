/**
 * Risk alerts — the monitoring half of §7.2 and the pre-publish gate of 附录 D.
 *
 * An alert is raised only from vocabulary that actually fired on a public
 * hot-list title, so every row can be traced back to its source item. The
 * mitigation text is the one the master plan already assigns to that risk, so
 * the board is actionable without a second analysis pass.
 */
import { RISK_RULES } from './lexicon.js'

const LEVEL_WEIGHT = { high: 3, medium: 2, low: 1 }
const LEVEL_LABEL = { high: '高', medium: '中', low: '低' }

const ENTITY_ERROR_PATTERN = /成立|哪年|哪一年|公司|主体|母公司|股权|法人|收购|备案号|真假|官方|微商|山寨/iu
/**
 * A trending question such as 「方里是哪个公司」 is a demand signal, not an error.
 * Raise the entity alert only when the title also asserts something wrong.
 */
const ERROR_ASSERTION = /写错|说错|弄错|认错|错误|不实|谣言|辟谣|混淆|张冠李戴|其实是|竟然是|冒充|假冒|山寨|自称/iu
const PLATFORM_SHIFT_PATTERN = /算法|改版|入口|下线|新功能|公测|灰度|封禁|限流/iu
const BEAUTY_CONTEXT = /粉底|粉饼|底妆|散粉|蜜粉|遮瑕|定妆|妆前|气垫|彩妆|护肤|敏感肌|油皮|干皮/iu

/** Classify one scored item into zero or more alert candidates. */
export function alertCandidates(item) {
  const haystack = `${item.title ?? ''} ${item.summary ?? ''}`
  const found = []
  const negative = item.negative ?? []
  const compliance = item.compliance ?? { absolute: [], medical: [], special: [] }
  const mentionsBrand = item.entities?.mentionsEntity === true
  const competitorActions = (item.entities?.competitors ?? []).filter(entry => (entry.actions ?? []).length > 0)

  if (negative.length > 0 && mentionsBrand) {
    found.push({
      match: 'negative-brand',
      terms: negative,
      severity: negative.length >= 2 ? 'high' : 'medium',
      note: '负面词与方里同现，按 §7.2「竞品恶意投毒 / 负面聚合」处置：先核实，再评估扩散面。',
    })
  } else if (negative.length > 0) {
    found.push({
      match: 'negative-any',
      terms: negative,
      severity: 'low',
      note: '行业负面词命中，未直接点名方里；纳入观察，不单独对外回应。',
    })
  }

  if (mentionsBrand && ENTITY_ERROR_PATTERN.test(haystack) && ERROR_ASSERTION.test(haystack)) {
    found.push({
      match: 'entity-error',
      terms: ['实体一致性'],
      severity: 'high',
      note: '涉及主体/成立时间/股权口径，是 AI 最易答错的 L1 问题；用权威页与百科口径 48 小时内对齐。',
    })
  }

  const claimTerms = [...compliance.medical, ...compliance.special]
  if (claimTerms.length > 0 || (compliance.absolute.length > 0 && BEAUTY_CONTEXT.test(haystack))) {
    found.push({
      match: 'forbidden-claim',
      terms: [...claimTerms, ...compliance.absolute],
      severity: compliance.medical.length > 0 ? 'high' : 'medium',
      note: '命中宣称红线（医疗术语 / 特殊功效 / 绝对化）。对外内容不得复用该表述，先过法务。',
    })
  }

  if (competitorActions.length > 0) {
    found.push({
      match: 'competitor-action',
      terms: competitorActions.flatMap(entry => entry.actions),
      severity: competitorActions.length >= 2 ? 'medium' : 'low',
      note: '竞品有公开动作，评估是否抢占引用池；必要时补一条对比型答案。',
    })
  }

  if (PLATFORM_SHIFT_PATTERN.test(haystack)) {
    found.push({
      match: 'platform-shift',
      terms: ['平台变化'],
      severity: 'low',
      note: '平台入口或算法信号；记录到季度重估清单，不单独行动。',
    })
  }

  return found
}

/** Expand candidates into alerts carrying the plan's mitigation. */
export function buildAlerts(items, options = {}) {
  const { date = new Date(), limit = 50 } = options
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  const alerts = []
  const seen = new Set()
  for (const item of items) {
    for (const candidate of alertCandidates(item)) {
      const rule = RISK_RULES.find(entry => entry.match === candidate.match)
      if (rule === undefined) continue
      const key = `${rule.id}:${item.platform}:${item.title}`
      if (seen.has(key)) continue
      seen.add(key)
      alerts.push({
        id: `GA-${stamp}-${String(alerts.length + 1).padStart(3, '0')}`,
        ruleId: rule.id,
        rule: rule.name,
        level: candidate.severity,
        levelLabel: LEVEL_LABEL[candidate.severity] ?? '低',
        owner: rule.owner,
        mitigation: rule.mitigation,
        note: candidate.note,
        terms: [...new Set(candidate.terms)].slice(0, 8),
        title: item.title,
        url: item.url ?? '',
        platform: item.platformName ?? item.platform,
        rank: item.rank,
        hot: item.hot ?? '',
        cluster: item.cluster?.name ?? '',
        detectedAt: new Date().toISOString(),
        evidence: item.clusters?.length > 0 ? `同现词：${(item.clusters[0].cues ?? []).slice(0, 4).join('、')}` : '',
      })
    }
  }
  alerts.sort((a, b) => {
    const byLevel = LEVEL_WEIGHT[b.level] - LEVEL_WEIGHT[a.level]
    if (byLevel !== 0) return byLevel
    return (a.rank ?? 99) - (b.rank ?? 99)
  })
  return alerts.slice(0, limit)
}

/** One-line summary used by status and report headers. */
export function summarizeAlerts(alerts) {
  const counts = { high: 0, medium: 0, low: 0 }
  for (const alert of alerts) {
    if (counts[alert.level] !== undefined) counts[alert.level] += 1
  }
  return {
    total: alerts.length,
    ...counts,
    rules: [...new Set(alerts.map(alert => alert.rule))],
  }
}

/** Render alerts as Markdown. */
export function renderAlertsMarkdown(alerts, meta = {}) {
  const summary = summarizeAlerts(alerts)
  const lines = [`# GEO 风险预警 · ${meta.date ?? new Date().toISOString().slice(0, 10)}`, '']
  lines.push(`共 ${summary.total} 条：高 ${summary.high} / 中 ${summary.medium} / 低 ${summary.low}。`)
  lines.push('')
  if (alerts.length === 0) {
    lines.push('本次扫描未触发负面或合规信号。风险为空不等于没有风险：竞品投毒与错误信息常先从长尾问题出现。')
    return lines.join('\n')
  }
  for (const alert of alerts) {
    lines.push(`## [${alert.levelLabel}] ${alert.rule} · ${alert.title}`)
    lines.push(`- 编号：${alert.id}　责任人：${alert.owner}　来源：${alert.platform} 第 ${alert.rank} 位`)
    if (alert.url !== '') lines.push(`- 原帖：${alert.url}`)
    lines.push(`- 命中词：${alert.terms.join('、')}`)
    lines.push(`- 处置：${alert.mitigation}`)
    lines.push(`- 说明：${alert.note}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
