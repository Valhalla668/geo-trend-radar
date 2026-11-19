import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadSnapshots, MAX_STORED_ITEMS, saveSnapshot } from '../lib/snapshots.js'
import { layout } from '../lib/store.js'

const makePaths = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-radar-'))
  return { root, paths: layout(root) }
}

const snapshot = index => ({
  id: `20261117-1200-0${index}`,
  version: 1,
  scannedAt: `2026-11-17T12:00:0${index}.000Z`,
  items: 3,
  candidates: 1,
  matched: 2,
  matchedItems: [
    { platform: 'candidate', platformName: '客服', rank: 1, title: '方里粉饼适合干皮吗', score: 69.2, cluster: { id: 'skin', name: '肤质肤况' } },
    { platform: 'zhihu', platformName: '知乎', rank: 4, title: '方里和花西子怎么选', score: 70.8, cluster: { id: 'compare', name: '竞品对比' } },
  ],
  mentions: { totalItems: 3, totalMentions: 1, brands: [{ id: 'fangli', name: '方里 FUNNY ELVES', self: true, mentions: 1, byPlatform: { 知乎: 1 }, topItems: [] }] },
})

test('a saved snapshot round-trips with its annotated items and mention summary', async () => {
  const { root, paths } = await makePaths()
  try {
    await saveSnapshot(paths, snapshot(1), 60)
    const loaded = await loadSnapshots(paths, 10)
    assert.equal(loaded.length, 1, 'the reader must see a snapshot the writer just saved')
    assert.equal(typeof loaded[0].matched, 'number')
    assert.equal(loaded[0].matched, 2)
    assert.ok(Array.isArray(loaded[0].matchedItems))
    assert.equal(loaded[0].matchedItems.length, 2)
    assert.equal(loaded[0].matchedItems[0].title, '方里粉饼适合干皮吗')
    assert.equal(loaded[0].mentions.brands[0].mentions, 1)
    assert.ok(loaded[0].matchedItems.length <= MAX_STORED_ITEMS)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('snapshots come back newest first and pruning keeps the newest', async () => {
  const { root, paths } = await makePaths()
  try {
    for (const index of [1, 2, 3]) await saveSnapshot(paths, snapshot(index), 2)
    const loaded = await loadSnapshots(paths, 10)
    assert.equal(loaded.length, 2, 'keep = 2 prunes the oldest snapshot')
    assert.equal(loaded[0].id, '20261117-1200-03')
    assert.equal(loaded[1].id, '20261117-1200-02')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a malformed snapshot file is skipped instead of breaking the read', async () => {
  const { root, paths } = await makePaths()
  try {
    await saveSnapshot(paths, snapshot(1), 60)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path.join(paths.snapshots, '20261117-1200-09.json'), '{"id":"broken"}', 'utf8')
    const loaded = await loadSnapshots(paths, 10)
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].id, '20261117-1200-01')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
