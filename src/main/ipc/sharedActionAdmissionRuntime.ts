import { ensureStartupPathRootAvailable, getStartupPathRootState } from '../path/startupPathAvailabilityRuntime'
import { applicationWorkEpoch, isApplicationClosing } from '../app/shutdownCoordinatorRuntime'
import { SharedIoProcessError } from '../path/sharedIoProcessRuntime'
import { pathRoots, sharedPathBlocked, sharedTagBlocked, SHARED_UNAVAILABLE_MESSAGE, type SharedAvailability } from '../../shared/sharedAvailability'

const itemChannels = new Set(['fonts:installSystem', 'fonts:installCurrentUser', 'fonts:activateFont', 'fonts:activateFonts', 'fonts:deleteFiles', 'fonts:moveFileToFolder', 'fonts:moveFilesToFolder', 'fonts:readPreviewFontData', 'fonts:renderPreviewImage', 'fonts:ensurePreviewCache'])
const physicalFontChannels = new Set([...itemChannels, 'fonts:uninstallSystem', 'fonts:uninstallManaged', 'fonts:deactivateFont', 'fonts:deactivateFonts'])
const pathChannels = new Set(['folders:createPhysical', 'folders:renamePhysical', 'folders:refreshWatched', 'shell:showItemInFolder'])
const listChannels = new Set(['fonts:scanFolders', 'fonts:loadFolderCache', 'folders:listPhysicalTree'])
const queryChannels = new Set(['fonts:query', 'fonts:queryPage'])
const sharedChannels = new Set(['fonts:setSharedTags', 'fonts:setSharedTagsBatch', 'fonts:renameSharedTag', 'fonts:deleteSharedTag'])
const freshItemChannels = new Set(['fonts:installSystem', 'fonts:installCurrentUser', 'fonts:activateFont', 'fonts:activateFonts', 'fonts:deleteFiles', 'fonts:moveFileToFolder', 'fonts:moveFilesToFolder'])
const freshListChannels = new Set(['fonts:scanFolders', 'folders:listPhysicalTree'])
export function createSharedActionAdmission(read: (() => Promise<SharedAvailability>) | undefined) {
  return async (channel: string, args: any[]): Promise<() => void> => {
    if (physicalFontChannels.has(channel)) {
      const items = Array.isArray(args[0]) ? args[0] : [args[0]]
      if (items.some(item => item?.recoveryPlaceholder === true || String(item?.id || '').startsWith('missing:'))) {
        throw new Error('历史字体记录仅供显示和重新链接，请先确认源文件。')
      }
    }
    if (!itemChannels.has(channel) && !pathChannels.has(channel) && !listChannels.has(channel) && !sharedChannels.has(channel) && !queryChannels.has(channel) && channel !== 'library:save') return () => undefined
    if (!read) throw new Error(SHARED_UNAVAILABLE_MESSAGE)
    const current = await read()
    const workEpoch = applicationWorkEpoch()
    const snapshot = { ...current, roots: [...current.roots] }
    const guarded = new Map<string, ReturnType<typeof getStartupPathRootState>>()
    const refreshRoot = async (path: string): Promise<void> => {
      if (guarded.has(path)) return
      if (!await ensureStartupPathRootAvailable(path, undefined, 'shared-action-admission')) throw new Error(SHARED_UNAVAILABLE_MESSAGE)
      const state = getStartupPathRootState(path)
      if (state.state !== 'online') throw new Error(SHARED_UNAVAILABLE_MESSAGE)
      guarded.set(path, state)
      snapshot.roots = snapshot.roots.map(root => root.path === path ? { ...root, ...state } : root)
    }
    let paths: unknown[] = []
    if (itemChannels.has(channel)) {
      const items = Array.isArray(args[0]) ? args[0] : [args[0]]
      paths = items.map(item => item?.path)
      if (channel.includes('moveFile')) paths.push(args[1])
    }
    if (pathChannels.has(channel)) paths = [args[0]]
    if (channel === 'folders:refreshWatched' && args[1]) paths.push(args[1])
    if (listChannels.has(channel)) {
      paths = Array.isArray(args[0]) ? args[0] : [undefined]
      // Adding a monitored folder reads it before saving its configuration. Verify
      // new roots through the existing owner; never trust a caller's online flag.
      for (const path of paths) {
        if (typeof path !== 'string' || !path || pathRoots(snapshot, path).length) continue
        await refreshRoot(path)
        snapshot.roots.push({ ...getStartupPathRootState(path), path, tags: [] })
      }
    }
    if (sharedChannels.has(channel)) {
      // These legacy mutations may visit all supplied indexes, so require all configured roots.
      if (channel === 'fonts:setSharedTags' || channel === 'fonts:setSharedTagsBatch') {
        paths = Array.isArray(args[0]) ? args[0].map(item => (item?.item || item)?.path) : [undefined]
        paths.push(...(Array.isArray(args[1]) ? args[1] : [undefined]))
      } else paths = Array.isArray(args[channel === 'fonts:renameSharedTag' ? 2 : 1]) ? args[channel === 'fonts:renameSharedTag' ? 2 : 1] : [undefined]
    }
    const changesSharedTags = channel === 'library:save' && JSON.stringify(args[0]?.tags) !== JSON.stringify(snapshot.tags)
    if (changesSharedTags && isApplicationClosing()) throw new Error(SHARED_UNAVAILABLE_MESSAGE)
    if (sharedChannels.has(channel) || changesSharedTags) {
      for (const root of snapshot.roots) await refreshRoot(root.path)
      if (sharedTagBlocked(snapshot)) throw new Error(SHARED_UNAVAILABLE_MESSAGE)
    } else if (freshItemChannels.has(channel) || pathChannels.has(channel) || freshListChannels.has(channel)) {
      for (const path of paths) {
        if (typeof path !== 'string' || !path) continue
        for (const root of pathRoots(snapshot, path)) await refreshRoot(root.path)
      }
    }
    if (queryChannels.has(channel)) {
      const request = args[0] || {}
      paths = [...(request.selectedWatchedFolders || []), ...(request.selectedFolderId ? [request.selectedFolderId] : [])]
      if ((request.sidebarPage === 'sharedTags' || request.activeFilter?.kind === 'sharedTag') && sharedTagBlocked(snapshot, request.activeFilter?.name || request.selectedTagName)) throw new Error(SHARED_UNAVAILABLE_MESSAGE)
    }
    if (channel === 'library:save' && JSON.stringify(args[0]?.tags) !== JSON.stringify(snapshot.tags) && sharedTagBlocked(snapshot)) throw new Error(SHARED_UNAVAILABLE_MESSAGE)
    if (paths.some(path => typeof path !== 'string' || !path || sharedPathBlocked(snapshot, path))) throw new Error(SHARED_UNAVAILABLE_MESSAGE)
    const assertCurrent = () => {
      if (guarded.size && (isApplicationClosing() || applicationWorkEpoch() !== workEpoch)) throw new SharedIoProcessError(SHARED_UNAVAILABLE_MESSAGE, 'not-started', 'stale-generation')
      for (const [path, expected] of guarded) {
        const latest = getStartupPathRootState(path)
        if (latest.state !== 'online' || latest.rootId !== expected.rootId || latest.generation !== expected.generation) throw new SharedIoProcessError(SHARED_UNAVAILABLE_MESSAGE, 'not-started', 'stale-generation')
      }
    }
    // Earlier roots may have changed while later roots were being confirmed.
    assertCurrent()
    return assertCurrent
  }
}
