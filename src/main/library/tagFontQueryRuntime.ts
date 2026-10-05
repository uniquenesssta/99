import os from 'node:os'
import { basename, resolve, parse } from 'node:path'
import type { FontItem, FontQueryPageResult, FontQueryRequest } from '../../shared/types'
import type { RustSharedMetadataOverlayReadInput, RustSharedMetadataOverlayReadResult } from '../rust-core/rustCoreWorkerContracts'
import { sharedFileSystem as fsp } from '../path/sharedFileSystemRuntime'
import { normalizePathForCacheCompare as key } from '../path/cachePath'
import { pathInsideFolder } from '../folders/physicalFolders'
import { asFormat, fontItemFromPath } from '../fonts/fontRuntime'
import { sharedMetadataDbPathForRoot } from '../indexing/shared-metadata/sharedMetadataPathsRuntime'
import { stateFromRow } from '../indexing/shared-metadata/sharedMetadataStateRuntime'
import { openTagFontSnapshots } from './tagFontSnapshotRuntime'

export function tagQueryScope(request: FontQueryRequest): 'local' | 'shared' | undefined {
  if (!request) return undefined
  if (request.sidebarPage === 'tags') return 'local'
  if (request.sidebarPage === 'sharedTags') return 'shared'
  if (!request.sidebarPage || request.sidebarPage === 'library') {
    if (request.activeFilter?.kind === 'tag') return 'local'
    if (request.activeFilter?.kind === 'sharedTag') return 'shared'
  }
  return undefined
}

export async function fontFileAvailability(path: string, roots: string[]): Promise<NonNullable<FontItem['fileAvailability']>> {
  try { return (await fsp.stat(path)).isFile() ? 'available' : 'missing' }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'unavailable'
    const root = roots.filter(root => pathInsideFolder(path, root)).sort((a, b) => b.length - a.length)[0] || parse(path).root
    // A removed/renamed local folder is missing; a disconnected volume/share is unknown.
    try { if (root && (await fsp.stat(root)).isDirectory()) return 'missing' }
    catch (rootError) {
      if ((rootError as NodeJS.ErrnoException).code !== 'ENOENT') return 'unavailable'
      const anchor = parse(path).root
      if (anchor && key(anchor) !== key(root)) {
        try { if ((await fsp.stat(anchor)).isDirectory()) return 'missing' } catch { /* Disconnected volume/share. */ }
      }
    }
    return 'unavailable'
  }
}

type Binding = { path: string; id: string; tags: string[] }
export function createTagFontQueryRuntime(deps: {
  openLibraryDb: () => Promise<any>
  roots: () => Promise<string[]>
  findPrevious?: (path: string) => Promise<FontItem | null>
  canReadDetached?: (path: string) => Promise<boolean>
  readShared: (input: RustSharedMetadataOverlayReadInput) => Promise<RustSharedMetadataOverlayReadResult | null>
  queryLive: (request: FontQueryRequest, limit: number, offset: number) => Promise<FontQueryPageResult>
  hydrate: (items: FontItem[]) => Promise<FontItem[]>
  matches: (font: FontItem, request: FontQueryRequest) => boolean
  compare: (a: FontItem, b: FontItem, request: FontQueryRequest) => number
}) {
  async function collect(request: FontQueryRequest, limit: number, offset: number): Promise<FontQueryPageResult> {
    const start = Date.now()
    const scope = tagQueryScope(request)!
    const name = String(request.sidebarPage === 'tags' || request.sidebarPage === 'sharedTags' ? request.selectedTagName || '' : request.activeFilter?.name || '').trim()
    const roots = await deps.roots()
    const db = await deps.openLibraryDb()
    const snapshots = openTagFontSnapshots(db)
    const bindings = new Map<string, Binding>()
    const offlineRoots = new Set<string>()
    if (scope === 'local') {
      const rows = db.prepare("SELECT font_id, font_path, tag_name FROM local_font_tags WHERE font_path IS NOT NULL AND font_path <> ''").all() as Array<{ font_id: string; font_path: string; tag_name: string }>
      for (const row of rows) {
        const pathKey = key(row.font_path)
        const binding = bindings.get(pathKey) || { path: row.font_path, id: row.font_id, tags: [] }
        if (!binding.tags.includes(row.tag_name)) binding.tags.push(row.tag_name)
        bindings.set(pathKey, binding)
      }
    } else {
      for (const root of roots) {
        db.exec('CREATE TABLE IF NOT EXISTS tag_shared_binding_snapshots (root_path TEXT PRIMARY KEY, rows_json TEXT NOT NULL)')
        let rows: import('../indexing/shared-metadata/sharedMetadataStateRuntime').SharedMetadataRow[]
        try {
          const result = await deps.readShared({ rootPath: root, dbPath: sharedMetadataDbPathForRoot(root), entries: [],
            preflight: { phase: 'snapshot', updatedAt: new Date().toISOString(), updatedBy: os.hostname(), writerPid: process.pid } })
          if (!result?.preflight?.snapshot?.rows) throw new Error('共享标签快照未确认。')
          rows = result.preflight.snapshot.rows
          db.prepare('INSERT OR REPLACE INTO tag_shared_binding_snapshots (root_path, rows_json) VALUES (?, ?)').run(key(root), JSON.stringify(rows))
        } catch (error) {
          let reachable = false
          try { reachable = (await fsp.stat(root)).isDirectory() } catch { /* Offline snapshots are display-only. */ }
          if (reachable) throw error
          offlineRoots.add(key(root))
          const cached = db.prepare('SELECT rows_json FROM tag_shared_binding_snapshots WHERE root_path = ?').get(key(root))
          rows = cached ? JSON.parse(cached.rows_json) : []
        }
        for (const row of rows) {
          const state = stateFromRow(row)
          if (!state?.tagNames.length || !row.relative_path) continue
          const path = resolve(root, row.relative_path)
          if (!pathInsideFolder(path, root)) continue
          bindings.set(key(path), { path, id: String(row.font_id || ''), tags: state.tagNames })
        }
      }
    }
    const broad: FontQueryRequest = { sidebarPage: scope === 'local' ? 'tags' : 'sharedTags', selectedTagName: name, sortMode: 'nameAsc' }
    const live = new Map<string, FontItem>()
    let first: FontQueryPageResult | undefined
    for (let at = 0; ; ) {
      const page = await deps.queryLive(broad, 500, at)
      if (first && (first.total !== page.total || JSON.stringify(first.tagRevision) !== JSON.stringify(page.tagRevision))) throw new Error('标签索引在读取期间发生变化，请重试。')
      first ||= page
      const previousSize = live.size
      for (const item of page.items) live.set(key(item.path), item)
      if (at + page.items.length >= page.total) break
      if (!page.items.length || previousSize === live.size) throw new Error('字体索引在读取期间发生变化，请重试。')
      at += page.items.length
    }
    snapshots.remember([...live.values()])
    // Existing legacy ID-only associations are already resolved by the live query.
    const items = new Map(live)
    async function resolveBinding([pathKey, binding]: [string, Binding]): Promise<void> {
      if (name && !binding.tags.includes(name)) return
      const old = live.get(pathKey) || snapshots.read(binding.path) || await deps.findPrevious?.(binding.path).catch(() => null)
      if (old) snapshots.remember([old])
      const fileName = basename(binding.path)
      let font: FontItem = old || { id: `missing:${pathKey}`, sourceId: binding.id, path: binding.path, fileName,
        family: fileName, fullName: fileName, postscriptName: '', style: '', format: asFormat(binding.path),
        fileSize: 0, modifiedAt: 0, addedAt: '', favorite: false, collectionIds: [], tagNames: [],
        systemInstalled: false, systemInstallMatches: [], active: false }
      let availability: NonNullable<FontItem['fileAvailability']> = roots.some(root => offlineRoots.has(key(root)) && pathInsideFolder(binding.path, root)) ? 'unavailable' : await fontFileAvailability(binding.path, roots)
      if (!live.has(pathKey) && availability === 'available') {
        try {
          if (!roots.some(root => pathInsideFolder(binding.path, root)) && !await deps.canReadDetached?.(binding.path)) throw new Error('文件尚未由重新链接操作授权。')
          font = await fontItemFromPath(binding.path)
          snapshots.remember([font])
        } catch { availability = 'unavailable' }
      }
      items.set(pathKey, { ...font, fileAvailability: availability,
        ...(scope === 'local' ? { localTagNames: binding.tags } : { tagNames: binding.tags, sourceId: binding.id }),
        ...(availability !== 'available' ? { previewDisabled: true, previewError: availability === 'missing' ? '文件丢失' : '文件暂不可访问' } : {}),
      })
    }
    const entries = [...bindings.entries()]
    for (let index = 0; index < entries.length; index += 8) await Promise.all(entries.slice(index, index + 8).map(resolveBinding))
    for (const [pathKey, item] of items) {
      if (item.fileAvailability) continue
      const availability = await fontFileAvailability(item.path, roots)
      items.set(pathKey, { ...item, fileAvailability: availability, ...(availability === 'available' ? {} : { previewDisabled: true }) })
    }
    const sorted = (await deps.hydrate([...items.values()])).filter(font => deps.matches(font, request)).sort((a, b) => deps.compare(a, b, request))
    return { ...first!, engine: 'mixed', items: sorted.slice(offset, offset + limit), total: sorted.length, offset, limit,
      truncated: offset + limit < sorted.length, elapsedMs: Date.now() - start }
  }
  let generation = 0
  const cache = new Map<string, { at: number; result: FontQueryPageResult }>()
  async function query(request: FontQueryRequest, limit: number, offset: number): Promise<FontQueryPageResult> {
    const { limit: _limit, offset: _offset, ...criteria } = request
    const cacheKey = JSON.stringify(criteria)
    const found = cache.get(cacheKey)
    const version = generation
    const result = found && Date.now() - found.at < 2000 ? found.result : await collect(criteria, Number.MAX_SAFE_INTEGER, 0)
    if (version !== generation) return query(request, limit, offset)
    if (version === generation) {
      if (cache.size >= 16) cache.delete(cache.keys().next().value!)
      cache.set(cacheKey, { at: found?.result === result ? found.at : Date.now(), result })
    }
    return { ...result, queryKey: JSON.stringify({ ...criteria, offset, limit }), items: result.items.slice(offset, offset + limit), offset, limit, truncated: offset + limit < result.total }
  }
  return { query, invalidate: () => { generation++; cache.clear() } }
}
