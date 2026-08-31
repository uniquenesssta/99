import type { FontItem } from '@shared/types'
import {
AUTO_PREVIEW_CACHE_FONT_SIZE,
AUTO_PREVIEW_CACHE_HEIGHT,
AUTO_PREVIEW_CACHE_TEXT,
AUTO_PREVIEW_CACHE_WIDTH,
MAX_CONCURRENT_PREVIEW_LOADS,
rendererMemoryPressure
} from '../../../appRuntime'
import type { FontAutoPreviewCacheQueueRuntime,FontPreviewQueueRuntimeOptions } from './fontPreviewQueueTypes'
import { networkAwarePreviewLimit } from './fontPreviewNetworkPathRuntime'

export function createFontAutoPreviewCacheQueueRuntime(options: FontPreviewQueueRuntimeOptions): FontAutoPreviewCacheQueueRuntime {
  async function startAutoPreviewCache(fonts: FontItem[]): Promise<void> {
    const candidates = fonts.filter((font) => !options.isBadFontRecord(font))
    options.autoPreviewCacheRunId.current += 1
    const runId = options.autoPreviewCacheRunId.current
    options.autoPreviewCacheQueue.current = []
    options.queuedAutoPreviewCacheIds.current.clear()
    options.autoPreviewCacheStats.current = { total: candidates.length, done: 0, cached: 0, generated: 0, failed: 0 }

    if (!candidates.length) return

    options.setStatus(`正在读取预览缓存索引：${candidates.length} 个字体……`)

    let missing = candidates
    try {
      const statusMap = await options.hfm.getPreviewCacheStatus(candidates, AUTO_PREVIEW_CACHE_TEXT, AUTO_PREVIEW_CACHE_FONT_SIZE, AUTO_PREVIEW_CACHE_WIDTH, AUTO_PREVIEW_CACHE_HEIGHT)
      if (runId !== options.autoPreviewCacheRunId.current) return
      missing = candidates.filter((font) => !statusMap[font.id])
      const cachedCount = candidates.length - missing.length
      options.autoPreviewCacheStats.current = { total: missing.length, done: 0, cached: cachedCount, generated: 0, failed: 0 }
      if (!missing.length) {
        options.setStatus(`预览缓存索引已完成：${cachedCount} 个已有缓存，无需生成。`)
        return
      }
    } catch {
      missing = candidates
      options.autoPreviewCacheStats.current = { total: candidates.length, done: 0, cached: 0, generated: 0, failed: 0 }
    }

    for (const font of missing) {
      if (options.queuedAutoPreviewCacheIds.current.has(font.id)) continue
      options.queuedAutoPreviewCacheIds.current.add(font.id)
      options.autoPreviewCacheQueue.current.push(font)
    }

    if (options.indexingActive) {
      options.setStatus(`正在更新索引，后台预览缓存已暂停：待生成 ${missing.length} 个。`)
      return
    }

    options.setStatus(`后台预览缓存开始：待生成 ${missing.length} 个，索引已命中 ${options.autoPreviewCacheStats.current.cached} 个，并发 ${networkAwarePreviewLimit(missing, MAX_CONCURRENT_PREVIEW_LOADS)} 个。`)
    processAutoPreviewCacheQueue(runId)
  }

  function processAutoPreviewCacheQueue(runId = options.autoPreviewCacheRunId.current): void {
    if (runId !== options.autoPreviewCacheRunId.current) return
    if (options.indexingActive) return
    if (options.fontListScrollingRef.current || options.rendererUserActive() || rendererMemoryPressure() !== 'normal') {
      window.setTimeout(() => processAutoPreviewCacheQueue(runId), 600)
      return
    }

    const maxConcurrentLoads = networkAwarePreviewLimit(options.autoPreviewCacheQueue.current, MAX_CONCURRENT_PREVIEW_LOADS)
    while (options.activeAutoPreviewCacheLoads.current < maxConcurrentLoads && options.autoPreviewCacheQueue.current.length) {
      const font = options.autoPreviewCacheQueue.current.shift()
      if (!font) continue
      options.queuedAutoPreviewCacheIds.current.delete(font.id)
      if (options.isBadFontRecord(font)) continue

      options.activeAutoPreviewCacheLoads.current += 1
      void options.hfm.ensurePreviewCache(font, AUTO_PREVIEW_CACHE_TEXT, AUTO_PREVIEW_CACHE_FONT_SIZE, AUTO_PREVIEW_CACHE_WIDTH, AUTO_PREVIEW_CACHE_HEIGHT)
        .then((result) => {
          if (runId !== options.autoPreviewCacheRunId.current) return
          const stats = options.autoPreviewCacheStats.current
          stats.done += 1
          if (result.ok) {
            if (result.cached) stats.cached += 1
            else stats.generated += 1
          } else {
            stats.failed += 1
          }

          if (stats.done === stats.total || stats.done % 100 === 0) {
            options.setStatus(`后台预览缓存：${stats.done}/${stats.total}，已有 ${stats.cached}，新生成 ${stats.generated}，失败 ${stats.failed}。`)
          }
        })
        .catch(() => {
          if (runId !== options.autoPreviewCacheRunId.current) return
          const stats = options.autoPreviewCacheStats.current
          stats.done += 1
          stats.failed += 1
        })
        .finally(() => {
          options.activeAutoPreviewCacheLoads.current = Math.max(0, options.activeAutoPreviewCacheLoads.current - 1)
          if (runId !== options.autoPreviewCacheRunId.current) {
            processAutoPreviewCacheQueue(options.autoPreviewCacheRunId.current)
            return
          }
          if (!options.autoPreviewCacheQueue.current.length && options.activeAutoPreviewCacheLoads.current === 0) {
            const stats = options.autoPreviewCacheStats.current
            options.setStatus(`后台预览缓存完成：${stats.total} 个字体，已有 ${stats.cached}，新生成 ${stats.generated}，失败 ${stats.failed}。`)
            return
          }
          processAutoPreviewCacheQueue(runId)
        })
    }
  }

  return {
    startAutoPreviewCache,
    processAutoPreviewCacheQueue
  }
}
