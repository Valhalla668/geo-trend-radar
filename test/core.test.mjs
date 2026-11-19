import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLUSTERS, DEFAULT_KEYWORD_GROUPS, ENGINES, ENTITY } from '../lib/lexicon.js'
import {
  classifyClusters,
  detectCompliance,
  detectEntities,
  detectNegative,
  hasDomainAnchor,
  matchItems,
  matchKeywordGroups,
  mergeScored,
  parseKeywordGroups,
  pickCluster,
  scoreItem,
} from '../lib/match.js'

test('lexicon ships an example brand without any personal or registration data', () => {
  assert.equal(ENTITY.brand, '方里 FUNNY ELVES')
  assert.ok(ENTITY.brandAliases.includes('方里'))
  assert.equal(ENTITY.positioning, '亚洲专研底妆品牌')
  assert.equal(ENTITY.coreProducts.length, 3)
  for (const removed of ['legalName', 'creditCode', 'legalRepresentative', 'founded']) {
    assert.equal(ENTITY[removed], undefined, `${removed} must not ship in the public repository`)
  }
  assert.deepEqual(ENTITY.parentAliases, [])
  assert.deepEqual(ENTITY.founderAliases, [])
  assert.equal(ENGINES.length, 6)
  assert.equal(CLUSTERS.length, 8)
  assert.ok(CLUSTERS.every(cluster => cluster.assets > 0))
})

test('keyword parser reads groups, literals and regular expressions', () => {
  const parsed = parseKeywordGroups(DEFAULT_KEYWORD_GROUPS)
  assert.ok(parsed.groups.length >= 6)
  assert.deepEqual(parsed.warnings, [])
  const brand = parsed.groups.find(group => group.name === '品牌')
  assert.ok(brand !== undefined)
  const labels = brand.terms.map(term => term.label)
  assert.ok(labels.includes('方里'))
  assert.ok(labels.includes('FUNNY ELVES'))
  const competitor = parsed.groups.find(group => group.name === '竞品')
  assert.ok(competitor.terms.some(term => term.type === 'regex' && term.label === 'blankme'))
})

test('keyword parser reports an invalid regular expression instead of throwing', () => {
  const parsed = parseKeywordGroups('[坏组]\n/[/\n方里')
  assert.equal(parsed.warnings.length, 1)
  assert.equal(parsed.groups[0].terms.length, 1)
  assert.equal(parsed.groups[0].terms[0].value, '方里')
})

test('keyword groups match a title across groups', () => {
  const parsed = parseKeywordGroups(DEFAULT_KEYWORD_GROUPS)
  const hits = matchKeywordGroups('方里柔焦蜜粉饼和花西子哪个好', parsed.groups)
  const names = hits.map(hit => hit.group)
  assert.ok(names.includes('品牌'))
  assert.ok(names.includes('竞品'))
  assert.ok(names.includes('品类'))
})

test('entity detection separates brand, related parties and competitors', () => {
  const brand = detectEntities('方里是国货底妆品牌')
  assert.equal(brand.isBrand, true)
  assert.equal(brand.mentionsEntity, true)
  assert.deepEqual(brand.founderHits, [], 'no founder names ship by default')
  assert.deepEqual(brand.parentHits, [], 'no parent company ships by default')

  const rival = detectEntities('花西子新品官宣')
  assert.equal(rival.isBrand, false)
  assert.equal(rival.isCompetitor, true)
  assert.deepEqual(rival.competitors.map(entry => entry.name), ['花西子'])
  assert.deepEqual(rival.competitors[0].actions, ['官宣'])
})

test('cluster routing prefers the rival comparison cluster when a comparison word is present', () => {
  const entities = detectEntities('方里和花西子怎么选')
  const cluster = pickCluster('方里和花西子怎么选', entities)
  assert.equal(cluster.id, 'compare')

  const skin = classifyClusters('敏感肌夏天用方里会闷痘吗')
  assert.equal(skin[0].id, 'skin')
})

test('compliance and negative vocabulary fire on the red-line terms', () => {
  const compliance = detectCompliance('这款粉底液治疗敏感肌，零毛孔，永久不脱妆')
  assert.ok(compliance.medical.includes('治疗'))
  assert.ok(compliance.absolute.includes('零毛孔'))
  assert.ok(compliance.absolute.includes('永久'))
  assert.ok(detectNegative('用户投诉方里烂脸，疑似假货').length >= 2)
})

test('scoring promotes a brand hit in a high-value cluster to P0 and explains why', () => {
  const item = { platform: 'zhihu', platformName: '知乎', rank: 3, title: '方里柔焦蜜粉饼适合油皮吗', url: '', hot: '100 万热度' }
  const scored = scoreItem(item, { groups: [] })
  assert.equal(scored.cluster.id, 'skin')
  assert.equal(scored.priority, 'P0')
  assert.ok(scored.score > 50)
  assert.ok(scored.reasons.some(reason => reason.includes('提及方里')))
  assert.ok(scored.evidenceGap.includes('A 级证据'))
  assert.equal(scored.product.name, '方里柔焦蜜粉饼')
})

test('a competitor mention without a brand hit still scores above an unrelated item', () => {
  const competitor = scoreItem({ platform: 'weibo', rank: 10, title: '花西子蜜粉饼上新' }, { groups: [] })
  const unrelated = scoreItem({ platform: 'weibo', rank: 10, title: '某地发布暴雨预警' }, { groups: [] })
  assert.ok(competitor.score > unrelated.score)
  assert.equal(competitor.entities.isCompetitor, true)
  assert.equal(unrelated.entities.isCompetitor, false)
})

test('matchItems drops unrelated trending news and keeps GEO-relevant hits', () => {
  const items = [
    { platform: 'weibo', rank: 1, title: '方里特护粉底液敏感肌实测' },
    { platform: 'weibo', rank: 2, title: '花西子官宣新代言人' },
    { platform: 'weibo', rank: 3, title: '新能源汽车销量创新高' },
    { platform: 'zhihu', rank: 4, title: '油皮夏天用什么粉底液不脱妆' },
  ]
  const matched = matchItems(items, { groups: [], limit: 10 })
  const titles = matched.map(entry => entry.title)
  assert.ok(titles.includes('方里特护粉底液敏感肌实测'))
  assert.ok(titles.includes('花西子官宣新代言人'))
  assert.ok(titles.includes('油皮夏天用什么粉底液不脱妆'))
  assert.ok(!titles.includes('新能源汽车销量创新高'))
})

test('the anchor gate needs a beauty or skin word, not just a season word', () => {
  assert.equal(hasDomainAnchor('冬天羽绒服怎么选'), false)
  assert.equal(hasDomainAnchor('敏感肌换季泛红'), true, 'a skin word is enough')
  assert.equal(hasDomainAnchor('冬天底妆怎么不卡粉'), true)

  const seasonal = matchItems([
    { platform: 'baidu', rank: 1, title: '冬天羽绒服怎么选' },
    { platform: 'baidu', rank: 2, title: '开学前家长需要准备什么' },
    { platform: 'baidu', rank: 3, title: '敏感肌换季怎么选底妆' },
  ], { groups: [], limit: 10 })
  assert.deepEqual(seasonal.map(entry => entry.title), ['敏感肌换季怎么选底妆'])
})

test('operator candidates bypass the anchor gate and merge without duplicates', () => {
  const pool = [
    { platform: '客服', platformName: '客服', rank: 1, title: '色号怎么挑' },
    { platform: '站内搜索', platformName: '站内搜索', rank: 2, title: '方里粉饼会卡粉吗' },
  ]
  const forced = matchItems(pool, { groups: [], limit: 10, requireAnchor: false })
  assert.equal(forced.length, 2, 'an explicit ask is scored even without an anchor')
  const gated = matchItems(pool, { groups: [], limit: 10 })
  assert.ok(gated.length < forced.length, 'the same titles are not all hot-list relevant')

  const merged = mergeScored([forced, gated], 10)
  assert.equal(merged.length, 2, 'the same headline is kept once')
  assert.ok(merged.every((entry, index) => index === 0 || merged[index - 1].score >= entry.score))
})
