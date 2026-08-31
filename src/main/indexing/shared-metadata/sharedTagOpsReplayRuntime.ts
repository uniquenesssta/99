import { cleanTagNames, parseTagNames, type SharedMetadataRow } from './sharedMetadataStateRuntime'

export type SharedTagOpAction = 'addTag' | 'removeTag'

export type SharedTagOperationRow = {
  rowid?: number | null
  op_id?: string | null
  font_id?: string | null
  relative_path?: string | null
  path_key?: string | null
  action?: string | null
  tag_name?: string | null
  base_revision?: number | null
  next_revision?: number | null
  created_at?: string | null
  machine_id?: string | null
  writer_pid?: number | null
  tombstone?: number | null
}

export type SharedTagOpsReplayConflict = {
  fontId: string
  tagName: string
  actions: string[]
  machines: string[]
  latestRevision: number
  latestAction: SharedTagOpAction
  opCount: number
  hasRevisionTie: boolean
}

export type SharedTagOpsReplayReport = {
  ok: boolean
  rootPath: string
  reason: string
  checkedOps: number
  fontRows: number
  changedRows: number
  insertedRows: number
  conflicts: number
  maxRowId: number
  previousMaxRowId: number
  skipped: boolean
  updatedAt: string
  samples: SharedTagOpsReplayConflict[]
}

export type SharedTagOpsDiagnosticsReport = {
  ok: boolean
  rootPath: string
  totalOps: number
  fontsWithOps: number
  tagPairs: number
  conflicts: number
  revisionTies: number
  latestRemovals: number
  machines: string[]
  samples: SharedTagOpsReplayConflict[]
}


export type SharedTagOpsConflictSeverity = 'ok' | 'info' | 'warning' | 'critical'

export type SharedTagOpsConflictReport = {
  ok: boolean
  rootPath: string
  totalOps: number
  conflicts: number
  revisionTies: number
  latestRemovalConflicts: number
  multiMachineConflicts: number
  severity: SharedTagOpsConflictSeverity
  suggestedActions: string[]
  samples: SharedTagOpsReplayConflict[]
}

export interface SharedTagOpsReplayRuntimeDeps {
  readMeta: (db: any, key: string) => string
  writeMeta: (db: any, key: string, value: string) => void
  appendStartupLog: (message: string) => void
}

type ReplayFontState = {
  fontId: string
  relativePath: string
  pathKey: string
  baseTags: string[]
  favorite: number
  deleteProtected: number
  revision: number
  latestByTag: Map<string, SharedTagOperationRow>
}

const LAST_REPLAY_ROWID_META_KEY = 'sharedTagOpsReplayMaxRowId'
const LAST_REPLAY_AT_META_KEY = 'sharedTagOpsReplayAt'
const CONFLICT_SAMPLE_LIMIT = 20

function numberValue(value: unknown): number {
  const number = Number(value || 0)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function stringValue(value: unknown): string {
  return String(value || '').trim()
}

function normalizedAction(value: unknown, tombstone: unknown): SharedTagOpAction | null {
  const action = stringValue(value)
  if (action === 'addTag') return 'addTag'
  if (action === 'removeTag') return 'removeTag'
  return numberValue(tombstone) > 0 ? 'removeTag' : null
}

function tableExists(db: any, tableName: string): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name=?`).get(tableName) as { count?: number } | undefined
  return Number(row?.count || 0) > 0
}

function readMaxRowId(db: any): number {
  if (!tableExists(db, 'shared_tag_ops')) return 0
  const row = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM shared_tag_ops').get() as { max_rowid?: number } | undefined
  return numberValue(row?.max_rowid)
}

function compareOps(left: SharedTagOperationRow, right: SharedTagOperationRow): number {
  const revisionDelta = numberValue(left.next_revision) - numberValue(right.next_revision)
  if (revisionDelta !== 0) return revisionDelta
  const createdDelta = stringValue(left.created_at).localeCompare(stringValue(right.created_at))
  if (createdDelta !== 0) return createdDelta
  const machineDelta = stringValue(left.machine_id).localeCompare(stringValue(right.machine_id))
  if (machineDelta !== 0) return machineDelta
  const opIdDelta = stringValue(left.op_id).localeCompare(stringValue(right.op_id))
  if (opIdDelta !== 0) return opIdDelta
  return numberValue(left.rowid) - numberValue(right.rowid)
}

function isNewerOp(left: SharedTagOperationRow, right: SharedTagOperationRow | undefined): boolean {
  if (!right) return true
  return compareOps(left, right) > 0
}

function readMetadataRows(db: any): SharedMetadataRow[] {
  if (!tableExists(db, 'font_metadata')) return []
  return db.prepare(`
    SELECT font_id, relative_path, path_key, tag_names_json, favorite, delete_protected, revision
    FROM font_metadata
  `).all() as SharedMetadataRow[]
}

function readTagOps(db: any): SharedTagOperationRow[] {
  if (!tableExists(db, 'shared_tag_ops')) return []
  return db.prepare(`
    SELECT rowid, op_id, font_id, relative_path, path_key, action, tag_name, base_revision, next_revision, created_at, machine_id, writer_pid, tombstone
    FROM shared_tag_ops
    ORDER BY font_id, tag_name, next_revision, created_at, machine_id, op_id, rowid
  `).all() as SharedTagOperationRow[]
}

function makeConflict(fontId: string, tagName: string, ops: SharedTagOperationRow[], latest: SharedTagOperationRow): SharedTagOpsReplayConflict | null {
  const actions = Array.from(new Set(ops.map((op) => normalizedAction(op.action, op.tombstone)).filter(Boolean) as string[])).sort()
  const machines = Array.from(new Set(ops.map((op) => stringValue(op.machine_id)).filter(Boolean))).sort()
  const latestRevision = numberValue(latest.next_revision)
  const latestAction = normalizedAction(latest.action, latest.tombstone)
  if (!latestAction) return null
  const latestComparable = ops.filter((op) => numberValue(op.next_revision) === latestRevision)
  const hasRevisionTie = latestComparable.length > 1
  const hasConflict = actions.length > 1 || machines.length > 1 || hasRevisionTie
  if (!hasConflict) return null
  return {
    fontId,
    tagName,
    actions,
    machines,
    latestRevision,
    latestAction,
    opCount: ops.length,
    hasRevisionTie,
  }
}

function buildReplayStates(rows: SharedMetadataRow[], ops: SharedTagOperationRow[]): {
  states: Map<string, ReplayFontState>
  conflicts: SharedTagOpsReplayConflict[]
} {
  const states = new Map<string, ReplayFontState>()
  for (const row of rows) {
    const fontId = stringValue(row.font_id)
    if (!fontId) continue
    states.set(fontId, {
      fontId,
      relativePath: stringValue(row.relative_path),
      pathKey: stringValue(row.path_key),
      baseTags: parseTagNames(row.tag_names_json),
      favorite: numberValue(row.favorite) > 0 ? 1 : 0,
      deleteProtected: numberValue(row.delete_protected) > 0 ? 1 : 0,
      revision: numberValue(row.revision),
      latestByTag: new Map<string, SharedTagOperationRow>(),
    })
  }

  const grouped = new Map<string, SharedTagOperationRow[]>()
  for (const op of ops) {
    const fontId = stringValue(op.font_id)
    const tagName = stringValue(op.tag_name)
    const action = normalizedAction(op.action, op.tombstone)
    if (!fontId || !tagName || !action) continue
    const key = `${fontId}\u0000${tagName}`
    const list = grouped.get(key) || []
    list.push(op)
    grouped.set(key, list)
    let state = states.get(fontId)
    if (!state) {
      state = {
        fontId,
        relativePath: stringValue(op.relative_path),
        pathKey: stringValue(op.path_key),
        baseTags: [],
        favorite: 0,
        deleteProtected: 0,
        revision: 0,
        latestByTag: new Map<string, SharedTagOperationRow>(),
      }
      states.set(fontId, state)
    } else {
      if (!state.relativePath) state.relativePath = stringValue(op.relative_path)
      if (!state.pathKey) state.pathKey = stringValue(op.path_key)
    }
    const latest = state.latestByTag.get(tagName)
    if (isNewerOp(op, latest)) state.latestByTag.set(tagName, op)
  }

  const conflicts: SharedTagOpsReplayConflict[] = []
  for (const [key, list] of grouped) {
    const [fontId, tagName] = key.split('\u0000')
    const latest = list.reduce((current, op) => (isNewerOp(op, current) ? op : current), undefined as SharedTagOperationRow | undefined)
    if (!latest) continue
    const conflict = makeConflict(fontId, tagName, list, latest)
    if (conflict) conflicts.push(conflict)
  }

  return { states, conflicts }
}

function replayTagsForState(state: ReplayFontState): string[] {
  const tags = new Set(cleanTagNames(state.baseTags))
  for (const [tagName, op] of state.latestByTag) {
    const action = normalizedAction(op.action, op.tombstone)
    if (action === 'addTag') tags.add(tagName)
    if (action === 'removeTag') tags.delete(tagName)
  }
  return cleanTagNames(Array.from(tags))
}

function sameTags(left: string[], right: string[]): boolean {
  const a = cleanTagNames(left)
  const b = cleanTagNames(right)
  return a.length === b.length && a.every((tag, index) => tag === b[index])
}

export function createSharedTagOpsReplayRuntime(deps: SharedTagOpsReplayRuntimeDeps) {
  function ensureSharedTagOpsReplayedInOpenDb(db: any, rootPath: string, reason = 'read'): SharedTagOpsReplayReport {
    const updatedAt = new Date().toISOString()
    const previousMaxRowId = numberValue(deps.readMeta(db, LAST_REPLAY_ROWID_META_KEY))
    const maxRowId = readMaxRowId(db)
    if (maxRowId <= 0 || previousMaxRowId >= maxRowId) {
      return {
        ok: true,
        rootPath,
        reason,
        checkedOps: 0,
        fontRows: 0,
        changedRows: 0,
        insertedRows: 0,
        conflicts: 0,
        maxRowId,
        previousMaxRowId,
        skipped: true,
        updatedAt,
        samples: [],
      }
    }

    const rows = readMetadataRows(db)
    const ops = readTagOps(db)
    const { states, conflicts } = buildReplayStates(rows, ops)
    const update = db.prepare(`
      UPDATE font_metadata
      SET tag_names_json = ?, revision = COALESCE(revision, 0) + 1, updated_at = ?, updated_by = ?
      WHERE font_id = ?
    `)
    const insert = db.prepare(`
      INSERT INTO font_metadata (
        font_id, relative_path, path_key, tag_names_json, favorite, delete_protected, revision, updated_at, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    let changedRows = 0
    let insertedRows = 0

    db.exec('BEGIN IMMEDIATE')
    try {
      for (const state of states.values()) {
        const nextTags = replayTagsForState(state)
        if (state.revision > 0) {
          if (!sameTags(state.baseTags, nextTags)) {
            update.run(JSON.stringify(nextTags), updatedAt, `tag-ops-replay:${reason}`, state.fontId)
            changedRows += 1
          }
        } else if (nextTags.length || state.relativePath || state.pathKey) {
          const revision = Math.max(1, ...Array.from(state.latestByTag.values()).map((op) => numberValue(op.next_revision)))
          insert.run(
            state.fontId,
            state.relativePath,
            state.pathKey,
            JSON.stringify(nextTags),
            state.favorite,
            state.deleteProtected,
            revision,
            updatedAt,
            `tag-ops-replay:${reason}`,
          )
          insertedRows += 1
        }
      }
      deps.writeMeta(db, LAST_REPLAY_ROWID_META_KEY, String(maxRowId))
      deps.writeMeta(db, LAST_REPLAY_AT_META_KEY, updatedAt)
      deps.writeMeta(db, 'sharedTagOpsConflictCount', String(conflicts.length))
      if (conflicts.length) deps.writeMeta(db, 'sharedTagOpsConflictSamples', JSON.stringify(conflicts.slice(0, CONFLICT_SAMPLE_LIMIT)))
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* ignore */ }
      throw error
    }

    const report: SharedTagOpsReplayReport = {
      ok: true,
      rootPath,
      reason,
      checkedOps: ops.length,
      fontRows: rows.length,
      changedRows,
      insertedRows,
      conflicts: conflicts.length,
      maxRowId,
      previousMaxRowId,
      skipped: false,
      updatedAt,
      samples: conflicts.slice(0, CONFLICT_SAMPLE_LIMIT),
    }
    if (changedRows || insertedRows || conflicts.length) {
      deps.appendStartupLog(`shared tag ops replay: root=${rootPath}, reason=${reason}, ops=${ops.length}, changed=${changedRows}, inserted=${insertedRows}, conflicts=${conflicts.length}`)
    }
    return report
  }

  function readSharedTagOpsDiagnosticsInOpenDb(db: any, rootPath: string): SharedTagOpsDiagnosticsReport {
    const ops = readTagOps(db)
    const { states, conflicts } = buildReplayStates([], ops)
    let latestRemovals = 0
    let revisionTies = 0
    const machines = new Set<string>()
    const tagPairs = new Set<string>()
    for (const op of ops) {
      const machineId = stringValue(op.machine_id)
      if (machineId) machines.add(machineId)
      const fontId = stringValue(op.font_id)
      const tagName = stringValue(op.tag_name)
      if (fontId && tagName) tagPairs.add(`${fontId}\u0000${tagName}`)
    }
    for (const conflict of conflicts) {
      if (conflict.hasRevisionTie) revisionTies += 1
    }
    for (const state of states.values()) {
      for (const op of state.latestByTag.values()) {
        if (normalizedAction(op.action, op.tombstone) === 'removeTag') latestRemovals += 1
      }
    }
    return {
      ok: true,
      rootPath,
      totalOps: ops.length,
      fontsWithOps: states.size,
      tagPairs: tagPairs.size,
      conflicts: conflicts.length,
      revisionTies,
      latestRemovals,
      machines: Array.from(machines).sort(),
      samples: conflicts.slice(0, CONFLICT_SAMPLE_LIMIT),
    }
  }

  function readSharedTagOpsConflictReportInOpenDb(db: any, rootPath: string): SharedTagOpsConflictReport {
    const ops = readTagOps(db)
    const { conflicts } = buildReplayStates([], ops)
    const revisionTies = conflicts.filter((conflict) => conflict.hasRevisionTie).length
    const latestRemovalConflicts = conflicts.filter((conflict) => conflict.latestAction === 'removeTag').length
    const multiMachineConflicts = conflicts.filter((conflict) => conflict.machines.length > 1).length
    let severity: SharedTagOpsConflictSeverity = 'ok'
    if (revisionTies > 0) severity = 'warning'
    else if (conflicts.length > 0) severity = 'info'
    const suggestedActions: string[] = []
    if (revisionTies > 0) suggestedActions.push('review same-revision shared tag operations and keep the machineId/opId tie-breaker result')
    if (latestRemovalConflicts > 0) suggestedActions.push('verify latest removeTag tombstones for affected fonts before assuming missing labels are bugs')
    if (multiMachineConflicts > 0) suggestedActions.push('compare machines in conflict samples to identify computers writing stale shared metadata')
    if (!suggestedActions.length) suggestedActions.push('no shared tag conflict action required')
    return {
      ok: true,
      rootPath,
      totalOps: ops.length,
      conflicts: conflicts.length,
      revisionTies,
      latestRemovalConflicts,
      multiMachineConflicts,
      severity,
      suggestedActions,
      samples: conflicts.slice(0, CONFLICT_SAMPLE_LIMIT),
    }
  }

  return {
    ensureSharedTagOpsReplayedInOpenDb,
    readSharedTagOpsDiagnosticsInOpenDb,
    readSharedTagOpsConflictReportInOpenDb,
  }
}
