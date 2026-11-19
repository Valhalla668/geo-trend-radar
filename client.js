/**
 * Web half of the GEO radar bundle.
 *
 * Every `geo_*` tool returns a Markdown digest plus one compact JSON block
 * tagged `kind: "geo.view"`. The Host view is registered per tool name in the
 * `tool.call.toolview` slot, so the conversation shows a dashboard while the
 * model still reads the digest. Nothing here fetches data: the card renders the
 * result the tool already produced.
 */
window.__ModuleLoader__.load({
  id: '@local/geo-trend-radar',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState } = React

    const NS = 'geoRadar'

    const DICT = {
      zh: {
        running: '正在运行 GEO 雷达',
        preparing: '准备参数',
        empty: '没有可渲染的雷达数据',
        scanned: '扫描时间',
        items: '热榜条目',
        matched: '命中',
        topics: '选题卡',
        alerts: '风险预警',
        high: '高危',
        platforms: '平台',
        priority: '优先级',
        cluster: '内容簇',
        product: '产品',
        format: '形态',
        score: '分数',
        source: '来源',
        share: '份额',
        mentions: '提及',
        window: '窗口',
        days: '天',
        scans: '次扫描',
        gap: '与最高竞品差距',
        progress: '采集进度',
        coverage: '覆盖率',
        mentionRate: '提及率',
        firstChoiceRate: '首选率',
        citationRate: '引用率',
        factAccuracy: '事实准确率',
        negativeRate: '负面率',
        remaining: '剩余',
        hotWindow: '热榜已有讨论',
        current: '进行中',
        upcoming: '即将开启',
        expand: '展开',
        collapse: '收起',
        owner: '责任人',
        terms: '命中词',
        exportPath: '已写入',
        probe: '连通性',
        noData: '本次没有命中与方里、竞品或底妆品类相关的热点',
        proxyNote: 'SOV 为公开热榜提及份额，是 AI 声量份额的公开信号代理',
        engine: '引擎',
      },
      en: {
        running: 'Running GEO radar',
        preparing: 'Preparing arguments',
        empty: 'No radar payload to render',
        scanned: 'Scanned',
        items: 'Hot-list items',
        matched: 'Matched',
        topics: 'Topic cards',
        alerts: 'Risk alerts',
        high: 'High',
        platforms: 'Platforms',
        priority: 'Priority',
        cluster: 'Cluster',
        product: 'Product',
        format: 'Format',
        score: 'Score',
        source: 'Source',
        share: 'Share',
        mentions: 'Mentions',
        window: 'Window',
        days: 'days',
        scans: 'scans',
        gap: 'Gap to leader',
        progress: 'Collection progress',
        coverage: 'Coverage',
        mentionRate: 'Mention rate',
        firstChoiceRate: 'First-choice rate',
        citationRate: 'Citation rate',
        factAccuracy: 'Fact accuracy',
        negativeRate: 'Negative rate',
        remaining: 'Remaining',
        hotWindow: 'Already trending',
        current: 'Current',
        upcoming: 'Upcoming',
        expand: 'Expand',
        collapse: 'Collapse',
        owner: 'Owner',
        terms: 'Matched terms',
        exportPath: 'Written to',
        probe: 'Probe',
        noData: 'No hot-list hit related to the brand, competitors, or base makeup',
        proxyNote: 'SOV is public hot-list mention share: a proxy signal, not AI share',
        engine: 'Engine',
      },
    }

    const C = {
      base: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    const PRIORITY_COLOR = { P0: C.error, P1: C.warn, P2: C.dim }
    const LEVEL_COLOR = { high: C.error, medium: C.warn, low: C.dim }

    const cardStyle = {
      background: C.layer1,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: '12px 14px',
      margin: '6px 0',
      color: C.text,
      fontSize: 13,
      lineHeight: 1.55,
    }

    const chipStyle = color => ({
      display: 'inline-block',
      padding: '1px 7px',
      borderRadius: 999,
      border: `1px solid ${color}`,
      color,
      fontSize: 11,
      lineHeight: 1.6,
      marginRight: 6,
      whiteSpace: 'nowrap',
    })

    const tileStyle = {
      flex: '1 1 96px',
      minWidth: 88,
      background: C.layer2,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: '8px 10px',
    }

    const Tile = ({ label, value, tone }) => h('div', { style: tileStyle },
      h('div', { style: { fontSize: 11, color: C.dim, marginBottom: 2 } }, label),
      h('div', { style: { fontSize: 18, fontWeight: 600, color: tone ?? C.text, fontVariantNumeric: 'tabular-nums' } }, String(value)))

    const Row = ({ left, right }) => h('div', { style: { display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 0', borderBottom: `1px solid ${C.border}` } },
      h('div', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, left),
      h('div', { style: { color: C.dim, fontSize: 12, whiteSpace: 'nowrap' } }, right))

    const Bar = ({ label, value, max, tone, suffix }) => {
      const width = max <= 0 ? 0 : Math.max(2, Math.round((value / max) * 100))
      return h('div', { style: { margin: '5px 0' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 } },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
          h('span', { style: { color: C.dim, fontVariantNumeric: 'tabular-nums' } }, suffix)),
        h('div', { style: { height: 6, background: C.layer2, borderRadius: 3, overflow: 'hidden' } },
          h('div', { style: { width: `${width}%`, height: '100%', background: tone ?? C.brand, borderRadius: 3 } })))
    }

    const Section = ({ title, children }) => h('div', { style: { marginTop: 10 } },
      h('div', { style: { fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.dim, marginBottom: 4 } }, title),
      children)

    /** Pull the `geo.view` payload out of the tool result's text blocks. */
    function extractPayload(block) {
      if (block === null || typeof block !== 'object') return null
      const content = Array.isArray(block.content) ? block.content : []
      for (const part of content) {
        if (part === null || typeof part !== 'object' || part.type !== 'text') continue
        const text = String(part.text ?? '').trim()
        if (!text.startsWith('{')) continue
        try {
          const parsed = JSON.parse(text)
          if (parsed !== null && typeof parsed === 'object' && parsed.kind === 'geo.view') return parsed
        } catch {
          /* not the payload block */
        }
      }
      return null
    }

    const Header = ({ title, sub, t }) => h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', marginBottom: 8 } },
      h('div', { style: { fontWeight: 600, fontSize: 13 } }, title),
      h('div', { style: { fontSize: 11, color: C.dim, whiteSpace: 'nowrap' } }, sub))

    function ScanView({ view, t }) {
      const counts = view.counts ?? {}
      const maxShare = Math.max(1, ...(view.sov?.brands ?? []).map(brand => brand.share ?? 0))
      return h('div', null,
        Header({ title: `GEO 雷达 · ${String(view.scannedAt ?? '').slice(0, 16).replace('T', ' ')}`, sub: `${counts.platformsOk ?? 0}/${counts.platformTotal ?? 0} 平台`, t }),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          Tile({ label: t('items'), value: counts.items ?? 0 }),
          Tile({ label: t('matched'), value: counts.matched ?? 0 }),
          Tile({ label: t('topics'), value: counts.topics ?? 0 }),
          Tile({ label: t('alerts'), value: counts.alerts ?? 0, tone: (counts.highAlerts ?? 0) > 0 ? C.error : undefined })),
        (view.topics ?? []).length === 0
          ? h(Section, { title: t('topics') }, h('div', { style: { color: C.dim, fontSize: 12 } }, t('noData')))
          : h(Section, { title: t('topics') },
            (view.topics ?? []).map(card => h(Row, {
              key: card.id,
              left: h('span', null,
                h('span', { style: chipStyle(PRIORITY_COLOR[card.priority] ?? C.dim) }, card.priority ?? '—'),
                h('span', { style: { color: C.dim, marginRight: 6 } }, card.cluster ?? ''),
                card.question ?? ''),
              right: `${card.platform ?? ''} #${card.rank ?? '—'} · ${card.score ?? ''}`,
            }))),
        (view.alerts ?? []).length === 0 ? null : h(Section, { title: t('alerts') },
          (view.alerts ?? []).map(alert => h(Row, {
            key: alert.id,
            left: h('span', null,
              h('span', { style: chipStyle(LEVEL_COLOR[alert.level] ?? C.dim) }, alert.levelLabel ?? ''),
              alert.title ?? ''),
            right: alert.rule ?? '',
          }))),
        (view.sov?.brands ?? []).length === 0 ? null : h(Section, { title: `SOV · ${view.sov?.days ?? 0}${t('days')}` },
          (view.sov?.brands ?? []).map(brand => Bar({
            key: brand.name,
            label: brand.self === true ? `${brand.name}（本方）` : brand.name,
            value: brand.share ?? 0,
            max: maxShare,
            tone: brand.self === true ? C.brand : C.idle,
            suffix: `${brand.share ?? 0}% · ${brand.mentions ?? 0}${t('mentions')}`,
          }))),
        (view.calendar ?? []).length === 0 ? null : h(Section, { title: 'PR' },
          (view.calendar ?? []).map(node => h('span', { key: node.theme, style: chipStyle(node.hot === true ? C.warn : C.dim) },
            `${node.theme}${node.phase === 'upcoming' ? ` · ${node.startsInDays}${t('days')}` : ''}`))),
        (view.errors ?? []).length === 0 ? null : h(Section, { title: '⚠︎' },
          (view.errors ?? []).map(error => h('div', { key: error.platform, style: { color: C.warn, fontSize: 12 } }, `${error.name}: ${error.message}`))),
        h('div', { style: { marginTop: 8, fontSize: 11, color: C.dim } }, t('proxyNote')))
    }

    function TopicsView({ view, t }) {
      return h('div', null,
        Header({ title: `GEO 选题卡 · ${view.total ?? 0}`, sub: `${view.scans ?? 0}${t('scans')} · ${view.days ?? 0}${t('days')}`, t }),
        (view.cards ?? []).map(card => h('div', { key: card.id, style: { padding: '6px 0', borderBottom: `1px solid ${C.border}` } },
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
            h('span', { style: chipStyle(PRIORITY_COLOR[card.priority] ?? C.dim) }, card.priority ?? '—'),
            h('span', { style: { fontWeight: 500 } }, card.question ?? card.id)),
          h('div', { style: { fontSize: 11, color: C.dim, marginTop: 2 } },
            `${card.id} · ${card.cluster ?? ''} · ${card.product ?? ''} · ${card.format ?? ''} · ${card.score ?? ''} · ${card.platform ?? ''} #${card.rank ?? '—'}`))))
    }

    function AlertsView({ view, t }) {
      const summary = view.summary ?? {}
      return h('div', null,
        Header({ title: `GEO 风险预警 · ${summary.total ?? 0}`, sub: `${view.days ?? 0}${t('days')}`, t }),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 } },
          Tile({ label: t('high'), value: summary.high ?? 0, tone: (summary.high ?? 0) > 0 ? C.error : undefined }),
          Tile({ label: '中', value: summary.medium ?? 0, tone: C.warn }),
          Tile({ label: '低', value: summary.low ?? 0 })),
        (view.alerts ?? []).map(alert => h('div', { key: alert.id, style: { padding: '6px 0', borderBottom: `1px solid ${C.border}` } },
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
            h('span', { style: chipStyle(LEVEL_COLOR[alert.levelLabel === '高' ? 'high' : alert.levelLabel === '中' ? 'medium' : 'low'] ?? C.dim) }, alert.levelLabel ?? ''),
            h('span', { style: { fontWeight: 500 } }, alert.title ?? '')),
          h('div', { style: { fontSize: 11, color: C.dim, marginTop: 2 } },
            `${alert.rule ?? ''} · ${t('owner')} ${alert.owner ?? ''}${(alert.terms ?? []).length > 0 ? ` · ${t('terms')} ${alert.terms.join('、')}` : ''}`))))
    }

    function SovView({ view, t }) {
      const max = Math.max(1, ...(view.brands ?? []).map(brand => brand.share ?? 0))
      return h('div', null,
        Header({ title: 'GEO SOV', sub: `${view.window?.scans ?? 0}${t('scans')} · ${view.window?.days ?? 0}${t('days')}`, t }),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 } },
          Tile({ label: t('items'), value: view.window?.items ?? 0 }),
          Tile({ label: t('mentions'), value: view.window?.mentionTotal ?? 0 }),
          Tile({ label: t('gap'), value: view.gap === null || view.gap === undefined ? '—' : `${view.gap}pp`, tone: C.warn })),
        (view.brands ?? []).map(brand => Bar({
          key: brand.name,
          label: brand.self === true ? `${brand.name}（本方）` : brand.name,
          value: brand.share ?? 0,
          max,
          tone: brand.self === true ? C.brand : C.idle,
          suffix: `${brand.share ?? 0}% · ${brand.mentions ?? 0}${brand.deltaPoints === 0 ? '' : ` · ${brand.deltaPoints > 0 ? '+' : ''}${brand.deltaPoints}pp`}`,
        })),
        h('div', { style: { marginTop: 8, fontSize: 11, color: C.dim } }, t('proxyNote')))
    }

    function BaselineView({ view, t }) {
      const total = view.total ?? 0
      const audited = view.audited ?? 0
      const percent = total === 0 ? 0 : Math.round((audited / total) * 100)
      const rate = value => (value === null || value === undefined ? '—' : `${value}%`)
      return h('div', null,
        Header({ title: `T0 基线审计 · ${audited}/${total}`, sub: view.action ?? '', t }),
        h('div', { style: { height: 8, background: C.layer2, borderRadius: 4, overflow: 'hidden', marginBottom: 10 } },
          h('div', { style: { width: `${percent}%`, height: '100%', background: C.brand } })),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          Tile({ label: t('coverage'), value: `${rate(view.coverage)}` }),
          Tile({ label: t('mentionRate'), value: rate(view.mentionRate) }),
          Tile({ label: t('firstChoiceRate'), value: rate(view.firstChoiceRate) }),
          Tile({ label: t('citationRate'), value: rate(view.citationRate) }),
          Tile({ label: t('factAccuracy'), value: rate(view.factAccuracy) }),
          Tile({ label: t('remaining'), value: view.remaining ?? Math.max(0, total - audited) })),
        (view.byEngine ?? []).length === 0 ? null : h(Section, { title: t('engine') },
          (view.byEngine ?? []).map(entry => h(Row, { key: entry.label, left: entry.label, right: `${entry.audited ?? 0} · ${rate(entry.mentionRate)}` }))))
    }

    function CalendarView({ view, t }) {
      return h('div', null,
        Header({ title: 'GEO 公关日历', sub: view.today ?? '', t }),
        (view.nodes ?? []).map(node => h('div', { key: node.theme, style: { display: 'flex', justifyContent: 'space-between', gap: 10, padding: '5px 0', borderBottom: `1px solid ${C.border}` } },
          h('span', null,
            h('span', { style: chipStyle(node.hot === true ? C.warn : C.dim) }, node.phase === 'current' ? t('current') : `${node.startsInDays}${t('days')}`),
            node.theme),
          h('span', { style: { fontSize: 11, color: C.dim } }, (node.engines ?? []).join('、')))))
    }

    function StatusView({ view, t }) {
      const rows = [
        ['数据目录', view.dataRoot ?? '—'],
        ['快照', view.snapshots ?? 0],
        [t('scanned'), view.latestScan === null || view.latestScan === undefined ? '—' : String(view.latestScan).slice(0, 16).replace('T', ' ')],
        ['关键词分组', view.groups ?? 0],
        ['正则告警', view.warnings ?? 0],
        ['T0 基线', view.baseline === null || view.baseline === undefined ? '未建立' : `${view.baseline.audited}/${view.baseline.total}`],
        [t('platforms'), (view.platforms ?? []).join('、')],
      ]
      return h('div', null,
        Header({ title: 'GEO 雷达状态', sub: '', t }),
        rows.map(([label, value]) => h(Row, { key: label, left: label, right: String(value) })),
        view.probe === null || view.probe === undefined ? null : h('div', { style: { marginTop: 8, fontSize: 12, color: view.probe.ok === true ? C.success : C.error } },
          `${t('probe')} ${view.probe.platform}: ${view.probe.ok === true ? `${view.probe.items}` : '失败'}`))
    }

    function ReportView({ view, t }) {
      return h('div', null,
        Header({ title: `GEO ${view.period === 'weekly' ? '周报' : '日报'}`, sub: `${view.scans ?? 0}${t('scans')} · ${view.days ?? 0}${t('days')}`, t }),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          Tile({ label: t('topics'), value: view.topics ?? 0 }),
          Tile({ label: t('alerts'), value: view.alerts ?? 0, tone: (view.alerts ?? 0) > 0 ? C.warn : undefined })),
        view.exportPath === null || view.exportPath === undefined
          ? null
          : h('div', { style: { marginTop: 8, fontSize: 11, color: C.dim, wordBreak: 'break-all' } }, `${t('exportPath')} ${view.exportPath}`))
    }

    function DraftView({ view, t }) {
      const action = view.action ?? 'skeleton'
      const title = action === 'skeleton' ? 'GEO 生成骨架' : action === 'render' ? 'GEO 成稿' : 'GEO 契约校验'
      const okTone = view.ok === false ? C.error : C.success
      const tiles = []
      if (action === 'skeleton') {
        tiles.push(Tile({ label: '模板', value: view.template ?? '—' }))
        tiles.push(Tile({ label: '类型', value: view.contentType ?? '—' }))
        tiles.push(Tile({ label: '建议风险', value: view.risk ?? '—', tone: view.risk === 'high' ? C.warn : undefined }))
        tiles.push(Tile({ label: 'claim', value: view.evidenceCount ?? 0, tone: view.evidenceMissing === true ? C.error : undefined }))
      } else if (action === 'render') {
        tiles.push(Tile({ label: 'claims', value: view.claims ?? 0 }))
        tiles.push(Tile({ label: 'citations', value: view.citations ?? 0 }))
        tiles.push(Tile({ label: '警告', value: view.warnings ?? 0, tone: (view.warnings ?? 0) > 0 ? C.warn : undefined }))
      } else {
        tiles.push(Tile({ label: '阻断项', value: view.errors ?? 0, tone: (view.errors ?? 0) > 0 ? C.error : C.success }))
        tiles.push(Tile({ label: '警告', value: view.warnings ?? 0, tone: C.warn }))
        tiles.push(Tile({ label: 'claims', value: view.claims ?? 0 }))
        tiles.push(Tile({ label: 'citations', value: view.citations ?? 0 }))
      }
      return h('div', null,
        Header({ title, sub: view.contentId ?? '', t }),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } }, tiles),
        view.evidenceMissing === true
          ? h('div', { style: { marginTop: 8, fontSize: 12, color: C.error } }, 'L3 证据包为空：起草前必须补齐 claim / evidence，否则内容不满足 G2 证据绑定。')
          : null,
        view.ok === false
          ? h('div', { style: { marginTop: 8, fontSize: 12, color: okTone } }, '契约未通过，按阻断项改写后重新校验。')
          : null,
        h('div', { style: { marginTop: 8, fontSize: 11, color: C.dim } },
          'G3 事实蕴含、G5 品牌语气与三签需人审；插件只判定 G1 Schema / G2 证据绑定 / G4 合规。'),
        [view.promptPath, view.jsonPath, view.markdownPath].filter(Boolean).map((file, index) =>
          h('div', { key: index, style: { marginTop: 4, fontSize: 11, color: C.dim, wordBreak: 'break-all' } }, file)))
    }

    function DbView({ view, t }) {
      const action = view.action ?? 'status'
      const title = action === 'template' ? '数据库配置模板' : action === 'test' ? '数据库连通性' : action === 'schema' ? '数据库字段清单' : action === 'sample' ? '数据库取样' : '数据库通道'
      const rows = []
      if (action === 'status') {
        const one = (label, info) => (info === null
          ? h(Row, { key: label, left: label, right: '未配置' })
          : h(Row, { key: label, left: `${label} ${info.target}`, right: `user ${info.user} · schema ${info.schema}` }))
        rows.push(one('证据库', view.evidence ?? null))
        rows.push(one('商品库', view.product ?? null))
      } else if (action === 'test') {
        rows.push(h(Row, { key: 'target', left: view.target ?? '—', right: view.database ?? '' }))
      } else if (action === 'schema') {
        rows.push(h(Row, { key: 'schema', left: `schema ${view.schema ?? ''}`, right: `${view.tables ?? 0} 张表` }))
        for (const table of (view.selected ?? [])) rows.push(h(Row, { key: table, left: table, right: '已导出' }))
      } else if (action === 'sample') {
        rows.push(h(Row, { key: 'rows', left: `${view.rows ?? 0} 行`, right: (view.fields ?? []).length === 0 ? '无字段' : `${view.fields.length} 个字段` }))
      }
      return h('div', null,
        Header({ title, sub: view.driver === undefined ? '' : `pg ${view.driver}`, t }),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          Tile({ label: '驱动', value: view.driver ?? '—', tone: view.driver === 'missing' ? C.error : undefined })),
        h('div', { style: { marginTop: 8 } }, rows),
        (view.problems ?? []).length === 0
          ? null
          : h('div', { style: { marginTop: 8, fontSize: 12, color: C.warn } }, (view.problems ?? []).join('；')),
        h('div', { style: { marginTop: 8, fontSize: 11, color: C.dim } }, '插件对数据库只读：会话强制 read only，只做 select。凭据存在插件 config 里，是明文。'))
    }

    function EvidenceView({ view, t }) {
      const counts = view.counts ?? null
      return h('div', null,
        Header({ title: view.action === 'sku' ? '商品事实卡' : '证据准入', sub: view.target ?? '', t }),
        counts === null
          ? h('div', null, Tile({ label: 'rows', value: view.rows ?? 0 }))
          : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            Tile({ label: '可用', value: counts.green ?? 0, tone: C.success }),
            Tile({ label: '有条件', value: counts.yellow ?? 0, tone: C.warn }),
            Tile({ label: '禁用', value: counts.red ?? 0, tone: (counts.red ?? 0) > 0 ? C.error : undefined }),
            Tile({ label: '合计', value: counts.total ?? 0 })),
        (view.green ?? []).length === 0 ? null : h(Section, { title: '绿色 / 可用' },
          (view.green ?? []).map(claim => h(Row, {
            key: claim.claimId,
            left: h('span', null, h('span', { style: chipStyle(C.success) }, claim.grade ?? '—'), `${claim.claimId} ${claim.text}`),
            right: '',
          }))),
        (view.red ?? []).length === 0 ? null : h(Section, { title: '红色 / 禁用' },
          (view.red ?? []).map(claim => h(Row, {
            key: claim.claimId,
            left: h('span', null, h('span', { style: chipStyle(C.error) }, '禁用'), `${claim.claimId} ${claim.text}`),
            right: (claim.reasons ?? [])[0] ?? '',
          }))),
        h('div', { style: { marginTop: 8, fontSize: 11, color: C.dim } },
          '准入规则：A/B 级且未过期才可直接写功效结论；C/D 级只能写场景与边界。'))
    }

    const VIEWS = {
      scan: ScanView,
      topics: TopicsView,
      alerts: AlertsView,
      sov: SovView,
      baseline: BaselineView,
      calendar: CalendarView,
      status: StatusView,
      report: ReportView,
      draft: DraftView,
      db: DbView,
      evidence: EvidenceView,
    }

    /** One view component for every geo tool; the payload picks the layout. */
    function makeView(t) {
      return function GeoToolView(props) {
        const [open, setOpen] = useState(true)
        const phase = props?.phase
        if (phase !== 'result') {
          return h('div', { style: { ...cardStyle, display: 'flex', gap: 8, alignItems: 'center', color: C.dim } },
            h('span', { style: { width: 6, height: 6, borderRadius: 3, background: C.brand } }),
            phase === 'preparing' ? t('preparing') : t('running'))
        }
        const payload = extractPayload(props?.block)
        if (payload === null) {
          return h('div', { style: { ...cardStyle, color: C.dim } }, t('empty'))
        }
        const View = VIEWS[payload.view] ?? ScanView
        return h('div', { style: cardStyle },
          h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
            h('button', {
              type: 'button',
              onClick: () => setOpen(value => !value),
              style: { background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', fontSize: 11, padding: 0 },
            }, open ? t('collapse') : t('expand'))),
          open ? h(View, { view: payload, t }) : null)
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const disposeLocale = ctx.locale.register(NS, DICT)
        ctx.effect(() => disposeLocale, 'geo-radar: locale')
        const t = ctx.locale.bind(NS)
        const View = makeView(t)
        const keys = ['geo_scan', 'geo_topics', 'geo_alerts', 'geo_sov', 'geo_report', 'geo_draft', 'geo_baseline', 'geo_calendar', 'geo_status', 'geo_db', 'geo_evidence']
        ctx.slots.inject('tool.call.toolview', function* register() {
          for (const key of keys) {
            yield ctx.slots.register({ name: 'tool.call.toolview', key, locale: NS }, View)
          }
        })
      },
    }
  },
})
