import { randomUUID } from 'node:crypto'
import { cleanTagNames, stateFromRow, type SharedMetadataRow, type SharedMetadataState } from './sharedMetadataStateRuntime'

export type SharedMetadataMergePolicy = 'replace' | 'tags' | 'favorite' | 'deleteProtected'

export type SharedMetadataMergeResult = {
  state: SharedMetadataState
  addedTags: string[]
  removedTags: string[]
  baseRevision: number
}

function cleanState(state: SharedMetadataState): SharedMetadataState {
  return {
    tagNames: cleanTagNames(state.tagNames || []),
    favorite: !!state.favorite,
    deleteProtected: !!state.deleteProtected,
  }
}

function numberRevision(row: SharedMetadataRow | undefined): number {
  const value = Number((row as { revision?: number | null } | undefined)?.revision || 0)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function difference(left: string[], right: string[]): string[] {
  const rightSet = new Set(cleanTagNames(right || []))
  return cleanTagNames(left || []).filter((tag) => !rightSet.has(tag))
}

export function mergeSharedMetadataState(options: {
  policy: SharedMetadataMergePolicy | undefined
  existingRow?: SharedMetadataRow
  baseState: SharedMetadataState
  requestedState: SharedMetadataState
}): SharedMetadataMergeResult {
  const policy = options.policy || 'replace'
  const baseState = cleanState(options.baseState)
  const requestedState = cleanState(options.requestedState)
  const existingState = cleanState(stateFromRow(options.existingRow) || baseState)
  const baseRevision = numberRevision(options.existingRow)

  if (policy === 'tags') {
    const addedTags = difference(requestedState.tagNames, baseState.tagNames)
    const removedTags = difference(baseState.tagNames, requestedState.tagNames)
    const removed = new Set(removedTags)
    const mergedTags = cleanTagNames([
      ...existingState.tagNames.filter((tag) => !removed.has(tag)),
      ...addedTags,
    ])
    return {
      state: {
        tagNames: mergedTags,
        favorite: existingState.favorite,
        deleteProtected: existingState.deleteProtected,
      },
      addedTags,
      removedTags,
      baseRevision,
    }
  }

  if (policy === 'favorite') {
    return {
      state: {
        tagNames: existingState.tagNames,
        favorite: requestedState.favorite,
        deleteProtected: existingState.deleteProtected,
      },
      addedTags: [],
      removedTags: [],
      baseRevision,
    }
  }

  if (policy === 'deleteProtected') {
    return {
      state: {
        tagNames: existingState.tagNames,
        favorite: existingState.favorite,
        deleteProtected: requestedState.deleteProtected,
      },
      addedTags: [],
      removedTags: [],
      baseRevision,
    }
  }

  return {
    state: requestedState,
    addedTags: difference(requestedState.tagNames, baseState.tagNames),
    removedTags: difference(baseState.tagNames, requestedState.tagNames),
    baseRevision,
  }
}

export function insertSharedTagOps(options: {
  db: any
  fontId: string
  relativePath: string
  pathKey: string
  addedTags: string[]
  removedTags: string[]
  baseRevision: number
  nextRevision: number
  createdAt: string
  machineId: string
  writerPid: number
}): number {
  const addedTags = cleanTagNames(options.addedTags || [])
  const removedTags = cleanTagNames(options.removedTags || [])
  if (!addedTags.length && !removedTags.length) return 0
  const insert = options.db.prepare(`
    INSERT OR IGNORE INTO shared_tag_ops (
      op_id, font_id, relative_path, path_key, action, tag_name, base_revision, next_revision, created_at, machine_id, writer_pid, tombstone
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  let written = 0
  for (const tagName of addedTags) {
    const result = insert.run(
      randomUUID(),
      options.fontId,
      options.relativePath,
      options.pathKey,
      'addTag',
      tagName,
      options.baseRevision,
      options.nextRevision,
      options.createdAt,
      options.machineId,
      options.writerPid,
      0,
    )
    written += Number(result?.changes || 0)
  }
  for (const tagName of removedTags) {
    const result = insert.run(
      randomUUID(),
      options.fontId,
      options.relativePath,
      options.pathKey,
      'removeTag',
      tagName,
      options.baseRevision,
      options.nextRevision,
      options.createdAt,
      options.machineId,
      options.writerPid,
      1,
    )
    written += Number(result?.changes || 0)
  }
  return written
}
