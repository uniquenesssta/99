import { resolve } from 'node:path'
import type {
  MergedIndexBuildRuntime,
  MergedIndexPageContext,
  MergedIndexSourceRuntime,
} from './mergedIndexPageTypes'

export type MergedIndexExternalCheckResult = {
  changed: boolean
  rebuilt: boolean
  roots: number
  elapsedMs: number
  reason: string
}

type SourceSharedMetadataRow = {
  root_path?: string
  shared_metadata_signature?: string
}

export function isSharedMetadataExternalCheckReason(reason: string): boolean {
  const value = String(reason || '').toLowerCase()
  return value.includes('shared-metadata') || value.includes('shared_metadata')
}

function normalizedSignature(value: unknown): string {
  return String(value || 'metadata:none')
}

export async function checkMergedIndexSharedMetadataExternalChanges(args: {
  ctx: MergedIndexPageContext
  sourceRuntime: MergedIndexSourceRuntime
  buildRuntime: MergedIndexBuildRuntime
  reason: string
}): Promise<MergedIndexExternalCheckResult | null> {
  const { ctx, sourceRuntime, buildRuntime, reason } = args
  const startedAt = Date.now()
  const roots = Array.from(
    new Set((await ctx.appWatchedFolders()).filter(Boolean).map((folder) => resolve(folder))),
  )
  if (!roots.length) {
    return { changed: false, rebuilt: false, roots: 0, elapsedMs: Date.now() - startedAt, reason }
  }

  const rootLookup = new Set(roots.map((root) => ctx.normalizePathForCacheCompare(root)))
  const db = await ctx.openMergedIndexDb()
  let changed = false
  try {
    if (!ctx.sqliteTableExists(db, 'sources')) return null
    if (!ctx.mergedIndexSourcesMatchRoots(db, roots)) return null

    const rows = db.prepare(`
      SELECT root_path, shared_metadata_signature
      FROM sources
    `).all() as SourceSharedMetadataRow[]
    if (!rows.length) return null

    for (const row of rows) {
      const rootPath = String(row.root_path || '')
      if (!rootPath || !rootLookup.has(ctx.normalizePathForCacheCompare(rootPath))) continue
      const previous = normalizedSignature(row.shared_metadata_signature)
      const current = normalizedSignature(await ctx.sharedMetadataSignatureForRoot(rootPath))
      if (previous !== current) {
        changed = true
        break
      }
      await ctx.delayToEventLoop()
    }

    if (!changed) {
      return { changed: false, rebuilt: false, roots: roots.length, elapsedMs: Date.now() - startedAt, reason }
    }
  } finally {
    ctx.closeSqliteDb(db)
  }

  const sources = await sourceRuntime.mergedIndexSourcesForRoots(roots)
  if (!sources.length) {
    return { changed: false, rebuilt: false, roots: roots.length, elapsedMs: Date.now() - startedAt, reason }
  }

  const sourcesKey = ctx.mergedIndexSourcesKey(sources)
  const rebuildDb = await ctx.openMergedIndexDb()
  try {
    await buildRuntime.ensureMergedIndexBuilt(rebuildDb, sources, sourcesKey)
    ctx.appendStartupLog(
      `local merged index shared metadata lightweight sync finished: reason=${reason}, roots=${roots.length}, elapsed=${Date.now() - startedAt}ms`,
    )
    return { changed: true, rebuilt: true, roots: roots.length, elapsedMs: Date.now() - startedAt, reason }
  } finally {
    ctx.closeSqliteDb(rebuildDb)
  }
}
