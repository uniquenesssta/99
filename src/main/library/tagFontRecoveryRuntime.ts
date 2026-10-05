import { createSharedActionAdmission } from '../ipc/sharedActionAdmissionRuntime'
import { assertApplicationOpen, applicationWorkEpoch } from '../app/shutdownCoordinatorRuntime'
import { dirname, join } from 'node:path'
import type { FontItem, FontQueryPageResult, FontQueryRequest, FontTagUpdateResult, FontTagBatchItem, LibraryState } from '../../shared/types'
import type { TagFontRecoveryRequest, TagFontRecoveryResult } from '../../shared/tagFontRecovery'
import type { IpcHandlerRuntime } from '../ipc/ipcHandlerTypes'
import { normalizePathForCacheCompare as key } from '../path/cachePath'
import { pathInsideFolder } from '../folders/physicalFolders'
import { sharedFileSystem as fsp } from '../path/sharedFileSystemRuntime'
import { asFormat, fontItemFromPath, hasValidFontSignature } from '../fonts/fontRuntime'
import { fontFileAvailability } from './tagFontQueryRuntime'

// Never use a filename alone to guess a replacement for a missing font.
export function sameRecoveryFont(old: FontItem, next: FontItem): boolean {
  return !!old.postscriptName && old.fileSize > 0 && old.fileSize === next.fileSize
    && old.postscriptName === next.postscriptName && old.style === next.style
    && old.fileName.toLowerCase() === next.fileName.toLowerCase() && old.format === next.format
}

export function uniqueRecoveryPairs(missing: FontItem[], candidates: FontItem[]): Array<[FontItem, FontItem]> {
  const choices = missing.map(old => ({ old, matches: candidates.filter(next => key(old.path) !== key(next.path) && sameRecoveryFont(old, next)) }))
  return choices.flatMap(({ old, matches }) => matches.length === 1 && choices.filter(choice => choice.matches.some(next => key(next.path) === key(matches[0].path))).length === 1
    ? [[old, matches[0]] as [FontItem, FontItem]] : [])
}

export function createTagFontRecoveryRuntime(runtime: IpcHandlerRuntime, pick: (font: FontItem) => Promise<string | undefined>) {
  async function readReplacement(file: string, indexed?: FontItem): Promise<FontItem> {
    if (indexed) {
      const stat = await fsp.stat(file)
      if (stat.isFile() && stat.size === indexed.fileSize && stat.mtimeMs === indexed.modifiedAt && indexed.postscriptName) return { ...indexed, path: file }
    }
    if (asFormat(file) === 'unknown' || !await hasValidFontSignature(file)) throw new Error('所选文件不是可识别的字体文件。')
    return fontItemFromPath(file)
  }
  let running = false
  const admit = createSharedActionAdmission(runtime.getSharedAvailability)
  async function readAll(request: FontQueryRequest): Promise<FontItem[]> {
    const items: FontItem[] = []
    const seen = new Set<string>()
    let first: FontQueryPageResult | undefined
    for (let offset = 0; ; ) {
      const page = await runtime.queryFontPageInLibrary({ ...request, limit: 500, offset }) as FontQueryPageResult
      if (first && (first.total !== page.total || JSON.stringify(first.tagRevision) !== JSON.stringify(page.tagRevision))) throw new Error('恢复期间字体范围已变化，请重试。')
      first ||= page
      for (const font of page.items) {
        const identity = key(font.path)
        if (seen.has(identity)) throw new Error('恢复期间收到重复的分页记录，请重试。')
        seen.add(identity)
      }
      items.push(...page.items)
      if (offset + page.items.length >= page.total) return items
      if (!page.items.length) throw new Error('字体范围读取不完整，请重试。')
      offset += page.items.length
    }
  }
  function check(result: unknown): void {
    const receipt = result as FontTagUpdateResult
    if (!receipt?.ok || receipt.failed?.length) throw new Error(receipt?.message || '标签关联写入未确认，原记录已保留。')
  }
  async function recover(input: TagFontRecoveryRequest): Promise<TagFontRecoveryResult> {
    if (running) return { linked: 0, remaining: 0, canceled: false, busy: true, failures: [], message: '正在恢复字体关联，请完成文件选择或等待本次恢复结束。' }
    if (!input || !['local', 'shared'].includes(input.scope) || !['reindex', 'relink'].includes(input.mode) || !(input.mode === 'reindex' ? String(input.tagName || '').trim() : String(input.fontPath || '').trim())) throw new Error('无效的标签恢复请求。')
    const ticket = applicationWorkEpoch()
    assertApplicationOpen(ticket)
    running = true
    const failures: string[] = []
    let linked = 0, canceled = false
    try {
      const library = await runtime.loadLibraryShell() as LibraryState
      const roots = library.folders || []
      const request: FontQueryRequest = { tagBindingsOnly: true, sidebarPage: input.scope === 'local' ? 'tags' : 'sharedTags',
        selectedTagName: input.mode === 'reindex' ? input.tagName : undefined, sortMode: 'nameAsc',
        selectedWatchedFolders: input.mode === 'relink' ? [dirname(input.fontPath)] : undefined }
      const initial = await readAll(request)
      let missing = initial.filter(font => font.fileAvailability === 'missing')
      const anchor = input.mode === 'relink' ? missing.find(font => key(font.path) === key(input.fontPath)) : undefined
      if (input.mode === 'relink' && !anchor) throw new Error('此字体已恢复、暂不可访问或标签关联已变化，请刷新后重试。')
      if (anchor) missing = missing.filter(font => key(dirname(font.path)) === key(dirname(anchor.path)))
      const targetPaths = new Set((anchor ? missing : initial.filter(font => font.fileAvailability !== 'available')).map(font => key(font.path)))
      const report = (message: string) => runtime.appendLog?.(`tag font recovery: ${message}`)
      report(`mode=${input.mode}, scope=${input.scope}, missing=${missing.length}${anchor ? `, anchor=${anchor.path}` : ''}`)
      const tags = (font: FontItem) => input.scope === 'local' ? font.localTagNames || [] : font.tagNames || []
      async function linkPairs(pairs: Array<[FontItem, FontItem]>, requiredPath?: string): Promise<void> {
        if (!pairs.length) return
        // Read current source AND destination tags once, after candidate parsing.
        const folders = [...new Set(pairs.flatMap(([old, next]) => [dirname(old.path), dirname(next.path)]))]
        const current = await readAll({ tagBindingsOnly: true, sidebarPage: request.sidebarPage, selectedWatchedFolders: folders })
        const byPath = new Map(current.map(font => [key(font.path), font]))
        const prepared: Array<{ old: FontItem; next: FontItem; combined: string[] }> = []
        for (const [old, next] of pairs) {
          try {
            if (key(old.path) === key(next.path)) throw new Error('请选择新的字体文件。')
            if (await fontFileAvailability(old.path, roots) !== 'missing') throw new Error('原路径已恢复或暂不可访问，未修改关联。')
            if (await fontFileAvailability(next.path, roots) !== 'available') throw new Error('所选字体文件不可访问。')
            if (input.scope === 'shared' && !roots.some(root => pathInsideFolder(next.path, root))) throw new Error('共享标签的目标文件必须位于监听文件夹中。')
            const source = byPath.get(key(old.path))
            if (!source || !tags(source).length || (input.mode === 'reindex' && !tags(source).includes(input.tagName))) throw new Error('原标签关联已变化，未执行过期的重新链接。')
            prepared.push({ old: source, next, combined: [...new Set([...tags(byPath.get(key(next.path)) || next), ...tags(source)])] })
          } catch (error) {
            if (requiredPath && key(old.path) === key(requiredPath)) throw error
            failures.push(`${old.fileName}：${String(error)}`)
          }
        }
        const completed = (old: FontItem, next: FontItem) => {
          missing = missing.filter(font => key(font.path) !== key(old.path))
          linked++
          report(`linked: from=${old.path}, to=${next.path}`)
        }
        if (input.scope === 'local') {
          const writes: FontTagBatchItem[] = []
          for (const { old, next, combined } of prepared) {
            if (!roots.some(root => pathInsideFolder(next.path, root))) await runtime.rememberRelinkedFontFile(next)
            writes.push({ item: next, tagNames: combined }, { item: old, tagNames: [] })
          }
          assertApplicationOpen(ticket)
          if (writes.length) {
            check(await runtime.setLocalFontTagsBatch(writes))
            for (const { old, next } of prepared) completed(old, next)
          }
        } else {
          for (const { old, next, combined } of prepared) {
            try {
              assertApplicationOpen(ticket)
              await admit('fonts:setSharedTagsBatch', [[{ item: old }, { item: next }], roots])
              const target = byPath.get(key(next.path))
              const previous = { ...next, tagNames: target?.tagNames || next.tagNames, sourceId: target?.sourceId || next.sourceId }
              // Confirm every destination addition before removing any source binding.
              for (const tag of tags(old)) {
                check(await runtime.setSharedFontTagsBatchInIndex([{ item: Object.assign({}, previous, { __sharedTagWriteMode: 'add', __sharedTagWriteTag: tag }), tagNames: combined }], roots))
              }
              for (const tag of tags(old)) {
                check(await runtime.setSharedFontTagsBatchInIndex([{ item: Object.assign({}, old, { __sharedTagWriteMode: 'remove', __sharedTagWriteTag: tag }), tagNames: tags(old).filter(name => name !== tag) }], roots))
              }
              completed(old, next)
            } catch (error) { failures.push(`${old.fileName}：${String(error)}`) }
          }
        }
      }
      if (input.mode === 'reindex') {
        // Resolve ownership before touching any root. Unrelated NAS roots must not
        // delay a recovery completed within the missing font's own watched root.
        const owner = (font: FontItem) => roots.filter(root => pathInsideFolder(font.path, root)).sort((a, b) => b.length - a.length)[0]
        const preferred = [...new Set(missing.map(owner).filter((root): root is string => !!root))]
        const ordered = [...preferred, ...roots.filter(root => !preferred.includes(root))]
        for (const root of ordered) {
          if (!missing.length) break
          try {
            assertApplicationOpen(ticket)
            report(`scan: root=${root}, remaining=${missing.length}`)
            await admit('folders:refreshWatched', [root, root])
            await runtime.refreshWatchedFolder(root, root, true)
            const current = await readAll(request)
            missing = missing.filter(old => current.some(font => key(font.path) === key(old.path) && font.fileAvailability === 'missing'))
            const candidates = await readAll({ sidebarPage: 'filters', activeFilter: { kind: 'all' }, selectedWatchedFolders: [root] })
            await linkPairs(uniqueRecoveryPairs(missing, candidates.filter(font => pathInsideFolder(font.path, root))))
          } catch (error) {
            failures.push(`${root}：${String(error)}`)
            report(`scan failed: root=${root}, error=${String(error)}`)
          }
        }
      } else if (anchor) {
        // One native picker for the clicked card; unmatched siblings remain for
        // their own card action instead of forcing a sequence of dialogs.
        report('picker opening')
        const selected = await pick(anchor)
        report(`picker closed: canceled=${!selected}`)
        assertApplicationOpen(ticket)
        if (!selected) canceled = true
        else try {
          const directory = dirname(selected)
          const indexed = new Map<string, FontItem>()
          try {
            for (const font of await readAll({ sidebarPage: 'filters', activeFilter: { kind: 'all' }, selectedWatchedFolders: [directory] })) {
              if (key(dirname(font.path)) === key(directory)) indexed.set(key(font.path), font)
            }
          } catch (error) { report(`candidate index unavailable: ${String(error)}`) }
          const next = await readReplacement(selected, indexed.get(key(selected)))
          const siblings = missing.filter(font => key(font.path) !== key(anchor.path))
          const names = new Set(siblings.map(font => font.fileName.toLowerCase()))
          const candidates: FontItem[] = []
          if (siblings.length) {
            for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
              const file = join(directory, entry.name)
              if (!entry.isFile() || !names.has(entry.name.toLowerCase()) || asFormat(entry.name) === 'unknown' || key(file) === key(selected)) continue
              try { candidates.push(await readReplacement(file, indexed.get(key(file)))) }
              catch (error) { failures.push(`${entry.name}：${String(error)}`) }
            }
          }
          const pairs = uniqueRecoveryPairs(siblings, candidates)
          report(`matched: candidates=${candidates.length}, siblings=${siblings.length}, pairs=${pairs.length}`)
          await linkPairs([[anchor, next], ...pairs], anchor.path)
        } catch (error) { failures.push(`${anchor.fileName}：${String(error)}`) }
      }
      const remaining = canceled ? targetPaths.size : (await readAll(request)).filter(font => targetPaths.has(key(font.path)) && font.fileAvailability !== 'available').length
      report(`finished: linked=${linked}, remaining=${remaining}, canceled=${canceled}, failures=${failures.length}`)
      return { linked, remaining, canceled, failures,
        message: `${canceled ? '已取消重新链接' : failures.length || remaining ? '字体关联恢复未全部完成' : '字体关联恢复完成'}：已链接 ${linked} 个，仍有 ${remaining} 个文件缺失或暂不可访问${failures.length ? `；${failures.length} 项未完成：${failures.join('；')}` : ''}。` }
    } finally { running = false }
  }
  return { recover }
}
