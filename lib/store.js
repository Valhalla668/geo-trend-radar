/**
 * Filesystem helpers for the GEO radar data directory.
 *
 * Everything the plugin persists lives under one root: snapshots of hot-list
 * scans, generated topic boards, alerts, SOV history, baseline-audit progress
 * and reports. Files are plain JSON / JSONL / Markdown so an operator can read,
 * diff and archive them without the plugin.
 */
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_ROOT = path.join(os.homedir(), '.dsh', 'geo-trend-radar')

/** Resolve the data root from plugin config, defaulting to the user profile. */
export function resolveDataRoot(config = {}) {
  const configured = typeof config.dataDir === 'string' ? config.dataDir.trim() : ''
  if (configured.length > 0) {
    return path.isAbsolute(configured) ? configured : path.resolve(os.homedir(), configured)
  }
  return DEFAULT_ROOT
}

/** True when the path exists and is a directory. */
export async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

/** `mkdir -p` that tolerates concurrent creation. */
export async function ensureDir(target) {
  await mkdir(target, { recursive: true })
  return target
}

/** Read JSON, returning null for a missing or unreadable file. */
export async function readJson(file) {
  try {
    const raw = await readFile(file, 'utf8')
    if (raw.trim().length === 0) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Write JSON atomically (temp file + rename) with a stable key order. */
export async function writeJson(file, value) {
  await ensureDir(path.dirname(file))
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, file)
  return file
}

/** Write UTF-8 text atomically. */
export async function writeText(file, value) {
  await ensureDir(path.dirname(file))
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, value, 'utf8')
  await rename(temp, file)
  return file
}

/** Append one JSON line. */
export async function appendJsonl(file, value) {
  await ensureDir(path.dirname(file))
  await writeFile(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'a' })
  return file
}

/** Read a JSONL file into an array, skipping malformed lines. */
export async function readJsonl(file) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const rows = []
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch {
      /* a truncated tail line is not fatal */
    }
  }
  return rows
}

/** List file names in a directory, newest first; empty when absent. */
export async function listFiles(dir, filter = () => true) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!filter(entry.name)) continue
    const full = path.join(dir, entry.name)
    let info = null
    try {
      info = await stat(full)
    } catch {
      continue
    }
    files.push({ name: entry.name, path: full, mtimeMs: info.mtimeMs, size: info.size })
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** Make a filesystem-safe identifier. */
export function sanitizeId(value, fallback = 'item') {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 80)
  return cleaned.length > 0 ? cleaned : fallback
}

/** Timestamp id such as `20261117-2145`. */
export function makeStamp(date = new Date()) {
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

/** Local calendar date such as `2026-11-17`. */
export function localDate(date = new Date()) {
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Directory layout under the data root. */
export function layout(root) {
  return {
    root,
    snapshots: path.join(root, 'snapshots'),
    latest: path.join(root, 'latest.json'),
    topics: path.join(root, 'topics'),
    alerts: path.join(root, 'alerts'),
    sov: path.join(root, 'sov'),
    baseline: path.join(root, 'baseline'),
    reports: path.join(root, 'reports'),
    drafts: path.join(root, 'drafts'),
  }
}
