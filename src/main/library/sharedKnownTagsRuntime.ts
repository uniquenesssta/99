import { sharedFileSystem as fsp } from '../path/sharedFileSystemRuntime'
import { getStartupPathRootState } from '../path/startupPathAvailabilityRuntime'
import { SHARED_ROOT_CATALOG_KEY, readSharedRootCatalog, mergeSharedRootCatalog, sharedCatalogRootId, type SharedRootCatalog, type ConfirmedRootCatalog } from './runtime/sharedRootCatalogRuntime'
import type { LibraryShell } from '../../shared/types'
import { filterStartupAvailableRoots } from '../path/startupPathAvailabilityRuntime'
import { sharedMetadataQueryTimeoutMs, withIoDeadlineResult } from '../path/ioDeadlineRuntime'
import {
  logNodeStateFallbackDisabled,
  logNodeStateFallbackUsed,
  nodeStateFallbackCompatibilityAllowed,
} from '../rust-core/nodeStateFallbackCompatibilityRuntime'

export interface SharedKnownTagsRefreshOptions {
  requireFresh?: boolean
  allowEmptyOverwrite?: boolean
  preserveTags?: string[]
  dropTags?: string[]
}

export interface SharedKnownTagRenameIfUnboundResult {
  renamed: boolean
  reason: string
  previousTags: string[]
  nextTags: string[]
}

export interface SharedKnownTagDeleteIfUnboundResult {
  deleted: boolean
  reason: string
  previousTags: string[]
  nextTags: string[]
}

export interface SharedKnownTagsRuntimeDeps {
  uniqueResolvedFolders: (folders: string[]) => string[]
  sharedMetadataDbPathForRoot: (rootPath: string) => string
  exists: (filePath: string) => Promise<boolean>
  openSharedMetadataDb: (rootPath: string, touch?: boolean) => Promise<any>
  closeSqliteDb: (db: any) => void
  openLibraryDb: () => Promise<any>
  loadLibraryShellFromSqlite: (db: any) => LibraryShell
  appendStartupLog: (message: string) => void
  runRustSharedMetadataKnownTags?: (input: { roots: Array<{ rootPath: string; dbPath: string }> }) => Promise<{ knownTags: string[]; roots?: Array<{ rootPath: string; dbPath: string; signature: string; knownTags: string[]; rows: number }> } | null>
}

function cleanTagName(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

export function createSharedKnownTagsRuntime(deps: SharedKnownTagsRuntimeDeps) {
  let revision = 0
  async function metadataFileMissingConfirmed(rootPath: string): Promise<boolean> {
    const result = await withIoDeadlineResult('shared-metadata-missing-confirm', async () => {
      try { await fsp.stat(deps.sharedMetadataDbPathForRoot(rootPath)); return false } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      // A failed exists() is not proof of an empty directory.
      return (await fsp.stat(rootPath)).isDirectory()
    }, sharedMetadataQueryTimeoutMs())
    return result.ok && result.value
  }

  async function readMetadataTagsForRoot(rootPath: string): Promise<string[]> {
    if (await metadataFileMissingConfirmed(rootPath)) return []
    await fsp.stat(deps.sharedMetadataDbPathForRoot(rootPath))
    const db = await deps.openSharedMetadataDb(rootPath, false)
    try {
      const rows = db.prepare('SELECT tag_names_json FROM font_metadata').all() as Array<{ tag_names_json?: string | null }>
      const tags = new Set<string>()
      for (const row of rows) {
        const parsed = JSON.parse(String(row.tag_names_json || '[]'))
        if (!Array.isArray(parsed) || !parsed.every(tag => typeof tag === 'string')) throw new Error('Invalid shared metadata tags')
        for (const tag of parsed.map(cleanTagName).filter(Boolean)) tags.add(tag)
      }
      return Array.from(tags)
    } finally {
      deps.closeSqliteDb(db)
    }
  }

  async function readPersistedSharedTags(): Promise<string[]> {
    const db = await deps.openLibraryDb()
    return deps.loadLibraryShellFromSqlite(db).tags || []
  }

  async function persistKnownSharedTags(roots: string[], nextTags: string[], source: string, catalog?: SharedRootCatalog, isCurrent: () => boolean = () => true): Promise<string[]> {
    const db = await deps.openLibraryDb()
    const previous = deps.loadLibraryShellFromSqlite(db).tags || []
    if (!isCurrent()) return previous
    const previousKey = previous.join('\u0000')
    const nextKey = nextTags.join('\u0000')
    if (previousKey !== nextKey || catalog) {
      const tx = db.transaction(() => {
        if (previousKey !== nextKey) {
          db.prepare('DELETE FROM tags').run()
          const insert = db.prepare('INSERT INTO tags (name, sort_order) VALUES (?, ?)')
          nextTags.forEach((tag, index) => insert.run(tag, index))
        }
        const snapshot = catalog || { version: 1, roots: [], unattributedTags: nextTags, publishedTags: nextTags }
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(SHARED_ROOT_CATALOG_KEY, JSON.stringify(snapshot))
      })
      tx()
      deps.appendStartupLog(`shared known tags refreshed from metadata: source=${source}, roots=${roots.length}, tags=${nextTags.length}`)
    }
    return nextTags
  }


  async function metadataRootHasTagBinding(rootPath: string, tagName: string): Promise<boolean> {
    try { return (await readMetadataTagsForRoot(rootPath)).includes(tagName) } catch { return true }
  }

  async function renameKnownSharedTagIfUnbound(
    watchedFoldersInput: string[],
    oldTagNameInput: string,
    newTagNameInput: string,
  ): Promise<SharedKnownTagRenameIfUnboundResult> {
    const operationRevision = ++revision
    const startedAt = Date.now()
    const oldTagName = cleanTagName(oldTagNameInput)
    const newTagName = cleanTagName(newTagNameInput)
    const previousTags = (await readPersistedSharedTags()).map(cleanTagName).filter(Boolean)
    if (!oldTagName || !newTagName) return { renamed: false, reason: 'empty-name', previousTags, nextTags: previousTags }
    if (oldTagName === newTagName) return { renamed: true, reason: 'same-name', previousTags, nextTags: previousTags }

    const roots = deps.uniqueResolvedFolders(watchedFoldersInput || [])
    const { availableRoots, skippedRoots } = await filterStartupAvailableRoots(roots, deps.appendStartupLog, 'shared-known-tag-zero-rename')
    const generations = new Map(availableRoots.map(root => [root, getStartupPathRootState(root).generation]))
    if (skippedRoots.length) {
      deps.appendStartupLog(`shared known tag zero-bind rename skipped: reason=unavailable-root, old=${oldTagName}, new=${newTagName}, skipped=${skippedRoots.length}, available=${availableRoots.length}`)
      return { renamed: false, reason: 'unavailable-root', previousTags, nextTags: previousTags }
    }

    for (const root of availableRoots) {
      if (await metadataRootHasTagBinding(root, oldTagName)) {
        return { renamed: false, reason: 'metadata-bindings-exist', previousTags, nextTags: previousTags }
      }
    }

    const nextTags = Array.from(new Set([
      ...previousTags.filter((tag) => tag !== oldTagName),
      newTagName,
    ])).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    let accepted = false
    const savedTags = await persistKnownSharedTags(availableRoots, nextTags, 'zero-bind-rename', undefined, () => {
      accepted = revision === operationRevision && availableRoots.every(root => {
        const state = getStartupPathRootState(root)
        return state.state === 'online' && state.generation === generations.get(root)
      })
      return accepted
    })
    if (!accepted) return { renamed: false, reason: 'superseded', previousTags, nextTags: savedTags }
    deps.appendStartupLog(`shared known tag zero-bind renamed: old=${oldTagName}, new=${newTagName}, roots=${availableRoots.length}, previous=${previousTags.length}, next=${nextTags.length}, durationMs=${Date.now() - startedAt}`)
    return { renamed: true, reason: 'zero-bind-known-tag', previousTags, nextTags }
  }

  async function deleteKnownSharedTagIfUnbound(
    watchedFoldersInput: string[],
    tagNameInput: string,
  ): Promise<SharedKnownTagDeleteIfUnboundResult> {
    const operationRevision = ++revision
    const startedAt = Date.now()
    const tagName = cleanTagName(tagNameInput)
    const previousTags = (await readPersistedSharedTags()).map(cleanTagName).filter(Boolean)
    if (!tagName) return { deleted: false, reason: 'empty-name', previousTags, nextTags: previousTags }

    const roots = deps.uniqueResolvedFolders(watchedFoldersInput || [])
    const { availableRoots, skippedRoots } = await filterStartupAvailableRoots(roots, deps.appendStartupLog, 'shared-known-tag-zero-delete')
    const generations = new Map(availableRoots.map(root => [root, getStartupPathRootState(root).generation]))
    if (skippedRoots.length) {
      deps.appendStartupLog(`shared known tag zero-bind delete skipped: reason=unavailable-root, tag=${tagName}, skipped=${skippedRoots.length}, available=${availableRoots.length}`)
      return { deleted: false, reason: 'unavailable-root', previousTags, nextTags: previousTags }
    }

    for (const root of availableRoots) {
      if (await metadataRootHasTagBinding(root, tagName)) {
        return { deleted: false, reason: 'metadata-bindings-exist', previousTags, nextTags: previousTags }
      }
    }

    const nextTags = previousTags.filter((tag) => tag !== tagName)
    let accepted = false
    const savedTags = await persistKnownSharedTags(availableRoots, nextTags, 'zero-bind-delete', undefined, () => {
      accepted = revision === operationRevision && availableRoots.every(root => {
        const state = getStartupPathRootState(root)
        return state.state === 'online' && state.generation === generations.get(root)
      })
      return accepted
    })
    if (!accepted) return { deleted: false, reason: 'superseded', previousTags, nextTags: savedTags }
    deps.appendStartupLog(`shared known tag zero-bind deleted: tag=${tagName}, roots=${availableRoots.length}, previous=${previousTags.length}, next=${nextTags.length}, durationMs=${Date.now() - startedAt}`)
    return { deleted: true, reason: previousTags.includes(tagName) ? 'zero-bind-known-tag' : 'zero-bind-known-tag-missing', previousTags, nextTags }
  }

  async function refreshKnownSharedTagsFromMetadata(watchedFoldersInput: string[], options: SharedKnownTagsRefreshOptions = {}): Promise<string[]> {
    const operationRevision = ++revision
    const roots = deps.uniqueResolvedFolders(watchedFoldersInput || [])
    const { availableRoots, skippedRoots } = await filterStartupAvailableRoots(roots, deps.appendStartupLog, 'shared-metadata-known-tags')
    const generations = new Map(roots.map(root => [root, getStartupPathRootState(root).generation]))
    const isCurrent = () => {
      const current = operationRevision === revision
        && roots.every(root => getStartupPathRootState(root).generation === generations.get(root))
        && availableRoots.every(root => getStartupPathRootState(root).state === 'online')
      if (!current && options.requireFresh) throw new Error('共享标签目录读取已失效，不能确认完整标签目录。')
      return current
    }
    if (skippedRoots.length) {
      deps.appendStartupLog(`shared known tags unavailable roots skipped: skipped=${skippedRoots.length}, available=${availableRoots.length}`)
      if (options.requireFresh) throw new Error('共享根目录暂时不可用，不能确认完整标签目录。')
    }
    if (!availableRoots.length && roots.length) return readPersistedSharedTags()

    async function finish(confirmed: ConfirmedRootCatalog[], complete: boolean, source: string, aggregateTags?: string[]): Promise<string[]> {
      if (options.requireFresh && (!complete || !isCurrent())) throw new Error('共享标签目录读取未成功，不能确认完整标签目录。')
      const db = await deps.openLibraryDb()
      const persistedTags = deps.loadLibraryShellFromSqlite(db).tags || []
      if (!isCurrent()) return persistedTags
      const previous = readSharedRootCatalog(db, persistedTags)
      const dropTags = new Set((options.dropTags || []).map(cleanTagName).filter(Boolean))
      const preserveTags = (options.preserveTags || []).map(cleanTagName).filter(Boolean)
      const extraTags = [
        ...(options.allowEmptyOverwrite === false ? persistedTags.filter(tag => !complete || !dropTags.has(tag)) : []),
        ...(options.allowEmptyOverwrite === false ? preserveTags : []),
      ]
      const catalog = mergeSharedRootCatalog(previous, roots, confirmed, complete, extraTags, aggregateTags)
      if (!catalog.publishedTags.length && options.allowEmptyOverwrite === false && !dropTags.size) {
        deps.appendStartupLog(`shared known tags empty refresh ignored after set: source=${source}, roots=${availableRoots.length}`)
        return persistedTags
      }
      return persistKnownSharedTags(roots, catalog.publishedTags, source, catalog, isCurrent)
    }

    const rustRoots = availableRoots.map((rootPath) => ({ rootPath, dbPath: deps.sharedMetadataDbPathForRoot(rootPath) }))
    if (rustRoots.length && deps.runRustSharedMetadataKnownTags) {
      const rustRead = await withIoDeadlineResult(
        'shared-metadata-known-tags',
        () => deps.runRustSharedMetadataKnownTags!({ roots: rustRoots }),
        sharedMetadataQueryTimeoutMs(),
      )
      const rustResult = rustRead.ok ? rustRead.value : null
      if (!rustRead.ok) {
        const error = 'error' in rustRead ? rustRead.error : new Error('shared known tags read failed')
        deps.appendStartupLog(`shared known tags rust read skipped: ${rustRead.timedOut ? 'deadline exceeded' : (error instanceof Error ? error.message : String(error))}`)
        if (options.requireFresh) throw new Error('共享标签目录读取未成功。', { cause: error })
        return readPersistedSharedTags()
      }
      if (rustResult && Array.isArray(rustResult.knownTags)) {
        if (!Array.isArray(rustResult.roots)) {
          // Compatibility protocol: aggregate success cannot establish root ownership.
          return finish([], false, 'rust-aggregate', rustResult.knownTags.map(cleanTagName).filter(Boolean))
        }
        const confirmed: ConfirmedRootCatalog[] = []
        for (const root of rustRoots) {
          const matches = rustResult.roots.filter(row => sharedCatalogRootId(row.rootPath) === sharedCatalogRootId(root.rootPath))
          if (matches.length !== 1) continue
          const row = matches[0]
          if (sharedCatalogRootId(row.dbPath) !== sharedCatalogRootId(root.dbPath) || !Array.isArray(row.knownTags) || !row.knownTags.every(tag => typeof tag === 'string')) continue
          if (!row.signature || row.signature === 'metadata:error') continue
          if (row.signature === 'metadata:none' && (row.knownTags.length > 0 || !(await metadataFileMissingConfirmed(root.rootPath)))) continue
          confirmed.push({ rootId: sharedCatalogRootId(root.rootPath), tags: row.knownTags.map(cleanTagName).filter(Boolean), signature: row.signature, confirmedAt: Date.now() })
        }
        return finish(confirmed, !skippedRoots.length && confirmed.length === roots.length, 'rust')
      }
    }

    if (!roots.length) return finish([], true, 'empty-configuration')
    if (!nodeStateFallbackCompatibilityAllowed()) {
      if (options.requireFresh) throw new Error('共享标签目录读取未成功。')
      logNodeStateFallbackDisabled({ appendStartupLog: deps.appendStartupLog, source: 'shared-known-tags-read', reason: 'rust-known-tags-returned-empty' })
      return readPersistedSharedTags()
    }
    logNodeStateFallbackUsed({ appendStartupLog: deps.appendStartupLog, source: 'shared-known-tags-read', detail: `roots=${availableRoots.length},skippedUnavailable=${skippedRoots.length}` })
    const confirmed: ConfirmedRootCatalog[] = []
    for (const root of availableRoots) {
      const read = await withIoDeadlineResult('shared-metadata-known-tags-node', () => readMetadataTagsForRoot(root), sharedMetadataQueryTimeoutMs())
      if (read.ok) confirmed.push({ rootId: sharedCatalogRootId(root), tags: read.value, signature: 'node-confirmed', confirmedAt: Date.now() })
    }
    return finish(confirmed, !skippedRoots.length && confirmed.length === roots.length, 'node-fallback')
  }

  return { refreshKnownSharedTagsFromMetadata, renameKnownSharedTagIfUnbound, deleteKnownSharedTagIfUnbound }
}
