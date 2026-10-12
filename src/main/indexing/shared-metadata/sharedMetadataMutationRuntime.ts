import { SharedIoProcessError } from '../../path/sharedIoProcessRuntime'
import { logOperation } from '../../logging/operationTraceContext'
import os from 'node:os'
import { basename } from 'node:path'
import type { FontItem, FontTagMutationProtocolResult } from '../../../shared/types'
import type { SharedIndexMutationFailure } from '../sharedIndexMutations'
import type { RustSharedMetadataMutationStateSignal } from '../../rust-core/rustCoreWorkerContracts'
import type { SharedFontMetadataRuntimeDeps, SharedMetadataCacheSource, SharedMetadataMutationOptions, SharedMetadataMutationResult, SharedMetadataCommittedLocator } from './sharedFontMetadataRuntime'
import { applyStateToFont, cleanTagNames, fontPathKey, stateFromFont, stateFromRow, uniqueFontItems, type SharedMetadataRow } from './sharedMetadataStateRuntime'
import { findSharedMetadataMatchedEntry } from './sharedMetadataEntryMatchRuntime'
import { sharedMetadataDbPathForRoot } from './sharedMetadataPathsRuntime'
import { emitSharedMetadataMutationStateSignal, sharedMetadataMutationSignalSummary } from './sharedMetadataMutationSignalRuntime'
import { insertSharedTagOps, mergeSharedMetadataState, type SharedMetadataMergePolicy } from './sharedMetadataFieldMergeRuntime'
import { guardSharedTagStateChange, readSharedTagWriteIntent } from '../../tags/tagDomainGuardRuntime'
import { createTagMutationProtocolResult } from '../../library/tagMutationProtocolResultRuntime'
import {
  logNodeStateFallbackDisabled,
  logNodeStateFallbackUsed,
  nodeStateFallbackCompatibilityAllowed,
  nodeStateFallbackDeniedMessage,
} from '../../rust-core/nodeStateFallbackCompatibilityRuntime'

export interface SharedMetadataMutationRuntimeDeps {
  runtimeDeps: SharedFontMetadataRuntimeDeps
  openSharedMetadataDb: (rootPath: string, touch?: boolean) => Promise<any>
  writeMeta: (db: any, key: string, value: string) => void
  withSharedMetadataWriteLock: <T>(rootPath: string, action: () => Promise<T>) => Promise<T>
  ensureLegacyMetadataImported: (rootPath: string, cache: SharedMetadataCacheSource['cache']) => Promise<void>
}


function sameTagNames(left: string[], right: string[]): boolean {
  const leftTags = cleanTagNames(left)
  const rightTags = cleanTagNames(right)
  return leftTags.length === rightTags.length && leftTags.every((tag, index) => tag === rightTags[index])
}

function renameTagNames(tagNames: string[], oldTagName: string, newTagName: string): string[] {
  const oldTag = String(oldTagName || '').trim()
  const nextTag = String(newTagName || '').trim()
  if (!oldTag || !nextTag || oldTag === nextTag) return cleanTagNames(tagNames || [])
  return cleanTagNames((tagNames || []).map((tag) => String(tag || '').trim() === oldTag ? nextTag : tag))
}

function tagDifference(left: string[], right: string[]): string[] {
  const rightSet = new Set(cleanTagNames(right || []))
  return cleanTagNames(left || []).filter((tag) => !rightSet.has(tag))
}

function sharedMetadataStateUnchanged(existingRow: SharedMetadataRow | undefined, state: { tagNames: string[]; favorite: boolean; deleteProtected: boolean }): boolean {
  if (!existingRow) return !state.tagNames.length && !state.favorite && !state.deleteProtected
  const existingState = stateFromRow(existingRow)
  if (!existingState) return !state.tagNames.length && !state.favorite && !state.deleteProtected
  return sameTagNames(existingState.tagNames, state.tagNames)
    && existingState.favorite === state.favorite
    && existingState.deleteProtected === state.deleteProtected
}

function nodeSharedMetadataMutationProtocol(options: {
  command: string
  mutationKind: string
  message: string
  updatedAt: string
  changedIds: string[]
  rootPath: string
  dbPath: string
  stateSignal?: Record<string, unknown>
  ok?: boolean
}): FontTagMutationProtocolResult {
  return createTagMutationProtocolResult({
    ok: options.ok ?? true,
    message: options.message,
    command: options.command,
    domain: 'sharedMetadata',
    mutationKind: options.mutationKind,
    source: 'node-fallback',
    changedIds: options.changedIds,
    updatedAt: options.updatedAt,
    dbPath: options.dbPath,
    rootPath: options.rootPath,
    cacheInvalidated: true,
    mergedIndexDirty: true,
    pageQueryDirty: true,
    metricsDirty: true,
    stateSignal: options.stateSignal,
    workerMode: `node-fallback:sharedMetadata:${options.mutationKind}`,
  })
}

function inspectCommittedSourceIds(
  receiptIds: unknown,
  changedCount: number,
  preparedSourceIds?: string[],
): { sourceIds: string[]; scopeUnconfirmed: boolean } {
  const rawIds = Array.isArray(receiptIds) ? receiptIds : []
  const validIds = rawIds.filter((id): id is string => typeof id === 'string' && !!id.trim())
  const distinctIds = [...new Set(validIds)]
  const multiplicities = new Map<string, number>()
  for (const id of preparedSourceIds || []) multiplicities.set(id, (multiplicities.get(id) || 0) + 1)
  const matchingIds = preparedSourceIds ? distinctIds.filter((id) => multiplicities.has(id)) : distinctIds
  // Native apply deduplicates IDs after counting changed payload rows. A repeated
  // source key may therefore account for more than one committed row operation.
  const maximumChanges = preparedSourceIds
    ? matchingIds.reduce((total, id) => total + (multiplicities.get(id) || 0), 0)
    : matchingIds.length
  const validCount = Number.isInteger(changedCount) && changedCount >= 0
  const trueNoOp = changedCount === 0 && (receiptIds === undefined || (Array.isArray(receiptIds) && rawIds.length === 0))
  const scopeUnconfirmed = !trueNoOp && (
    !validCount || (receiptIds !== undefined && !Array.isArray(receiptIds))
    || changedCount < distinctIds.length || changedCount > maximumChanges
    || validIds.length !== rawIds.length || distinctIds.length !== rawIds.length
    || matchingIds.length !== distinctIds.length
  )
  // Contradictory zero/low counts cannot acknowledge particular input items.
  const sourceIds = validCount && changedCount >= distinctIds.length && changedCount > 0 ? matchingIds : []
  return { sourceIds, scopeUnconfirmed }
}

function confirmedMutationSignal(
  signal: RustSharedMetadataMutationStateSignal | undefined,
  scope: ReturnType<typeof inspectCommittedSourceIds>,
): RustSharedMetadataMutationStateSignal | undefined {
  if (!scope.scopeUnconfirmed) return { ...signal, changedIds: scope.sourceIds }
  return {
    ...signal,
    changedIds: scope.sourceIds,
    sharedMetadataChanged: true,
    cacheInvalidated: true,
    mergedIndexDirty: true,
    pageQueryDirty: true,
    metricsDirty: true,
  }
}

function confirmedMutationProtocol(
  protocol: FontTagMutationProtocolResult,
  scope: ReturnType<typeof inspectCommittedSourceIds>,
  stateSignal: RustSharedMetadataMutationStateSignal,
): FontTagMutationProtocolResult {
  if (!scope.scopeUnconfirmed) return { ...protocol, changedIds: scope.sourceIds, stateSignal: stateSignal as Record<string, unknown> }
  return {
    ...protocol,
    changedIds: scope.sourceIds,
    message: '共享写入已提交，但影响范围尚未完全确认，请重新读取受影响文件夹。',
    cacheInvalidated: true,
    mergedIndexDirty: true,
    pageQueryDirty: true,
    metricsDirty: true,
    stateSignal: stateSignal as Record<string, unknown>,
  }
}

export function createSharedMetadataMutationRuntime(deps: SharedMetadataMutationRuntimeDeps) {
  const runtimeDeps = deps.runtimeDeps
  const appendAfterCommit = (message: string): void => {
    try { runtimeDeps.appendStartupLog(message) } catch { /* A committed write must not become a retryable failure because logging failed. */ }
  }

  async function updateSharedFontMetadataEntries(
    options: SharedMetadataMutationOptions,
  ): Promise<SharedMetadataMutationResult> {
    const updatedIds: string[] = []
    const failed: SharedIndexMutationFailure[] = []
    const mutationProtocols: FontTagMutationProtocolResult[] = []
    const committedLocators: SharedMetadataCommittedLocator[] = []
    const committedRefreshRoots: string[] = []
    const watchedFolders = options.watchedFolders || []
    const groups = new Map<string, FontItem[]>()

    for (const item of uniqueFontItems(options.items)) {
      const fileName = item.fileName || (item.path ? basename(item.path) : item.id)
      try {
        if (!item.path) throw new Error(options.emptyPathMessage)
        const root = runtimeDeps.findBestWatchedRootForFile(item.path, watchedFolders)
        if (!root) throw new Error(options.outsideRootMessage)
        const list = groups.get(root) || []
        list.push(item)
        groups.set(root, list)
      } catch (error) {
        failed.push({
          id: item.id,
          fileName,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    for (const [root, items] of groups) {
      let cacheSource: SharedMetadataCacheSource | null = null
      let syntheticMatches = 0
      let committed = false
      try {
        cacheSource = await runtimeDeps.loadExistingFolderCache(root)
        if (!cacheSource) throw new Error(options.missingIndexMessage)
        await deps.ensureLegacyMetadataImported(root, cacheSource.cache)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        for (const item of items) failed.push({
          id: item.id,
          fileName: item.fileName || (item.path ? basename(item.path) : item.id),
          message,
        })
        continue
      }

      try {
        await deps.withSharedMetadataWriteLock(root, async () => {
          const now = new Date().toISOString()
          const writerHost = os.hostname()
          const preparedRows: Array<{
            itemId: string
            row: {
              fontId: string
              relativePath: string
              pathKey: string
              tagNamesJson: string
              favorite: boolean
              deleteProtected: boolean
              eventType: string
              payloadJson: string
              baseTagNamesJson: string
              mergePolicy: SharedMetadataMergePolicy
            }
          }> = []

          for (const item of items) {
            const fileName = item.fileName || (item.path ? basename(item.path) : item.id)
            try {
              const matched = findSharedMetadataMatchedEntry(runtimeDeps, root, cacheSource!, item)
              if (!matched) throw new Error(options.missingEntryMessage)
              if (matched.synthetic) syntheticMatches += 1
              const baseState = stateFromFont(matched.font)
              const baseFont = applyStateToFont(matched.font, baseState)
              const nextFont = options.mutateFont(baseFont, item)
              const state = stateFromFont(nextFont)
              if (options.mergePolicy === 'tags') {
                const intent = readSharedTagWriteIntent(item)
                const guard = guardSharedTagStateChange({
                  policy: options.mergePolicy,
                  baseTags: baseState.tagNames,
                  requestedTags: state.tagNames,
                  intent,
                })
                if (!guard.allowed) {
                  const message = guard.message || '共享标签保护层拦截了未声明意图的破坏性覆盖。'
                  runtimeDeps.appendStartupLog(`shared tag domain guard blocked: root=${root}, font=${item.id}, removed=${guard.removedTags.join('|') || '-'}, added=${guard.addedTags.join('|') || '-'}, message=${message}`)
                  failed.push({ id: item.id, fileName, message })
                  continue
                }
              }
              preparedRows.push({
                itemId: item.id,
                row: {
                  fontId: matched.font.id || item.id,
                  relativePath: matched.relativePath,
                  pathKey: fontPathKey(matched.font, runtimeDeps.cacheEntryRuntimePath(root, matched.entry.path || matched.relativePath)),
                  tagNamesJson: JSON.stringify(state.tagNames),
                  favorite: state.favorite,
                  deleteProtected: state.deleteProtected,
                  eventType: 'update',
                  payloadJson: JSON.stringify(state),
                  baseTagNamesJson: JSON.stringify(baseState.tagNames),
                  mergePolicy: options.mergePolicy || 'replace',
                },
              })
            } catch (error) {
              failed.push({
                id: item.id,
                fileName,
                message: error instanceof Error ? error.message : String(error),
              })
            }
          }

          if (!preparedRows.length) return

          if (runtimeDeps.runRustSharedMetadataApply) {
            const rustResult = await runtimeDeps.runRustSharedMetadataApply({
              dbPath: sharedMetadataDbPathForRoot(root),
              rootPath: root,
              updatedAt: now,
              updatedBy: writerHost,
              writerPid: process.pid,
              rows: preparedRows.map((entry) => entry.row),
            })
            if (rustResult) {
              committed = true
              const scope = inspectCommittedSourceIds(rustResult.changedIds, rustResult.written, preparedRows.map((entry) => entry.row.fontId.trim()))
              if (scope.scopeUnconfirmed) {
                committedRefreshRoots.push(root)
                appendAfterCommit(`shared metadata committed scope unconfirmed: root=${root}, kind=apply, written=${rustResult.written}; root refresh required, do not retry committed write`)
              }
              const changedIdSet = new Set(scope.sourceIds)
              // Rust persists trimmed source IDs; Node compatibility keeps its exact key.
              const changedRows = preparedRows
                .map((entry) => ({ entry, sourceFontId: entry.row.fontId.trim() }))
                .filter(({ sourceFontId }) => changedIdSet.has(sourceFontId))
              const changedIds = changedRows.map(({ entry }) => entry.itemId)
              updatedIds.push(...changedIds)
              committedLocators.push(...changedRows.map(({ sourceFontId }) => ({ rootPath: root, sourceFontId })))
              const stateSignal = emitSharedMetadataMutationStateSignal(runtimeDeps.onSharedMetadataMutationStateSignal, confirmedMutationSignal(rustResult.stateSignal, scope), root, 'apply', changedIds, 'rust-worker')
              if (rustResult.mutationProtocol) mutationProtocols.push(confirmedMutationProtocol(rustResult.mutationProtocol, scope, stateSignal))
              appendAfterCommit(`shared metadata mutation wrote by rust: root=${root}, rows=${rustResult.written}, requested=${preparedRows.length}, ${sharedMetadataMutationSignalSummary(stateSignal, root)}`)
              return
            }
          }
          if (!nodeStateFallbackCompatibilityAllowed()) {
            logNodeStateFallbackDisabled({
              appendStartupLog: runtimeDeps.appendStartupLog,
              source: 'shared-metadata-apply',
              reason: 'rust-apply-returned-empty',
            })
            throw new Error(nodeStateFallbackDeniedMessage('shared-metadata-apply'))
          }
          logNodeStateFallbackUsed({
            appendStartupLog: runtimeDeps.appendStartupLog,
            source: 'shared-metadata-apply',
            detail: `root=${root}, rows=${preparedRows.length}`,
          })

          const db = await deps.openSharedMetadataDb(root)
          try {
            logOperation({ stage: 'backend-start', backend: 'node' })
            db.exec('BEGIN IMMEDIATE')
            try {
              const upsert = db.prepare(`
                INSERT INTO font_metadata (
                  font_id, relative_path, path_key, tag_names_json, favorite, delete_protected, revision, updated_at, updated_by
                ) VALUES (@font_id, @relative_path, @path_key, @tag_names_json, @favorite, @delete_protected, 1, @updated_at, @updated_by)
                ON CONFLICT(font_id) DO UPDATE SET
                  relative_path = excluded.relative_path,
                  path_key = excluded.path_key,
                  tag_names_json = excluded.tag_names_json,
                  favorite = excluded.favorite,
                  delete_protected = excluded.delete_protected,
                  revision = COALESCE(font_metadata.revision, 0) + 1,
                  updated_at = excluded.updated_at,
                  updated_by = excluded.updated_by
              `)
              const eventInsert = db.prepare(`
                INSERT INTO metadata_events (event_type, font_id, relative_path, payload_json, created_at, writer_host, writer_pid)
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `)
              const selectExisting = db.prepare(`
                SELECT font_id, relative_path, path_key, tag_names_json, favorite, delete_protected, revision
                FROM font_metadata
                WHERE font_id = ?
              `)
              const changedIds: string[] = []
              const changedSourceIds: string[] = []
              for (const entry of preparedRows) {
                const existingRow = selectExisting.get(entry.row.fontId) as SharedMetadataRow | undefined
                const requestedState = {
                  tagNames: cleanTagNames(JSON.parse(entry.row.tagNamesJson || '[]')),
                  favorite: entry.row.favorite,
                  deleteProtected: entry.row.deleteProtected,
                }
                const baseState = {
                  tagNames: cleanTagNames(JSON.parse(entry.row.baseTagNamesJson || '[]')),
                  favorite: requestedState.favorite,
                  deleteProtected: requestedState.deleteProtected,
                }
                const mergeResult = mergeSharedMetadataState({
                  policy: entry.row.mergePolicy,
                  existingRow,
                  baseState,
                  requestedState,
                })
                if (sharedMetadataStateUnchanged(existingRow, mergeResult.state)) continue
                const nextRevision = mergeResult.baseRevision > 0 ? mergeResult.baseRevision + 1 : 1
                upsert.run({
                  font_id: entry.row.fontId,
                  relative_path: entry.row.relativePath,
                  path_key: entry.row.pathKey,
                  tag_names_json: JSON.stringify(mergeResult.state.tagNames),
                  favorite: mergeResult.state.favorite ? 1 : 0,
                  delete_protected: mergeResult.state.deleteProtected ? 1 : 0,
                  updated_at: now,
                  updated_by: writerHost,
                })
                insertSharedTagOps({
                  db,
                  fontId: entry.row.fontId,
                  relativePath: entry.row.relativePath,
                  pathKey: entry.row.pathKey,
                  addedTags: mergeResult.addedTags,
                  removedTags: mergeResult.removedTags,
                  baseRevision: mergeResult.baseRevision,
                  nextRevision,
                  createdAt: now,
                  machineId: writerHost,
                  writerPid: process.pid,
                })
                eventInsert.run(entry.row.eventType, entry.row.fontId, entry.row.relativePath, JSON.stringify(mergeResult.state), now, writerHost, process.pid)
                changedIds.push(entry.itemId)
                changedSourceIds.push(entry.row.fontId)
              }
              deps.writeMeta(db, 'updatedAt', now)
              deps.writeMeta(db, 'writerHost', writerHost)
              db.exec('COMMIT')
              committed = true
              updatedIds.push(...changedIds)
              committedLocators.push(...changedSourceIds.map((sourceFontId) => ({ rootPath: root, sourceFontId })))
              logOperation({ stage: 'commit', outcome: 'committed', backend: 'node', reason: 'shared-metadata-transaction' })
              const stateSignal = emitSharedMetadataMutationStateSignal(runtimeDeps.onSharedMetadataMutationStateSignal, undefined, root, 'apply', changedIds, 'node-fallback')
              mutationProtocols.push(nodeSharedMetadataMutationProtocol({
                command: '--shared-metadata-apply',
                mutationKind: 'apply',
                message: `shared metadata node fallback applied ${changedIds.length} rows`,
                updatedAt: now,
                changedIds,
                rootPath: root,
                dbPath: sharedMetadataDbPathForRoot(root),
                stateSignal: stateSignal as Record<string, unknown>,
              }))
              try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);') } catch { /* ignore */ }
            } catch (error) {
              if (!committed) {
                try { db.exec('ROLLBACK') } catch { /* ignore */ }
              }
              throw error
            }
          } finally {
            runtimeDeps.closeSqliteDb(db)
          }
        })
        if (syntheticMatches > 0) {
          runtimeDeps.appendStartupLog(`shared metadata mutation used path fallback: root=${root}, rows=${syntheticMatches}`)
        }
      } catch (error) {
        if (committed) {
          appendAfterCommit(`shared metadata post-commit work deferred: root=${root}, cause=${String(error)}; do not retry committed write`)
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        for (const item of items) {
          if (updatedIds.includes(item.id)) continue
          failed.push({
            id: item.id,
            fileName: item.fileName || (item.path ? basename(item.path) : item.id),
            message,
          })
        }
      }
    }

    return { updatedIds, failed, mutationProtocols, committedLocators, committedRefreshRoots }
  }

  async function renameSharedTagInMetadataIndexes(
    oldTagNameInput: string,
    newTagNameInput: string,
    watchedFoldersInput: string[],
  ): Promise<SharedMetadataMutationResult> {
    const oldTagName = String(oldTagNameInput || '').trim()
    const newTagName = String(newTagNameInput || '').trim()
    const watchedFolders = runtimeDeps.uniqueResolvedFolders(watchedFoldersInput || [])
    const updatedIds: string[] = []
    const failed: SharedIndexMutationFailure[] = []
    const mutationProtocols: FontTagMutationProtocolResult[] = []
    const committedLocators: SharedMetadataCommittedLocator[] = []
    const committedRefreshRoots: string[] = []
    if (!oldTagName || !newTagName) return { updatedIds, failed, mutationProtocols, committedLocators, committedRefreshRoots }
    if (oldTagName === newTagName) return { updatedIds, failed, mutationProtocols, committedLocators, committedRefreshRoots }

    for (const root of watchedFolders) {
      let committed = false
      try {
        const cacheSource = await runtimeDeps.loadExistingFolderCache(root, { applySharedMetadataOverlay: false })
        if (!cacheSource) throw new Error('没有找到共享索引库，请先更新索引。')
        await deps.ensureLegacyMetadataImported(root, cacheSource.cache)
        await deps.withSharedMetadataWriteLock(root, async () => {
          let targets: Array<{
            row: SharedMetadataRow
            previousTags: string[]
            nextTags: string[]
          }> = []

          let readDb: any
          try {
            let rows: SharedMetadataRow[]
            if (runtimeDeps.runRustSharedMetadataOverlayRead) {
              const result = await runtimeDeps.runRustSharedMetadataOverlayRead({ rootPath: root, dbPath: sharedMetadataDbPathForRoot(root), entries: [], preflight: {phase:'snapshot',updatedAt:new Date().toISOString(),updatedBy:os.hostname(),writerPid:process.pid} })
              if (!result?.preflight?.snapshot?.rows) throw new SharedIoProcessError('共享重命名快照未确认。','unknown','invalid-receipt')
              rows = result.preflight.snapshot.rows
            } else {
              readDb = await deps.openSharedMetadataDb(root)
              rows = readDb.prepare('SELECT font_id, relative_path, path_key, tag_names_json, favorite, delete_protected, revision FROM font_metadata').all()
            }
            targets = rows
              .map((row) => {
                const state = stateFromRow(row)
                const previousTags = cleanTagNames(state?.tagNames || [])
                const nextTags = renameTagNames(previousTags, oldTagName, newTagName)
                return { row, previousTags, nextTags }
              })
              .filter((item) => item.previousTags.includes(oldTagName) && !sameTagNames(item.previousTags, item.nextTags))
          } finally {
            if (readDb) runtimeDeps.closeSqliteDb(readDb)
          }

          if (!targets.length) return

          const now = new Date().toISOString()
          const writerHost = os.hostname()
          const changedIds = targets.map((target) => String(target.row.font_id || '')).filter(Boolean)

          if (runtimeDeps.runRustSharedMetadataApply) {
            const rustResult = await runtimeDeps.runRustSharedMetadataApply({
              dbPath: sharedMetadataDbPathForRoot(root),
              rootPath: root,
              updatedAt: now,
              updatedBy: writerHost,
              writerPid: process.pid,
              rows: targets.map((target) => ({
                fontId: String(target.row.font_id || ''),
                relativePath: String(target.row.relative_path || ''),
                pathKey: String(target.row.path_key || ''),
                tagNamesJson: JSON.stringify(target.nextTags),
                favorite: !!target.row.favorite,
                deleteProtected: !!target.row.delete_protected,
                eventType: 'rename_tag',
                payloadJson: JSON.stringify({ oldTagName, newTagName, previousTags: target.previousTags, nextTags: target.nextTags }),
                baseTagNamesJson: JSON.stringify(target.previousTags),
                mergePolicy: 'tags',
              })),
            })
            if (rustResult) {
              committed = true
              const scope = inspectCommittedSourceIds(rustResult.changedIds, rustResult.written, changedIds.map((id) => id.trim()))
              if (scope.scopeUnconfirmed) {
                committedRefreshRoots.push(root)
                appendAfterCommit(`shared metadata committed scope unconfirmed: root=${root}, kind=renameTag, written=${rustResult.written}; root refresh required, do not retry committed write`)
              }
              const committedIds = scope.sourceIds
              updatedIds.push(...committedIds)
              committedLocators.push(...committedIds.map((sourceFontId) => ({ rootPath: root, sourceFontId })))
              const stateSignal = emitSharedMetadataMutationStateSignal(runtimeDeps.onSharedMetadataMutationStateSignal, confirmedMutationSignal(rustResult.stateSignal, scope), root, 'renameTag', committedIds, 'rust-worker')
              if (rustResult.mutationProtocol) mutationProtocols.push(confirmedMutationProtocol({
                ...rustResult.mutationProtocol,
                mutationKind: rustResult.mutationProtocol.mutationKind || 'renameTag',
              }, scope, stateSignal))
              appendAfterCommit(`shared metadata tag renamed by rust: root=${root}, from=${oldTagName}, to=${newTagName}, rows=${rustResult.written}, ${sharedMetadataMutationSignalSummary(stateSignal, root)}`)
              return
            }
          }

          if (!nodeStateFallbackCompatibilityAllowed()) {
            logNodeStateFallbackDisabled({
              appendStartupLog: runtimeDeps.appendStartupLog,
              source: 'shared-metadata-rename-tag',
              reason: 'rust-rename-tag-returned-empty',
            })
            throw new Error(nodeStateFallbackDeniedMessage('shared-metadata-rename-tag'))
          }
          logNodeStateFallbackUsed({
            appendStartupLog: runtimeDeps.appendStartupLog,
            source: 'shared-metadata-rename-tag',
            detail: `root=${root}, from=${oldTagName}, to=${newTagName}`,
          })

          const db = await deps.openSharedMetadataDb(root)
          try {
            logOperation({ stage: 'backend-start', backend: 'node' })
            db.exec('BEGIN IMMEDIATE')
            try {
              const update = db.prepare(`
                UPDATE font_metadata
                SET tag_names_json = ?, revision = COALESCE(revision, 0) + 1, updated_at = ?, updated_by = ?
                WHERE font_id = ?
              `)
              const eventInsert = db.prepare(`
                INSERT INTO metadata_events (event_type, font_id, relative_path, payload_json, created_at, writer_host, writer_pid)
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `)
              for (const target of targets) {
                const row = target.row
                const baseRevision = Number(row.revision || 0)
                const nextRevision = baseRevision > 0 ? baseRevision + 1 : 1
                update.run(JSON.stringify(target.nextTags), now, writerHost, row.font_id)
                insertSharedTagOps({
                  db,
                  fontId: String(row.font_id || ''),
                  relativePath: String(row.relative_path || ''),
                  pathKey: String(row.path_key || ''),
                  addedTags: tagDifference(target.nextTags, target.previousTags),
                  removedTags: tagDifference(target.previousTags, target.nextTags),
                  baseRevision,
                  nextRevision,
                  createdAt: now,
                  machineId: writerHost,
                  writerPid: process.pid,
                })
                eventInsert.run('rename_tag', row.font_id, row.relative_path, JSON.stringify({ oldTagName, newTagName, previousTags: target.previousTags, nextTags: target.nextTags, baseRevision, nextRevision }), now, writerHost, process.pid)
              }
              deps.writeMeta(db, 'updatedAt', now)
              deps.writeMeta(db, 'writerHost', writerHost)
              db.exec('COMMIT')
              committed = true
              updatedIds.push(...changedIds)
              committedLocators.push(...changedIds.map((sourceFontId) => ({ rootPath: root, sourceFontId })))
              logOperation({ stage: 'commit', outcome: 'committed', backend: 'node', reason: 'shared-metadata-transaction' })
              const stateSignal = emitSharedMetadataMutationStateSignal(runtimeDeps.onSharedMetadataMutationStateSignal, undefined, root, 'renameTag', changedIds, 'node-fallback')
              mutationProtocols.push(nodeSharedMetadataMutationProtocol({
                command: '--shared-metadata-rename-tag',
                mutationKind: 'renameTag',
                message: `shared metadata node fallback renamed tag on ${changedIds.length} rows`,
                updatedAt: now,
                changedIds,
                rootPath: root,
                dbPath: sharedMetadataDbPathForRoot(root),
                stateSignal: stateSignal as Record<string, unknown>,
              }))
              try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);') } catch { /* ignore */ }
            } catch (error) {
              if (!committed) {
                try { db.exec('ROLLBACK') } catch { /* ignore */ }
              }
              throw error
            }
          } finally {
            runtimeDeps.closeSqliteDb(db)
          }
        })
      } catch (error) {
        if (committed) {
          appendAfterCommit(`shared metadata post-commit work deferred: root=${root}, cause=${String(error)}; do not retry committed write`)
          continue
        }
        failed.push({
          id: root,
          fileName: basename(root),
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return { updatedIds: Array.from(new Set(updatedIds)), failed, mutationProtocols, committedLocators, committedRefreshRoots }
  }

  async function removeSharedTagFromMetadataIndexes(
    tagNameInput: string,
    watchedFoldersInput: string[],
  ): Promise<SharedMetadataMutationResult> {
    const tagName = String(tagNameInput || '').trim()
    const watchedFolders = runtimeDeps.uniqueResolvedFolders(watchedFoldersInput || [])
    const updatedIds: string[] = []
    const failed: SharedIndexMutationFailure[] = []
    const mutationProtocols: FontTagMutationProtocolResult[] = []
    const committedLocators: SharedMetadataCommittedLocator[] = []
    const committedRefreshRoots: string[] = []
    if (!tagName) return { updatedIds, failed, mutationProtocols, committedLocators, committedRefreshRoots }

    for (const root of watchedFolders) {
      let committed = false
      try {
        const cacheSource = await runtimeDeps.loadExistingFolderCache(root, { applySharedMetadataOverlay: false })
        if (!cacheSource) throw new Error('没有找到共享索引库，请先更新索引。')
        await deps.ensureLegacyMetadataImported(root, cacheSource.cache)
        await deps.withSharedMetadataWriteLock(root, async () => {
          if (runtimeDeps.runRustSharedMetadataRemoveTag) {
            const now = new Date().toISOString()
            const rustResult = await runtimeDeps.runRustSharedMetadataRemoveTag({
              dbPath: sharedMetadataDbPathForRoot(root),
              rootPath: root,
              tagName,
              updatedAt: now,
              updatedBy: os.hostname(),
              writerPid: process.pid,
            })
            if (rustResult) {
              committed = true
              const scope = inspectCommittedSourceIds(rustResult.updatedIds, rustResult.updated)
              if (scope.scopeUnconfirmed) {
                committedRefreshRoots.push(root)
                appendAfterCommit(`shared metadata committed scope unconfirmed: root=${root}, kind=removeTag, written=${rustResult.updated}; root refresh required, do not retry committed write`)
              }
              updatedIds.push(...scope.sourceIds)
              committedLocators.push(...scope.sourceIds.map((sourceFontId) => ({ rootPath: root, sourceFontId })))
              const stateSignal = emitSharedMetadataMutationStateSignal(runtimeDeps.onSharedMetadataMutationStateSignal, confirmedMutationSignal(rustResult.stateSignal, scope), root, 'removeTag', scope.sourceIds, 'rust-worker')
              if (rustResult.mutationProtocol) mutationProtocols.push(confirmedMutationProtocol(rustResult.mutationProtocol, scope, stateSignal))
              appendAfterCommit(`shared metadata tag removed by rust: root=${root}, tag=${tagName}, rows=${rustResult.updated}, ${sharedMetadataMutationSignalSummary(stateSignal, root)}`)
              return
            }
          }
          if (!nodeStateFallbackCompatibilityAllowed()) {
            logNodeStateFallbackDisabled({
              appendStartupLog: runtimeDeps.appendStartupLog,
              source: 'shared-metadata-remove-tag',
              reason: 'rust-remove-tag-returned-empty',
            })
            throw new Error(nodeStateFallbackDeniedMessage('shared-metadata-remove-tag'))
          }
          logNodeStateFallbackUsed({
            appendStartupLog: runtimeDeps.appendStartupLog,
            source: 'shared-metadata-remove-tag',
            detail: `root=${root}, tag=${tagName}`,
          })

          const db = await deps.openSharedMetadataDb(root)
          try {
            const rows = db.prepare(`
              SELECT font_id, relative_path, path_key, tag_names_json, favorite, delete_protected, revision
              FROM font_metadata
            `).all() as SharedMetadataRow[]
            const targets = rows
              .map((row) => ({ row, state: stateFromRow(row) }))
              .filter((item) => item.state?.tagNames.includes(tagName))
            if (!targets.length) return

            logOperation({ stage: 'backend-start', backend: 'node' })
            db.exec('BEGIN IMMEDIATE')
            try {
              const now = new Date().toISOString()
              const update = db.prepare(`
                UPDATE font_metadata
                SET tag_names_json = ?, revision = COALESCE(revision, 0) + 1, updated_at = ?, updated_by = ?
                WHERE font_id = ?
              `)
              const eventInsert = db.prepare(`
                INSERT INTO metadata_events (event_type, font_id, relative_path, payload_json, created_at, writer_host, writer_pid)
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `)
              const changedIds = targets.map((target) => String(target.row.font_id || '')).filter(Boolean)
              for (const target of targets) {
                const row = target.row
                const previousTags = cleanTagNames(target.state?.tagNames || [])
                const nextTags = cleanTagNames(previousTags.filter((tag) => tag !== tagName))
                const baseRevision = Number(row.revision || 0)
                const nextRevision = baseRevision > 0 ? baseRevision + 1 : 1
                update.run(JSON.stringify(nextTags), now, os.hostname(), row.font_id)
                insertSharedTagOps({
                  db,
                  fontId: String(row.font_id || ''),
                  relativePath: String(row.relative_path || ''),
                  pathKey: String(row.path_key || ''),
                  addedTags: [],
                  removedTags: [tagName],
                  baseRevision,
                  nextRevision,
                  createdAt: now,
                  machineId: os.hostname(),
                  writerPid: process.pid,
                })
                eventInsert.run('delete_tag', row.font_id, row.relative_path, JSON.stringify({ tagName, previousTags, nextTags, baseRevision, nextRevision }), now, os.hostname(), process.pid)
              }
              deps.writeMeta(db, 'updatedAt', now)
              deps.writeMeta(db, 'writerHost', os.hostname())
              db.exec('COMMIT')
              committed = true
              updatedIds.push(...changedIds)
              committedLocators.push(...changedIds.map((sourceFontId) => ({ rootPath: root, sourceFontId })))
              logOperation({ stage: 'commit', outcome: 'committed', backend: 'node', reason: 'shared-metadata-transaction' })
              const stateSignal = emitSharedMetadataMutationStateSignal(runtimeDeps.onSharedMetadataMutationStateSignal, undefined, root, 'removeTag', changedIds, 'node-fallback')
              mutationProtocols.push(nodeSharedMetadataMutationProtocol({
                command: '--shared-metadata-remove-tag',
                mutationKind: 'removeTag',
                message: `shared metadata node fallback removed tag from ${changedIds.length} rows`,
                updatedAt: now,
                changedIds,
                rootPath: root,
                dbPath: sharedMetadataDbPathForRoot(root),
                stateSignal: stateSignal as Record<string, unknown>,
              }))
              try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);') } catch { /* ignore */ }
            } catch (error) {
              if (!committed) {
                try { db.exec('ROLLBACK') } catch { /* ignore */ }
              }
              throw error
            }
          } finally {
            runtimeDeps.closeSqliteDb(db)
          }
        })
      } catch (error) {
        if (committed) {
          appendAfterCommit(`shared metadata post-commit work deferred: root=${root}, cause=${String(error)}; do not retry committed write`)
          continue
        }
        failed.push({
          id: root,
          fileName: basename(root),
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return { updatedIds: Array.from(new Set(updatedIds)), failed, mutationProtocols, committedLocators, committedRefreshRoots }
  }

  return {
    updateSharedFontMetadataEntries,
    renameSharedTagInMetadataIndexes,
    removeSharedTagFromMetadataIndexes,
  }
}
