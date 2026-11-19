/**
 * Public hot-list collection.
 *
 * The data source is the same `newsnow` API that TrendRadar (sansan0/TrendRadar)
 * reads through `platforms.api_url`, so this plugin reports the same hot lists
 * without requiring a TrendRadar deployment. The platform ids and expected
 * domains below are copied from TrendRadar's `config/config.yaml`.
 *
 * TrendRadar asks its users to be considerate of the shared endpoint, so the
 * collector fetches platforms sequentially with a delay, sends a browser user
 * agent (the endpoint rejects bot user agents), and never retries in a loop.
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** Default newsnow endpoint; override with config `apiUrl` for a self-hosted instance. */
export const DEFAULT_API_URL = 'https://newsnow.busiyi.world/api/s'

/** Platform ids and names from TrendRadar `config/config.yaml`. */
export const SOURCE_CATALOG = [
  { id: 'toutiao', name: '今日头条', expectedDomain: 'toutiao.com' },
  { id: 'baidu', name: '百度热搜', expectedDomain: 'baidu.com' },
  { id: 'wallstreetcn-hot', name: '华尔街见闻', expectedDomain: 'wallstreetcn.com' },
  { id: 'thepaper', name: '澎湃新闻', expectedDomain: 'thepaper.cn' },
  { id: 'bilibili-hot-search', name: 'bilibili 热搜', expectedDomain: 'bilibili.com' },
  { id: 'cls-hot', name: '财联社热门', expectedDomain: 'cls.cn' },
  { id: 'ifeng', name: '凤凰网', expectedDomain: 'ifeng.com' },
  { id: 'tieba', name: '贴吧', expectedDomain: 'baidu.com' },
  { id: 'weibo', name: '微博', expectedDomain: 'weibo.com' },
  { id: 'douyin', name: '抖音', expectedDomain: 'douyin.com' },
  { id: 'zhihu', name: '知乎', expectedDomain: 'zhihu.com' },
]

/** Platforms used when the caller names none: the ones that carry consumer beauty talk. */
export const DEFAULT_PLATFORMS = ['zhihu', 'weibo', 'douyin', 'baidu', 'toutiao', 'bilibili-hot-search']

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Resolve a platform id to its catalog entry. */
export function platformInfo(id) {
  return SOURCE_CATALOG.find(entry => entry.id === id) ?? { id, name: id, expectedDomain: undefined }
}

/**
 * Turn an upstream error body into one readable line.
 * newsnow answers with a JSON envelope whose `message` explains the failure, so
 * the raw body is never worth showing in full.
 */
export function describeHttpFailure(status, text) {
  const raw = String(text ?? '')
  let detail = raw
  try {
    const parsed = JSON.parse(raw)
    detail = [parsed?.statusMessage, parsed?.message].filter(value => typeof value === 'string' && value.length > 0).join(' · ') || raw
  } catch {
    /* not a JSON envelope */
  }
  const cleaned = detail.replace(/\s+/gu, ' ').trim()
  const shortened = cleaned.length > 96 ? `${cleaned.slice(0, 96)}…` : cleaned
  return `HTTP ${status}${shortened.length === 0 ? '' : ` · ${shortened}`}`
}

/** Minimal HTTPS GET returning parsed JSON.
 * Implemented on `node:https` so the plugin needs no global `fetch` and no
 * dependency, and so redirects and timeouts behave the same on every runtime.
 */
export function requestJson(url, options = {}) {
  const { ua = DEFAULT_UA, timeoutMs = 15_000, accept = 'application/json' } = options
  return new Promise((resolve, reject) => {
    const attempt = (target, hops) => {
      let parsed
      try {
        parsed = new URL(target)
      } catch {
        reject(new Error(`无效的地址：${target}`))
        return
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        reject(new Error(`只支持 http(s)：${target}`))
        return
      }
      const mod = parsed.protocol === 'https:' ? httpsRequest : httpRequest
      const req = mod(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port === '' ? undefined : parsed.port,
          path: `${parsed.pathname}${parsed.search}`,
          method: 'GET',
          headers: {
            'user-agent': ua,
            accept,
            'accept-encoding': 'identity',
            'accept-language': 'zh-CN,zh;q=0.9',
          },
        },
        res => {
          const status = res.statusCode ?? 0
          if (status >= 300 && status < 400 && res.headers.location !== undefined && hops > 0) {
            res.resume()
            attempt(new URL(res.headers.location, target).toString(), hops - 1)
            return
          }
          const chunks = []
          res.on('data', chunk => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            if (status < 200 || status >= 300) {
              reject(new Error(describeHttpFailure(status, text)))
              return
            }
            try {
              resolve(JSON.parse(text))
            } catch {
              reject(new Error(`返回内容不是 JSON：${text.slice(0, 120)}`))
            }
          })
        },
      )
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`请求超时（${timeoutMs}ms）`))
      })
      req.on('error', reject)
      req.end()
    }
    attempt(url, 3)
  })
}

/** Build the hot-list URL for one platform. */
export function platformUrl(apiUrl, platformId) {
  const base = typeof apiUrl === 'string' && apiUrl.trim().length > 0 ? apiUrl.trim() : DEFAULT_API_URL
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}id=${encodeURIComponent(platformId)}`
}

/** Drop tracking parameters so the same story on two runs dedupes. */
export function canonicalUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  try {
    const url = new URL(value)
    const drop = ['band_rank', 'refer', 't', 'c', 's', 'from', 'spm', 'share_token', 'timestamp', 'traceid']
    for (const key of [...url.searchParams.keys()]) {
      if (drop.includes(key.toLowerCase())) url.searchParams.delete(key)
    }
    url.hash = ''
    return url.toString().toLowerCase()
  } catch {
    return value.trim().toLowerCase()
  }
}

/** Accept a link only when it matches the platform's expected domain, like TrendRadar. */
export function domainAllowed(url, expectedDomain) {
  if (typeof expectedDomain !== 'string' || expectedDomain.length === 0) return true
  if (typeof url !== 'string' || url.length === 0) return true
  try {
    const host = new URL(url).hostname.toLowerCase()
    const wanted = expectedDomain.toLowerCase()
    return host === wanted || host.endsWith(`.${wanted}`)
  } catch {
    return false
  }
}

/** Normalize one raw newsnow item into the plugin's shape. */
export function normalizeItem(raw, platformId, rank) {
  const extra = raw !== null && typeof raw === 'object' && raw.extra !== null && typeof raw.extra === 'object' ? raw.extra : {}
  const url = typeof raw?.url === 'string' && raw.url.length > 0
    ? raw.url
    : typeof raw?.mobileUrl === 'string' && raw.mobileUrl.length > 0
      ? raw.mobileUrl
      : ''
  return {
    platform: platformId,
    platformName: platformInfo(platformId).name,
    rank: typeof raw?.rank === 'number' ? raw.rank : rank,
    title: String(raw?.title ?? '').trim(),
    url,
    hot: typeof extra.info === 'string' ? extra.info : '',
    summary: typeof extra.hover === 'string' ? extra.hover : '',
    id: raw?.id === undefined ? '' : String(raw.id),
  }
}

/**
 * Collect hot lists for the given platforms.
 * @returns {Promise<{items: object[], platforms: object[], errors: object[], fetchedAt: string}>}
 */
export async function collectHotlists(options = {}) {
  const {
    platforms = DEFAULT_PLATFORMS,
    apiUrl = DEFAULT_API_URL,
    intervalMs = 600,
    timeoutMs = 15_000,
    ua = DEFAULT_UA,
    fetcher = requestJson,
    now = () => new Date(),
  } = options

  const items = []
  const platformReports = []
  const errors = []
  const seen = new Set()
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  for (const [index, platformId] of platforms.entries()) {
    const info = platformInfo(platformId)
    if (index > 0 && intervalMs > 0) await sleep(intervalMs)
    try {
      const payload = await fetcher(platformUrl(apiUrl, platformId), { ua, timeoutMs })
      const rawItems = Array.isArray(payload?.items) ? payload.items : []
      let accepted = 0
      let rejected = 0
      for (const [offset, raw] of rawItems.entries()) {
        const item = normalizeItem(raw, platformId, offset + 1)
        if (item.title.length === 0) continue
        if (!domainAllowed(item.url, info.expectedDomain)) {
          rejected++
          continue
        }
        const key = canonicalUrl(item.url) || `${platformId}:${item.title}`
        if (seen.has(key)) continue
        seen.add(key)
        items.push(item)
        accepted++
      }
      platformReports.push({
        id: platformId,
        name: info.name,
        status: typeof payload?.status === 'string' ? payload.status : 'ok',
        updatedTime: typeof payload?.updatedTime === 'number' ? payload.updatedTime : null,
        accepted,
        rejected,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push({ platform: platformId, name: info.name, message })
      platformReports.push({ id: platformId, name: info.name, status: 'error', accepted: 0, rejected: 0, message })
    }
  }

  return {
    items,
    platforms: platformReports,
    errors,
    fetchedAt: now().toISOString(),
    apiUrl: apiUrl.length > 0 ? apiUrl : DEFAULT_API_URL,
  }
}
