import assert from 'node:assert/strict'
import { test } from 'node:test'
import { admitClaim, admitClaims, buildEvidencePack, groupClaimRows, renderEvidenceMarkdown } from '../lib/evidence.js'
import {
  buildClaimsQuery,
  buildSkuQuery,
  configTemplate,
  describeDbError,
  describeInstance,
  normalizeInstance,
  quoteIdent,
  resolveDatabases,
} from '../lib/pgdb.js'

const NOW = new Date('2026-11-17T09:00:00.000Z')

const connection = {
  host: '10.0.0.10',
  port: 5432,
  database: 'geo_evidence',
  user: 'geo_readonly',
  password: 'secret-not-printed',
}

const claim = (overrides = {}) => ({
  claimId: 'C01',
  sku: 'FL-POWDER-01',
  text: '即时控油与柔焦毛孔的视觉改善',
  limitations: '仅油皮/混油',
  status: 'approved',
  approvedAt: '2026-06-01',
  evidence: [
    {
      evidenceId: 'E01',
      grade: 'A',
      source: '第三方检测报告',
      sourceUrl: 'https://example.com/e01',
      testedAt: '2026-06-01',
      validUntil: '2027-06-01',
      sampleSize: 32,
      method: '仪器测试',
    },
  ],
  ...overrides,
})

test('an instance needs host, database and user before it can be used', () => {
  const empty = normalizeInstance('evidence', {})
  assert.equal(empty.instance, null)
  assert.equal(empty.problems.length, 3)

  const disabled = normalizeInstance('evidence', { ...connection, enabled: false })
  assert.equal(disabled.instance, null)
  assert.ok(disabled.problems[0].includes('已禁用'))

  const ok = normalizeInstance('evidence', connection)
  assert.notEqual(ok.instance, null)
  assert.deepEqual(ok.problems, [])
  assert.equal(ok.instance.port, 5432)
  assert.equal(ok.instance.maxRows, 200)
  assert.equal(ok.instance.mapping.tables.claim, 'geo_claim')
})

test('the mapping merges over defaults instead of replacing them', () => {
  const { instance } = normalizeInstance('evidence', {
    ...connection,
    schema: 'geo',
    mapping: { tables: { claim: 'claim_tbl' }, columns: { claim: { claim_text: 'wording' } } },
  })
  assert.equal(instance.mapping.tables.claim, 'claim_tbl')
  assert.equal(instance.mapping.tables.evidence, 'geo_evidence', 'untouched default survives')
  assert.equal(instance.mapping.columns.claim.claim_text, 'wording')
  assert.equal(instance.mapping.columns.claim.claim_id, 'claim_id')
})

test('status never exposes the password', () => {
  const { instance } = normalizeInstance('evidence', connection)
  const info = describeInstance(instance)
  assert.equal(info.passwordSet, true)
  assert.ok(!JSON.stringify(info).includes('secret-not-printed'))
  assert.equal(info.target, '10.0.0.10:5432/geo_evidence')
  assert.equal(info.readOnly, true)
})

test('resolveDatabases reports both instances independently', () => {
  const none = resolveDatabases({})
  assert.equal(none.configured, false)
  assert.equal(none.evidence, null)
  assert.equal(none.problems.length, 2)

  const one = resolveDatabases({ databases: { evidence: connection } })
  assert.equal(one.configured, true)
  assert.notEqual(one.evidence, null)
  assert.equal(one.product, null)
})

test('identifiers are quoted so odd names still work', () => {
  assert.equal(quoteIdent('claim_id'), '"claim_id"')
  assert.equal(quoteIdent('we"ird'), '"we""ird"')
})

test('the generated claim query follows the mapping and parameter order', () => {
  const { instance } = normalizeInstance('evidence', { ...connection, schema: 'geo' })
  const query = buildClaimsQuery(instance, { sku: 'FL-01', keyword: '控油', limit: 25 })
  assert.ok(query.text.includes('"geo"."geo_claim"'))
  assert.ok(query.text.includes('"geo"."geo_evidence"'))
  assert.ok(query.text.includes('as claim_id'))
  assert.ok(query.text.includes('as valid_until'))
  assert.deepEqual(query.values, ['FL-01', '控油', 25])
  assert.ok(query.text.trimEnd().endsWith('limit $3::int'))
})

test('the row limit is clamped to maxRows and custom sql wins', () => {
  const { instance } = normalizeInstance('evidence', { ...connection, maxRows: 30 })
  assert.equal(buildClaimsQuery(instance, { limit: 500 }).values[2], 30)

  const custom = normalizeInstance('evidence', { ...connection, sql: { claims: 'select 1 as claim_id where $1::text is null or $2::text is null limit $3' } })
  const query = buildClaimsQuery(custom.instance, { sku: null, limit: 5 })
  assert.equal(query.text, 'select 1 as claim_id where $1::text is null or $2::text is null limit $3')
  assert.deepEqual(query.values, [null, null, 5])
})

test('the SKU query aliases every mapped column', () => {
  const { instance } = normalizeInstance('product', { ...connection, database: 'geo_product' })
  const query = buildSkuQuery(instance, { sku: 'FL-01', limit: 10 })
  for (const alias of ['sku_code', 'product_name', 'price_cny', 'filing_no', 'skin_ty']) {
    assert.ok(query.text.includes(alias), `missing alias ${alias}`)
  }
  assert.ok(query.text.includes('"geo_sku"'))
  assert.deepEqual(query.values, ['FL-01', null, 10])
})

test('connection failures carry an actionable hint', () => {
  const { instance } = normalizeInstance('evidence', connection)
  const refused = describeDbError(Object.assign(new Error('connect ECONNREFUSED 10.0.0.10:5432'), { code: 'ECONNREFUSED' }), instance)
  assert.ok(refused.includes('端口未监听'))
  const missing = describeDbError(Object.assign(new Error('relation does not exist'), { code: '42P01' }), instance)
  assert.ok(missing.includes('mapping.tables'))
  const auth = describeDbError(Object.assign(new Error('password authentication failed'), { code: '28P01' }), instance)
  assert.ok(auth.includes('认证失败'))
})

test('the config template documents both instances', () => {
  const text = configTemplate()
  for (const key of ['databases:', 'evidence:', 'product:', 'mapping:', 'valid_until']) {
    assert.ok(text.includes(key), `template missing ${key}`)
  }
})

test('flat rows group into one claim with its evidence', () => {
  const rows = [
    { claim_id: 'C01', sku_code: 'FL-01', claim_text: '控油', limitations: '油皮', status: 'approved', evidence_id: 'E01', grade: 'A', source: '检测', valid_until: '2027-01-01' },
    { claim_id: 'C01', sku_code: 'FL-01', claim_text: '控油', limitations: '油皮', status: 'approved', evidence_id: 'E02', grade: 'B', source: '消费者测试', valid_until: '2027-01-01' },
    { claim_id: 'C02', sku_code: 'FL-02', claim_text: '保湿', limitations: '', status: 'approved', evidence_id: null, grade: null },
  ]
  const claims = groupClaimRows(rows)
  assert.equal(claims.length, 2)
  assert.equal(claims[0].evidence.length, 2)
  assert.equal(claims[1].evidence.length, 0, 'a claim without evidence still arrives')
})

test('admission puts A/B, unexpired claims in green', () => {
  const verdict = admitClaim(claim(), { now: NOW })
  assert.equal(verdict.level, 'green')
  assert.equal(verdict.grade, 'A')
  assert.ok(verdict.writeMode.includes('功效结论'))
})

test('C/D grade, near expiry and a missing boundary are all 有条件', () => {
  const gradedC = admitClaim(claim({ evidence: [{ ...claim().evidence[0], grade: 'C' }] }), { now: NOW })
  assert.equal(gradedC.level, 'yellow')

  const expiring = admitClaim(claim({ evidence: [{ ...claim().evidence[0], validUntil: '2026-11-25' }] }), { now: NOW })
  assert.equal(expiring.level, 'yellow')
  assert.ok(expiring.reasons.some(reason => reason.includes('天后过期')))

  const noLimit = admitClaim(claim({ limitations: '' }), { now: NOW })
  assert.equal(noLimit.level, 'yellow')
  assert.ok(noLimit.reasons.some(reason => reason.includes('适用边界')))
})

test('expired, unreferenced, E-grade and red-line claims are refused', () => {
  const expired = admitClaim(claim({ evidence: [{ ...claim().evidence[0], validUntil: '2026-01-01' }] }), { now: NOW })
  assert.equal(expired.level, 'red')
  assert.ok(expired.reasons[0].includes('过期'))

  assert.equal(admitClaim(claim({ evidence: [] }), { now: NOW }).level, 'red')
  assert.equal(admitClaim(claim({ evidence: [{ ...claim().evidence[0], grade: 'E' }] }), { now: NOW }).level, 'red')
  assert.equal(admitClaim(claim({ status: 'pending' }), { now: NOW }).level, 'red')

  const medical = admitClaim(claim({ text: '可以治疗敏感肌' }), { now: NOW })
  assert.equal(medical.level, 'red')
  assert.ok(medical.reasons[0].includes('医疗术语'))

  const absolute = admitClaim(claim({ text: '最服帖的粉饼' }), { now: NOW })
  assert.equal(absolute.level, 'red')
  assert.ok(absolute.reasons[0].includes('绝对化'))

  const special = admitClaim(claim({ text: '能美白的粉饼' }), { now: NOW })
  assert.equal(special.level, 'red')
  assert.ok(special.reasons[0].includes('特殊功效'))
})

test('a batch produces counts plus a pack usable as L3 evidence', () => {
  const result = admitClaims(
    [claim(), claim({ claimId: 'C02', evidence: [{ ...claim().evidence[0], evidenceId: 'E02', grade: 'C' }] })],
    { now: NOW },
  )
  assert.deepEqual(result.counts, { total: 2, green: 1, yellow: 1, red: 0 })
  const pack = buildEvidencePack(result.green, result.yellow)
  assert.equal(pack.length, 2)
  assert.equal(pack[0].claim_id, 'C01')
  assert.equal(pack[0].evidence_id, 'E01')
  assert.equal(pack[0].grade, 'A')
  assert.equal(pack[0].limitations, '仅油皮/混油')
  assert.ok(pack[1].writeMode.includes('体验'))
})

test('the evidence markdown separates the three colours and states the rule', () => {
  const result = admitClaims([claim(), claim({ claimId: 'C02', text: '可以治疗敏感肌' })], { now: NOW })
  const markdown = renderEvidenceMarkdown(result, { target: '10.0.0.10:5432/geo_evidence', schema: 'public', query: 'SKU FL-POWDER-01' })
  assert.ok(markdown.includes('绿色 / 可用'))
  assert.ok(markdown.includes('红色 / 禁用'))
  assert.ok(markdown.includes('待补充'))
  assert.ok(markdown.includes('10.0.0.10:5432/geo_evidence'))
})
