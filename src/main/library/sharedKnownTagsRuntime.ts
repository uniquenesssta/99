import type { LibraryShell } from '../../shared/types'
import { filterStartupAvailableRoots } from '../path/startupPathAvailabilityRuntime'
import { sharedMetadataQueryTimeoutMs, withIoDeadlineResult } from '../path/ioDeadlineRuntime'
import {
  logNodeStateFallbackDisabled,
  logNodeStateFallbackUsed,
  nodeStateFallbackCompatibilityAllowed,
} from '../rust-core/nodeStateFallbackCompatibilityRuntime'

export interface SharedKnownTagsRefreshOptions {
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

function parseTagNamesJson(value: unknown): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(String(value))
    if (!Array.isArray(parsed)) return []
    return Array.from(new Set(parsed.map(cleanTagName).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  } catch {
    return []
  }
}

export function createSharedKnownTagsRuntime(deps: SharedKnownTagsRuntimeDeps) {
  async function readMetadataTagsForRoot(rootPath: string): Promise<string[]> {
    const dbPath = deps.sharedMetadataDbPathForRoot(rootPath)
    if (!(await deps.exists(dbPath).catch(() => false))) return []
    const db = await deps.openSharedMetadataDb(rootPath, false)
    try {
      const rows = db.prepare('SELECT tag_names_json FROM font_metadata').all() as Array<{ tag_names_json?: string | null }>
      const tags = new Set<string>()
      for (const row of rows) {
        for (const tag of parseTagNamesJson(row.tag_names_json)) tags.add(tag)
      }
      return Array.from(tags)
    } catch {
      return []
    } finally {
      deps.closeSqliteDb(db)
    }
  }

  async function readPersistedSharedTags(): Promise<string[]> {
    const db = await deps.openLibraryDb()
    return deps.loadLibraryShellFromSqlite(db).tags || []
  }

  async function persistKnownSharedTags(roots: string[], nextTags: string[], source: string): Promise<string[]> {
    const db = await deps.openLibraryDb()
    const previous = deps.loadLibraryShellFromSqlite(db).tags || []
    const previousKey = previous.join('\u0000')
    const nextKey = nextTags.join('\u0000')
    if (previousKey !== nextKey) {
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM tags').run()
        const insert = db.prepare('INSERT INTO tags (name, sort_order) VALUES (?, ?)')
        nextTags.forEach((tag, index) => insert.run(tag, index))
      })
      tx()
      deps.appendStartupLog(`shared known tags refreshed from metadata: source=${source}, roots=${roots.length}, tags=${nextTags.length}`)
    }
    return nextTags
  }


  async function metadataRootHasTagBinding(rootPath: string, tagName: string): Promise<boolean> {
    const dbPath = deps.sharedMetadataDbPathForRoot(rootPath)
    if (!(await deps.exists(dbPath).catch(() => false))) return false
    const db = await deps.openSharedMetadataDb(rootPath, false)
    try {
      const rows = db.prepare('SELECT tag_names_json FROM font_metadata').all() as Array<{ tag_names_json?: string | null }>
      for (const row of rows) {
        if (parseTagNamesJson(row.tag_names_json).includes(tagName)) return true
      }
      return false
    } catch {
      return true
    } finally {
      deps.closeSqliteDb(db)
    }
  }

  async function renameKnownSharedTagIfUnbound(
    watchedFoldersInput: string[],
    oldTagNameInput: string,
    newTagNameInput: string,
  ): Promise<SharedKnownTagRenameIfUnboundResult> {
    const startedAt = Date.now()
    const oldTagName = cleanTagName(oldTagNameInput)
    const newTagName = cleanTagName(newTagNameInput)
    const previousTags = (await readPersistedSharedTags()).map(cleanTagName).filter(Boolean)
    if (!oldTagName || !newTagName) return { renamed: false, reason: 'empty-name', previousTags, nextTags: previousTags }
    if (oldTagName === newTagName) return { renamed: true, reason: 'same-name', previousTags, nextTags: previousTags }

    const roots = deps.uniqueResolvedFolders(watchedFoldersInput || [])
    const { availableRoots, skippedRoots } = await filterStartupAvailableRoots(roots, deps.appendStartupLog, 'shared-known-tag-zero-rename')
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
    await persistKnownSharedTags(availableRoots, nextTags, 'zero-bind-rename')
    deps.appendStartupLog(`shared known tag zero-bind renamed: old=${oldTagName}, new=${newTagName}, roots=${availableRoots.length}, previous=${previousTags.length}, next=${nextTags.length}, durationMs=${Date.now() - startedAt}`)
    return { renamed: true, reason: 'zero-bind-known-tag', previousTags, nextTags }
  }

  async function deleteKnownSharedTagIfUnbound(
    watchedFoldersInput: string[],
    tagNameInput: string,
  ): Promise<SharedKnownTagDeleteIfUnboundResult> {
    const startedAt = Date.now()
    const tagName = cleanTagName(tagNameInput)
    const previousTags = (await readPersistedSharedTags()).map(cleanTagName).filter(Boolean)
    if (!tagName) return { deleted: false, reason: 'empty-name', previousTags, nextTags: previousTags }

    const roots = deps.uniqueResolvedFolders(watchedFoldersInput || [])
    const { availableRoots, skippedRoots } = await filterStartupAvailableRoots(roots, deps.appendStartupLog, 'shared-known-tag-zero-delete')
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
    await persistKnownSharedTags(availableRoots, nextTags, 'zero-bind-delete')
    deps.appendStartupLog(`shared known tag zero-bind deleted: tag=${tagName}, roots=${availableRoots.length}, previous=${previousTags.length}, next=${nextTags.length}, durationMs=${Date.now() - startedAt}`)
    return { deleted: true, reason: previousTags.includes(tagName) ? 'zero-bind-known-tag' : 'zero-bind-known-tag-missing', previousTags, nextTags }
  }

  async function refreshKnownSharedTagsFromMetadata(watchedFoldersInput: string[], options: SharedKnownTagsRefreshOptions = {}): Promise<string[]> {
    const preserveTags = Array.from(new Set((options.preserveTags || []).map(cleanTagName).filter(Boolean)))
    const dropTags = new Set((options.dropTags || []).map(cleanTagName).filter(Boolean))
    const persistedTags = options.allowEmptyOverwrite === false
      ? (await readPersistedSharedTags()).map(cleanTagName).filter((tag) => tag && !dropTags.has(tag))
      : []
    const roots = deps.uniqueResolvedFolders(watchedFoldersInput || [])
    const { availableRoots, skippedRoots } = await filterStartupAvailableRoots(roots, deps.appendStartupLog, 'shared-metadata-known-tags')
    if (skippedRoots.length) {
      deps.appendStartupLog(`shared known tags unavailable roots skipped: skipped=${skippedRoots.length}, available=${availableRoots.length}`)
    }
    if (!availableRoots.length && roots.length) {
      return readPersistedSharedTags()
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
      }
      if (rustResult && Array.isArray(rustResult.knownTags)) {
        const rustKnownTags = rustResult.knownTags.map(cleanTagName).filter(Boolean)
        const nextTags = Array.from(new Set([
          ...rustKnownTags.filter((tag) => !dropTags.has(tag)),
          ...(options.allowEmptyOverwrite === false ? persistedTags : []),
          ...(options.allowEmptyOverwrite === false ? preserveTags : []),
        ])).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
        if (!nextTags.length && options.allowEmptyOverwrite === false) {
          deps.appendStartupLog(`shared known tags empty refresh ignored after set: source=rust, roots=${availableRoots.length}`)
          return readPersistedSharedTags()
        }
        return persistKnownSharedTags(availableRoots, nextTags, options.allowEmptyOverwrite === false && preserveTags.length ? 'rust+mutation-preserve' : 'rust')
      }
    }

    if (!nodeStateFallbackCompatibilityAllowed()) {
      logNodeStateFallbackDisabled({
        appendStartupLog: deps.appendStartupLog,
        source: 'shared-known-tags-read',
        reason: 'rust-known-tags-returned-empty',
      })
      return readPersistedSharedTags()
    }
    logNodeStateFallbackUsed({
      appendStartupLog: deps.appendStartupLog,
      source: 'shared-known-tags-read',
      detail: `roots=${availableRoots.length},skippedUnavailable=${skippedRoots.length}`,
    })

    const tags = new Set<string>()
    for (const root of availableRoots) {
      for (const tag of await readMetadataTagsForRoot(root)) tags.add(tag)
    }
    const nextTags = Array.from(new Set([
      ...Array.from(tags).filter((tag) => !dropTags.has(tag)),
      ...(options.allowEmptyOverwrite === false ? persistedTags : []),
      ...(options.allowEmptyOverwrite === false ? preserveTags : []),
    ])).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    if (!nextTags.length && options.allowEmptyOverwrite === false) {
      deps.appendStartupLog(`shared known tags empty refresh ignored after set: source=node-fallback, roots=${availableRoots.length}`)
      return readPersistedSharedTags()
    }
    return persistKnownSharedTags(availableRoots, nextTags, options.allowEmptyOverwrite === false && preserveTags.length ? 'node-fallback+mutation-preserve' : 'node-fallback')
  }

  return { refreshKnownSharedTagsFromMetadata, renameKnownSharedTagIfUnbound, deleteKnownSharedTagIfUnbound }
}
