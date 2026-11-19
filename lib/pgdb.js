/**
 * Read access to the two external PostgreSQL reference databases.
 *
 * The plugin does not own the evidence or the product master data: those live in
 * tables the team already runs, reached over a normal database port. This module
 * owns only the connection, the identifier mapping and the read-only guarantee.
 *
 * Design points that matter when you configure it later:
 *   · two independent instances (`evidence` and `product`) instead of one;
 *   · every table and column name comes from config, so any existing schema works;
 *   · a `sql` override per instance replaces the generated query entirely;
 *   · each session is forced read-only and carries connect/statement timeouts;
 *   · the driver is imported lazily, so a missing dependency degrades to a clear
 *     message instead of breaking the whole plugin.
 * Passwords never appear in status output.
 */
import path from 'node:path'
import { defaultPasswordVariable, readEnvFile, resolvePassword } from './envfile.js'

let clientClass = null

/**
 * Import the driver on first use. A missing `pg` package then degrades to one
 * clear message instead of preventing the whole plugin from activating.
 */
async function loadClientClass() {
  if (clientClass !== null) return clientClass
  const module = await import('pg')
  clientClass = module.Client ?? module.default?.Client ?? null
  if (clientClass === null) throw new Error('pg 驱动加载失败：模块没有导出 Client')
  return clientClass
}

/** Table and column names the generated query assumes, all overridable. */
export const DEFAULT_MAPPING = {
  evidence: {
    tables: { claim: 'geo_claim', evidence: 'geo_evidence' },
    columns: {
      claim: {
        claim_id: 'claim_id',
        sku_code: 'sku_code',
        claim_text: 'claim_text',
        limitations: 'limitations',
        status: 'status',
        approved_at: 'approved_at',
      },
      evidence: {
        evidence_id: 'evidence_id',
        claim_id: 'claim_id',
        grade: 'grade',
        source: 'source',
        source_url: 'source_url',
        tested_at: 'tested_at',
        valid_until: 'valid_until',
        sample_size: 'sample_size',
        method: 'method',
      },
    },
  },
  product: {
    tables: { sku: 'geo_sku' },
    columns: {
      sku: {
        sku_code: 'sku_code',
        product_name: 'product_name',
        brand: 'brand',
        category: 'category',
        spec: 'spec',
        price_cny: 'price_cny',
        price_updated: 'price_updated',
        shelf: 'shelf',
        skin_types: 'skin_types',
        filing_no: 'filing_no',
        launched_at: 'launched_at',
        status: 'status',
      },
    },
  },
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0

/** Merge a partial user mapping over the defaults, two levels deep. */
function mergeMapping(base, override) {
  if (!isObject(override)) return base
  const merged = { tables: { ...base.tables }, columns: {} }
  for (const [group, columns] of Object.entries(base.columns)) {
    merged.columns[group] = { ...columns, ...(isObject(override.columns?.[group]) ? override.columns[group] : {}) }
  }
  if (isObject(override.tables)) merged.tables = { ...base.tables, ...override.tables }
  return merged
}

/** Quote an identifier so a reserved word or odd spelling still works. */
export function quoteIdent(value) {
  return `"${String(value).replace(/"/gu, '""')}"`
}

const qualified = (schema, table) => (nonEmpty(schema) ? `${quoteIdent(schema)}.${quoteIdent(table)}` : quoteIdent(table))

/**
 * Normalize one configured instance.
 * The password is resolved from the environment or `.env`; a literal `password`
 * in config still works but is reported as plaintext.
 * @returns {{instance: object|null, problems: string[]}}
 */
export function normalizeInstance(label, raw, options = {}) {
  if (!isObject(raw)) return { instance: null, problems: [`${label}：未配置连接`] }
  if (raw.enabled === false) return { instance: null, problems: [`${label}：已禁用（enabled: false）`] }
  const problems = []
  for (const key of ['host', 'database', 'user']) {
    if (!nonEmpty(raw[key])) problems.push(`${label}：缺少 ${key}`)
  }
  const port = Number(raw.port ?? 5432)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) problems.push(`${label}：port 非法（${String(raw.port)}）`)
  if (problems.length > 0) return { instance: null, problems }

  const credential = resolvePassword(raw, label, options)
  const defaults = DEFAULT_MAPPING[label]
  const ssl = raw.ssl === true
    ? { rejectUnauthorized: true }
    : raw.ssl === false || raw.ssl === undefined
      ? false
      : isObject(raw.ssl)
        ? raw.ssl
        : false

  const instance = {
    label,
    host: String(raw.host).trim(),
    port,
    database: String(raw.database).trim(),
    user: String(raw.user).trim(),
    password: credential.value,
    passwordSource: credential.source,
    passwordVariable: credential.variable,
    passwordWarning: credential.warning,
    ssl,
    schema: nonEmpty(raw.schema) ? raw.schema.trim() : '',
    connectTimeoutMs: Number.isFinite(Number(raw.connectTimeoutMs)) ? Math.max(500, Number(raw.connectTimeoutMs)) : 5000,
    statementTimeoutMs: Number.isFinite(Number(raw.statementTimeoutMs)) ? Math.max(500, Number(raw.statementTimeoutMs)) : 8000,
    maxRows: Number.isFinite(Number(raw.maxRows)) ? Math.min(2000, Math.max(1, Number(raw.maxRows))) : 200,
    mapping: defaults === undefined ? null : mergeMapping(defaults, raw.mapping),
    sql: isObject(raw.sql) ? raw.sql : {},
  }
  return { instance, problems: [] }
}

/**
 * Where the credentials file lives.
 *
 * Order: `config.envFile` (absolute, or relative to the data directory), then
 * `<dataDir>/.env`, then `<pluginRoot>/.env` — the repository copies the first
 * existing file, and otherwise points at the data-directory path to create.
 */
export function resolveEnvFilePath(config = {}, dataRoot = '', pluginRoot = '') {
  const configured = isObject(config) && typeof config.envFile === 'string' ? config.envFile.trim() : ''
  if (configured.length > 0) {
    return path.isAbsolute(configured) ? configured : path.resolve(dataRoot.length === 0 ? '.' : dataRoot, configured)
  }
  const candidates = []
  if (dataRoot.length > 0) candidates.push(path.join(dataRoot, '.env'))
  if (pluginRoot.length > 0) candidates.push(path.join(pluginRoot, '.env'))
  for (const candidate of candidates) {
    if (readEnvFile(candidate).exists) return candidate
  }
  return candidates[0] ?? null
}

/** Resolve both instances from the plugin config. */
export function resolveDatabases(config = {}, options = {}) {
  const root = isObject(config.databases) ? config.databases : {}
  const context = { env: options.env ?? process.env, envFile: options.envFile ?? null }
  const evidence = normalizeInstance('evidence', root.evidence, context)
  const product = normalizeInstance('product', root.product, context)
  return {
    evidence: evidence.instance,
    product: product.instance,
    problems: [...evidence.problems.map(text => `databases.${text}`), ...product.problems.map(text => `databases.${text}`)],
    configured: evidence.instance !== null || product.instance !== null,
    envFile: context.envFile,
    envFileExists: context.envFile === null ? false : readEnvFile(context.envFile).exists,
  }
}

/** A status line that never leaks the password. */
export function describeInstance(instance) {
  if (instance === null) return null
  return {
    label: instance.label,
    target: `${instance.host}:${instance.port}/${instance.database}`,
    user: instance.user,
    ssl: instance.ssl === false ? false : true,
    schema: instance.schema === '' ? 'public' : instance.schema,
    tables: instance.mapping === null ? {} : instance.mapping.tables,
    passwordSet: instance.password.length > 0,
    passwordSource: instance.passwordSource,
    passwordVariable: instance.passwordVariable ?? defaultPasswordVariable(instance.label),
    passwordWarning: instance.passwordWarning,
    readOnly: true,
    connectTimeoutMs: instance.connectTimeoutMs,
    statementTimeoutMs: instance.statementTimeoutMs,
    maxRows: instance.maxRows,
    customSql: Object.keys(instance.sql),
  }
}

/** Generated claim+evidence query. `$1` sku, `$2` keyword, `$3` limit. */
export function buildClaimsQuery(instance, params = {}) {
  const limit = Math.min(instance.maxRows, Math.max(1, Number(params.limit) || 50))
  if (nonEmpty(instance.sql.claims)) {
    return { text: instance.sql.claims, values: [params.sku ?? null, params.keyword ?? null, limit] }
  }
  const { tables, columns } = instance.mapping
  const c = columns.claim
  const e = columns.evidence
  const claimTable = qualified(instance.schema, tables.claim)
  const evidenceTable = qualified(instance.schema, tables.evidence)
  const text = [
    'select',
    `  c.${quoteIdent(c.claim_id)} as claim_id,`,
    `  c.${quoteIdent(c.sku_code)} as sku_code,`,
    `  c.${quoteIdent(c.claim_text)} as claim_text,`,
    `  c.${quoteIdent(c.limitations)} as limitations,`,
    `  c.${quoteIdent(c.status)} as status,`,
    `  c.${quoteIdent(c.approved_at)} as approved_at,`,
    `  e.${quoteIdent(e.evidence_id)} as evidence_id,`,
    `  e.${quoteIdent(e.grade)} as grade,`,
    `  e.${quoteIdent(e.source)} as source,`,
    `  e.${quoteIdent(e.source_url)} as source_url,`,
    `  e.${quoteIdent(e.tested_at)} as tested_at,`,
    `  e.${quoteIdent(e.valid_until)} as valid_until,`,
    `  e.${quoteIdent(e.sample_size)} as sample_size,`,
    `  e.${quoteIdent(e.method)} as method`,
    `from ${claimTable} c`,
    `left join ${evidenceTable} e on e.${quoteIdent(e.claim_id)} = c.${quoteIdent(c.claim_id)}`,
    'where ($1::text is null or c.' + quoteIdent(c.sku_code) + ' = $1::text)',
    '  and ($2::text is null or c.' + quoteIdent(c.claim_text) + ' ilike \'%\' || $2::text || \'%\')',
    `  and coalesce(c.${quoteIdent(c.status)}, 'approved') not in ('rejected', 'archived')`,
    `order by c.${quoteIdent(c.claim_id)}, e.${quoteIdent(e.grade)} nulls last`,
    'limit $3::int',
  ].join('\n')
  return { text, values: [params.sku ?? null, params.keyword ?? null, limit] }
}

/** Generated SKU query. `$1` sku, `$2` keyword, `$3` limit. */
export function buildSkuQuery(instance, params = {}) {
  const limit = Math.min(instance.maxRows, Math.max(1, Number(params.limit) || 50))
  if (nonEmpty(instance.sql.sku)) {
    return { text: instance.sql.sku, values: [params.sku ?? null, params.keyword ?? null, limit] }
  }
  const { tables, columns } = instance.mapping
  const k = columns.sku
  const table = qualified(instance.schema, tables.sku)
  const names = Object.keys(k)
  const text = [
    'select',
    ...names.map((key, index) => `  ${quoteIdent(k[key])} as ${quoteIdent(key)}${index === names.length - 1 ? '' : ','}`),
    `from ${table}`,
    'where ($1::text is null or ' + quoteIdent(k.sku_code) + ' = $1::text)',
    '  and ($2::text is null or ' + quoteIdent(k.product_name) + ' ilike \'%\' || $2::text || \'%\')',
    `limit $3::int`,
  ].join('\n')
  return { text, values: [params.sku ?? null, params.keyword ?? null, limit] }
}

/** Turn a driver failure into one actionable line. */
export function describeDbError(error, instance) {
  const target = instance === null || instance === undefined ? '未配置' : `${instance.host}:${instance.port}`
  const code = error?.code === undefined ? '' : `（${error.code}）`
  const message = String(error?.message ?? error ?? '未知错误').replace(/\s+/gu, ' ').trim()
  const hints = {
    ECONNREFUSED: '端口未监听：确认库已启动、端口对当前机器开放',
    ETIMEDOUT: '连接超时：检查防火墙、安全组或 VPN',
    ENOTFOUND: '主机名解析失败：检查 host 拼写',
    '28P01': '认证失败：检查 user / password',
    '28000': '认证被拒：确认 pg_hba.conf 允许该来源',
    '3D000': '数据库不存在：检查 database',
    '42P01': '表不存在：检查 databases.*.mapping.tables 与 schema',
    '42703': '列不存在：检查 databases.*.mapping.columns',
    '42501': '权限不足：确认只读账号对该表有 select 权限',
    '57014': '语句超时：收紧查询或提高 statementTimeoutMs',
  }
  const hint = hints[String(error?.code ?? '').toUpperCase()] ?? (message.includes('ECONNREFUSED') ? hints.ECONNREFUSED : '')
  const authFailed = ['28P01', '28000'].includes(String(error?.code ?? '').toUpperCase())
  const noPassword = instance !== null && instance !== undefined
    && (instance.passwordSource === 'none' || String(instance.password ?? '').length === 0)
  const variable = instance?.passwordVariable ?? 'GEO_<INSTANCE>_PASSWORD'
  const resolvedHint = authFailed && noPassword
    ? `未提供口令：在 .env 或环境变量中设置 ${variable}`
    : hint
  return `连接 ${target} 失败${code}：${message}${resolvedHint === '' ? '' : `　→ ${resolvedHint}`}`
}

/** Open a client, force a read-only session, run one callback, always close. */
export async function withClient(instance, callback) {
  const Client = await loadClientClass()
  const client = new Client({
    host: instance.host,
    port: instance.port,
    database: instance.database,
    user: instance.user,
    password: instance.password,
    ssl: instance.ssl,
    connectionTimeoutMillis: instance.connectTimeoutMs,
    statement_timeout: instance.statementTimeoutMs,
    query_timeout: instance.statementTimeoutMs,
    application_name: 'dsh-geo-trend-radar',
  })
  await client.connect()
  try {
    await client.query('set session characteristics as transaction read only')
    return await callback(client)
  } finally {
    await client.end().catch(() => {})
  }
}

/** `select 1` plus server version, for the readiness check. */
export async function testConnection(instance) {
  return withClient(instance, async client => {
    const result = await client.query('select 1 as ok, current_database() as db, current_user as usr, version() as version')
    const row = result.rows[0] ?? {}
    return {
      ok: row.ok === 1,
      database: row.db,
      user: row.usr,
      version: String(row.version ?? '').split(' on ')[0],
    }
  })
}

/**
 * List tables and columns so an existing schema can be mapped without hand-copying.
 * Without `tables` in config this lists the whole schema.
 */
export async function introspectSchema(instance, wantedTables = []) {
  const schema = instance.schema === '' ? 'public' : instance.schema
  return withClient(instance, async client => {
    const tables = await client.query(
      `select table_schema, table_name, table_type
         from information_schema.tables
        where table_schema = $1
        order by table_name`,
      [schema],
    )
    const names = tables.rows.map(row => row.table_name)
    const selected = wantedTables.length === 0 ? names : names.filter(name => wantedTables.includes(name))
    const columns = selected.length === 0
      ? { rows: [] }
      : await client.query(
        `select table_name, ordinal_position, column_name, data_type, is_nullable
           from information_schema.columns
          where table_schema = $1 and table_name = any($2::text[])
          order by table_name, ordinal_position`,
        [schema, selected],
      )
    return {
      schema,
      tables: names,
      selected,
      columns: columns.rows.map(row => ({
        table: row.table_name,
        position: row.ordinal_position,
        column: row.column_name,
        type: row.data_type,
        nullable: row.is_nullable === 'YES',
      })),
    }
  })
}

/** The YAML block a user can paste into the plugin config. */
export function configTemplate() {
  return `# 连接信息写在插件 config；口令不要写在这里，见 .env（geo_db action=env）
databases:
  evidence:
    enabled: true
    host: 10.0.0.10
    port: 5432
    database: geo_evidence
    user: geo_readonly
    # 口令来源：默认读 GEO_EVIDENCE_PASSWORD（环境变量优先，其次 .env）
    passwordEnv: GEO_EVIDENCE_PASSWORD
    ssl: false
    schema: public
    connectTimeoutMs: 5000
    statementTimeoutMs: 8000
    maxRows: 200
    # 表名与字段名全部可配；下面是我建议的结构，按你们现有表改这里即可
    mapping:
      tables:
        claim: geo_claim
        evidence: geo_evidence
      columns:
        claim:
          claim_id: claim_id
          sku_code: sku_code
          claim_text: claim_text
          limitations: limitations
          status: status
          approved_at: approved_at
        evidence:
          evidence_id: evidence_id
          claim_id: claim_id
          grade: grade
          source: source
          source_url: source_url
          tested_at: tested_at
          valid_until: valid_until
          sample_size: sample_size
          method: method
  product:
    enabled: true
    host: 10.0.0.11
    port: 5432
    database: geo_product
    user: geo_readonly
    passwordEnv: GEO_PRODUCT_PASSWORD
    ssl: false
    schema: public
    mapping:
      tables:
        sku: geo_sku
      columns:
        sku:
          sku_code: sku_code
          product_name: product_name
          brand: brand
          category: category
          spec: spec
          price_cny: price_cny
          price_updated: price_updated
          shelf: shelf
          skin_types: skin_types
          filing_no: filing_no
          launched_at: launched_at
          status: status`
}
