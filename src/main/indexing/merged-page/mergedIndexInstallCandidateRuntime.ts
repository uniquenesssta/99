import { getStartupPathRootState } from '../../path/startupPathAvailabilityRuntime'
import type { FontItem } from '../../../shared/types'
import { fileRuntimeFontId } from '../../fonts/fontFileIdentity'
import { currentFolderWatcherRegistrationGeneration } from '../../watcher/folderWatcherRegistrationRuntime'
import type { MergedIndexPageRow } from '../rootIndexQuerySql'
import type { MergedIndexPageContext } from './mergedIndexPageTypes'
import { assertFreshMergedIndexSource, readMergedIndexAppliedSources } from './mergedIndexSourceRuntime'

// Read-only candidate enumeration, never source freshness or installation proof.
// A complete applied certificate is mandatory; pending population is not a
// snapshot. No root index, shared metadata or font file is opened here.
export function createMergedIndexInstallCandidateRuntime(ctx: MergedIndexPageContext) {
  async function readInstallRefreshSnapshot(roots: string[]): Promise<FontItem[] | null> {
    const rootsKey = ctx.mergedIndexRootsKey(roots)
    const registrationGeneration = currentFolderWatcherRegistrationGeneration()
    const rootIds = roots.map(root => getStartupPathRootState(root).rootId)
    const current = async () => ctx.mergedIndexRootsKey(await ctx.appWatchedFolders()) === rootsKey
      && currentFolderWatcherRegistrationGeneration() === registrationGeneration
      && roots.every((root, index) => getStartupPathRootState(root).rootId === rootIds[index])
    if (!await current()) return null
    const db = await ctx.openMergedIndexDb()
    let items: FontItem[]
    try {
      if (!ctx.mergedIndexLocalSnapshotUsable(db, roots)) return null
      const sources = readMergedIndexAppliedSources(ctx, db)
      if (ctx.getSqliteMeta(db, 'sourcesKey') !== ctx.mergedIndexSourcesKey(sources)
        || ctx.mergedIndexRootsKey(sources.map(source => source.root)) !== rootsKey) return null
      for (const source of sources) assertFreshMergedIndexSource(source)
      const rows = db.prepare("SELECT * FROM entries WHERE COALESCE(is_deleted,0)=0 AND status='ok' AND font_json IS NOT NULL AND json_valid(font_json)").all() as MergedIndexPageRow[]
      items = []
      const rootKeys = new Set(roots.map(root => ctx.normalizePathForCacheCompare(root)))
      for (const row of rows) {
        if (!rootKeys.has(ctx.normalizePathForCacheCompare(row.root_path))) return null
        const item = ctx.fontFromRootIndexPageRow(row.root_path, row)
        if (!item || !ctx.pathInsideFolder(row.root_path, item.path) || fileRuntimeFontId(item.path, item.fileSize, item.modifiedAt) !== item.id) return null
        items.push(item)
      }
    } finally { ctx.closeSqliteDb(db) }
    return await current() ? items : null
  }
  return { readInstallRefreshSnapshot }
}
