import type { LibraryState,ScanResult,WatchedFolderRefreshResult } from '@shared/types'

export function hasImportedSystemFonts(state: LibraryState): boolean {
  return Object.values(state.fonts || {}).some((font) => !!font.systemImported)
}

export function cacheLoadStatus(result: ScanResult): string {
  const missingCount = result.missingCacheFolders?.length || 0
  const cacheFolderCount = result.cacheFolders?.length || 0

  if (result.fonts.length) {
    return `快速读取共享索引完成：${result.fonts.length} 个字体，跳过坏索引 ${result.stats?.skippedBad || 0} 个；未扫描/未逐个校验字体文件${missingCount ? `；${missingCount} 个文件夹没有索引` : ''}。`
  }

  if (!cacheFolderCount) return '未发现共享索引库。请先在其中一台电脑点击“更新索引”建立 .hfm-cache/database/index.sqlite。'
  return `共享索引为空或没有可用字体记录；未扫描字体文件${missingCount ? `；${missingCount} 个文件夹没有索引` : ''}。`
}

export function folderRefreshStatusText(result: WatchedFolderRefreshResult): string {
  if (result.mode === 'background') {
    return result.message || '已开始后台刷新，完成后会自动推送索引变更。'
  }

  const repaired = result.cacheRepairs.filter((item) => item.repaired)
  const repairText = repaired.length
    ? `已修复 ${repaired.map((item) => item.cache === 'index' ? '索引缓存' : '预览缓存').join('、')}；`
    : '缓存正常；'

  if (result.mode === 'repair-rebuild') {
    return `${repairText}已覆盖重建索引，索引 ${result.totalFiles} 个字体，跳过 ${result.skippedBad} 个，用时 ${Math.round(result.elapsedMs / 1000)} 秒。`
  }
  if (result.mode === 'incremental') {
    return `${repairText}检测到新增/更新 ${result.upserts} 个、删除 ${result.deletes} 个，重新解析 ${result.parsed} 个，复用 ${result.fromCache} 个${result.workerCount ? `，Worker ${result.workerCount} 个` : ''}，用时 ${Math.round(result.elapsedMs / 1000)} 秒。`
  }
  return `${repairText}没有发现新增或删除字体，已重新读取缓存，复用 ${result.fromCache} 个，用时 ${Math.round(result.elapsedMs / 1000)} 秒。`
}
