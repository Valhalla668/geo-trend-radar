import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildPromptPack,
  CONTENT_CONTRACT,
  pickTemplate,
  renderDraftMarkdown,
  scanWords,
  validateDraft,
} from '../lib/draft.js'
import { FORBIDDEN_ABSOLUTE } from '../lib/lexicon.js'

const topic = {
  question: '方里柔焦蜜粉饼适合干皮吗？',
  cluster: '肤质肤况',
  clusterId: 'skin',
  product: '方里柔焦蜜粉饼',
  productId: 'powder',
  format: '深度答案页',
  evidenceGap: '缺 A 级证据：斑贴 / 人体功效评价 / 检测报告',
  evidence: '目标证据等级：A（检测 / 斑贴 / 人体功效）',
}

const validDraft = () => ({
  content_id: 'gen_20261117_001',
  content_type: 'answer_page',
  title: '方里粉饼适合干皮吗',
  summary: '不是最适合，但可以用。它更偏油皮/混油，干皮秋冬全脸使用可能拔干，建议局部定妆。',
  blocks: [
    { type: 'paragraph', text: '方里柔焦蜜粉饼主打控油与柔焦，更偏油皮/混油。[C01]', claim_ids: ['C01'] },
    { type: 'paragraph', text: '干皮秋冬全脸使用可能拔干；建议局部定妆，妆前做好保湿。[C02]', claim_ids: ['C02'] },
  ],
  claims: [
    { claim_id: 'C01', text: '控油柔焦', evidence_ids: ['E01'], limitations: '油皮/混油' },
    { claim_id: 'C02', text: '干皮局部使用', evidence_ids: ['E02'], limitations: '不建议全脸' },
  ],
  citations: [
    { evidence_id: 'E01', source: '第三方检测报告', date: '2025-06-01', url: 'https://example.com/e01' },
    { evidence_id: 'E02', source: '消费者测试', date: '2025-06-01' },
  ],
  risk_level: 'high',
  review_required: true,
})

test('the contract mirrors 附录 B', () => {
  assert.deepEqual(CONTENT_CONTRACT.properties.content_type.enum, ['answer_page', 'faq', 'comparison', 'social', 'video', 'qa', 'translation'])
  assert.deepEqual(CONTENT_CONTRACT.required, ['content_id', 'content_type', 'title', 'summary', 'blocks', 'claims', 'citations', 'risk_level'])
  assert.deepEqual(CONTENT_CONTRACT.properties.risk_level.enum, ['low', 'medium', 'high'])
})

test('template selection follows the topic format, not a free choice', () => {
  assert.equal(pickTemplate('skin', '深度答案页').id, 'G01')
  assert.equal(pickTemplate('category', 'FAQ / 短答案').id, 'G02')
  assert.equal(pickTemplate('compare', '对比表 / 选购指南').id, 'G03')
  assert.equal(pickTemplate('category', '选购指南').id, 'G04')
  assert.equal(pickTemplate('scene', '视频脚本').id, 'G06')
  assert.equal(pickTemplate('product', '数据图 / 信息图').id, 'G11')
})

test('the prompt pack carries the seven hard rules and marks a missing evidence pack', () => {
  const pack = buildPromptPack(topic, {})
  assert.equal(pack.evidenceMissing, true)
  assert.equal(pack.evidenceCount, 0)
  for (const rule of ['只能使用【证据包】', '必须绑定 claim_id 与 evidence_id', '证据强度低于 B', '适用边界', '零毛孔', '待补充', '只输出 JSON']) {
    assert.ok(pack.layers.L1.includes(rule), `L1 missing rule: ${rule}`)
  }
  assert.ok(pack.layers.L2.includes(topic.question))
  assert.ok(pack.layers.L2.includes('content_type = "answer_page"'))
  assert.ok(pack.layers.L3.includes('待填'))
  assert.ok(pack.layers.L3.includes(topic.evidenceGap))
  assert.ok(pack.layers.L4.includes('自检'))
  assert.equal(pack.template.id, 'G01')
})

test('an evidence pack is rendered into L3 line by line', () => {
  const pack = buildPromptPack(topic, {
    evidence: [{ claim_id: 'C01', text: '控油柔焦', evidence_id: 'E01', source: '第三方检测', date: '2025-06-01', grade: 'A', limitations: '油皮/混油' }],
  })
  assert.equal(pack.evidenceMissing, false)
  assert.ok(pack.layers.L3.includes('C01 | 控油柔焦 | E01 | 第三方检测 | 2025-06-01 | A | 油皮/混油'))
  assert.ok(!pack.layers.L3.includes('待填'))
})

test('negated restricted words pass and are reported as warnings', () => {
  assert.deepEqual(scanWords('不是最适合干皮', FORBIDDEN_ABSOLUTE), { hits: [], negated: ['最'] })
  assert.deepEqual(scanWords('最服帖的粉饼', FORBIDDEN_ABSOLUTE).hits, ['最'])
  const mixed = scanWords('不追求第一，但这是最稳的选择', FORBIDDEN_ABSOLUTE)
  assert.ok(mixed.hits.includes('最'), 'a non-negated occurrence still fails')
  assert.ok(mixed.negated.includes('第一'))
})

test('a contract-conforming draft passes all three mechanical gates', () => {
  const report = validateDraft(validDraft())
  assert.equal(report.ok, true, report.errors.join(' | '))
  assert.deepEqual(report.errors, [])
  assert.equal(report.stats.claims, 2)
  assert.equal(report.stats.citations, 2)
  assert.equal(report.stats.claimBoundBlocks, 2)
  assert.ok(report.warnings.length >= 0)
})

test('G1 rejects missing fields, bad enums and an over-long title', () => {
  const missing = validDraft()
  delete missing.citations
  assert.equal(validateDraft(missing).errors.some(error => error.includes('citations')), true)

  const badType = validDraft()
  badType.content_type = 'blog_post'
  assert.equal(validateDraft(badType).errors.some(error => error.includes('content_type')), true)

  const longTitle = validDraft()
  longTitle.title = '方'.repeat(31)
  assert.equal(validateDraft(longTitle).errors.some(error => error.includes('30 字')), true)

  assert.equal(validateDraft(null).ok, false)
})

test('G2 refuses an open evidence chain in both directions', () => {
  const danglingClaim = validDraft()
  danglingClaim.blocks[0].claim_ids = ['C99']
  assert.equal(validateDraft(danglingClaim).errors.some(error => error.includes('未声明的 claim_id')), true)

  const danglingEvidence = validDraft()
  danglingEvidence.claims[0].evidence_ids = ['E99']
  assert.equal(validateDraft(danglingEvidence).errors.some(error => error.includes('E99')), true)

  const unbound = validDraft()
  unbound.claims[0].evidence_ids = []
  assert.equal(validateDraft(unbound).errors.some(error => error.includes('没有绑定任何 evidence_id')), true)

  const noClaims = validDraft()
  noClaims.claims = []
  noClaims.citations = []
  assert.equal(validateDraft(noClaims).errors.some(error => error.includes('claims 为空')), true)
})

test('a missing limitations field is a warning, not a blocker', () => {
  const draft = validDraft()
  draft.claims[0].limitations = ''
  const report = validateDraft(draft)
  assert.equal(report.ok, true)
  assert.equal(report.warnings.some(warning => warning.includes('limitations')), true)
})

test('G4 blocks a medical claim and lets a negated absolute through', () => {
  const medical = validDraft()
  medical.blocks[0].text = '这款粉饼可以治疗敏感肌。[C01]'
  const report = validateDraft(medical)
  assert.equal(report.ok, false)
  assert.equal(report.errors.some(error => error.includes('医疗术语')), true)

  const special = validDraft()
  special.summary = '能美白、防晒的粉饼。'
  assert.equal(validateDraft(special).errors.some(error => error.includes('特殊功效')), true)

  const hedged = validDraft()
  hedged.summary = '不是最适合干皮，但油皮可用。'
  assert.equal(validateDraft(hedged).ok, true, 'a negated 最 must not block the draft')
})

test('renderDraftMarkdown emits body, claim table, sources and the human-review note', () => {
  const markdown = renderDraftMarkdown(validDraft(), { templateId: 'G01', contentId: 'gen_20261117_001' })
  assert.ok(markdown.startsWith('# 方里粉饼适合干皮吗'))
  assert.ok(markdown.includes('| C01 | 控油柔焦 | E01 | 油皮/混油 |'))
  assert.ok(markdown.includes('- E01 · 第三方检测报告（2025-06-01）'))
  assert.ok(markdown.includes('三签'))
  assert.ok(markdown.includes('G3 事实蕴含与 G5 品牌语气未由插件判定'))
})
