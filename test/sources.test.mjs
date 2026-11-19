import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canonicalUrl,
  collectHotlists,
  DEFAULT_API_URL,
  domainAllowed,
  normalizeItem,
  platformInfo,
  platformUrl,
  SOURCE_CATALOG,
} from '../lib/hotlist.js'

test('the source catalog mirrors TrendRadar platform ids and domains', () => {
  const ids = SOURCE_CATALOG.map(entry => entry.id)
  for (const expected of ['zhihu', 'weibo', 'douyin', 'baidu', 'toutiao', 'bilibili-hot-search']) {
    assert.ok(ids.includes(expected), `missing platform ${expected}`)
  }
  assert.equal(platformInfo('zhihu').name, '知乎')
  assert.equal(platformInfo('weibo').expectedDomain, 'weibo.com')
  assert.equal(platformInfo('unknown-platform').name, 'unknown-platform')
})

test('platform URLs target the configured endpoint', () => {
  assert.equal(platformUrl('', 'zhihu'), `${DEFAULT_API_URL}?id=zhihu`)
  assert.equal(platformUrl('https://mirror.example.com/api/s', 'weibo'), 'https://mirror.example.com/api/s?id=weibo')
  assert.equal(platformUrl('https://mirror.example.com/api/s?token=1', 'douyin'), 'https://mirror.example.com/api/s?token=1&id=douyin')
})

test('canonical URLs drop tracking parameters so re-runs dedupe', () => {
  const raw = 'https://s.weibo.com/weibo?q=%23%E6%96%B9%E9%87%8C%23&t=31&band_rank=1&Refer=top'
  const clean = canonicalUrl(raw)
  assert.ok(!clean.includes('band_rank'))
  assert.ok(!clean.includes('Refer='))
  assert.ok(!clean.includes('t=31'))
  assert.equal(canonicalUrl(raw), clean)
  assert.equal(canonicalUrl(''), '')
})

test('domain validation follows the expected domain and its subdomains', () => {
  assert.equal(domainAllowed('https://s.weibo.com/weibo?q=x', 'weibo.com'), true)
  assert.equal(domainAllowed('https://weibo.com/x', 'weibo.com'), true)
  assert.equal(domainAllowed('https://evil.example.com/x', 'weibo.com'), false)
  assert.equal(domainAllowed('not a url', 'weibo.com'), false)
  assert.equal(domainAllowed('https://anything.example/', undefined), true)
})

test('normalizeItem prefers the full URL and keeps the hotness note', () => {
  const item = normalizeItem({ id: 7, title: ' 方里测评 ', url: 'https://a.example/x', extra: { info: '573 万热度', hover: '摘要' } }, 'zhihu', 3)
  assert.equal(item.title, '方里测评')
  assert.equal(item.url, 'https://a.example/x')
  assert.equal(item.hot, '573 万热度')
  assert.equal(item.summary, '摘要')
  assert.equal(item.rank, 3)
  assert.equal(item.platformName, '知乎')

  const mobile = normalizeItem({ title: 't', mobileUrl: 'https://m.example/y' }, 'weibo', 1)
  assert.equal(mobile.url, 'https://m.example/y')
})

test('collectHotlists deduplicates across platforms and records failures', async () => {
  const shared = 'https://www.baidu.com/s?wd=%E6%96%B9%E9%87%8C&band_rank=2&t=31'
  const payloads = {
    baidu: { status: 'cache', updatedTime: 1, items: [{ title: '方里粉饼测评', url: 'https://www.baidu.com/s?wd=1' }, { title: '重复条目', url: shared }] },
    tieba: { status: 'cache', updatedTime: 2, items: [{ title: '方里吧讨论', url: 'https://tieba.baidu.com/p/1' }, { title: '重复条目另一平台', url: 'https://www.baidu.com/s?wd=%E6%96%B9%E9%87%8C&t=31' }] },
  }
  const fetcher = async url => {
    const id = new URL(url).searchParams.get('id')
    if (id === 'douyin') throw new Error('HTTP 403：blocked')
    const payload = payloads[id]
    if (payload === undefined) throw new Error(`unexpected platform ${id}`)
    return payload
  }
  const result = await collectHotlists({ platforms: ['baidu', 'tieba', 'douyin'], intervalMs: 0, fetcher })
  assert.equal(result.items.length, 3, 'the same story on two platforms is stored once')
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].platform, 'douyin')
  assert.ok(result.errors[0].message.includes('403'))
  const douyin = result.platforms.find(entry => entry.id === 'douyin')
  assert.equal(douyin.status, 'error')
  assert.equal(result.platforms.filter(entry => entry.status !== 'error').length, 2)
  assert.ok(result.items.every(item => item.title.length > 0))
  assert.equal(result.apiUrl, DEFAULT_API_URL)
})

test('collectHotlists drops links outside the platform expected domain', async () => {
  const fetcher = async () => ({ items: [{ title: '站外链接', url: 'https://hijack.example/x' }, { title: '站内链接', url: 'https://www.zhihu.com/question/1' }] })
  const result = await collectHotlists({ platforms: ['zhihu'], intervalMs: 0, fetcher })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].title, '站内链接')
  assert.equal(result.platforms[0].rejected, 1)
})
