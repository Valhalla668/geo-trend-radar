/**
 * Minimal `.env` reader for database credentials.
 *
 * Rules kept deliberately small, so a credentials file behaves the same way on
 * every machine and nothing is ever expanded or executed:
 *   · one `KEY=VALUE` per line, `#` starts a comment, `export ` is ignored
 *   · matching single or double quotes are stripped; `\n` and `\"` unescape
 *     only inside double quotes
 *   · blank values are kept as empty strings, malformed lines are reported
 *   · no variable interpolation — a password containing `${...}` stays literal
 *
 * Precedence is handled by `resolvePassword`: the process environment wins over
 * the file, so CI or a container can inject the secret without any file at all.
 */
import { readFileSync, statSync } from 'node:fs'

/** Parsed files, keyed by path + size + mtime, so edits are picked up. */
const fileCache = new Map()

/** Parse `.env` text. Returns values plus one message per malformed line. */
export function parseDotenv(text) {
  const values = Object.create(null)
  const errors = []
  const lines = String(text ?? '').split(/\r?\n/u)
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const body = line.startsWith('export ') ? line.slice(7).trim() : line
    const separator = body.indexOf('=')
    if (separator <= 0) {
      errors.push(`第 ${index + 1} 行不是 KEY=VALUE：${line.slice(0, 40)}`)
      continue
    }
    const key = body.slice(0, separator).trim()
    let value = body.slice(separator + 1).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      errors.push(`第 ${index + 1} 行变量名非法：${key.slice(0, 40)}`)
      continue
    }
    const quoted = /^(['"])([\s\S]*)\1$/u.exec(value)
    if (quoted !== null) {
      value = quoted[2]
      if (quoted[1] === '"') value = value.replace(/\\n/gu, '\n').replace(/\\"/gu, '"')
    } else if (value.includes(' #')) {
      value = value.slice(0, value.indexOf(' #')).trim()
    }
    values[key] = value
  }
  return { values, errors }
}

/** Read and parse a `.env` file; a missing file is not an error. */
export function readEnvFile(file) {
  if (typeof file !== 'string' || file.length === 0) return { exists: false, values: {}, errors: [], path: null }
  let info
  try {
    info = statSync(file)
  } catch {
    return { exists: false, values: {}, errors: [], path: file }
  }
  const cacheKey = `${file}:${info.size}:${info.mtimeMs}`
  const cached = fileCache.get(cacheKey)
  if (cached !== undefined) return cached
  try {
    const parsed = parseDotenv(readFileSync(file, 'utf8'))
    const result = { exists: true, values: parsed.values, errors: parsed.errors, path: file }
    fileCache.clear()
    fileCache.set(cacheKey, result)
    return result
  } catch (error) {
    return { exists: true, values: {}, errors: [`读取失败：${error instanceof Error ? error.message : String(error)}`], path: file }
  }
}

/** Clear the parsed-file cache (tests and manual reloads). */
export function clearEnvCache() {
  fileCache.clear()
}

/** Default variable name for an instance, e.g. `GEO_EVIDENCE_PASSWORD`. */
export function defaultPasswordVariable(instanceLabel) {
  return `GEO_${String(instanceLabel ?? 'db').toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}_PASSWORD`
}

/**
 * Resolve one instance password.
 *
 * Order: `passwordEnv` (or `password: env:NAME`) → process environment →
 * `.env` file → a literal `password` in config, which is accepted for
 * backwards compatibility and reported as plaintext.
 *
 * @returns {{value: string, source: 'environment'|'env-file'|'config-plaintext'|'none', variable: string|null, warning: string|null}}
 */
export function resolvePassword(config, instanceLabel, options = {}) {
  const { env = process.env, envFile = null } = options
  const raw = config !== null && typeof config === 'object' ? config : {}
  const explicit = typeof raw.passwordEnv === 'string' && raw.passwordEnv.trim().length > 0 ? raw.passwordEnv.trim() : ''
  const configPassword = typeof raw.password === 'string' ? raw.password : ''
  const prefixed = configPassword.startsWith('env:') ? configPassword.slice(4).trim() : ''
  const variable = explicit || prefixed || defaultPasswordVariable(instanceLabel)

  const fromProcess = env === undefined || env === null ? '' : env[variable]
  if (typeof fromProcess === 'string' && fromProcess.length > 0) {
    return { value: fromProcess, source: 'environment', variable, warning: null }
  }

  const file = readEnvFile(envFile)
  const fromFile = file.values[variable]
  if (typeof fromFile === 'string' && fromFile.length > 0) {
    return { value: fromFile, source: 'env-file', variable, warning: null }
  }

  if (configPassword.length > 0 && prefixed.length === 0) {
    return {
      value: configPassword,
      source: 'config-plaintext',
      variable: null,
      warning: `口令写在插件 config 里（明文）。建议改用 ${variable}，写在 .env 或环境变量中。`,
    }
  }

  const where = envFile === null ? '.env 或环境变量' : `${envFile} 或环境变量`
  return { value: '', source: 'none', variable, warning: `未找到口令：请在 ${where} 中设置 ${variable}` }
}

/** The `.env` lines a user can copy, with names only. */
export function envTemplate() {
  return [
    '# 数据库口令。放到 .env 里，或直接配成真实环境变量（环境变量优先）。',
    '# 该文件不要提交到仓库。',
    `GEO_EVIDENCE_PASSWORD=`,
    `GEO_PRODUCT_PASSWORD=`,
  ].join('\n')
}
