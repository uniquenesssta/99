import { win32 } from 'node:path'
import type { FontItem } from '../../../shared/types'

export type InstallRefreshCandidates = {
  items: FontItem[]
  scope: 'all-roots' | 'snapshot' | 'available-roots'
  unavailableRoots: string[]
  snapshotIds: Set<string>
}

// This result is deliberately not a shared-font cache: a partial population must
// never be published under the configured all-roots cache key.
export async function loadInstallRefreshCandidates(
  folders: string[],
  loadRoot: (folders: string[]) => Promise<FontItem[]>,
  readSnapshot?: (folders: string[]) => Promise<FontItem[] | null>,
): Promise<InstallRefreshCandidates> {
  // Preserve the ordinary complete-population/cache path and its I/O budget.
  // Isolation is a recovery path only after that all-roots read has failed.
  try {
    return { items: await loadRoot(folders), scope: 'all-roots', unavailableRoots: [], snapshotIds: new Set<string>() }
  } catch { /* Recover each root independently without publishing a partial cache. */ }
  const items = new Map<string, FontItem>()
  const unavailableRoots: string[] = []
  for (const root of folders) {
    try { for (const item of await loadRoot([root])) items.set(item.id, item) }
    catch { unavailableRoots.push(root) }
  }
  const snapshotIds = new Set<string>()
  if (!unavailableRoots.length) return { items: [...items.values()], scope: 'all-roots', unavailableRoots, snapshotIds }
  const snapshot = await readSnapshot?.(folders).catch(() => null)
  if (snapshot) {
    for (const item of snapshot) {
      if (unavailableRoots.some(root => {
        const relative = win32.relative(root, item.path)
        return !!relative && !win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\')
      }) && !items.has(item.id)) { items.set(item.id, item); snapshotIds.add(item.id) }
    }
  }
  return { items: [...items.values()], scope: snapshot ? 'snapshot' : 'available-roots', unavailableRoots, snapshotIds }
}
