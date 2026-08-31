import { resolve } from 'node:path'
import { filterStartupAvailableRoots } from '../path/startupPathAvailabilityRuntime'

export type FolderCacheRootAvailabilityLogger = (message: string) => void

export type FolderCacheRootAvailabilityResult = {
  folders: string[]
  skippedFolders: string[]
}

function uniqueResolvedFolders(folders: string[]): string[] {
  return Array.from(new Set((folders || []).filter(Boolean).map((item) => resolve(item))))
}

export async function filterFolderCacheAvailableRoots(
  folders: string[],
  appendLog?: FolderCacheRootAvailabilityLogger,
  reason = 'folder-cache',
): Promise<FolderCacheRootAvailabilityResult> {
  const resolvedFolders = uniqueResolvedFolders(folders)
  const { availableRoots, skippedRoots } = await filterStartupAvailableRoots(
    resolvedFolders,
    appendLog,
    reason,
  )

  if (skippedRoots.length > 0) {
    appendLog?.(
      `folder cache unavailable roots skipped: reason=${reason}, skipped=${skippedRoots.length}, available=${availableRoots.length}`,
    )
  }

  return {
    folders: availableRoots,
    skippedFolders: skippedRoots,
  }
}
