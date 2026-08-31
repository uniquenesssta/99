import type { FontItem } from '@shared/types'
import type { PreviewQueueEntry } from '../../../appRuntime'
import {
INDEXING_PREVIEW_LOADS,
MAX_CONCURRENT_PREVIEW_LOADS,
SCROLLING_PREVIEW_LOADS,
rendererMemoryPressure,
requestIdleWindow
} from '../../../appRuntime'
import { previewQueueCooldownRemaining } from './fontPreviewIndexCooldownRuntime'
import { VISIBLE_PREVIEW_CACHE_BATCH_LIMIT } from './fontPreviewBatchPolicyRuntime'
import { hasNetworkFontPath, networkAwarePreviewLimit } from './fontPreviewNetworkPathRuntime'
import { resolveFontPreviewRoute } from './fontPreviewRouteRuntime'
import type { FontPreviewLoadRuntime,FontPreviewQueueRuntimeOptions,FontPreviewStateRuntime,FontVisiblePreviewQueueRuntime } from './fontPreviewQueueTypes'


export function createFontVisiblePreviewQueueRuntime(
  options: FontPreviewQueueRuntimeOptions,
  stateRuntime: Pick<FontPreviewStateRuntime, 'canRequestPreviewFont'>,
  loadRuntime: FontPreviewLoadRuntime
): FontVisiblePreviewQueueRuntime {
  let deferredPreviewRetryId: number | null = null
  let normalPreviewProcessScheduled = false
  let cachedPreviewBatchInFlight = false
  let cachedPreviewBatchToken = ''
  const cachedPreviewBatchCheckedIds = new Set<string>()
  const cachedPreviewBatchMissIds = new Set<string>()

  function currentPreviewText(): string {
    return options.previewText.trim() || '字体预览\nAaBb 123'
  }

  function currentPreviewBatchToken(): string {
    return `${currentPreviewText()}::${Math.round(Number(options.listPreviewFontSize || 0))}`
  }

  function syncCachedPreviewBatchText(): void {
    const previewToken = currentPreviewBatchToken()
    if (cachedPreviewBatchToken === previewToken) return
    cachedPreviewBatchToken = previewToken
    cachedPreviewBatchCheckedIds.clear()
    cachedPreviewBatchMissIds.clear()
  }

  function scheduleDeferredPreviewRetry(delayMs = 420): void {
    if (!options.previewQueue.current.length || deferredPreviewRetryId !== null) return
    deferredPreviewRetryId = window.setTimeout(() => {
      deferredPreviewRetryId = null
      processPreviewQueue()
    }, delayMs)
  }

  function scheduleNormalPreviewProcess(): void {
    if (normalPreviewProcessScheduled) return
    normalPreviewProcessScheduled = true
    requestIdleWindow(() => {
      normalPreviewProcessScheduled = false
      processPreviewQueue()
    }, 120)
  }

  function canBatchCheckCachedPreview(font: FontItem): boolean {
    syncCachedPreviewBatchText()
    if (cachedPreviewBatchCheckedIds.has(font.id)) return false
    if (cachedPreviewBatchMissIds.has(font.id)) return false
    const routeForcesNative = resolveFontPreviewRoute(font).shouldSkipWebFontFileLoad
    if (options.previewFamilies[font.id] && !routeForcesNative) return false
    if (options.nativePreviewImages[font.id]) return false
    if (options.loadingFonts.current.has(font.id)) return false
    if (options.isBadFontRecord(font)) return false
    if (font.previewDisabled && (font.previewError?.includes('字体文件不存在') || font.previewError?.includes('路径已失效'))) return false
    return true
  }

  function collectCachedPreviewBatchCandidates(): FontItem[] {
    const seen = new Set<string>()
    const candidates: FontItem[] = []
    for (const entry of options.previewQueue.current) {
      const font = entry.font
      if (!font?.id || seen.has(font.id) || !canBatchCheckCachedPreview(font)) continue
      seen.add(font.id)
      candidates.push(font)
      if (candidates.length >= VISIBLE_PREVIEW_CACHE_BATCH_LIMIT) break
    }
    return candidates
  }

  function pruneCachedPreviewBatchCheckedIds(): void {
    if (options.previewQueue.current.length) return
    cachedPreviewBatchCheckedIds.clear()
    cachedPreviewBatchMissIds.clear()
  }

  function processCachedPreviewBatchIfNeeded(): boolean {
    syncCachedPreviewBatchText()
    if (cachedPreviewBatchInFlight) return true
    const candidates = collectCachedPreviewBatchCandidates()
    if (!candidates.length) return false

    cachedPreviewBatchInFlight = true
    for (const font of candidates) cachedPreviewBatchCheckedIds.add(font.id)

    void loadRuntime.loadCachedNativeCardPreviews(candidates)
      .then((hitIds) => {
        for (const font of candidates) {
          if (!hitIds.has(font.id)) cachedPreviewBatchMissIds.add(font.id)
        }
        if (!hitIds.size) return
        options.previewQueue.current = options.previewQueue.current.filter((entry) => {
          if (!hitIds.has(entry.font.id)) return true
          options.queuedPreviewFontIds.current.delete(entry.font.id)
          return false
        })
      })
      .finally(() => {
        cachedPreviewBatchInFlight = false
        pruneCachedPreviewBatchCheckedIds()
        processPreviewQueue()
      })

    return true
  }

  function processPreviewQueue(): void {
    const cooldownMs = previewQueueCooldownRemaining()
    if (cooldownMs > 0) {
      scheduleDeferredPreviewRetry(Math.min(cooldownMs + 80, 2200))
      return
    }

    const memory = rendererMemoryPressure()
    const userActive = options.rendererUserActive()
    if ((memory === 'hard' || userActive) && !options.previewQueue.current.some((entry) => entry.priority === 'high')) {
      scheduleDeferredPreviewRetry(memory === 'hard' ? 900 : 420)
      return
    }

    if (processCachedPreviewBatchIfNeeded()) return

    const baseLimit = options.indexingActive ? INDEXING_PREVIEW_LOADS : (options.fontListScrollingRef.current || userActive) ? SCROLLING_PREVIEW_LOADS : MAX_CONCURRENT_PREVIEW_LOADS
    const storageAwareLimit = networkAwarePreviewLimit(options.previewQueue.current.map((entry) => entry.font), baseLimit)
    const limit = memory === 'soft' ? Math.min(storageAwareLimit, 1) : storageAwareLimit

    while (options.activePreviewLoads.current < limit && options.previewQueue.current.length) {
      const entryIndex = options.fontListScrollingRef.current || userActive
        ? options.previewQueue.current.findIndex((item) => item.priority === 'high')
        : 0
      if (entryIndex < 0) {
        scheduleDeferredPreviewRetry(240)
        return
      }

      const entry = options.previewQueue.current.splice(entryIndex, 1)[0]
      if (!entry) continue
      const font = entry.font
      options.queuedPreviewFontIds.current.delete(font.id)
      if (!stateRuntime.canRequestPreviewFont(font)) continue

      options.activePreviewLoads.current += 1
      void loadRuntime.ensurePreviewFont(font).finally(() => {
        options.activePreviewLoads.current = Math.max(0, options.activePreviewLoads.current - 1)
        pruneCachedPreviewBatchCheckedIds()
        processPreviewQueue()
      })
    }
  }

  function requestPreviewFont(font: FontItem, priority: 'normal' | 'high' = 'normal'): void {
    if (!stateRuntime.canRequestPreviewFont(font)) return
    const routeForcesNative = resolveFontPreviewRoute(font).shouldSkipWebFontFileLoad
    if ((!routeForcesNative && options.previewFamilies[font.id]) || options.nativePreviewImages[font.id] || options.loadingFonts.current.has(font.id)) return
    if (routeForcesNative && options.previewFamilies[font.id]) {
      options.setPreviewFamilies((prev) => {
        if (!prev[font.id]) return prev
        const next = { ...prev }
        delete next[font.id]
        return next
      })
    }

    if (options.queuedPreviewFontIds.current.has(font.id)) {
      if (priority === 'high') {
        const entryIndex = options.previewQueue.current.findIndex((entry) => entry.font.id === font.id)
        if (entryIndex >= 0) {
          const [entry] = options.previewQueue.current.splice(entryIndex, 1)
          options.previewQueue.current.unshift({ ...entry, priority: 'high' })
        }
        processPreviewQueue()
      }
      return
    }

    options.queuedPreviewFontIds.current.add(font.id)
    cachedPreviewBatchCheckedIds.delete(font.id)
    const entry: PreviewQueueEntry = { font, priority }
    if (priority === 'high') {
      options.previewQueue.current.unshift(entry)
      processPreviewQueue()
    } else {
      options.previewQueue.current.push(entry)
      scheduleNormalPreviewProcess()
    }
  }

  return {
    processPreviewQueue,
    requestPreviewFont
  }
}
