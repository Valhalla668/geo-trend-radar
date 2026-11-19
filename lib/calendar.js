/**
 * PR-calendar coupling — §3.4.
 *
 * The master plan fixes a year of nodes, but a node only becomes a GEO window if
 * questions about it are being asked right now. This module reports where today
 * sits on that calendar, which node opens next, and what to draft for it.
 * The comparison to live hot-list volume is done by the caller (`geo_scan`),
 * which passes the matched clusters so the window can be marked hot or quiet.
 */
import { CALENDAR, CLUSTER_BY_ID } from './lexicon.js'

const MONTH_MS = 1000 * 60 * 60 * 24

/** Days from `from` to the first day of `month` in the next occurrence. */
function daysUntilMonthStart(from, month) {
  const year = from.getMonth() + 1 <= month ? from.getFullYear() : from.getFullYear() + 1
  const target = new Date(year, month - 1, 1, 0, 0, 0, 0)
  const diff = target.getTime() - from.getTime()
  return Math.round(diff / MONTH_MS)
}

/** Which nodes cover the given month, and which start within the horizon. */
export function calendarStatus(date = new Date(), options = {}) {
  const { horizonDays = 60 } = options
  const month = date.getMonth() + 1
  const current = CALENDAR.filter(node => node.months.includes(month))
  const upcoming = []
  for (const node of CALENDAR) {
    if (node.months.includes(month)) continue
    const soonest = node.months
      .map(nodeMonth => ({ month: nodeMonth, days: daysUntilMonthStart(date, nodeMonth) }))
      .sort((a, b) => a.days - b.days)[0]
    if (soonest === undefined || soonest.days > horizonDays) continue
    upcoming.push({
      id: node.id,
      theme: node.theme,
      content: node.content,
      engines: node.engines,
      months: node.months,
      startsInDays: soonest.days,
    })
  }
  upcoming.sort((a, b) => a.startsInDays - b.startsInDays)

  const all = [
    ...current.map(node => ({
      id: node.id,
      theme: node.theme,
      content: node.content,
      engines: node.engines,
      clusters: node.clusters.map(id => CLUSTER_BY_ID[id]?.name ?? id),
      phase: 'current',
      startsInDays: 0,
    })),
    ...upcoming.map(node => ({ ...node, phase: 'upcoming' })),
  ]

  return {
    today: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    month,
    current: all.filter(node => node.phase === 'current'),
    upcoming: all.filter(node => node.phase === 'upcoming'),
    nodes: all,
  }
}

/**
 * Mark each node as hot when recent scans contain its clusters.
 * @param {object} status - result of `calendarStatus`
 * @param {Array<{clusterId: string, count: number}>} clusterVolume
 */
export function annotateCalendar(status, clusterVolume = []) {
  const volumeOf = clusterId => clusterVolume.find(entry => entry.clusterId === clusterId)?.count ?? 0
  return {
    ...status,
    nodes: status.nodes.map(node => {
      const clusters = Array.isArray(node.clusters) ? node.clusters : []
      const hot = clusters.some(name => {
        const entry = Object.values(CLUSTER_BY_ID).find(cluster => cluster.name === name)
        return entry !== undefined && volumeOf(entry.id) > 0
      })
      return { ...node, hot }
    }),
  }
}

/** Markdown rendering for the report and the tool view. */
export function renderCalendarMarkdown(status) {
  const lines = [`# 公关日历窗口 · ${status.today}`, '']
  if (status.current.length === 0) {
    lines.push('当前月份没有固定节点；按 §3.4 的常态节奏做周更答案资产与月度复测。')
  } else {
    lines.push('## 进行中的节点')
    for (const node of status.current) {
      lines.push(`- **${node.theme}**：${node.content}`)
      lines.push(`  - 重点引擎：${node.engines.join('、')}　关联内容簇：${node.clusters.join('、')}${node.hot === true ? '　🔥 热榜已有对应讨论' : ''}`)
    }
  }
  lines.push('')
  if (status.upcoming.length === 0) {
    lines.push('未来 60 天没有日历节点需要提前准备。')
  } else {
    lines.push('## 即将开启')
    for (const node of status.upcoming) {
      lines.push(`- **${node.theme}**（${node.startsInDays} 天后）：${node.content}`)
      lines.push(`  - 重点引擎：${node.engines.join('、')}`)
    }
  }
  return lines.join('\n').trimEnd()
}
