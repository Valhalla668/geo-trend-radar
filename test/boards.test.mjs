import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { buildAlerts, renderAlertsMarkdown, summarizeAlerts } from '../lib/alerts.js'
import { scoreItem } from '../lib/match.js'
import { buildSov, computeMentions, renderSovMarkdown } from '../lib/sov.js'
import { buildTopics, renderTopicsMarkdown, toQuestion } from '../lib/topics.js'

const PROMPTS_URL = new URL('../assets/prompts.json', import.meta.url)

const prompts = async () => JSON.parse(await readFile(PROMPTS_URL, 'utf8')).prompts

test('the sample prompt library covers all eight clusters', async () => {
  const list = await prompts()
  assert.equal(list.length, 20)
  const byCluster = {}
  for (const prompt of list) byCluster[prompt.cluster] = (byCluster[prompt.cluster] ?? 0) + 1
  assert.deepEqual(byCluster, { 品牌认知: 3, 品类推荐: 4, 肤质肤况: 4, 场景需求: 3, 产品决策: 3, 竞品对比: 1, 价格渠道: 1, 出海英文: 1 })
  assert.equal(list[0].id, 'P001')
  assert.ok(list.every(prompt => prompt.prompt.length > 0))
})

test('toQuestion turns a statement title into a question per cluster', () => {
  assert.equal(toQuestion({ title: '方里和花西子怎么选', cluster: { id: 'compare' }, entities: { competitors: [{ name: '花西子' }] } }), '方里和花西子怎么选？')
  assert.equal(toQuestion({ title: '夏天通勤底妆', cluster: { id: 'scene' }, clusters: [{ cues: ['通勤'] }] }), '通勤场景下底妆怎么选？')
  assert.equal(toQuestion({ title: '安全吗？', cluster: { id: 'category' } }), '安全吗？')
})

test('buildTopics produces ordered, deduplicated cards with an id and a prompt link', async () => {
  const list = await prompts()
  const items = [
    { ...scoreItem({ platform: 'zhihu', platformName: '知乎', rank: 2, title: '方里柔焦蜜粉饼适合油皮吗' }, { groups: [] }), scannedAt: '2026-11-17T01:00:00.000Z' },
    { ...scoreItem({ platform: 'zhihu', platformName: '知乎', rank: 3, title: '方里柔焦蜜粉饼适合油皮吗？' }, { groups: [] }), scannedAt: '2026-11-17T01:00:00.000Z' },
    { ...scoreItem({ platform: 'weibo', platformName: '微博', rank: 1, title: '花西子蜜粉饼上新，和方里怎么选' }, { groups: [] }), scannedAt: '2026-11-17T01:00:00.000Z' },
  ]
  const cards = buildTopics(items, { limit: 10, prompts: list })
  assert.equal(cards.length, 2, 'near-duplicate titles collapse')
  assert.ok(cards.every(card => /^GT-\d{8}-\d{3}$/u.test(card.id)))
  assert.ok(cards.every((card, index) => card.id.endsWith(`-${String(index + 1).padStart(3, '0')}`)))
  assert.equal(cards[0].priority, 'P0')
  assert.ok(cards.every(card => card.promptRef === null || card.promptRef.id.startsWith('P')))
  assert.ok(cards.some(card => card.promptRef !== null))
  const markdown = renderTopicsMarkdown(cards, { date: '2026-11-17', scannedAt: '2026-11-17 09:00' })
  assert.ok(markdown.includes('# GEO 选题卡'))
  assert.ok(markdown.includes('证据缺口'))
})

test('buildTopics caps one cluster so a single subject cannot fill the board', async () => {
  const list = await prompts()
  const items = Array.from({ length: 12 }, (_, index) => ({
    ...scoreItem({ platform: 'zhihu', platformName: '知乎', rank: index + 1, title: `敏感肌底妆问题编号${index}`, summary: '油皮 干皮 敏感肌 卡粉' }, { groups: [] }),
  }))
  const cards = buildTopics(items, { limit: 12, perCluster: 4, prompts: list })
  const skin = cards.filter(card => card.cluster === '肤质肤况')
  assert.ok(skin.length <= 4, `expected at most 4 skin cards, got ${skin.length}`)
})

test('alerts escalate brand-negative and medical claims, and stay empty on clean input', () => {
  const dirty = [
    scoreItem({ platform: 'weibo', platformName: '微博', rank: 1, title: '方里粉饼烂脸投诉，网友称假货' }),
    scoreItem({ platform: 'weibo', platformName: '微博', rank: 2, title: '某粉底液宣称治疗敏感肌' }),
  ]
  const alerts = buildAlerts(dirty)
  assert.ok(alerts.length >= 2)
  const brandAlert = alerts.find(alert => alert.ruleId === 'competitor-poisoning')
  assert.ok(brandAlert !== undefined)
  assert.equal(brandAlert.level, 'high')
  assert.equal(brandAlert.owner, '公关/法务')
  assert.ok(brandAlert.mitigation.length > 0)
  const claimAlert = alerts.find(alert => alert.ruleId === 'compliance-claim')
  assert.ok(claimAlert !== undefined)
  assert.ok(claimAlert.terms.includes('治疗'))

  const summary = summarizeAlerts(alerts)
  assert.equal(summary.total, alerts.length)
  assert.ok(summary.high >= 1)

  const clean = buildAlerts([scoreItem({ platform: 'zhihu', platformName: '知乎', rank: 5, title: '油皮粉底液怎么选' })])
  assert.equal(clean.length, 0)
  assert.ok(renderAlertsMarkdown([], { date: '2026-11-17' }).includes('未触发负面或合规信号'))
})

test('a trending brand question is a topic, not an entity-error alert', () => {
  const question = scoreItem({ platform: 'candidate', platformName: '客服', rank: 1, title: '方里是哪个公司的品牌？是国货吗？' })
  assert.equal(buildAlerts([question]).length, 0, 'a question is demand, not an error')

  const wrong = scoreItem({ platform: 'weibo', platformName: '微博', rank: 1, title: '网传方里成立于 2015 年，官方辟谣：成立时间写错了' })
  const alerts = buildAlerts([wrong])
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].ruleId, 'brand-hallucination')
  assert.equal(alerts[0].level, 'high')
})

test('computeMentions counts each brand once per item and keeps its platform', () => {
  const items = [
    { title: '方里和花西子怎么选', platformName: '知乎', platform: 'zhihu', rank: 1 },
    { title: '方里柔焦蜜粉饼测评', platformName: '微博', platform: 'weibo', rank: 2 },
    { title: '毛戈平粉膏上新', platformName: '微博', platform: 'weibo', rank: 3 },
    { title: '天气预警', platformName: '百度', platform: 'baidu', rank: 4 },
  ]
  const mentions = computeMentions(items)
  assert.equal(mentions.totalItems, 4)
  const self = mentions.brands.find(brand => brand.self === true)
  assert.equal(self.mentions, 2)
  assert.equal(self.byPlatform['知乎'], 1)
  assert.equal(self.byPlatform['微博'], 1)
  const rival = mentions.brands.find(brand => brand.name === '花西子')
  assert.equal(rival.mentions, 1)
  assert.equal(mentions.brands.some(brand => brand.name === '毛戈平'), true)
})

test('buildSov reports shares, self brand and the gap to the leader', () => {
  const now = new Date('2026-11-17T12:00:00.000Z')
  const snapshot = {
    scannedAt: '2026-11-17T02:00:00.000Z',
    mentions: computeMentions([
      { title: '方里柔焦蜜粉饼测评', platformName: '知乎', platform: 'zhihu', rank: 1 },
      { title: '花西子蜜粉饼上新', platformName: '微博', platform: 'weibo', rank: 2 },
      { title: '花西子官宣代言人', platformName: '微博', platform: 'weibo', rank: 3 },
    ]),
  }
  const sov = buildSov([snapshot], { days: 7, now })
  assert.equal(sov.window.scans, 1)
  assert.equal(sov.window.items, 3)
  assert.equal(sov.self.mentions, 1)
  assert.equal(sov.leader.name, '花西子')
  assert.equal(sov.self.share + sov.leader.share, 100)
  assert.ok(sov.gap > 0)
  const markdown = renderSovMarkdown(sov)
  assert.ok(markdown.includes('口径说明'))
  assert.ok(markdown.includes('| 品牌 |'))
})

test('buildSov reports an empty window without inventing numbers', () => {
  const sov = buildSov([], { days: 7, now: new Date('2026-11-17T12:00:00.000Z') })
  assert.equal(sov.window.scans, 0)
  assert.equal(sov.brands.length, 0)
  assert.equal(sov.self, null)
  assert.ok(renderSovMarkdown(sov).includes('还没有扫描记录'))
})
