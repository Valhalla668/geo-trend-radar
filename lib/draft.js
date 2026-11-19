/**
 * Draft scaffolding and contract validation — 车间 03 / 04 / 05, the light tier.
 *
 * The plugin does not call a model. It hands the agent a complete, constrained
 * brief (the four-layer prompt of §4.4 plus a template from 附录 C), then checks
 * whatever JSON comes back against the contract of 附录 B and the red lines of
 * §7.1. Generation stays with the agent; structure and refusal stay here.
 *
 * Three gates are enforced mechanically:
 *   G1 Schema        字段、类型、必填、枚举、标题长度
 *   G2 证据绑定      block→claim→evidence→citation 的引用必须闭合
 *   G4 合规          绝对化 / 医疗 / 特殊功效词，命中即退回
 * G3 事实蕴含（NLI）与 G5 品牌语气需要人审，这里只标记，不假装通过。
 */
import { CLUSTER_BY_ID, FORBIDDEN_ABSOLUTE, MEDICAL_TERMS, PRODUCT_BY_ID, SPECIAL_EFFICACY } from './lexicon.js'

/** 附录 B 的 JSON 契约，逐字段照搬。 */
export const CONTENT_CONTRACT = {
  type: 'object',
  required: ['content_id', 'content_type', 'title', 'summary', 'blocks', 'claims', 'citations', 'risk_level'],
  properties: {
    content_id: { type: 'string' },
    content_type: { enum: ['answer_page', 'faq', 'comparison', 'social', 'video', 'qa', 'translation'] },
    title: { type: 'string', maxLength: 30 },
    summary: { type: 'string' },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'text'],
        properties: {
          type: { enum: ['paragraph', 'list', 'table', 'faq'] },
          text: { type: 'string' },
          claim_ids: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim_id', 'text', 'evidence_ids'],
        properties: {
          claim_id: { type: 'string' },
          text: { type: 'string' },
          evidence_ids: { type: 'array', items: { type: 'string' } },
          limitations: { type: 'string' },
        },
      },
    },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['evidence_id', 'source'],
        properties: {
          evidence_id: { type: 'string' },
          source: { type: 'string' },
          url: { type: 'string' },
          date: { type: 'string' },
        },
      },
    },
    risk_level: { enum: ['low', 'medium', 'high'] },
  },
}

/** 附录 C 的 12 个模板索引。 */
export const TEMPLATES = [
  { id: 'G01', name: '答案页', content_type: 'answer_page', purpose: '官网 / 知乎长答案', words: '800—1500 字' },
  { id: 'G02', name: 'FAQ', content_type: 'faq', purpose: '把答案拆成 5—8 条', words: '300—600 字' },
  { id: 'G03', name: '对比页', content_type: 'comparison', purpose: '方里 vs 竞品', words: '600—1000 字' },
  { id: 'G04', name: '选购指南', content_type: 'answer_page', purpose: '多 SKU / 场景', words: '1000—1500 字' },
  { id: 'G05', name: '小红书 9 图', content_type: 'social', purpose: '卡片文案', words: '每张 ≤40 字' },
  { id: 'G06', name: '抖音 60 秒', content_type: 'video', purpose: '口播脚本', words: '250—350 字' },
  { id: 'G07', name: '知乎回答', content_type: 'answer_page', purpose: '专业长文', words: '1200—1800 字' },
  { id: 'G08', name: 'B 站脚本', content_type: 'video', purpose: '5—8 分钟测评', words: '1500—2500 字' },
  { id: 'G09', name: '电商 QA', content_type: 'qa', purpose: '详情页问答', words: '50—100 字/条' },
  { id: 'G10', name: '客服话术', content_type: 'qa', purpose: '3 句话', words: '80—120 字' },
  { id: 'G11', name: '标题/摘要', content_type: 'social', purpose: '10 标题 + 3 摘要', words: '≤30 字/条' },
  { id: 'G12', name: '日文翻译', content_type: 'translation', purpose: '日本市场', words: '等长' },
]

/** §4.4 的硬性规则，逐条照搬，不要在这里改写措辞。 */
const HARD_RULES = [
  '只能使用【证据包】中的 claim 与 evidence；不得补充外部知识。',
  '每个功效句必须绑定 claim_id 与 evidence_id；没有证据的句子删除。',
  '证据强度低于 B 的 claim，只能写“体验/场景”，不得写功效结论。',
  '必须写“适用边界/不适用人群”。',
  '禁止：最、第一、国家级、治疗、修复疾病、医美替代、零毛孔、永久。',
  '证据不足、过期、冲突时，写“待补充”，不得推测。',
  '只输出 JSON，不输出解释；字段缺失填 null。',
]

/** 按选题卡的形态与内容簇选择模板。 */
export function pickTemplate(clusterId, format) {
  const byFormat = String(format ?? '')
  if (byFormat.includes('FAQ')) return TEMPLATES[1]
  if (byFormat.includes('对比表')) return TEMPLATES[2]
  if (byFormat.includes('选购指南')) return clusterId === 'compare' ? TEMPLATES[2] : TEMPLATES[3]
  if (byFormat.includes('视频')) return TEMPLATES[5]
  if (byFormat.includes('数据图')) return TEMPLATES[10]
  if (clusterId === 'skin' || clusterId === 'brand') return TEMPLATES[0]
  return TEMPLATES[0]
}

/**
 * Build the four-layer prompt pack.
 * L3 is deliberately a fill-in section: without a real evidence pack the draft
 * must not pretend to be claim-bound, so the skeleton says so in place.
 */
export function buildPromptPack(topic, options = {}) {
  const { evidence = [], template = TEMPLATES[0] } = options
  const cluster = CLUSTER_BY_ID[topic.clusterId] ?? null
  const product = PRODUCT_BY_ID[topic.productId] ?? null
  const audience = cluster?.id === 'skin'
    ? '有明确肤质困扰、正在挑底妆的 18—28 岁消费者'
    : cluster?.id === 'compare'
      ? '已经锁定 2 个候选品牌、需要第三方依据做决策的消费者'
      : '在 AI 搜索里做购买决策的美妆消费者'

  const evidenceLines = evidence.length === 0
    ? [
        '（待填）把证据包粘在这里。每条一行，格式：',
        'claim_id | claim 原文 | evidence_id | 来源 | 日期 | 证据等级(A-E) | 限制条件',
        '示例：C01 | 控油柔焦，油皮/混油适用 | E01 | 第三方检测报告 | 2025-06-01 | A | 仅油皮/混油',
      ]
    : evidence.map(entry => {
        const parts = [
          entry.claim_id ?? entry.claimId ?? '',
          entry.text ?? '',
          entry.evidence_id ?? entry.evidenceId ?? '',
          entry.source ?? '',
          entry.date ?? '',
          entry.grade ?? '',
          entry.limitations ?? '',
        ]
        return parts.join(' | ')
      })

  const l1 = [
    '你是方里 FUNNY ELVES 的 GEO 内容编辑。你的任务不是写营销文案，而是把【证据包】中的 claim 写成可被 AI 引用、可被人审核的答案资产。',
    '硬性规则：',
    ...HARD_RULES.map((rule, index) => `${index + 1}. ${rule}`),
  ].join('\n')

  const l2 = [
    `用户问题：${topic.question}`,
    `内容簇：${topic.cluster}　产品：${product?.name ?? topic.product ?? '—'}　形态：${template.name}（${template.id}）`,
    `目标人群：${audience}`,
    `篇幅：${template.words}　结构：结论先行（前 60 字给出结论）→ 证据 → 适用边界 → 对比（如适用）→ 来源`,
    `输出：严格按 JSON 契约，content_type = "${template.content_type}"，title ≤ 30 字。`,
  ].join('\n')

  const l3 = [
    `本条选题的证据缺口（来自选题卡）：${topic.evidenceGap ?? '—'}`,
    `目标证据等级：${topic.evidence ?? '—'}`,
    evidence.length === 0 ? '本次未提供证据包，起草前必须补齐。' : `本次提供 ${evidence.length} 条 claim。`,
    '',
    ...evidenceLines,
  ].join('\n')

  const l4 = [
    '在输出 JSON 前，逐条自检并在 note 字段写明结论：',
    '1. 每个 block 是否都绑定 claim_ids？没有绑定的段落是否属于转化句或流程说明？',
    '2. 每条 claim 的 evidence_ids 是否都存在于 citations？',
    '3. 是否存在绝对化、医疗、特殊功效表述？有则删除。',
    '4. 是否写了适用边界/不适用人群？',
    '5. 证据不足或冲突的句子，是否改写为“待补充”？',
    '6. risk_level 是否与实际风险相符（敏感肌/功效/对比/价格为 high）？',
  ].join('\n')

  return {
    template,
    layers: { L1: l1, L2: l2, L3: l3, L4: l4 },
    text: [`【L1 角色/边界】`, l1, '', `【L2 任务】`, l2, '', `【L3 证据】`, l3, '', `【L4 自检】`, l4].join('\n'),
    evidenceCount: evidence.length,
    evidenceMissing: evidence.length === 0,
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const asArray = value => (Array.isArray(value) ? value : [])

const NEGATION = /[不非没无未]/u
/** How many characters before a restricted word still count as its negation context. */
const NEGATION_WINDOW = 4

/**
 * Scan for restricted words while respecting negation.
 * 「不是最适合」是常见的合规口径（结论直接回答是/不是/要看情况），
 * 它含有「最」却不是绝对化宣称，因此紧邻否定词的出现记为待人工确认的警告。
 * 这是启发式：窗口内出现否定词即放行并告警，最终由法务确认。
 */
export function scanWords(text, words) {
  const source = String(text ?? '')
  const hits = new Set()
  const negated = new Set()
  for (const word of words) {
    if (!source.includes(word)) continue
    let index = source.indexOf(word)
    while (index >= 0) {
      const before = source.slice(Math.max(0, index - NEGATION_WINDOW), index)
      if (NEGATION.test(before)) negated.add(word)
      else hits.add(word)
      index = source.indexOf(word, index + word.length)
    }
  }
  return { hits: [...hits], negated: [...negated] }
}

/** All user-visible text of a draft, for the compliance scan. */
function draftText(draft) {
  const parts = [draft.title, draft.summary]
  for (const block of asArray(draft.blocks)) parts.push(block?.text)
  for (const claim of asArray(draft.claims)) parts.push(claim?.text)
  return parts.filter(value => typeof value === 'string').join('\n')
}

/**
 * Validate a model-returned draft against G1 / G2 / G4.
 * @returns {{ok: boolean, errors: string[], warnings: string[], stats: object}}
 */
export function validateDraft(draft) {
  const errors = []
  const warnings = []

  if (!isPlainObject(draft)) {
    return { ok: false, errors: ['G1：草稿不是 JSON 对象（只接受附录 B 契约的对象）'], warnings, stats: { blocks: 0, claims: 0, citations: 0 } }
  }

  // ---- G1 Schema
  for (const field of CONTENT_CONTRACT.required) {
    if (draft[field] === undefined || draft[field] === null) errors.push(`G1：缺少必填字段 ${field}`)
  }
  if (typeof draft.content_id === 'string' && draft.content_id.trim().length === 0) errors.push('G1：content_id 为空')
  const allowedTypes = CONTENT_CONTRACT.properties.content_type.enum
  if (draft.content_type !== undefined && !allowedTypes.includes(draft.content_type)) {
    errors.push(`G1：content_type 必须是 ${allowedTypes.join(' / ')} 之一，收到 ${JSON.stringify(draft.content_type)}`)
  }
  if (typeof draft.title === 'string' && draft.title.length > 30) {
    errors.push(`G1：title 超过 30 字（当前 ${draft.title.length} 字）`)
  }
  if (typeof draft.summary !== 'string' || draft.summary.trim().length === 0) errors.push('G1：summary 不能为空')
  const allowedRisk = CONTENT_CONTRACT.properties.risk_level.enum
  if (draft.risk_level !== undefined && !allowedRisk.includes(draft.risk_level)) {
    errors.push(`G1：risk_level 必须是 ${allowedRisk.join(' / ')} 之一`)
  }
  if (asArray(draft.blocks).length === 0) errors.push('G1：blocks 至少要有 1 个段落')
  const blockTypes = CONTENT_CONTRACT.properties.blocks.items.properties.type.enum
  for (const [index, block] of asArray(draft.blocks).entries()) {
    if (!isPlainObject(block)) {
      errors.push(`G1：blocks[${index}] 不是对象`)
      continue
    }
    if (!blockTypes.includes(block.type)) errors.push(`G1：blocks[${index}].type 非法（${JSON.stringify(block.type)}）`)
    if (typeof block.text !== 'string' || block.text.trim().length === 0) errors.push(`G1：blocks[${index}].text 为空`)
  }

  // ---- G2 证据绑定
  const claimIds = new Set()
  const claimById = new Map()
  for (const [index, claim] of asArray(draft.claims).entries()) {
    if (!isPlainObject(claim)) {
      errors.push(`G2：claims[${index}] 不是对象`)
      continue
    }
    if (typeof claim.claim_id !== 'string' || claim.claim_id.trim().length === 0) {
      errors.push(`G2：claims[${index}] 缺少 claim_id`)
      continue
    }
    if (claimIds.has(claim.claim_id)) errors.push(`G2：claim_id 重复（${claim.claim_id}）`)
    claimIds.add(claim.claim_id)
    claimById.set(claim.claim_id, claim)
    if (asArray(claim.evidence_ids).length === 0) errors.push(`G2：claim ${claim.claim_id} 没有绑定任何 evidence_id`)
    if (typeof claim.text !== 'string' || claim.text.trim().length === 0) errors.push(`G2：claim ${claim.claim_id} 的 text 为空`)
    if (typeof claim.limitations !== 'string' || claim.limitations.trim().length === 0) {
      warnings.push(`G2：claim ${claim.claim_id} 没写 limitations（适用范围/不适用人群）`)
    }
  }
  if (claimIds.size === 0) errors.push('G2：claims 为空，等于没有任何可核验的事实')

  const citedEvidence = new Set()
  for (const [index, citation] of asArray(draft.citations).entries()) {
    if (!isPlainObject(citation)) {
      errors.push(`G2：citations[${index}] 不是对象`)
      continue
    }
    if (typeof citation.evidence_id !== 'string' || citation.evidence_id.trim().length === 0) {
      errors.push(`G2：citations[${index}] 缺少 evidence_id`)
      continue
    }
    citedEvidence.add(citation.evidence_id)
    if (typeof citation.source !== 'string' || citation.source.trim().length === 0) errors.push(`G2：citations[${index}] 缺少 source`)
    if (typeof citation.date !== 'string' || citation.date.trim().length === 0) warnings.push(`G2：citations[${index}]（${citation.evidence_id}）没写日期，无法判断是否过期`)
  }

  for (const claim of claimById.values()) {
    for (const evidenceId of asArray(claim.evidence_ids)) {
      if (!citedEvidence.has(evidenceId)) errors.push(`G2：claim ${claim.claim_id} 引用的 ${evidenceId} 不在 citations 里`)
    }
  }

  for (const [index, block] of asArray(draft.blocks).entries()) {
    const ids = asArray(block?.claim_ids)
    for (const claimId of ids) {
      if (!claimIds.has(claimId)) errors.push(`G2：blocks[${index}] 引用了未声明的 claim_id（${claimId}）`)
    }
    if (ids.length === 0 && block?.type === 'paragraph') {
      warnings.push(`G2：blocks[${index}] 是段落但没有 claim_ids，确认它不属于功效陈述`)
    }
  }

  // ---- G4 合规
  const text = draftText(draft)
  const absolute = scanWords(text, FORBIDDEN_ABSOLUTE)
  const medical = scanWords(text, MEDICAL_TERMS)
  const special = scanWords(text, SPECIAL_EFFICACY)
  if (medical.hits.length > 0) errors.push(`G4：命中医疗术语（${medical.hits.join('、')}），必须删除或改写`)
  if (absolute.hits.length > 0) errors.push(`G4：命中绝对化用语（${absolute.hits.join('、')}），必须删除或提供合法依据`)
  if (special.hits.length > 0) errors.push(`G4：命中特殊功效宣称（${special.hits.join('、')}），普通化妆品不得宣称`)
  for (const [label, result] of [['绝对化用语', absolute], ['医疗术语', medical], ['特殊功效', special]]) {
    if (result.negated.length > 0) {
      warnings.push(`G4：${result.negated.join('、')} 出现在否定语境（${label}），已放行，请人工确认口径`)
    }
  }

  // ---- 人审提示（G3 / G5 不在这里通过）
  if (draft.risk_level === 'high' && draft.review_required !== true) {
    warnings.push('G3/G5：risk_level 为 high，但 review_required 不为 true，人审可能被跳过')
  }
  if (asArray(draft.citations).length === 0) warnings.push('G2：citations 为空，引用率将无法统计')

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      blocks: asArray(draft.blocks).length,
      claims: asArray(draft.claims).length,
      citations: asArray(draft.citations).length,
      claimBoundBlocks: asArray(draft.blocks).filter(block => asArray(block?.claim_ids).length > 0).length,
      absolute: absolute.hits, medical: medical.hits, special: special.hits,
      negated: [...new Set([...absolute.negated, ...medical.negated, ...special.negated])],
    },
  }
}

/** 车间 05 的轻量版：把已通过的 JSON 渲染成 Markdown。 */
export function renderDraftMarkdown(draft, meta = {}) {
  const lines = [`# ${draft.title}`, '']
  if (meta.templateId !== undefined) lines.push(`模板：${meta.templateId}　类型：${draft.content_type}　风险：${draft.risk_level}`)
  if (meta.contentId !== undefined) lines.push(`内容 ID：${meta.contentId}`)
  lines.push('')
  lines.push(`> ${draft.summary}`)
  lines.push('')
  for (const block of asArray(draft.blocks)) {
    if (block.type === 'list') {
      for (const line of String(block.text).split(/\n+/u)) lines.push(`- ${line.replace(/^[-*]\s*/u, '')}`)
    } else if (block.type === 'faq') {
      lines.push(`**${block.text}**`)
    } else if (block.type === 'table') {
      lines.push('```')
      lines.push(String(block.text))
      lines.push('```')
    } else {
      lines.push(String(block.text))
    }
    lines.push('')
  }
  if (asArray(draft.claims).length > 0) {
    lines.push('## 事实与证据')
    lines.push('| claim | 表述 | 证据 | 适用边界 |')
    lines.push('| --- | --- | --- | --- |')
    for (const claim of asArray(draft.claims)) {
      const evidence = asArray(claim.evidence_ids).join('、')
      lines.push(`| ${claim.claim_id} | ${claim.text} | ${evidence} | ${claim.limitations ?? '—'} |`)
    }
    lines.push('')
  }
  if (asArray(draft.citations).length > 0) {
    lines.push('## 来源')
    for (const citation of asArray(draft.citations)) {
      const date = typeof citation.date === 'string' ? `（${citation.date}）` : ''
      const url = typeof citation.url === 'string' && citation.url.length > 0 ? ` ${citation.url}` : ''
      lines.push(`- ${citation.evidence_id} · ${citation.source}${date}${url}`)
    }
    lines.push('')
  }
  lines.push('---')
  lines.push('发布前仍需三签：事实核查签、法务签、品牌/渠道签；G3 事实蕴含与 G5 品牌语气未由插件判定。')
  return lines.join('\n').trimEnd()
}
