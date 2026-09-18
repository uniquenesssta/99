import { ensureStartupPathRootAvailable, getStartupPathRootState } from '../path/startupPathAvailabilityRuntime'
import { pathRoots, sharedPathBlocked, sharedTagBlocked, SHARED_UNAVAILABLE_MESSAGE, type SharedAvailability } from '../../shared/sharedAvailability'

const itemChannels = new Set(['fonts:installSystem', 'fonts:installCurrentUser', 'fonts:activateFont', 'fonts:activateFonts', 'fonts:deleteFiles', 'fonts:moveFileToFolder', 'fonts:moveFilesToFolder', 'fonts:readPreviewFontData', 'fonts:renderPreviewImage', 'fonts:ensurePreviewCache'])
const pathChannels = new Set(['folders:createPhysical', 'folders:renamePhysical', 'folders:refreshWatched', 'shell:showItemInFolder'])
const listChannels = new Set(['fonts:scanFolders', 'fonts:loadFolderCache', 'folders:listPhysicalTree'])
const queryChannels = new Set(['fonts:query', 'fonts:queryPage'])
const sharedChannels = new Set(['fonts:setSharedTags', 'fonts:setSharedTagsBatch', 'fonts:renameSharedTag', 'fonts:deleteSharedTag'])
export function createSharedActionAdmission(read: (() => Promise<SharedAvailability>) | undefined) {
  return async (channel: string, args: any[]): Promise<void> => {
    if (!itemChannels.has(channel) && !pathChannels.has(channel) && !listChannels.has(channel) && !sharedChannels.has(channel) && !queryChannels.has(channel) && channel !== 'library:save') return
    if (!read) throw new Error(SHARED_UNAVAILABLE_MESSAGE)
    const current = await read()
    const snapshot = { ...current, roots: [...current.roots] }
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
        if (!await ensureStartupPathRootAvailable(path, undefined, 'new-folder-admission')) throw new Error(SHARED_UNAVAILABLE_MESSAGE)
        snapshot.roots.push({ ...getStartupPathRootState(path), path, tags: [] })
      }
    }
    if (sharedChannels.has(channel)) {
      // These legacy mutations may visit all supplied indexes, so require all configured roots.
      if (sharedTagBlocked(snapshot)) throw new Error(SHARED_UNAVAILABLE_MESSAGE)
      if (channel === 'fonts:setSharedTags' || channel === 'fonts:setSharedTagsBatch') {
        paths = Array.isArray(args[0]) ? args[0].map(item => (item?.item || item)?.path) : [undefined]
        paths.push(...(Array.isArray(args[1]) ? args[1] : [undefined]))
      } else paths = Array.isArray(args[channel === 'fonts:renameSharedTag' ? 2 : 1]) ? args[channel === 'fonts:renameSharedTag' ? 2 : 1] : [undefined]
    }
    if (queryChannels.has(channel)) {
      const request = args[0] || {}
      paths = [...(request.selectedWatchedFolders || []), ...(request.selectedFolderId ? [request.selectedFolderId] : [])]
      if ((request.sidebarPage === 'sharedTags' || request.activeFilter?.kind === 'sharedTag') && sharedTagBlocked(snapshot, request.activeFilter?.name || request.selectedTagName)) throw new Error(SHARED_UNAVAILABLE_MESSAGE)
    }
    if (channel === 'library:save' && JSON.stringify(args[0]?.tags) !== JSON.stringify(snapshot.tags) && sharedTagBlocked(snapshot)) throw new Error(SHARED_UNAVAILABLE_MESSAGE)
    if (paths.some(path => typeof path !== 'string' || !path || sharedPathBlocked(snapshot, path))) throw new Error(SHARED_UNAVAILABLE_MESSAGE)
  }
}
