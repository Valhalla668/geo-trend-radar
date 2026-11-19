import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  computeMetrics,
  createAudit,
  deriveFlags,
  enginesFor,
  nextBatch,
  recordAnswers,
  renderBaselineMarkdown,
} from '../lib/baseline.js'
import { annotateCalendar, calendarStatus, renderCalendarMarkdown } from '../lib/calendar.js'
import { demoteHeadings, renderReport, uniqueByTitle } from '../lib/report.js'
import { buildSov, computeMentions } from '../lib/sov.js'
import { ENGINES } from '../lib/lexicon.js'

const PROMPTS_URL = new URL('../assets/prompts.json', import.meta.url)
const prompts = async () => JSON.parse(await readFile(PROMPTS_URL, 'utf8')).prompts

test('the audit grid expands every prompt across its engines', async () => {
  const list = await prompts()
  const audit = createAudit(list)
  const expected = list.reduce((sum, prompt) => sum + enginesFor(prompt).length, 0)
  assert.equal(audit.promptCount, 20)
  assert.equal(audit.total, expected)
  assert.equal(new Set(audit.rows.map(row => row.id)).size, audit.total, 'row ids are unique')
  assert.ok(audit.rows.every(row => row.status === 'pending'))
  assert.equal(enginesFor({ engines: '全部' }).length, ENGINES.length)
})

test('derived flags read the answer text without an LLM', () => {
  const flags = deriveFlags('方里由某某控股有限公司持有，官网 funnyelves.com 有完整备案信息，天猫旗舰店同步。')
  assert.equal(flags.brandMentioned, true)
  assert.equal(flags.firstChoice, true)
  assert.ok(flags.ownedCited.includes('funnyelves.com'))
  assert.ok(flags.ownedCited.includes('天猫'))
  assert.deepEqual(flags.negative, [])

  const late = deriveFlags(`${'底妆测评内容'.repeat(30)}方里粉饼`)
  assert.equal(late.brandMentioned, true)
  assert.equal(late.firstChoice, false, 'a late mention is not a first choice')
  assert.deepEqual(late.competitors, [])
})

test('next hands out batches in priority order and honours filters', async () => {
  const audit = createAudit(await prompts())
  const batch = nextBatch(audit, 5)
  assert.equal(batch.batch.length, 5)
  assert.equal(batch.remaining, audit.total)
  assert.ok(batch.batch.every(row => row.priority === 'A'))

  const filtered = nextBatch(audit, 3, { cluster: '竞品对比' })
  assert.ok(filtered.batch.every(row => row.cluster === '竞品对比'))

  const byPrompt = nextBatch(audit, 6, { promptId: 'P001' })
  assert.ok(byPrompt.batch.every(row => row.promptId === 'P001'))
  assert.equal(byPrompt.batch.length, Math.min(6, byPrompt.remaining))
})

test('recording answers derives flags and moves the five metrics', async () => {
  const audit = createAudit(await prompts())
  const empty = computeMetrics(audit)
  assert.equal(empty.audited, 0)
  assert.equal(empty.mentionRate, null, 'no audited row means no rate, not zero')

  const first = recordAnswers(audit, [
    { promptId: 'P001', engine: 'DeepSeek', answer: '方里属于某某控股有限公司，官网 funnyelves.com 可查。', factsTotal: 2, factsCorrect: 1 },
  ])
  assert.equal(first.recorded, 1)
  assert.deepEqual(first.skipped, [])

  const skipped = recordAnswers(audit, [
    { promptId: 'P001', engine: '不存在的引擎', answer: 'x' },
    { promptId: 'P999', engine: 'DeepSeek', answer: 'x' },
    { promptId: 'P002', engine: 'DeepSeek', answer: '   ' },
  ])
  assert.equal(skipped.recorded, 0)
  assert.equal(skipped.skipped.length, 3)

  recordAnswers(audit, [
    { promptId: 'P002', engine: '豆包', answer: '底妆品牌有很多，建议按肤质挑选。', factsTotal: 1, factsCorrect: 1 },
  ])
  const metrics = computeMetrics(audit)
  assert.equal(metrics.audited, 2)
  assert.equal(metrics.mentionRate, 50)
  assert.equal(metrics.firstChoiceRate, 50)
  assert.equal(metrics.citationRate, 100, 'citation rate divides by mentions, not by answers')
  assert.equal(metrics.factAccuracy, Math.round((2 / 3) * 1000) / 10)
  assert.equal(metrics.negativeRate, 0)
  assert.equal(metrics.coverage, Math.round((2 / audit.total) * 1000) / 10)
  assert.ok(metrics.byEngine.length >= 2)
  const markdown = renderBaselineMarkdown(audit, metrics, { remaining: audit.total - 2 })
  assert.ok(markdown.includes('五个核心指标'))
  assert.ok(markdown.includes('剩余待采集'))
})

test('the report renders every section and states its limits', async () => {
  const audit = createAudit(await prompts())
  const sov = buildSov([
    {
      scannedAt: '2026-11-17T02:00:00.000Z',
      mentions: computeMentions([
        { title: '方里柔焦蜜粉饼测评', platformName: '知乎', platform: 'zhihu', rank: 1 },
        { title: '油皮粉底液怎么选', platformName: '微博', platform: 'weibo', rank: 2 },
      ]),
    },
  ], { days: 7, now: new Date('2026-11-17T12:00:00.000Z') })
  const report = renderReport({
    period: 'daily',
    date: new Date('2026-11-17T12:00:00.000Z'),
    snapshot: { scannedAt: '2026-11-17T02:00:00.000Z', matched: 3, sources: '最近 1 天的 1 次扫描' },
    topics: [],
    alerts: [],
    sov,
    calendar: calendarStatus(new Date('2026-11-17T12:00:00.000Z')),
    audit,
    history: [{ scannedAt: '2026-11-17T02:00:00.000Z', items: 120, matched: 3, errors: 0 }],
  })
  assert.ok(report.includes('# 方里 GEO 日报 · 2026-11-17'))
  for (const heading of ['一屏结论', '选题卡', '风险预警', '竞品声量', '公关日历', '基线审计', '近几次扫描', '口径与限制']) {
    assert.ok(report.includes(heading), `missing section: ${heading}`)
  }
  assert.ok(report.includes('不是 AI 答案里的份额'))
  assert.ok(report.includes('只覆盖一次扫描'))
})

test('repeated headlines across scans are counted once, and embedded headings nest', () => {
  const items = [
    { title: '方里粉饼适合干皮吗', rank: 1 },
    { title: '方里粉饼适合干皮吗？', rank: 2 },
    { title: '方里和花西子怎么选', rank: 3 },
  ]
  const unique = uniqueByTitle(items)
  assert.equal(unique.length, 2, 'the same headline from two scans counts once')

  const demoted = demoteHeadings('# 标题\n正文\n## 小节')
  assert.equal(demoted, '### 标题\n正文\n#### 小节')
})

test('the PR calendar covers the year and orders upcoming nodes by distance', () => {
  const status = calendarStatus(new Date('2026-11-17T12:00:00.000Z'), { horizonDays: 90 })
  assert.equal(status.month, 11)
  assert.ok(status.current.length >= 1, 'every month belongs to a node')
  assert.ok(status.current.some(node => node.theme === '双 11'))
  assert.ok(status.upcoming.length >= 1)
  const distances = status.upcoming.map(node => node.startsInDays)
  assert.deepEqual(distances, [...distances].sort((a, b) => a - b))
  assert.ok(status.upcoming.every(node => node.startsInDays > 0 && node.startsInDays <= 90))

  const annotated = annotateCalendar(status, [{ clusterId: 'price', count: 2 }])
  const priceWindow = annotated.nodes.find(node => node.theme === '双 11')
  assert.ok(priceWindow !== undefined)
  assert.ok(renderCalendarMarkdown(annotated).includes('公关日历窗口'))
})
