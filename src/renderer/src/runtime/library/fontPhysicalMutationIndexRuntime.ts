import { normalizeFolderPathForCompare } from '../../libraryNormalize'

export type PhysicalMutationIndexRefreshReport = {
  roots: string[]
  scheduled: number
  failed: Array<{ root: string; message: string }>
  supported: boolean
}

function pathInsideRoot(pathValue: string, rootValue: string): boolean {
  const path = normalizeFolderPathForCompare(pathValue)
  const root = normalizeFolderPathForCompare(rootValue)
  return !!path && !!root && (path === root || path.startsWith(`${root}\\`))
}

export function affectedWatchedRootsForPaths(paths: string[], watchedFolders: string[]): string[] {
  const roots = Array.from(new Map(
    (watchedFolders || [])
      .filter(Boolean)
      .map((root) => [normalizeFolderPathForCompare(root), root] as const)
  ).values()).sort((left, right) => normalizeFolderPathForCompare(right).length - normalizeFolderPathForCompare(left).length)

  const affected = new Map<string, string>()
  for (const path of paths || []) {
    if (!path) continue
    for (const root of roots) {
      if (!pathInsideRoot(path, root)) continue
      affected.set(normalizeFolderPathForCompare(root), root)
    }
  }
  return Array.from(affected.values())
}

export async function refreshIndexesAfterPhysicalMutation(args: {
  hfm: Window['hfm']
  watchedFolders: string[]
  affectedPaths: string[]
}): Promise<PhysicalMutationIndexRefreshReport> {
  const roots = affectedWatchedRootsForPaths(args.affectedPaths, args.watchedFolders)
  if (typeof args.hfm.refreshWatchedFolder !== 'function') {
    return { roots, scheduled: 0, failed: [], supported: false }
  }

  const failed: PhysicalMutationIndexRefreshReport['failed'] = []
  let scheduled = 0
  for (const root of roots) {
    try {
      await args.hfm.refreshWatchedFolder(root, root)
      scheduled += 1
    } catch (error) {
      failed.push({
        root,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return { roots, scheduled, failed, supported: true }
}

export function physicalMutationIndexRefreshSuffix(report: PhysicalMutationIndexRefreshReport): string {
  if (!report.roots.length) return ' 未找到受影响的监听根目录，请手动更新索引。'
  if (!report.supported) return ' 当前版本缺少根目录刷新接口，请手动更新索引。'
  if (report.failed.length) return ` 已安排 ${report.scheduled} 个根目录后台刷新，另有 ${report.failed.length} 个安排失败，请手动更新索引。`
  return ` 已安排 ${report.scheduled} 个受影响根目录后台刷新。`
}
