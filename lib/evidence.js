/**
 * Claim admission — §5.3 Claim 准入 over rows read from the evidence database.
 *
 * The evidence database stores claims and the evidence behind them; this module
 * decides what may be written into content. The three colours are the plan's:
 *
 *   绿色 / 可用   A/B 级证据、在宣称范围内、未过期  → 可直接写功效结论
 *   黄色 / 有条件 证据较弱或范围受限、临近过期      → 必须写边界，不得泛化
 *   红色 / 禁用   无证据、过期、超备案、医疗、绝对化 → 不得生成，提示补证据
 *
 * Everything here is pure: rows in, verdicts out, so the rules are testable
 * without a database.
 */
import { FORBIDDEN_ABSOLUTE, MEDICAL_TERMS, SPECIAL_EFFICACY } from './lexicon.js'

/** Near-expiry threshold: inside this window a claim is only 有条件可用. */
export const EXPIRY_WARNING_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

const toDate = value => {
  if (value === null || value === undefined || value === '') return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const daysBetween = (from, to) => Math.round((to.getTime() - from.getTime()) / DAY_MS)

const text = value => (typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value))

/**
 * Group flat claim+evidence rows into one record per claim.
 * The generated SQL left-joins evidence, so a claim with no evidence still arrives.
 */
export function groupClaimRows(rows) {
  const byClaim = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const claimId = text(row.claim_id)
    if (claimId.length === 0) continue
    const entry = byClaim.get(claimId) ?? {
      claimId,
      sku: text(row.sku_code),
      text: text(row.claim_text),
      limitations: text(row.limitations),
      status: text(row.status) || 'approved',
      approvedAt: text(row.approved_at),
      evidence: [],
    }
    const evidenceId = text(row.evidence_id)
    if (evidenceId.length > 0) {
      entry.evidence.push({
        evidenceId,
        grade: text(row.grade).toUpperCase(),
        source: text(row.source),
        sourceUrl: text(row.source_url),
        testedAt: text(row.tested_at),
        validUntil: text(row.valid_until),
        sampleSize: row.sample_size === null || row.sample_size === undefined ? null : Number(row.sample_size),
        method: text(row.method),
      })
    }
    byClaim.set(claimId, entry)
  }
  return [...byClaim.values()]
}

/** Best (highest) evidence grade attached to a claim. */
const bestGrade = evidence => {
  const order = ['A', 'B', 'C', 'D', 'E']
  const grades = evidence.map(entry => entry.grade).filter(grade => order.includes(grade))
  if (grades.length === 0) return null
  return grades.sort((left, right) => order.indexOf(left) - order.indexOf(right))[0]
}

const restrictedWords = claimText => {
  const haystack = claimText
  return {
    absolute: FORBIDDEN_ABSOLUTE.filter(word => haystack.includes(word)),
    medical: MEDICAL_TERMS.filter(word => haystack.includes(word)),
    special: SPECIAL_EFFICACY.filter(word => haystack.includes(word)),
  }
}

/**
 * Admit one claim.
 * @param {object} claim - grouped claim record
 * @param {{now?: Date}} options
 * @returns {{level: 'green'|'yellow'|'red', reasons: string[], writeMode: string, grade: string|null, expiresInDays: number|null}}
 */
export function admitClaim(claim, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date()
  const reasons = []
  const grade = bestGrade(claim.evidence ?? [])
  const words = restrictedWords(claim.text)
  const validUntil = (claim.evidence ?? [])
    .map(entry => toDate(entry.validUntil))
    .filter(date => date !== null)
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null
  const expiresInDays = validUntil === null ? null : daysBetween(now, validUntil)

  const red = () => ({ level: 'red', reasons, writeMode: '不得生成；提示补证据', grade, expiresInDays })
  const yellow = () => ({ level: 'yellow', reasons, writeMode: '只能写体验/场景与适用边界，不得写功效结论', grade, expiresInDays })
  const green = () => ({ level: 'green', reasons, writeMode: '可直接写功效结论', grade, expiresInDays })

  if (claim.text.length === 0) {
    reasons.push('claim 没有可用表述')
    return red()
  }
  if (['rejected', 'archived', 'pending'].includes(claim.status)) {
    reasons.push(`状态为 ${claim.status}，未通过审批`)
    return red()
  }
  if ((claim.evidence ?? []).length === 0) {
    reasons.push('没有任何证据行')
    return red()
  }
  if (grade === null) {
    reasons.push('证据等级缺失或不在 A—E 内')
    return red()
  }
  if (words.medical.length > 0) {
    reasons.push(`含医疗术语：${words.medical.join('、')}`)
    return red()
  }
  if (words.special.length > 0) {
    reasons.push(`含特殊功效宣称：${words.special.join('、')}`)
    return red()
  }
  if (words.absolute.length > 0) {
    reasons.push(`含绝对化用语：${words.absolute.join('、')}`)
    return red()
  }
  if (grade === 'E') {
    reasons.push('仅有 E 级（品牌自述）证据')
    return red()
  }
  if (expiresInDays !== null && expiresInDays < 0) {
    reasons.push(`证据已于 ${validUntil.toISOString().slice(0, 10)} 过期`)
    return red()
  }

  // ---- 有条件可用
  if (grade === 'C' || grade === 'D') {
    reasons.push(`${grade} 级证据，只能写场景/体验`)
    return yellow()
  }
  if (expiresInDays !== null && expiresInDays <= EXPIRY_WARNING_DAYS) {
    reasons.push(`证据 ${expiresInDays} 天后过期，先续期再扩量`)
    return yellow()
  }
  if (claim.limitations.length === 0) {
    reasons.push('缺少适用边界，必须先补 limitations')
    return yellow()
  }

  reasons.push(`${grade} 级证据，未过期`)
  return green()
}

/**
 * Admit a whole result set.
 * @returns {{green: object[], yellow: object[], red: object[], counts: object, evidencePack: object[]}}
 */
export function admitClaims(claims, options = {}) {
  const green = []
  const yellow = []
  const red = []
  for (const claim of claims) {
    const verdict = admitClaim(claim, options)
    const record = { ...claim, verdict }
    if (verdict.level === 'green') green.push(record)
    else if (verdict.level === 'yellow') yellow.push(record)
    else red.push(record)
  }
  const counts = { total: claims.length, green: green.length, yellow: yellow.length, red: red.length }
  return { green, yellow, red, counts, evidencePack: buildEvidencePack(green, yellow) }
}

/**
 * Flatten admitted claims into the `evidence` array `geo_draft` accepts, so the
 * L3 layer can be filled from the database instead of being pasted by hand.
 */
export function buildEvidencePack(green, yellow) {
  const pack = []
  for (const claim of [...green, ...yellow]) {
    const evidence = claim.evidence[0]
    if (evidence === undefined) continue
    pack.push({
      claim_id: claim.claimId,
      text: claim.text,
      evidence_id: evidence.evidenceId,
      source: evidence.source,
      date: evidence.testedAt,
      grade: evidence.grade,
      limitations: claim.limitations,
      writeMode: claim.verdict.writeMode,
    })
  }
  return pack
}

/** Claims asked for that the database could not supply. */
export function evidenceGaps(claims, wanted = []) {
  const present = new Set(claims.map(claim => claim.sku))
  return wanted.filter(sku => !present.has(sku))
}

/** Markdown for the tool result and the dashboard. */
export function renderEvidenceMarkdown(result, meta = {}) {
  const { counts } = result
  const lines = ['# 证据准入 · Claim 检查', '']
  if (meta.target !== undefined) lines.push(`数据源：${meta.target}${meta.schema === undefined ? '' : `（schema ${meta.schema}）`}`)
  if (meta.query !== undefined) lines.push(`查询：${meta.query}`)
  lines.push(`共 ${counts.total} 条 claim：可用 ${counts.green} / 有条件 ${counts.yellow} / 禁用 ${counts.red}`)
  lines.push('')

  const section = (title, list) => {
    if (list.length === 0) return
    lines.push(`## ${title}`)
    for (const claim of list) {
      lines.push(`### ${claim.claimId}${claim.sku === '' ? '' : ` · ${claim.sku}`} · ${claim.verdict.grade ?? '无等级'} 级`)
      lines.push(`- 表述：${claim.text}`)
      lines.push(`- 边界：${claim.limitations === '' ? '（未填，需补）' : claim.limitations}`)
      lines.push(`- 判定：${claim.verdict.reasons.join('；')}`)
      lines.push(`- 写法：${claim.verdict.writeMode}`)
      for (const evidence of claim.evidence) {
        const validity = evidence.validUntil === '' ? '无有效期' : `有效期至 ${evidence.validUntil}`
        lines.push(`- 证据 ${evidence.evidenceId}：${evidence.source || '来源未填'}（${evidence.grade} 级，${validity}）`)
      }
      lines.push('')
    }
  }
  section('绿色 / 可用', result.green)
  section('黄色 / 有条件', result.yellow)
  section('红色 / 禁用', result.red)

  if (counts.total === 0) {
    lines.push('没有查到 claim。可能是 sku 不匹配、关键词太窄，或该 SKU 在证据库里还没有被批准的表述。')
    return lines.join('\n')
  }
  if (result.red.length > 0) {
    lines.push('红色项不得进入起草；证据不足时写“待补充”，不要推测。')
  }
  return lines.join('\n').trimEnd()
}
