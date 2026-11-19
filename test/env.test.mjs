import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  clearEnvCache,
  defaultPasswordVariable,
  envTemplate,
  parseDotenv,
  readEnvFile,
  resolvePassword,
} from '../lib/envfile.js'
import { describeInstance, normalizeInstance, resolveDatabases, resolveEnvFilePath } from '../lib/pgdb.js'

const makeDir = async () => mkdtemp(path.join(os.tmpdir(), 'geo-env-'))

const connection = {
  host: '10.0.0.10',
  port: 5432,
  database: 'geo_evidence',
  user: 'geo_readonly',
}

test('the dotenv parser handles comments, quotes, export and inline comments', () => {
  const parsed = parseDotenv([
    '# 注释',
    '',
    'PLAIN=value',
    'export EXPORTED=from-export',
    'SINGLE=\'quoted # not a comment\'',
    'DOUBLE="line\\nbreak"',
    'INLINE=secret # trailing comment',
    'EMPTY=',
    '  SPACED  =  padded  ',
  ].join('\r\n'))
  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.values.PLAIN, 'value')
  assert.equal(parsed.values.EXPORTED, 'from-export')
  assert.equal(parsed.values.SINGLE, 'quoted # not a comment')
  assert.equal(parsed.values.DOUBLE, 'line\nbreak')
  assert.equal(parsed.values.INLINE, 'secret')
  assert.equal(parsed.values.EMPTY, '')
  assert.equal(parsed.values.SPACED, 'padded')
})

test('the dotenv parser reports malformed lines instead of guessing', () => {
  const parsed = parseDotenv('GOOD=1\nnot-a-pair\n9BAD=value')
  assert.equal(parsed.values.GOOD, '1')
  assert.equal(parsed.errors.length, 2)
  assert.ok(parsed.errors[0].includes('第 2 行'))
})

test('a password keeps characters that look like interpolation', () => {
  const parsed = parseDotenv('PW=a${B}c#d')
  assert.equal(parsed.values.PW, 'a${B}c#d')
})

test('default variable names follow the instance label', () => {
  assert.equal(defaultPasswordVariable('evidence'), 'GEO_EVIDENCE_PASSWORD')
  assert.equal(defaultPasswordVariable('product'), 'GEO_PRODUCT_PASSWORD')
  assert.equal(defaultPasswordVariable('my-db 2'), 'GEO_MY_DB_2_PASSWORD')
})

test('the environment wins over the file, and the file over plaintext config', async () => {
  const dir = await makeDir()
  try {
    const envPath = path.join(dir, '.env')
    await writeFile(envPath, 'GEO_EVIDENCE_PASSWORD=from-file\n', 'utf8')
    clearEnvCache()

    const fromEnv = resolvePassword(connection, 'evidence', { env: { GEO_EVIDENCE_PASSWORD: 'from-env' }, envFile: envPath })
    assert.equal(fromEnv.value, 'from-env')
    assert.equal(fromEnv.source, 'environment')

    const fromFile = resolvePassword(connection, 'evidence', { env: {}, envFile: envPath })
    assert.equal(fromFile.value, 'from-file')
    assert.equal(fromFile.source, 'env-file')
    assert.equal(fromFile.variable, 'GEO_EVIDENCE_PASSWORD')

    const fromConfig = resolvePassword({ ...connection, password: 'in-config' }, 'evidence', { env: {}, envFile: null })
    assert.equal(fromConfig.value, 'in-config')
    assert.equal(fromConfig.source, 'config-plaintext')
    assert.ok(fromConfig.warning.includes('明文'))

    // A leftover plaintext must never override the credentials file.
    const fileWins = resolvePassword({ ...connection, password: 'in-config' }, 'evidence', { env: {}, envFile: envPath })
    assert.equal(fileWins.value, 'from-file')
    assert.equal(fileWins.source, 'env-file')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('passwordEnv and the env: prefix both name the variable', async () => {
  const dir = await makeDir()
  try {
    const envPath = path.join(dir, '.env')
    await writeFile(envPath, 'MY_SECRET=abc\nOTHER_SECRET=xyz\n', 'utf8')
    clearEnvCache()

    const named = resolvePassword({ ...connection, passwordEnv: 'MY_SECRET' }, 'evidence', { env: {}, envFile: envPath })
    assert.equal(named.value, 'abc')
    assert.equal(named.variable, 'MY_SECRET')

    const prefixed = resolvePassword({ ...connection, password: 'env:OTHER_SECRET' }, 'evidence', { env: {}, envFile: envPath })
    assert.equal(prefixed.value, 'xyz')
    assert.equal(prefixed.source, 'env-file')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing password is reported with the variable to set', () => {
  const result = resolvePassword(connection, 'product', { env: {}, envFile: null })
  assert.equal(result.value, '')
  assert.equal(result.source, 'none')
  assert.ok(result.warning.includes('GEO_PRODUCT_PASSWORD'))
})

test('a missing env file is not an error', () => {
  const result = readEnvFile(path.join(os.tmpdir(), 'definitely-not-here-9f2a', '.env'))
  assert.equal(result.exists, false)
  assert.deepEqual(result.errors, [])
})

test('the env file path prefers config, then the data dir, then the plugin dir', async () => {
  const dir = await makeDir()
  try {
    const dataDir = path.join(dir, 'data')
    const pluginDir = path.join(dir, 'plugin')
    await writeFile(path.join(dir, 'placeholder'), '', 'utf8')
    await (await import('node:fs/promises')).mkdir(dataDir, { recursive: true })
    await (await import('node:fs/promises')).mkdir(pluginDir, { recursive: true })
    clearEnvCache()

    assert.equal(resolveEnvFilePath({}, dataDir, pluginDir), path.join(dataDir, '.env'), 'data dir path when nothing exists')

    await writeFile(path.join(pluginDir, '.env'), 'GEO_EVIDENCE_PASSWORD=x\n', 'utf8')
    clearEnvCache()
    assert.equal(resolveEnvFilePath({}, dataDir, pluginDir), path.join(pluginDir, '.env'), 'falls back to the plugin dir file')

    await writeFile(path.join(dataDir, '.env'), 'GEO_EVIDENCE_PASSWORD=x\n', 'utf8')
    clearEnvCache()
    assert.equal(resolveEnvFilePath({}, dataDir, pluginDir), path.join(dataDir, '.env'), 'data dir wins when both exist')

    const configured = resolveEnvFilePath({ envFile: 'creds/.env' }, dataDir, pluginDir)
    assert.equal(configured, path.join(dataDir, 'creds', '.env'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('status reports where the password came from and never prints it', async () => {
  const dir = await makeDir()
  try {
    const envPath = path.join(dir, '.env')
    await writeFile(envPath, 'GEO_EVIDENCE_PASSWORD=super-secret-value\n', 'utf8')
    clearEnvCache()
    const { instance } = normalizeInstance('evidence', connection, { env: {}, envFile: envPath })
    const info = describeInstance(instance)
    assert.equal(info.passwordSet, true)
    assert.equal(info.passwordSource, 'env-file')
    assert.equal(info.passwordVariable, 'GEO_EVIDENCE_PASSWORD')
    assert.ok(!JSON.stringify(info).includes('super-secret-value'))
    assert.equal(info.passwordWarning, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resolveDatabases passes the credential context to both instances', async () => {
  const dir = await makeDir()
  try {
    const envPath = path.join(dir, '.env')
    await writeFile(envPath, 'GEO_EVIDENCE_PASSWORD=e1\nGEO_PRODUCT_PASSWORD=p1\n', 'utf8')
    clearEnvCache()
    const resolved = resolveDatabases(
      { databases: { evidence: connection, product: { ...connection, database: 'geo_product' } } },
      { env: {}, envFile: envPath },
    )
    assert.equal(resolved.configured, true)
    assert.equal(resolved.evidence.password, 'e1')
    assert.equal(resolved.product.password, 'p1')
    assert.equal(resolved.envFile, envPath)
    assert.equal(resolved.envFileExists, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the credentials template names both variables and carries no secrets', () => {
  const text = envTemplate()
  assert.ok(text.includes('GEO_EVIDENCE_PASSWORD='))
  assert.ok(text.includes('GEO_PRODUCT_PASSWORD='))
  assert.ok(!/\S=./u.test(text.replace(/GEO_[A-Z]+_PASSWORD=/gu, '')), 'no value follows a variable')
})
