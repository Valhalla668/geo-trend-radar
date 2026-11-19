/**
 * Report rendering — the deliverable half of §3.5 GEO Radar.
 *
 * Two shapes are produced from the same data:
 *   renderScanSummary  the short, model-facing digest returned by `geo_scan`
 *   renderReport       the daily / weekly Markdown a CMO can read as-is
 *
 * Both state the measurement window and the known limits, because the plan is
 * explicit that a proxy signal must never be reported as if it were AI share.
 */
import { renderAlertsMarkdown, summarizeAlerts } from './alerts.js'
import { computeMetrics } from './baseline.js'
import { renderCalendarMarkdown } from './calendar.js'
import { renderSovMarkdown } from './sov.js'
import { renderTopicsMarkdown } from './topics.js'

const rate = value => (value === null || value === undefined ? '—' : `${value}%`)

/** Count topics per priority. */
export function countTopics(cards) {
  const counts = { P0: 0, P1: 0, P2: 0 }
  for (const card of cards) {
    if (counts[card.priority] !== undefined) counts[card.priority] += 1
  }
  return counts
}

/**
 * Drop repeated headlines collected across several scans of the same window, so
 * a title that stayed on the list all day is counted once instead of once per scan.
 */
export function uniqueByTitle(items) {
  const seen = new Map()
  for (const item of items) {
    const key = String(item.title ?? '').replace(/[\s\p{P}]/gu, '')
    if (!seen.has(key)) seen.set(key, item)
  }
  return [...seen.values()]
}

/**
 * Push embedded section headings two levels down so they sit under the report's
 * own `##` sections instead of competing with them.
 */
export function demoteHeadings(markdown) {
  return String(markdown ?? '')
    .split('\n')
    .map(line => (/^#{1,4}\s/u.test(line) ? `##${line}` : line))
    .join('\n')
}

/** Cluster volume, used to mark calendar windows as hot. */
export function clusterVolume(cards) {
  const map = new Map()
  for (const card of cards) {
    map.set(card.clusterId, (map.get(card.clusterId) ?? 0) + 1)
  }
  return [...map.entries()].map(([clusterId, count]) => ({ clusterId, count })).sort((a, b) => b.count - a.count)
}

/** Short digest returned to the model after a scan. */
export function renderScanSummary({ snapshot, topics, alerts, sov, calendar, platforms }) {
  const lines = []
  const topicCounts = countTopics(topics)
  const alertSummary = summarizeAlerts(alerts)
  lines.push(`## GEO 雷达扫描 · ${snapshot.scannedAt.slice(0, 16).replace('T', ' ')}`)
  lines.push('')
  lines.push(`- 采集：${snapshot.platformOk}/${snapshot.platformTotal} 个平台成功，共 ${snapshot.items} 条热榜，命中相关 ${snapshot.matched} 条`)
  if ((snapshot.candidates ?? 0) > 0) lines.push(`- 候选问题：${snapshot.candidates} 条（客服 / 站内搜索 / 竞品动态，绕过热榜锚点闸门）`)
  if (snapshot.errors.length > 0) {
    const shown = snapshot.errors.slice(0, 3).map(entry => `${entry.name}（${entry.message}）`).join('；')
    const extra = snapshot.errors.length > 3 ? ` 等 ${snapshot.errors.length} 个平台` : ''
    lines.push(`- 失败平台：${shown}${extra}`)
  }
  lines.push(`- 选题卡：${topics.length} 张（P0 ${topicCounts.P0} / P1 ${topicCounts.P1} / P2 ${topicCounts.P2}）`)
  lines.push(`- 风险预警：${alertSummary.total} 条（高 ${alertSummary.high} / 中 ${alertSummary.medium} / 低 ${alertSummary.low}）`)
  const self = sov.self
  lines.push(`- 声量：方里近 ${sov.window.days} 天公开热榜提及 ${self?.mentions ?? 0} 次，份额 ${rate(self?.share)}${sov.leader === null ? '' : `；最高竞品 ${sov.leader.name} ${rate(sov.leader.share)}`}`)
  if (calendar.current.length > 0) lines.push(`- 节点：当前处于「${calendar.current.map(node => node.theme).join('、')}」窗口`)
  lines.push('')
  if (topics.length > 0) {
    lines.push('### 优先处理')
    for (const card of topics.slice(0, 5)) {
      lines.push(`${card.id} · ${card.priority} · ${card.cluster} · ${card.question}（${card.source.platform} 第 ${card.source.rank} 位，${card.score} 分）`)
    }
    lines.push('')
  }
  if (alerts.length > 0) {
    lines.push('### 需要今天看一眼')
    for (const alert of alerts.slice(0, 4)) {
      lines.push(`[${alert.levelLabel}] ${alert.rule}：${alert.title}`)
    }
    lines.push('')
  }
  lines.push(`平台明细：${platforms.map(entry => `${entry.name} ${entry.accepted}`).join('、')}`)
  return lines.join('\n')
}

/**
 * Full daily / weekly report.
 * @param {object} input
 */
export function renderReport(input) {
  const {
    period = 'daily',
    date = new Date(),
    snapshot,
    topics = [],
    alerts = [],
    sov,
    calendar,
    audit,
    history = [],
  } = input
  const metrics = audit === null || audit === undefined ? null : computeMetrics(audit)
  const topicCounts = countTopics(topics)
  const alertSummary = summarizeAlerts(alerts)
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const title = period === 'weekly' ? `方里 GEO 周报 · ${stamp}` : `方里 GEO 日报 · ${stamp}`
  const lines = [`# ${title}`, '']

  lines.push('## 一屏结论')
  lines.push(`- 公开热榜命中 ${snapshot.matched} 条，产出 ${topics.length} 张选题卡（P0 ${topicCounts.P0} 张）`)
  lines.push(`- 风险信号 ${alertSummary.total} 条，其中高危 ${alertSummary.high} 条`)
  const self = sov?.self ?? null
  lines.push(`- 方里公开声量份额 ${rate(self?.share)}（近 ${sov?.window.days ?? 0} 天${self === null ? '' : `，${self.mentions} 次提及`}）`)
  if (metrics !== null) {
    lines.push(`- T0 基线进度 ${metrics.audited}/${metrics.total}，提及率 ${rate(metrics.mentionRate)}，首选率 ${rate(metrics.firstChoiceRate)}`)
  } else {
    lines.push('- T0 基线尚未建立，先用 `geo_baseline` 的 `init` 生成审计网格')
  }
  if (sov?.window?.scans !== undefined && sov.window.scans <= 1) {
    lines.push('- 注意：当前窗口只覆盖一次扫描，环比数据还不具备可比性')
  }
  lines.push('')

  lines.push('## 二、选题卡')
  lines.push(demoteHeadings(renderTopicsMarkdown(topics, { date: stamp, scannedAt: snapshot.scannedAt.slice(0, 16).replace('T', ' '), sources: snapshot.sources })))
  lines.push('')

  lines.push('## 三、风险预警')
  lines.push(demoteHeadings(renderAlertsMarkdown(alerts, { date: stamp })))
  lines.push('')

  if (sov !== undefined && sov !== null) {
    lines.push('## 四、竞品声量')
    lines.push(demoteHeadings(renderSovMarkdown(sov)))
    lines.push('')
  }

  if (calendar !== undefined && calendar !== null) {
    lines.push('## 五、公关日历')
    lines.push(demoteHeadings(renderCalendarMarkdown(calendar)))
    lines.push('')
  }

  if (metrics !== null) {
    lines.push('## 六、基线审计')
    lines.push(`- 已采集 ${metrics.audited} / ${metrics.total}（${rate(metrics.coverage)}）`)
    lines.push(`- 提及率 ${rate(metrics.mentionRate)}｜首选率 ${rate(metrics.firstChoiceRate)}｜引用率 ${rate(metrics.citationRate)}｜事实准确率 ${rate(metrics.factAccuracy)}｜负面 ${rate(metrics.negativeRate)}`)
    if (metrics.byEngine.length > 0) {
      lines.push(`- 分引擎提及率：${metrics.byEngine.map(entry => `${entry.label} ${rate(entry.mentionRate)}`).join('；')}`)
    }
    lines.push('')
  }

  if (history.length > 0) {
    lines.push('## 七、近几次扫描')
    for (const entry of history.slice(0, 5)) {
      lines.push(`- ${entry.scannedAt.slice(0, 16).replace('T', ' ')}：热榜 ${entry.items} 条，命中 ${entry.matched} 条，失败 ${entry.errors} 个平台`)
    }
    lines.push('')
  }

  lines.push('## 口径与限制')
  lines.push('- 「声量份额」是公开热榜提及占比，是 AI 声量份额的公开信号代理，不是 AI 答案里的份额。')
  lines.push('- 「提及率 / 首选率 / 引用率 / 事实准确率」只在 T0 基线录入答案后才有值，且以人工核查为准。')
  lines.push('- 热榜为各平台公开榜单，不含付费投放数据；链接与标题按采集时点快照，可能已变化。')
  lines.push('- 选题卡为规则初筛，优先级与证据缺口需内容策略确认后再进入起草车间。')
  return lines.join('\n').trimEnd()
}
