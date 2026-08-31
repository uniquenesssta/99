import os from 'node:os'
import { basename } from 'node:path'
import type { FontItem, FontTagMutationProtocolResult } from '../../../shared/types'
import type { SharedIndexMutationFailure } from '../sharedIndexMutations'
import type { SharedFontMetadataRuntimeDeps, SharedMetadataCacheSource, SharedMetadataMutationOptions } from './sharedFontMetadataRuntime'
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

export function createSharedMetadataMutationRuntime(deps: SharedMetadataMutationRuntimeDeps) {
  const runtimeDeps = deps.runtimeDeps

  async function updateSharedFontMetadataEntries(
    options: SharedMetadataMutationOptions,
  ): Promise<{ updatedIds: string[]; failed: SharedIndexMutationFailure[]; mutationProtocols?: FontTagMutationProtocolResult[] }> {
    const updatedIds: string[] = []
    const failed: SharedIndexMutationFailure[] = []
    const mutationProtocols: FontTagMutationProtocolResult[] = []
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
              const changedIdSet = new Set((rustResult.changedIds || []).map((id) => String(id || '').trim()).filter(Boolean))
              const changedIds = preparedRows
                .filter((entry) => changedIdSet.has(String(entry.row.fontId || '').trim()))
                .map((entry) => entry.itemId)
              updatedIds.push(...changedIds)
              const stateSignal = emitSharedMetadataMutationStateSignal(runtimeDeps.onSharedMetadataMutationStateSignal, rustResult.stateSignal, root, 'apply', changedIds, 'rust-worker')
              if (rustResult.mutationProtocol) mutationProtocols.push(rustResult.mutationProtocol)
              runtimeDeps.appendStartupLog(`shared metadata mutation wrote by rust: root=${root}, rows=${rustResult.written}, requested=${preparedRows.length}, ${sharedMetadataMutationSignalSummary(stateSignal, root)}`)
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
                updatedIds.push(entry.itemId)
              }
              deps.writeMeta(db, 'updatedAt', now)
              deps.writeMeta(db, 'writerHost', writerHost)
              db.exec('COMMIT')
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
              try { db.exec('ROLLBACK') } catch { /* ignore */ }
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

    return { updatedIds, failed, mutationProtocols }
  }

  async function renameSharedTagInMetadataIndexes(
    oldTagNameInput: string,
    newTagNameInput: string,
    watchedFoldersInput: string[],
  ): Promise<{ updatedIds: string[]; failed: SharedIndexMutationFailure[]; mutationProtocols?: FontTagMutationProtocolResult[] }> {
    const oldTagName = String(oldTagNameInput || '').trim()
    const newTagName = String(newTagNameInput || '').trim()
    const watchedFolders = runtimeDeps.uniqueResolvedFolders(watchedFoldersInput || [])
    const updatedIds: string[] = []
    const failed: SharedIndexMutationFailure[] = []
    const mutationProtocols: FontTagMutationProtocolResult[] = []
    if (!oldTagName || !newTagName) return { updatedIds, failed, mutationProtocols }
    if (oldTagName === newTagName) return { updatedIds, failed, mutationProtocols }

    for (const root of watchedFolders) {
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

          const readDb = await deps.openSharedMetadataDb(root)
          try {
            const rows = readDb.prepare(`
              SELECT font_id, relative_path, path_key, tag_names_json, favorite, delete_protected, revision
              FROM font_metadata
            `).all() as SharedMetadataRow[]
            targets = rows
              .map((row) => {
                const state = stateFromRow(row)
                const previousTags = cleanTagNames(state?.tagNames || [])
                const nextTags = renameTagNames(previousTags, oldTagName, newTagName)
                return { row, previousTags, nextTags }
              })
              .filter((item) => item.previousTags.includes(oldTagName) && !sameTagNames(item.previousTags, item.nextTags))
          } finally {
            runtimeDeps.closeSqliteDb(readDb)
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
              updatedIds.push(...(rustResult.changedIds?.length ? rustResult.changedIds : changedIds))
              const stateSignal = emitSharedMetadataMutationStateSignal(runtimeDeps.onSharedMetadataMutationStateSignal, rustResult.stateSignal, root, 'renameTag', rustResult.changedIds?.length ? rustResult.changedIds : changedIds, 'rust-worker')
              if (rustResult.mutationProtocol) mutationProtocols.push({
                ...rustResult.mutationProtocol,
                mutationKind: rustResult.mutationProtocol.mutationKind || 'renameTag',
              })
              runtimeDeps.appendStartupLog(`shared metadata tag renamed by rust: root=${root}, from=${oldTagName}, to=${newTagName}, rows=${rustResult.written}, ${sharedMetadataMutationSignalSummary(stateSignal, root)}`)
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
                if (row.font_id) updatedIds.push(String(row.font_id))
              }
              deps.writeMeta(db, 'updatedAt', now)
              deps.writeMeta(db, 'writerHost', writerHost)
              db.exec('COMMIT')
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
              try { db.exec('ROLLBACK') } catch { /* ignore */ }
              throw error
            }
          } finally {
            runtimeDeps.closeSqliteDb(db)
          }
        })
      } catch (error) {
        failed.push({
          id: root,
          fileName: basename(root),
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return { updatedIds: Array.from(new Set(updatedIds)), failed, mutationProtocols }
  }

  async function removeSharedTagFromMetadataIndexes(
    tagNameInput: string,
    watchedFoldersInput: string[],
  ): Promise<{ updatedIds: string[]; failed: SharedIndexMutationFailure[]; mutationProtocols?: FontTagMutationProtocolResult[] }> {
    const tagName = String(tagNameInput || '').trim()
    const watchedFolders = runtimeDeps.uniqueResolvedFolders(watchedFoldersInput || [])
    const updatedIds: string[] = []
    const failed: SharedIndexMutationFailure[] = []
    const mutationProtocols: FontTagMutationProtocolResult[] = []
    if (!tagName) return { updatedIds, failed, mutationProtocols }

    for (const root of watchedFolders) {
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
              updatedIds.push(...rustResult.updatedIds)
              const stateSignal = emitSharedMetadataMutationStateSignal(runtimeDeps.onSharedMetadataMutationStateSignal, rustResult.stateSignal, root, 'removeTag', rustResult.updatedIds, 'rust-worker')
              if (rustResult.mutationProtocol) mutationProtocols.push(rustResult.mutationProtocol)
              runtimeDeps.appendStartupLog(`shared metadata tag removed by rust: root=${root}, tag=${tagName}, rows=${rustResult.updated}, ${sharedMetadataMutationSignalSummary(stateSignal, root)}`)
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
                if (row.font_id) updatedIds.push(String(row.font_id))
              }
              deps.writeMeta(db, 'updatedAt', now)
              deps.writeMeta(db, 'writerHost', os.hostname())
              db.exec('COMMIT')
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
              try { db.exec('ROLLBACK') } catch { /* ignore */ }
              throw error
            }
          } finally {
            runtimeDeps.closeSqliteDb(db)
          }
        })
      } catch (error) {
        failed.push({
          id: root,
          fileName: basename(root),
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return { updatedIds: Array.from(new Set(updatedIds)), failed, mutationProtocols }
  }

  return {
    updateSharedFontMetadataEntries,
    renameSharedTagInMetadataIndexes,
    removeSharedTagFromMetadataIndexes,
  }
}
