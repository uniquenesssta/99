import { createSharedActionAdmission } from '../ipc/sharedActionAdmissionRuntime'
import { assertApplicationOpen, applicationWorkEpoch } from '../app/shutdownCoordinatorRuntime'
import { dirname, join } from 'node:path'
import type { FontItem, FontQueryPageResult, FontQueryRequest, FontTagUpdateResult, LibraryState } from '../../shared/types'
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
  async function readReplacement(file: string): Promise<FontItem> {
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
    if (running) throw new Error('正在恢复字体关联，请等待当前操作完成。')
    if (!input || !['local', 'shared'].includes(input.scope) || !['reindex', 'relink'].includes(input.mode) || !String(input.tagName || '').trim()) throw new Error('无效的标签恢复请求。')
    const ticket = applicationWorkEpoch()
    assertApplicationOpen(ticket)
    running = true
    const failures: string[] = []
    let linked = 0, canceled = false
    try {
      const library = await runtime.loadLibraryShell() as LibraryState
      const roots = library.folders || []
      const request: FontQueryRequest = { sidebarPage: input.scope === 'local' ? 'tags' : 'sharedTags', selectedTagName: input.tagName, sortMode: 'nameAsc' }
      if (input.mode === 'reindex') {
        for (const root of roots) {
          try { assertApplicationOpen(ticket); await admit('folders:refreshWatched', [root, root]); await runtime.refreshWatchedFolder(root, root, true) }
          catch (error) { failures.push(`${root}：${String(error)}`) }
        }
      }
      let missing = (await readAll(request)).filter(font => font.fileAvailability === 'missing')
      const tags = (font: FontItem) => input.scope === 'local' ? font.localTagNames || [] : font.tagNames || []
      async function link(old: FontItem, next: FontItem): Promise<void> {
        if (key(old.path) === key(next.path)) throw new Error('请选择新的字体文件。')
        if (await fontFileAvailability(old.path, roots) !== 'missing') throw new Error('原路径已恢复或暂不可访问，未修改关联。')
        if (await fontFileAvailability(next.path, roots) !== 'available') throw new Error('所选字体文件不可访问。')
        if (input.scope === 'shared' && !roots.some(root => pathInsideFolder(next.path, root))) throw new Error('共享标签的目标文件必须位于监听文件夹中。')
        assertApplicationOpen(ticket)
        if (input.scope === 'shared') await admit('fonts:setSharedTagsBatch', [[{ item: old }, { item: next }], roots])
        const current = await readAll({ sidebarPage: request.sidebarPage })
        const source = current.find(font => key(font.path) === key(old.path))
        if (!source || !tags(source).includes(input.tagName)) throw new Error('原标签关联已变化，未执行过期的重新链接。')
        assertApplicationOpen(ticket)
        old = source
        const previous = current.find(font => key(font.path) === key(next.path)) || next
        const sourceTags = tags(old)
        const combined = [...new Set([...tags(previous), ...sourceTags])]
        if (input.scope === 'local') {
          if (!roots.some(root => pathInsideFolder(next.path, root))) await runtime.rememberRelinkedFontFile(next)
          check(await runtime.setLocalFontTagsBatch([{ item: next, tagNames: combined }, { item: old, tagNames: [] }]))
        } else {
          // Confirm all destination additions before removing any source binding.
          for (const tag of sourceTags) {
            check(await runtime.setSharedFontTagsBatchInIndex([{ item: Object.assign({}, previous, { __sharedTagWriteMode: 'add', __sharedTagWriteTag: tag }), tagNames: combined }], roots))
          }
          for (const tag of sourceTags) {
            check(await runtime.setSharedFontTagsBatchInIndex([{ item: Object.assign({}, old, { __sharedTagWriteMode: 'remove', __sharedTagWriteTag: tag }), tagNames: tags(old).filter(name => name !== tag) }], roots))
          }
        }
        missing = missing.filter(font => key(font.path) !== key(old.path))
        linked++
      }
      async function automatic(candidates: FontItem[], targets = missing): Promise<void> {
        for (const [old, next] of uniqueRecoveryPairs(targets, candidates)) {
          try { await link(old, next) } catch (error) { failures.push(`${old.fileName}：${String(error)}`) }
        }
      }
      if (input.mode === 'reindex') {
        await automatic(await readAll({ sidebarPage: 'library', activeFilter: { kind: 'all' } }))
      } else {
        for (const old of [...missing]) {
          if (!missing.some(font => key(font.path) === key(old.path))) continue
          const selected = await pick(old)
          if (!selected) { canceled = true; break }
          try {
            const next = await readReplacement(selected)
            await link(old, next)
            const candidates: FontItem[] = []
            const siblings = missing.filter(font => key(dirname(font.path)) === key(dirname(old.path)))
            if (siblings.length) {
              for (const entry of await fsp.readdir(dirname(selected), { withFileTypes: true })) {
                if (!entry.isFile() || asFormat(entry.name) === 'unknown' || key(join(dirname(selected), entry.name)) === key(selected)) continue
                try { candidates.push(await readReplacement(join(dirname(selected), entry.name))) } catch { /* Bad fonts are never matched. */ }
              }
              await automatic(candidates, siblings)
            }
          } catch (error) { failures.push(`${old.fileName}：${String(error)}`) }
        }
      }
      const remaining = (await readAll(request)).filter(font => font.fileAvailability !== 'available').length
      return { linked, remaining, canceled, failures,
        message: `${canceled ? '已停止重新链接' : '字体关联恢复完成'}：已链接 ${linked} 个，仍有 ${remaining} 个文件缺失或暂不可访问${failures.length ? `；${failures.length} 项未完成：${failures.join('；')}` : ''}。` }
    } finally { running = false }
  }
  return { recover }
}
