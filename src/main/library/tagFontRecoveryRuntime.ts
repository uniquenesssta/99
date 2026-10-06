import { withOperationWork, measureOperationPhase } from '../logging/operationTraceContext'
import { withSharedIoPriority } from '../path/sharedFileSystemRuntime'
import { detailedStartupLogsEnabled } from '../logging/startupLogPolicy'
import { createSharedActionAdmission } from '../ipc/sharedActionAdmissionRuntime'
import { assertApplicationOpen, applicationWorkEpoch } from '../app/shutdownCoordinatorRuntime'
import { dirname, join, parse } from 'node:path'
import type { FontItem, FontQueryPageResult, FontQueryRequest, FontTagUpdateResult, FontTagBatchItem, LibraryState } from '../../shared/types'
import type { TagFontRecoveryRequest, TagFontRecoveryResult } from '../../shared/tagFontRecovery'
import type { IpcHandlerRuntime } from '../ipc/ipcHandlerTypes'
import { normalizePathForCacheCompare as key } from '../path/cachePath'
import { createTagRecoveryPaths } from './tagRecoveryPathRuntime'
import { sharedFileSystem as fsp } from '../path/sharedFileSystemRuntime'
import { asFormat, fontItemFromPath, hasValidFontSignature } from '../fonts/fontRuntime'
import { fontFileAvailability, withTagFontQuerySnapshot } from './tagFontQueryRuntime'

import { readFontContentIdentity, fontPhysicalKey } from '../fonts/fontContentIdentityRuntime'
import { recoveryCandidate, sameRecoveryFont, uniqueRecoveryPairs } from './tagRecoveryMatchRuntime'
export { sameRecoveryFont, uniqueRecoveryPairs } from './tagRecoveryMatchRuntime'

export function createTagFontRecoveryRuntime(runtime: IpcHandlerRuntime, pick: (font: FontItem) => Promise<string | undefined>) {
  const physicalPaths = new Map<string, string>()
  const fileKeys = new Map<string, string>()
  async function readReplacement(file: string, indexed?: FontItem, expectedHashes: string[] = []): Promise<FontItem> {
    const identity = await readFontContentIdentity(file)
    physicalPaths.set(key(file), identity.path)
    const physicalKey = fontPhysicalKey(identity)
    if (physicalKey) fileKeys.set(key(file), physicalKey)
    let font: FontItem
    if (indexed && identity.size === indexed.fileSize && identity.modified === indexed.modifiedAt
      && indexed.postscriptName && (expectedHashes.includes(identity.sha256) || indexed.recoveryContentHash === identity.sha256)) font = { ...indexed, path: file }
    else {
      if (asFormat(file) === 'unknown' || !await hasValidFontSignature(file)) throw new Error('所选文件不是可识别的字体文件。')
      font = await fontItemFromPath(file)
      if (font.fileSize !== identity.size || font.modifiedAt !== identity.modified) throw new Error('字体解析期间文件已变化，请重新选择。')
    }
    return { ...font, recoveryContentHash: identity.sha256 }
  }
  let running = false
  const admit = createSharedActionAdmission(runtime.getSharedAvailability)
  async function readAll(request: FontQueryRequest): Promise<FontItem[]> {
    return withTagFontQuerySnapshot(async () => {
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
    })
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
    physicalPaths.clear()
    fileKeys.clear()
    const failures: string[] = []
    const unresolved = new Map<string, string>()
    const pendingAssociations: string[] = []
    let linked = 0, canceled = false
    try {
      const library = await runtime.loadLibraryShell() as LibraryState
      const paths = await createTagRecoveryPaths(library.folders || [])
      const roots = paths.roots
      const request: FontQueryRequest = { tagBindingsOnly: true, sidebarPage: input.scope === 'local' ? 'tags' : 'sharedTags',
        selectedTagName: input.mode === 'reindex' ? input.tagName : undefined, sortMode: 'nameAsc',
        selectedWatchedFolders: input.mode === 'relink' ? [dirname(input.fontPath)] : undefined }
      const initial = await measureOperationPhase('preparation', () => readAll(request))
      let missing = initial.filter(font => font.fileAvailability === 'missing')
      const anchor = input.mode === 'relink' ? initial.find(font => key(font.path) === key(input.fontPath) &&
        (font.fileAvailability === 'missing' || font.fileRelinkRequired) && !font.tagBindingReadOnly) : undefined
      if (input.mode === 'relink' && !anchor) throw new Error('此字体已恢复、暂不可访问或标签关联已变化，请刷新后重试。')
      if (anchor) missing = [anchor, ...missing.filter(font => key(font.path) !== key(anchor.path) && paths.compare(dirname(font.path)) === paths.compare(dirname(anchor.path)))]
      const completedPaths = new Set<string>()
      const targetPaths = new Set((anchor ? missing : initial.filter(font => font.fileAvailability !== 'available')).map(font => key(font.path)))
      const report = (message: string) => { if (detailedStartupLogsEnabled() || message.startsWith('scan failed:')) runtime.appendLog?.(`tag font recovery: ${message}`) }
      report(`mode=${input.mode}, scope=${input.scope}, missing=${missing.length}${anchor ? `, anchor=${anchor.path}` : ''}`)
      const tags = (font: FontItem) => input.scope === 'local' ? font.localTagNames || [] : font.tagNames || []
      const signature = (names: string[]) => JSON.stringify([...new Set(names)].sort())
      const compare = (file: string) => paths.compare(physicalPaths.get(key(file)) || file)
      // This cache owns candidate preparation only. Every link and transaction
      // below still reads content freshly at its own mutation safety boundary.
      let preparedCandidates = new Map<string, Promise<FontItem>>()
      const prepareReplacement = (file: string, hint?: FontItem, hashes: string[] = []) => {
        const identity = key(file)
        let pending = preparedCandidates.get(identity)
        if (!pending) { pending = measureOperationPhase('candidate', () => readReplacement(file, hint, hashes)); preparedCandidates.set(identity, pending) }
        return pending
      }
      async function matchPairs(sources: FontItem[], hints: FontItem[], reserved?: FontItem): Promise<Array<[FontItem, FontItem]>> {
        const candidates: FontItem[] = []
        for (const font of hints) {
          const relevant = sources.filter(old => recoveryCandidate(old, font) && /^[a-f0-9]{64}$/.test(old.recoveryContentHash || ''))
          if (!relevant.length) continue
          try {
            const next = await prepareReplacement(font.path, font, relevant.map(old => old.recoveryContentHash!))
            if (!paths.contains(physicalPaths.get(key(next.path))!)) throw new Error('候选实际文件位于监听范围外，需从卡片手选确认。')
            if (reserved && (fileKeys.get(key(next.path)) || compare(next.path)) === (fileKeys.get(key(reserved.path)) || compare(reserved.path))) continue
            candidates.push(next)
          } catch (error) { for (const old of relevant) unresolved.set(key(old.path), `候选读取失败：${String(error)}`) }
        }
        const pairs = uniqueRecoveryPairs(sources, candidates, file => fileKeys.get(key(file)) || compare(file))
        for (const old of sources) {
          if (pairs.some(([source]) => key(source.path) === key(old.path))) { unresolved.delete(key(old.path)); continue }
          if (!/^[a-f0-9]{64}$/.test(old.recoveryContentHash || '')) unresolved.set(key(old.path), '历史内容证据不足，请从字体卡片手选文件。')
          else if (candidates.some(next => sameRecoveryFont(old, next))) unresolved.set(key(old.path), '存在多个候选或来源争用，需手选文件。')
          else if (!unresolved.has(key(old.path))) unresolved.set(key(old.path), '未找到内容一致的候选文件。')
        }
        return pairs
      }

      async function linkPairs(pairs: Array<[FontItem, FontItem]>, requiredPath?: string): Promise<void> {
        preparedCandidates.clear()
        if (!pairs.length) return
        // Read current source AND destination tags once, after candidate parsing.
        const folders = [...new Set(pairs.flatMap(([old, next]) => [dirname(old.path), dirname(next.path)]))]
        const current = await readAll({ tagBindingsOnly: true, sidebarPage: request.sidebarPage, selectedWatchedFolders: folders })
        const byPath = new Map(current.map(font => [key(font.path), font]))
        const prepared: Array<{ old: FontItem; next: FontItem; combined: string[]; targetTags: string[]; verified: boolean }> = []
        for (const [old, next] of pairs) {
          try {
            const source = byPath.get(key(old.path))
            if (source?.tagBindingReadOnly || byPath.get(key(next.path))?.tagBindingReadOnly) throw new Error('共享标签暂不可读取，未修改历史关联。')
            const reconfirm = input.scope === 'local' && !!source?.fileRelinkRequired
            if (key(old.path) === key(next.path) && !reconfirm) throw new Error('请选择新的字体文件。')
            if (!reconfirm && await fontFileAvailability(old.path, roots) !== 'missing') throw new Error('原路径已恢复或暂不可访问，未修改关联。')
            if (await fontFileAvailability(next.path, roots) !== 'available') throw new Error('所选字体文件不可访问。')
            const identity = await readFontContentIdentity(next.path)
            if (identity.sha256 !== next.recoveryContentHash || identity.size !== next.fileSize || identity.modified !== next.modifiedAt || paths.compare(identity.path) !== compare(next.path)) throw new Error('候选在准备后已被替换，未修改关联。')
            assertApplicationOpen(ticket)
            if (input.scope === 'shared' && (!paths.contains(next.path) || !paths.contains(identity.path))) throw new Error('共享标签的目标文件必须位于监听文件夹中。')
            if (!source || !tags(source).length || (input.mode === 'reindex' && !tags(source).includes(input.tagName))) throw new Error('原标签关联已变化，未执行过期的重新链接。')
            prepared.push({ old: source, next, targetTags: tags(byPath.get(key(next.path)) || { ...next, tagNames: [], localTagNames: [] }), combined: [...new Set([...tags(byPath.get(key(next.path)) || { ...next, tagNames: [], localTagNames: [] }), ...tags(source)])], verified: sameRecoveryFont(source, next) })
          } catch (error) {
            if (requiredPath && key(old.path) === key(requiredPath)) throw error
            failures.push(`${old.fileName}：${String(error)}`)
          }
        }
        const completed = (old: FontItem, next: FontItem) => {
          missing = missing.filter(font => key(font.path) !== key(old.path))
          targetPaths.delete(key(old.path))
          completedPaths.add(key(old.path))
          unresolved.delete(key(old.path))
          linked++
          if (paths.contains(old.path) && old.deleteProtected) pendingAssociations.push(`${old.fileName}：监听库保护记录保留在原路径，请在目标字体卡确认保护。`)
          if (detailedStartupLogsEnabled()) report(`linked: from=${old.path}, to=${next.path}`)
        }
        if (input.scope === 'local') {
          const writes: FontTagBatchItem[] = []
          for (const { old, next, combined, targetTags } of prepared) {
            if (!paths.contains(next.path) || !paths.contains(physicalPaths.get(key(next.path)) || next.path)) await runtime.rememberRelinkedFontFile(next)
            writes.push({ item: next, tagNames: combined, expectedTagNames: targetTags })
            if (key(old.path) !== key(next.path)) writes.push({ item: old, tagNames: [], expectedTagNames: tags(old) })
          }
          assertApplicationOpen(ticket)
          if (writes.length) {
            check(await runtime.setLocalFontTagsBatch(writes, { recoveryMissingSources: prepared.filter(({ old }) => old.fileAvailability === 'missing').map(({ old }) => ({ path: old.path, rootPath: paths.owner(old.path) || parse(old.path).root })), recoveryFiles: prepared.map(({ next }) => ({ path: next.path, physicalPath: physicalPaths.get(key(next.path))!, sha256: next.recoveryContentHash! })), recoveryMoves: prepared.filter(pair => pair.verified).map(({ old, next }) => ({ from: key(old.path), to: key(next.path) })) }))
            for (const { old, next } of prepared) completed(old, next)
          }
        } else {
          for (const { old, next, combined, verified } of prepared) {
            try {
              assertApplicationOpen(ticket)
              await admit('fonts:setSharedTagsBatch', [[{ item: old }, { item: next }], roots])
              const target = byPath.get(key(next.path))
              const previous = { ...next, tagNames: target?.tagNames || next.tagNames, sourceId: target?.sourceId || next.sourceId }
              // Confirm every destination addition before removing any source binding.
              for (const tag of tags(old)) {
                assertApplicationOpen(ticket)
                check(await runtime.setSharedFontTagsBatchInIndex([{ item: Object.assign({}, previous, { __sharedTagWriteMode: 'add', __sharedTagWriteTag: tag }), tagNames: combined }], roots))
              }
              const refreshed = await readAll({ tagBindingsOnly: true, sidebarPage: request.sidebarPage, selectedWatchedFolders: folders })
              const liveSource = refreshed.find(font => key(font.path) === key(old.path))
              const liveTarget = refreshed.find(font => key(font.path) === key(next.path))
              if (!liveSource || liveSource.tagBindingReadOnly || liveTarget?.tagBindingReadOnly || signature(tags(liveSource)) !== signature(tags(old)) || !tags(old).every(tag => liveTarget && tags(liveTarget).includes(tag))) throw new Error('共享关联在恢复期间变化，目标未全部确认，原关联已保留，请重试。')
              const identity = await readFontContentIdentity(next.path)
              if (identity.sha256 !== next.recoveryContentHash || paths.compare(identity.path) !== compare(next.path)) throw new Error('共享目标已被替换，原关联已保留。')
              if (await fontFileAvailability(old.path, roots) !== 'missing') throw new Error('原字体已恢复或暂不可访问，未解除共享关联。')
              if (verified) check(await runtime.setLocalFontTagsBatch([], { recoveryMoves: [{ from: key(old.path), to: key(next.path) }], recoveryFiles: [{ path: next.path, physicalPath: identity.path, sha256: next.recoveryContentHash! }] }))
              assertApplicationOpen(ticket)
              for (const tag of tags(old)) {
                assertApplicationOpen(ticket)
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
        const owner = (font: FontItem) => paths.owner(font.path)
        const preferred = [...new Set(missing.map(owner).filter((root): root is string => !!root))]
        const ordered = [...preferred, ...roots.filter(root => !preferred.includes(root))]
        report(`scan plan: preferred=${JSON.stringify(preferred)}, fallback=${JSON.stringify(ordered.slice(preferred.length))}`)
        for (const root of ordered) {
          if (!missing.length) break
          try {
            assertApplicationOpen(ticket)
            report(`scan: root=${root}, reason=${preferred.includes(root) ? 'longest-owner' : preferred.length ? 'unmatched-after-preferred' : 'no-confirmed-owner'}, remaining=${missing.length}`)
            await admit('folders:refreshWatched', [root, root])
            const result = await runtime.refreshWatchedFolder(root, root, true)
            report(`scan result: root=${root}, mode=${result.mode}, errors=${result.errors}, canceled=${!!result.cancelled}, files=${result.totalFiles}`)
            if (result.cancelled) { canceled = true; break }
            if (!result.ok || result.errors) failures.push(`${root}：${result.message}`)
            const current = await readAll(request)
            missing = missing.filter(old => current.some(font => key(font.path) === key(old.path) && font.fileAvailability === 'missing'))
            preparedCandidates = new Map()
            const candidates = await readAll({ sidebarPage: 'filters', activeFilter: { kind: 'all' }, selectedWatchedFolders: [root] })
            const pairs = await matchPairs(missing, candidates.filter(font => paths.inside(font.path, root)))
            await measureOperationPhase('commit', () => linkPairs(pairs))
          } catch (error) {
            failures.push(`${root}：${String(error)}`)
            report(`scan failed: root=${root}, error=${String(error)}`)
          }
        }
      } else if (anchor) {
        // One native picker for the clicked card; unmatched siblings remain for
        // their own card action instead of forcing a sequence of dialogs.
        report('picker opening')
        const selected = await measureOperationPhase('picker', () => pick(anchor))
        report(`picker closed: canceled=${!selected}`)
        assertApplicationOpen(ticket)
        if (!selected) canceled = true
        else try {
          const directory = dirname(selected)
          const indexed = new Map<string, FontItem>()
          try {
            for (const font of await readAll({ sidebarPage: 'filters', activeFilter: { kind: 'all' }, selectedWatchedFolders: [directory] })) {
              if (paths.compare(dirname(font.path)) === paths.compare(directory)) indexed.set(key(font.path), font)
            }
          } catch (error) { report(`candidate index unavailable: ${String(error)}`) }
          const next = await prepareReplacement(selected, indexed.get(key(selected)), anchor.recoveryContentHash ? [anchor.recoveryContentHash] : [])
          const siblings = missing.filter(font => key(font.path) !== key(anchor.path))
          const candidates: FontItem[] = []
          const eligibleSiblings = siblings.filter(old => /^[a-f0-9]{64}$/.test(old.recoveryContentHash || ''))
          if (eligibleSiblings.length) try {
            for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
              const file = join(directory, entry.name)
              if ((!entry.isFile() && !entry.isSymbolicLink()) || asFormat(entry.name) === 'unknown' || compare(file) === compare(selected)) continue
              try {
                const hint = indexed.get(key(file))
                if (hint) { if (eligibleSiblings.some(old => recoveryCandidate(old, hint))) candidates.push(hint) }
                else { const stat = await fsp.stat(file); if (eligibleSiblings.some(old => old.fileSize === stat.size && old.format === asFormat(file))) candidates.push(await prepareReplacement(file, undefined)) }
              }
              catch (error) { failures.push(`${entry.name}：${String(error)}`) }
            }
          }
          catch (error) { for (const old of siblings) unresolved.set(key(old.path), `同目录读取失败：${String(error)}`) }
          const pairs = await matchPairs(siblings, candidates, next)
          report(`matched: candidates=${candidates.length}, siblings=${siblings.length}, pairs=${pairs.length}`)
          await measureOperationPhase('commit', () => linkPairs([[anchor, next], ...pairs], anchor.path))
        } catch (error) { failures.push(`${anchor.fileName}：${String(error)}`) }
      }
      const remaining = canceled ? targetPaths.size : (await readAll(request)).filter(font => targetPaths.has(key(font.path)) && font.fileAvailability !== 'available').length
      if (linked) {
        try {
          const other = await readAll({ tagBindingsOnly: true, sidebarPage: input.scope === 'local' ? 'sharedTags' : 'tags', selectedWatchedFolders: [...new Set(initial.map(font => dirname(font.path)))] })
          for (const font of other) if (completedPaths.has(key(font.path)) && (input.scope === 'local' ? font.tagNames : font.localTagNames)?.length) pendingAssociations.push(`${font.fileName}：${input.scope === 'local' ? '共享' : '本地'}标签仍在原路径，请从对应标签页继续恢复。`)
        } catch (error) { pendingAssociations.push(`其他标签范围未能确认，请从对应标签页继续：${String(error)}`) }
      }
      report(`finished: linked=${linked}, remaining=${remaining}, canceled=${canceled}, failures=${failures.length}`)
      return { linked, remaining, canceled, failures, scope: input.scope, pendingAssociations, unresolved: [...unresolved].filter(([path]) => targetPaths.has(path)).map(([path, reason]) => ({ path, reason })),
        message: `${canceled ? input.mode === 'reindex' ? '已取消重新索引' : '已取消重新链接' : failures.length || remaining ? '字体关联恢复未全部完成' : '字体关联恢复完成'}：已链接 ${linked} 个，仍有 ${remaining} 个文件缺失或暂不可访问${failures.length ? `；${failures.length} 项未完成：${failures.join('；')}` : ''}。本次处理${input.scope === 'local' ? '本地' : '共享'}标签${pendingAssociations.length ? `；${pendingAssociations.join('；')}` : ''}${remaining && unresolved.size ? `；${[...unresolved.values()].join('；')}` : ''}。` }
    } finally { running = false }
  }
  return { recover: (input: TagFontRecoveryRequest) => withOperationWork('tag-recovery', runtime.appendLog, () => withSharedIoPriority('foreground', () => recover(input))) }
}
