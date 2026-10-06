import { getCardPreviewLayout } from '@shared/preview-layout/previewTextFitRuntime'
import { previewFailureKind } from '@shared/previewFailure'
import { previewTrace, previewEvent } from '../previewTraceRuntime'
import type { FontItem } from '@shared/types'
import type { PreviewQueueEntry } from '../../../appRuntime'
import {
MAX_CONCURRENT_PREVIEW_LOADS,
rendererMemoryPressure,
requestIdleWindow
} from '../../../appRuntime'
import { VISIBLE_PREVIEW_CACHE_BATCH_LIMIT, VISIBLE_PREVIEW_CACHE_WAIT_MS } from './fontPreviewBatchPolicyRuntime'
import type { FontPreviewLoadRuntime,FontPreviewQueueRuntimeOptions,FontPreviewStateRuntime,FontVisiblePreviewQueueRuntime } from './fontPreviewQueueTypes'


export function createFontVisiblePreviewQueueRuntime(
  options: FontPreviewQueueRuntimeOptions,
  stateRuntime: Pick<FontPreviewStateRuntime, 'canRequestPreviewFont'>,
  loadRuntime: FontPreviewLoadRuntime
): FontVisiblePreviewQueueRuntime {
  type Demand = { font: FontItem; key: string; callers: Set<() => boolean> }
  const demand = new Map<string, Demand>()
  const alwaysCurrent = () => true
  const requestKey = (font: FontItem): string => loadRuntime.previewRequestKey?.(font) || JSON.stringify([font.id, font.path, font.fileSize, font.modifiedAt, currentPreviewBatchToken()])
  function hasDemand(id: string, expected?: Demand): boolean {
    const entry = demand.get(id)
    if (!entry || (expected && entry !== expected)) return false
    for (const caller of entry.callers) if (!caller()) entry.callers.delete(caller)
    if (!entry.callers.size || entry.key !== requestKey(entry.font)) {
      demand.delete(id)
      return false
    }
    return true
  }
  function canRequest(font: FontItem, allowQueued = false): boolean {
    return stateRuntime.canRequestPreviewFont(font, allowQueued, loadRuntime.previewStateForFont?.(font))
  }
  function removePreviewFontDemand(ids: ReadonlySet<string>): void {
    for (const id of ids) { demand.delete(id); options.queuedPreviewFontIds.current.delete(id) }
    options.previewQueue.current = options.previewQueue.current.filter(entry => !ids.has(entry.font.id))
    pruneCachedPreviewBatchCheckedIds()
  }
  let deferredPreviewRetryId: number | null = null
  let normalPreviewProcessScheduled = false
  let idleId: number | null = null
  let queueGeneration = 0
  let disposed = false
  let cachedPreviewBatchInFlight = false
  let cachedPreviewBatchToken = ''
  let cacheWaitTimer: number | null = null
  let cacheWaitExpired = false
  const cachedPreviewBatchCheckedIds = new Set<string>()
  const cachedPreviewBatchMissIds = new Set<string>()

  function resetVisiblePreviewQueue(keepDemand = false): void {
    queueGeneration += 1
    if (!keepDemand) demand.clear()
    cacheWaitExpired = cachedPreviewBatchInFlight
    if (cacheWaitTimer !== null) window.clearTimeout(cacheWaitTimer)
    cacheWaitTimer = null
    cachedPreviewBatchCheckedIds.clear()
    cachedPreviewBatchMissIds.clear()
    if (deferredPreviewRetryId !== null) window.clearTimeout(deferredPreviewRetryId)
    deferredPreviewRetryId = null
    if (idleId !== null) {
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleId)
      else window.clearTimeout(idleId)
    }
    idleId = null
    normalPreviewProcessScheduled = false
  }
  function disposePreviewQueue(): void { disposed = true; resetVisiblePreviewQueue(); loadRuntime.resetPreviewLoads(); options.loadingFonts.current.clear() }
  function resumePreviewQueue(): void { disposed = false }


  function pausePreviewForScroll(): void {
    resetVisiblePreviewQueue(true)
    loadRuntime.resetPreviewLoads()
    options.loadingFonts.current.clear()
    options.previewQueue.current = []
    options.queuedPreviewFontIds.current.clear()
  }
  function resumePreviewAfterScroll(): void {
    if (disposed) return
    for (const [id, entry] of [...demand]) {
      if (!hasDemand(id)) continue
      for (const caller of entry.callers) requestPreviewFont(entry.font, 'high', caller)
    }
    processPreviewQueue()
  }

  function currentPreviewTrace(fontId: string) {
    const layout = getCardPreviewLayout(options.previewLayoutMode ?? 'list', options.previewText, options.listPreviewFontSize)
    return previewTrace(fontId, layout.text, layout.fontSize)
  }

  function currentPreviewBatchToken(): string {
    return getCardPreviewLayout(options.previewLayoutMode ?? 'list', options.previewText, options.listPreviewFontSize).token
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
    const generation = queueGeneration
    deferredPreviewRetryId = window.setTimeout(() => {
      if (disposed || generation !== queueGeneration) return
      deferredPreviewRetryId = null
      processPreviewQueue()
    }, delayMs)
  }

  function scheduleNormalPreviewProcess(): void {
    if (normalPreviewProcessScheduled) return
    normalPreviewProcessScheduled = true
    const generation = queueGeneration
    idleId = requestIdleWindow(() => {
      if (disposed || generation !== queueGeneration) return
      idleId = null
      normalPreviewProcessScheduled = false
      processPreviewQueue()
    }, 120)
  }

  function canBatchCheckCachedPreview(font: FontItem): boolean {
    syncCachedPreviewBatchText()
    const key = requestKey(font)
    if (cachedPreviewBatchCheckedIds.has(key) || cachedPreviewBatchMissIds.has(key)) return false
    if (!canRequest(font, true)) return false
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
    const queuedKeys = new Set(options.previewQueue.current.map(entry => requestKey(entry.font)))
    for (const key of cachedPreviewBatchCheckedIds) if (!queuedKeys.has(key)) cachedPreviewBatchCheckedIds.delete(key)
    for (const key of cachedPreviewBatchMissIds) if (!queuedKeys.has(key)) cachedPreviewBatchMissIds.delete(key)
  }

  function processCachedPreviewBatchIfNeeded(): boolean {
    syncCachedPreviewBatchText()
    if (cachedPreviewBatchInFlight) return !cacheWaitExpired
    const candidates = collectCachedPreviewBatchCandidates()
    if (!candidates.length) return false

    const generation = queueGeneration
    const token = currentPreviewBatchToken()
    cachedPreviewBatchInFlight = true
    const candidateOwners = new Map(candidates.map(font => [font.id, demand.get(font.id)]))
    const candidateKeys = new Map(candidates.map(font => [font.id, requestKey(font)]))
    for (const font of candidates) cachedPreviewBatchCheckedIds.add(requestKey(font))

    cacheWaitExpired = false
    let accepting = true
    const acceptsResult = (font?: FontItem) => accepting && !disposed && generation === queueGeneration && token === currentPreviewBatchToken() && (!font || (hasDemand(font.id, candidateOwners.get(font.id)) && candidateKeys.get(font.id) === requestKey(font)))
    cacheWaitTimer = window.setTimeout(() => {
      cacheWaitTimer = null
      accepting = false
      cacheWaitExpired = true
      if (!disposed && generation === queueGeneration) processPreviewQueue()
    }, VISIBLE_PREVIEW_CACHE_WAIT_MS)
    void loadRuntime.loadCachedNativeCardPreviews(candidates, acceptsResult)
      .then((hitIds) => {
        if (!acceptsResult()) return
        for (const font of candidates) {
          if (acceptsResult(font) && !hitIds.has(font.id)) cachedPreviewBatchMissIds.add(requestKey(font))
        }
        if (!hitIds.size) return
        options.previewQueue.current = options.previewQueue.current.filter((entry) => {
          if (!hitIds.has(entry.font.id) || !acceptsResult(entry.font) || candidateKeys.get(entry.font.id) !== requestKey(entry.font)) return true
          options.queuedPreviewFontIds.current.delete(entry.font.id)
          demand.delete(entry.font.id)
          return false
        })
      })
      .catch((error) => {
        if (!acceptsResult()) return
        if (previewFailureKind(error) === 'cancelled') {
          // Cancel only these exact consumers. A replacement's demand survives,
          // and a future request is allowed to probe again without failure cooldown.
          options.previewQueue.current = options.previewQueue.current.filter(entry => {
            if (!candidateOwners.has(entry.font.id) || !acceptsResult(entry.font)) return true
            options.queuedPreviewFontIds.current.delete(entry.font.id)
            demand.delete(entry.font.id)
            return false
          })
          return
        }
        // A failed probe is a miss for this queue attempt, not a reason to probe forever.
        for (const font of candidates) if (acceptsResult(font)) cachedPreviewBatchMissIds.add(requestKey(font))
      })
      .finally(() => {
        accepting = false
        if (cacheWaitTimer !== null) window.clearTimeout(cacheWaitTimer)
        cacheWaitTimer = null
        cachedPreviewBatchInFlight = false
        cacheWaitExpired = false
        if (disposed) return
        pruneCachedPreviewBatchCheckedIds()
        processPreviewQueue()
      })

    return true
  }

  function processPreviewQueue(): void {
    if (disposed || options.fontListScrollingRef.current) return
    options.previewQueue.current = options.previewQueue.current.filter(entry => {
      if (hasDemand(entry.font.id) && demand.get(entry.font.id)?.key === requestKey(entry.font)) return true
      options.queuedPreviewFontIds.current.delete(entry.font.id)
      return false
    })
    const memory = rendererMemoryPressure()
    const userActive = options.rendererUserActive()
    if ((memory === 'hard' || userActive) && !options.previewQueue.current.some((entry) => entry.priority === 'high')) {
      scheduleDeferredPreviewRetry(memory === 'hard' ? 900 : 420)
      return
    }

    if (processCachedPreviewBatchIfNeeded()) return

    const limit = MAX_CONCURRENT_PREVIEW_LOADS

    while (options.activePreviewLoads.current < limit && options.previewQueue.current.length) {
      const entry = options.previewQueue.current.shift()
      if (!entry) continue
      const font = entry.font
      options.queuedPreviewFontIds.current.delete(font.id)
      if (!canRequest(font)) continue

      const owner = demand.get(font.id)
      const generation = queueGeneration
      previewEvent(currentPreviewTrace(font.id), 'load-start')
      options.activePreviewLoads.current += 1
      void loadRuntime.ensurePreviewFont(font, true, () => !disposed && !!owner && hasDemand(font.id, owner)).finally(() => {
        options.activePreviewLoads.current = Math.max(0, options.activePreviewLoads.current - 1)
        if (disposed) return
        if (generation === queueGeneration && demand.get(font.id) === owner && !options.queuedPreviewFontIds.current.has(font.id)) demand.delete(font.id)
        pruneCachedPreviewBatchCheckedIds()
        processPreviewQueue()
      })
    }
  }

  function requestPreviewFont(font: FontItem, priority: 'normal' | 'high' = 'normal', acceptsResult: () => boolean = alwaysCurrent): void {
    if (disposed || !acceptsResult()) return
    loadRuntime.preparePreviewFont?.(font)
    const key = requestKey(font)
    const previous = demand.get(font.id)
    const owner = previous?.key === key ? previous : { font, key, callers: new Set<() => boolean>() }
    for (const caller of owner.callers) if (!caller()) owner.callers.delete(caller)
    owner.font = font
    owner.callers.add(acceptsResult)
    demand.set(font.id, owner)
    const trace = currentPreviewTrace(font.id)
    previewEvent(trace, 'request', priority)
    if (!canRequest(font, true)) {
      const loading = loadRuntime.previewStateForFont?.(font)?.loading ?? options.loadingFonts.current.has(font.id)
      if (!loading && !options.queuedPreviewFontIds.current.has(font.id)) demand.delete(font.id)
      previewEvent(trace, 'admission-rejected'); return
    }
    if (options.queuedPreviewFontIds.current.has(font.id)) {
      const entryIndex = options.previewQueue.current.findIndex(entry => entry.font.id === font.id)
      if (entryIndex >= 0) {
        const [previousEntry] = options.previewQueue.current.splice(entryIndex, 1)
        const entry: PreviewQueueEntry = { font, priority: priority === 'high' ? 'high' : previousEntry.priority }
        if (entry.priority === 'high') options.previewQueue.current.unshift(entry)
        else options.previewQueue.current.splice(entryIndex, 0, entry)
      }
      if (priority === 'high') processPreviewQueue()
      return
    }

    previewEvent(trace, 'queued', priority)
    options.queuedPreviewFontIds.current.add(font.id)
    cachedPreviewBatchCheckedIds.delete(key)
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
    removePreviewFontDemand,
    resetVisiblePreviewQueue,
    pausePreviewForScroll,
    resumePreviewAfterScroll,
    disposePreviewQueue,
    resumePreviewQueue,
    processPreviewQueue,
    requestPreviewFont
  }
}
