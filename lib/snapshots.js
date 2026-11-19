/**
 * Scan-snapshot persistence.
 *
 * A snapshot keeps the annotated hits (not only their count) plus the compact
 * mention summary, so topic boards, alerts and SOV can be rebuilt without
 * touching the network again. `matched` stays a number for display; the payload
 * lives in `matchedItems`, and both readers must agree on that shape.
 */
import path from 'node:path'
import { unlink } from 'node:fs/promises'
import { ensureDir, listFiles, readJson, writeJson } from './store.js'

/** Upper bound on annotated items kept per snapshot. */
export const MAX_STORED_ITEMS = 200

/** Trim one annotated item to the fields the boards and reports need. */
export function compactItem(item) {
  return {
    platform: item.platform,
    platformName: item.platformName,
    rank: item.rank,
    title: item.title,
    url: item.url,
    hot: item.hot,
    score: item.score,
    priority: item.priority,
    cluster: item.cluster,
    clusters: item.clusters,
    product: item.product,
    format: item.format,
    entities: item.entities,
    negative: item.negative,
    compliance: item.compliance,
    riskScore: item.riskScore,
    evidenceGap: item.evidenceGap,
    reasons: item.reasons,
    scannedAt: item.scannedAt,
  }
}

/** Persist a scan, point `latest.json` at it, and prune old snapshots. */
export async function saveSnapshot(paths, snapshot, keep = 60) {
  const file = path.join(paths.snapshots, `${snapshot.id}.json`)
  await writeJson(file, snapshot)
  await writeJson(paths.latest, { id: snapshot.id, scannedAt: snapshot.scannedAt, file })
  const files = await listFiles(paths.snapshots, fileName => fileName.endsWith('.json'))
  for (const stale of files.slice(Math.max(1, keep))) {
    try {
      await unlink(stale.path)
    } catch {
      /* pruning is best effort */
    }
  }
  return file
}

/** Read stored snapshots, newest first, ignoring files that are not snapshots. */
export async function loadSnapshots(paths, limit = 30) {
  const files = await listFiles(paths.snapshots, fileName => fileName.endsWith('.json'))
  const snapshots = []
  for (const file of files.slice(0, limit)) {
    const value = await readJson(file.path)
    if (value !== null && Array.isArray(value.matchedItems)) snapshots.push(value)
  }
  return snapshots
}

/** Ensure the snapshot directory exists (kept here so callers stay in one place). */
export async function ensureSnapshotDir(paths) {
  return ensureDir(paths.snapshots)
}
