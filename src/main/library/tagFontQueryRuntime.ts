import { basename, dirname, parse } from 'node:path'
import type { FontItem, FontQueryPageResult, FontQueryRequest } from '../../shared/types'
import type { RustSharedMetadataOverlayReadInput, RustSharedMetadataOverlayReadResult } from '../rust-core/rustCoreWorkerContracts'
import { sharedFileSystem as fsp } from '../path/sharedFileSystemRuntime'
import { normalizePathForCacheCompare as key } from '../path/cachePath'
import { createTagRecoveryPaths, type TagRecoveryPaths } from './tagRecoveryPathRuntime'
import { readTagFontBindings, type TagFontBinding } from './tagFontBindingRuntime'
import { asFormat, fontItemFromPath } from '../fonts/fontRuntime'
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

type FileAvailability = NonNullable<FontItem['fileAvailability']>
type FileStat = (path: string) => Promise<Pick<import('node:fs').Stats, 'isFile' | 'isDirectory'>>
async function missingFileAvailability(path: string, roots: string[], stat: FileStat, paths?: TagRecoveryPaths): Promise<FileAvailability> {
  const root = (paths || await createTagRecoveryPaths(roots)).owner(path) || parse(path).root
  try { if (root && (await stat(root)).isDirectory()) return 'missing' }
  catch (rootError) {
    if ((rootError as NodeJS.ErrnoException).code !== 'ENOENT') return 'unavailable'
    const anchor = parse(path).root
    if (anchor && key(anchor) !== key(root)) {
      try { if ((await stat(anchor)).isDirectory()) return 'missing' } catch { /* Disconnected volume/share. */ }
    }
  }
  return 'unavailable'
}
export async function fontFileAvailability(path: string, roots: string[]): Promise<FileAvailability> {
  try { return (await fsp.stat(path)).isFile() ? 'available' : 'missing' }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? missingFileAvailability(path, roots, file => fsp.stat(file)) : 'unavailable'
  }
}

// A tag often holds dozens of siblings. List each parent once per query instead
// of submitting one isolated process for every missing file and root probe.
function createAvailabilityReader(roots: string[], paths: TagRecoveryPaths) {
  const stats = new Map<string, ReturnType<FileStat>>()
  const stat: FileStat = path => {
    const id = key(path)
    let pending = stats.get(id)
    if (!pending) { pending = fsp.stat(path); stats.set(id, pending) }
    return pending
  }
  const directories = new Map<string, Promise<Map<string, import('node:fs').Dirent> | FileAvailability>>()
  return async (path: string): Promise<FileAvailability> => {
    const parent = dirname(path), id = key(parent)
    let pending = directories.get(id)
    if (!pending) {
      pending = fsp.readdir(parent, { withFileTypes: true })
        .then(entries => new Map(entries.map(entry => [entry.name.toLowerCase(), entry])))
        .catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? missingFileAvailability(path, roots, stat, paths) : 'unavailable' as const)
      directories.set(id, pending)
    }
    const entries = await pending
    if (typeof entries === 'string') return entries
    const entry = entries.get(basename(path).toLowerCase())
    if (!entry) return 'missing'
    if (entry.isFile()) return 'available'
    if (entry.isSymbolicLink()) return fontFileAvailability(path, roots)
    return 'missing'
  }
}

export function createTagFontQueryRuntime(deps: {
  openLibraryDb: () => Promise<any>
  roots: () => Promise<string[]>
  findPrevious?: (path: string) => Promise<FontItem | null>
  canReadDetached?: (path: string) => Promise<boolean>
  readDetachedState?: (path: string) => Promise<'authorized' | 'changed' | 'unknown'>
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
    const paths = await createTagRecoveryPaths(roots)
    const availabilityFor = createAvailabilityReader(roots, paths)
    const inScope = (path: string) => !request.selectedWatchedFolders?.length || request.selectedWatchedFolders.some(root => paths.inside(path, root))
    const db = await deps.openLibraryDb()
    const snapshots = openTagFontSnapshots(db)
    const { bindings, legacyTags, unavailableRoots } = await readTagFontBindings({ db, paths, scope,
      folders: request.selectedWatchedFolders, readShared: deps.readShared })
    const liveRoots = paths.roots.filter(root => !unavailableRoots.includes(root))
    const liveFolders = scope === 'shared' && unavailableRoots.length
      ? request.selectedWatchedFolders?.length ? liveRoots.flatMap(root => request.selectedWatchedFolders!.flatMap(folder =>
          paths.inside(folder, root) ? [folder] : paths.inside(root, folder) ? [root] : [])) : liveRoots
      : request.selectedWatchedFolders
    const broad: FontQueryRequest = { sidebarPage: scope === 'local' ? 'tags' : 'sharedTags', selectedTagName: name, selectedWatchedFolders: liveFolders, sortMode: 'nameAsc' }
    const live = new Map<string, FontItem>()
    const seenLive = new Set<string>()
    let first: FontQueryPageResult | undefined
    for (let at = 0; !request.tagBindingsOnly && (scope !== 'shared' || (liveRoots.length > 0 && (!unavailableRoots.length || !!liveFolders?.length))); ) {
      const page = await deps.queryLive(broad, 500, at)
      if (first && (first.total !== page.total || JSON.stringify(first.tagRevision) !== JSON.stringify(page.tagRevision))) throw new Error('标签索引在读取期间发生变化，请重试。')
      first ||= page
      const previousSize = seenLive.size
      for (const item of page.items) {
        const id = key(item.path)
        seenLive.add(id)
        const tags = bindings.get(id)?.tags || legacyTags.get(item.id) || legacyTags.get(item.sourceId || '')
        if (tags?.length && (!name || tags.includes(name))) live.set(id, item)
      }
      if (at + page.items.length >= page.total) break
      if (!page.items.length || previousSize === seenLive.size) throw new Error('字体索引在读取期间发生变化，请重试。')
      at += page.items.length
    }
    snapshots.remember([...live.values()])
    // Existing legacy ID-only associations are already resolved by the live query.
    const items = new Map(live)
    async function resolveBinding([pathKey, binding]: [string, TagFontBinding]): Promise<void> {
      if (name && !binding.tags.includes(name)) return
      const old = live.get(pathKey) || snapshots.read(binding.path) || await deps.findPrevious?.(binding.path).catch(() => null)
      if (old) snapshots.remember([old])
      const fileName = basename(binding.path)
      let font: FontItem = old || { id: `missing:${pathKey}`, sourceId: binding.id, path: binding.path, fileName,
        family: fileName, fullName: fileName, postscriptName: '', style: '', format: asFormat(binding.path),
        fileSize: 0, modifiedAt: 0, addedAt: '', favorite: false, collectionIds: [], tagNames: [],
        systemInstalled: false, systemInstallMatches: [], active: false }
      const tagBindingReadOnly = unavailableRoots.some(root => paths.inside(binding.path, root))
      let availability: NonNullable<FontItem['fileAvailability']> = tagBindingReadOnly ? 'unavailable' : await availabilityFor(binding.path)
      let fileRelinkRequired = false
      if (availability === 'available' && scope === 'local' && !paths.contains(binding.path)) {
        const state = deps.readDetachedState ? await deps.readDetachedState(binding.path)
          : await deps.canReadDetached?.(binding.path) ? 'authorized' : 'unknown'
        fileRelinkRequired = state === 'changed'
        if (state !== 'authorized') availability = 'unavailable'
      }
      if (!request.tagBindingsOnly && !live.has(pathKey) && availability === 'available') {
        try {
          font = await fontItemFromPath(binding.path)
          snapshots.remember([font])
        } catch { availability = 'unavailable' }
      }
      items.set(pathKey, { ...font, fileAvailability: availability, fileRelinkRequired, tagBindingReadOnly,
        ...(scope === 'local' ? { localTagNames: binding.tags } : { tagNames: binding.tags, sourceId: binding.id }),
        ...(availability !== 'available' ? { previewDisabled: true, previewError: tagBindingReadOnly ? '共享标签暂不可读取' : fileRelinkRequired ? '文件已变化，请右键重新链接确认' : availability === 'missing' ? '文件丢失' : '文件暂不可访问' } : font.fileAvailability === 'missing' || font.fileAvailability === 'unavailable' ? { previewDisabled: false, previewError: undefined } : {}),
      })
    }
    const entries = [...bindings.entries()]
    for (let index = 0; index < entries.length; index += 8) await Promise.all(entries.slice(index, index + 8).map(resolveBinding))
    for (const [pathKey, item] of items) {
      if (item.fileAvailability) continue
      const availability = await availabilityFor(item.path)
      items.set(pathKey, { ...item, fileAvailability: availability, ...(availability === 'available' ? {} : { previewDisabled: true }) })
    }
    const scoped = [...items.values()].filter(font => inScope(font.path))
    const sorted = (request.tagBindingsOnly ? scoped : await deps.hydrate(scoped)).filter(font => deps.matches(font, request)).sort((a, b) => deps.compare(a, b, request))
    return { queryKey: JSON.stringify(request), ...first, engine: 'mixed', items: sorted.slice(offset, offset + limit), total: sorted.length, offset, limit,
      truncated: offset + limit < sorted.length, elapsedMs: Date.now() - start }
  }
  let generation = 0
  const inFlight = new Map<string, Promise<FontQueryPageResult>>()
  const cache = new Map<string, { at: number; result: FontQueryPageResult }>()
  async function query(request: FontQueryRequest, limit: number, offset: number): Promise<FontQueryPageResult> {
    if (request.tagBindingsOnly) return collect(request, limit, offset)
    const { limit: _limit, offset: _offset, ...criteria } = request
    const cacheKey = JSON.stringify(criteria)
    const found = cache.get(cacheKey)
    const version = generation
    const fresh = !!found && Date.now() - found.at < 2000
    let pending = inFlight.get(cacheKey)
    if (!fresh && !pending) {
      pending = collect(criteria, Number.MAX_SAFE_INTEGER, 0)
      inFlight.set(cacheKey, pending)
      const own = pending
      void own.finally(() => { if (inFlight.get(cacheKey) === own) inFlight.delete(cacheKey) }).catch(() => undefined)
    }
    const result = fresh ? found!.result : await pending!
    if (version !== generation) return query(request, limit, offset)
    if (version === generation) {
      if (cache.size >= 16) cache.delete(cache.keys().next().value!)
      cache.set(cacheKey, { at: found?.result === result ? found.at : Date.now(), result })
    }
    return { ...result, queryKey: JSON.stringify({ ...criteria, offset, limit }), items: result.items.slice(offset, offset + limit), offset, limit, truncated: offset + limit < result.total }
  }
  async function sharedTagCounts(): Promise<Record<string, number> | undefined> {
    const paths = await createTagRecoveryPaths(await deps.roots())
    const { bindings, complete } = await readTagFontBindings({ db: await deps.openLibraryDb(), paths, scope: 'shared', readShared: deps.readShared })
    if (!complete) return undefined
    const counts: Record<string, number> = {}
    for (const binding of bindings.values()) for (const tag of binding.tags) counts[tag] = (counts[tag] || 0) + 1
    return counts
  }
  return { query, sharedTagCounts, invalidate: () => { generation++; cache.clear(); inFlight.clear() } }
}
