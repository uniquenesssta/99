import { ROOT_INDEX_DB_SCHEMA_VERSION } from '../../cache/constants'
import type { FontScanCacheEntry, RootIndexStorage } from './rootIndexTypes'

export interface RootIndexEntryCounts {
  total: number
  usable: number
  bad: number
}

export interface RootIndexCandidateDbCounts extends RootIndexEntryCounts {
  schemaVersion: number
  cacheVersion: number
}

export interface RootIndexSwitchGuardInput {
  rootPath: string
  storage: RootIndexStorage
  mode: 'full' | 'incremental'
  previous: RootIndexEntryCounts
  next: RootIndexEntryCounts
  upserts?: number
  deletes?: number
}

export interface RootIndexCandidateValidationInput {
  rootPath: string
  storage: RootIndexStorage
  expected: RootIndexEntryCounts
  candidate: RootIndexCandidateDbCounts
  expectedCacheVersion: number
}

function isUsableEntry(entry: FontScanCacheEntry | undefined): boolean {
  return !!entry && entry.status === 'ok' && !!entry.font
}

export function countRootIndexEntries(entries: Record<string, FontScanCacheEntry> | undefined): RootIndexEntryCounts {
  let total = 0
  let usable = 0
  let bad = 0
  for (const entry of Object.values(entries || {})) {
    total += 1
    if (isUsableEntry(entry)) usable += 1
    else bad += 1
  }
  return { total, usable, bad }
}

export function readRootIndexCandidateDbCounts(db: any): RootIndexCandidateDbCounts {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'ok' AND font_json IS NOT NULL AND COALESCE(is_deleted, 0) = 0 THEN 1 ELSE 0 END) AS usable,
      SUM(CASE WHEN status <> 'ok' AND COALESCE(is_deleted, 0) = 0 THEN 1 ELSE 0 END) AS bad
    FROM entries
    WHERE COALESCE(is_deleted, 0) = 0 AND status <> 'deleted'
  `).get() as { total?: number; usable?: number; bad?: number } | undefined
  const metaRows = db.prepare('SELECT key, value FROM meta WHERE key IN (?, ?, ?)').all('schema_version', 'schemaVersion', 'index_version') as Array<{ key?: string; value?: string }>
  const meta = new Map(metaRows.map((item) => [String(item.key || ''), String(item.value || '')]))
  return {
    total: Number(row?.total || 0),
    usable: Number(row?.usable || 0),
    bad: Number(row?.bad || 0),
    schemaVersion: Number(meta.get('schema_version') || meta.get('schemaVersion') || 0),
    cacheVersion: Number(meta.get('index_version') || 0),
  }
}

export function assertRootIndexSwitchAllowed(input: RootIndexSwitchGuardInput): void {
  if (input.storage !== 'root') return
  const previousUsable = Number(input.previous.usable || 0)
  const nextUsable = Number(input.next.usable || 0)
  if (previousUsable <= 0 || nextUsable > 0) return

  const upserts = Number(input.upserts || 0)
  const deletes = Number(input.deletes || 0)
  const reason = [
    `root=${input.rootPath}`,
    `mode=${input.mode}`,
    `previousUsable=${previousUsable}`,
    `previousTotal=${input.previous.total}`,
    `nextUsable=${nextUsable}`,
    `nextTotal=${input.next.total}`,
    `upserts=${upserts}`,
    `deletes=${deletes}`,
  ].join(', ')
  throw new Error(`root index atomic switch blocked empty usable index: ${reason}`)
}

export function assertRootIndexCandidateDbValid(input: RootIndexCandidateValidationInput): void {
  if (input.storage !== 'root') return
  if (input.candidate.schemaVersion !== ROOT_INDEX_DB_SCHEMA_VERSION) {
    throw new Error(`root index candidate schema mismatch: root=${input.rootPath}, schema=${input.candidate.schemaVersion}, expected=${ROOT_INDEX_DB_SCHEMA_VERSION}`)
  }
  if (input.candidate.cacheVersion !== input.expectedCacheVersion) {
    throw new Error(`root index candidate cache version mismatch: root=${input.rootPath}, cache=${input.candidate.cacheVersion}, expected=${input.expectedCacheVersion}`)
  }
  if (input.candidate.total !== input.expected.total || input.candidate.usable !== input.expected.usable) {
    throw new Error(`root index candidate count mismatch: root=${input.rootPath}, expectedTotal=${input.expected.total}, dbTotal=${input.candidate.total}, expectedUsable=${input.expected.usable}, dbUsable=${input.candidate.usable}`)
  }
}
