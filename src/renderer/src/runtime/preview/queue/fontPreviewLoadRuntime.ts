import { availabilityPath, pathRoots } from '@shared/sharedAvailability'
import { readPreviewAvailability } from '../previewAvailabilitySnapshotRuntime'
import { hasLegacyMissingPreviewFlag, previewRecordForProbe, previewFailure, previewFailureKind } from '@shared/previewFailure'
import { previewTrace, previewLoadTrace, previewEvent, previewBatchTrace, rememberPreviewImageTrace } from '../previewTraceRuntime'
import type { FontItem } from '@shared/types'
import { getCardPreviewLayout } from '@shared/preview-layout/previewTextFitRuntime'
import { PREVIEW_STATE_LRU_LIMIT,pruneRecordByKeyLimit } from '../../../appRuntime'
import { createPreviewFamilyName,previewStateKeepIds } from '../../../fontPreviewStateRuntime'
import { reportRendererTrace } from '../../../rendererPerformance'
import { resolveFontPreviewRoute } from './fontPreviewRouteRuntime'
import type { FontPreviewLoadRuntime,FontPreviewQueueRuntimeOptions } from './fontPreviewQueueTypes'
import {
  QuickPreviewTimeoutError,
  createFontFaceLoadOwner,
  QUICK_WEBFONT_BINARY_TIMEOUT_MS,
  QUICK_WEBFONT_TOTAL_BUDGET_MS,
  QUICK_WEBFONT_URL_TIMEOUT_MS,
  canUseBinaryWebFontQuickFallback,
  isFontCollectionOrLargeFont,
  loadFontFaceFromBinaryWithinBudget,
  loadFontFaceFromUrlWithinBudget,
  quickPreviewBudgetExpired,
  remainingQuickPreviewBudget
} from './fontPreviewQuickFallbackRuntime'

const CACHE_MISS_LRU_LIMIT = 800

function normalizeFontFaceBinarySource(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    const copy = new Uint8Array(view.byteLength)
    copy.set(new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength))
    return copy.buffer
  }

  const record = value as { type?: string; data?: unknown } | undefined
  if (record?.type === 'Buffer' && Array.isArray(record.data)) {
    return new Uint8Array(record.data as number[]).buffer
  }

  return null
}

export function createFontPreviewLoadRuntime(options: FontPreviewQueueRuntimeOptions): FontPreviewLoadRuntime {
  const cachedPreviewMissKeys = new Set<string>()
  const failedPreviewUntil = new Map<string, number>()
  let cachedPreviewMissText = ''
  let loadGeneration = 0
  let faceOwner: ReturnType<typeof createFontFaceLoadOwner> | undefined
  const loadingOwners = new Map<string, { key: string }>()
  const sourceKeys = new Map<string, string>()
  const ownershipTokens = new Map<string, object>()
  const settledFamilies = new Map<string, { key: string; value: string }>()
  const settledImages = new Map<string, { key: string; value: string }>()
  const failureKeys = new Map<string, string>()
  const attachedFaces = new Map<string, FontFace>()
  function fontAuthorityStamp(font: FontItem): string {
    const snapshot = readPreviewAvailability(true)
    const roots = snapshot ? pathRoots(snapshot, font.path) : []
    // Retain the last known generation for provenance only. Fresh admission still
    // belongs to the caller/main protocol; snapshot TTL expiry is not new content.
    return roots.length ? JSON.stringify(roots.map(root => [root.rootId, root.generation, root.state])) : 'unknown'
  }
  function fontSourceKey(font: FontItem): string {
    return JSON.stringify([font.id, availabilityPath(font.path || ''), font.fileSize || 0, font.modifiedAt || 0, font.recoveryContentHash || '', fontAuthorityStamp(font)])
  }
  function previewRequestKey(font: FontItem): string { return `${fontSourceKey(font)}::${cacheMissToken()}` }
  function previewStateForFont(font: FontItem) {
    const source = fontSourceKey(font)
    return {
      key: previewRequestKey(font),
      family: settledFamilies.get(font.id)?.key === source ? settledFamilies.get(font.id)?.value : undefined,
      image: settledImages.get(font.id)?.key === previewRequestKey(font) ? settledImages.get(font.id)?.value : undefined,
      failed: failureKeys.get(font.id) === source ? true as const : undefined,
      loading: loadingOwners.get(font.id)?.key === previewRequestKey(font),
    }
  }
  function clearFontState(fontId: string): void {
    const attached = attachedFaces.get(fontId)
    if (attached) { document.fonts.delete?.(attached); attachedFaces.delete(fontId) }
    const omit = <T,>(previous: Record<string, T>): Record<string, T> => {
      if (!(fontId in previous)) return previous
      const next = { ...previous }; delete next[fontId]; return next
    }
    options.setPreviewFamilies(omit)
    options.setNativePreviewImages(omit)
    options.setFailedPreviewFontIds(omit)
  }
  function preparePreviewFont(font: FontItem): string {
    const source = fontSourceKey(font)
    const previous = sourceKeys.get(font.id)
    if (previous !== source) {
      // An old WebFont failure is only a native-route hint, never a ready pixel.
      const initialFailureHint = !sourceKeys.has(font.id) && !!options.failedPreviewFontIds[font.id]
      ownershipTokens.set(font.id, {})
      settledFamilies.delete(font.id); settledImages.delete(font.id); failureKeys.delete(font.id)
      if (sourceKeys.has(font.id) || options.previewFamilies[font.id] || options.nativePreviewImages[font.id]) clearFontState(font.id)
      if (initialFailureHint) failureKeys.set(font.id, source)
    }
    sourceKeys.delete(font.id)
    sourceKeys.set(font.id, source)
    if (sourceKeys.size > PREVIEW_STATE_LRU_LIMIT) {
      const keep = previewKeepIds(font.id)
      for (const id of sourceKeys.keys()) {
        if (sourceKeys.size <= PREVIEW_STATE_LRU_LIMIT) break
        if (keep.has(id) || loadingOwners.has(id)) continue
        sourceKeys.delete(id); ownershipTokens.delete(id)
        settledFamilies.delete(id); settledImages.delete(id); failureKeys.delete(id)
        const attached = attachedFaces.get(id)
        if (attached) { document.fonts.delete?.(attached); attachedFaces.delete(id) }
      }
    }
    return previewRequestKey(font)
  }
  function removePreviewFontLoads(ids: ReadonlySet<string>): void {
    for (const id of ids) {
      // Tombstones prevent an asynchronous React state snapshot from being rebound.
      sourceKeys.set(id, '')
      ownershipTokens.set(id, {})
      settledFamilies.delete(id); settledImages.delete(id); failureKeys.delete(id)
      loadingOwners.delete(id); options.loadingFonts.current.delete(id)
      clearFontState(id)
    }
  }
  function resetPreviewLoads(clearSettledImages = false): void {
    loadGeneration += 1; loadingOwners.clear(); cachedPreviewMissKeys.clear(); failedPreviewUntil.clear()
    if (clearSettledImages) { settledImages.clear(); failureKeys.clear() }
  }

  function previewKeepIds(fontId: string): Set<string> {
    return previewStateKeepIds(fontId, options.selectedFontId, options.selectedFontIds)
  }

  function cacheMissToken(): string {
    return getCardPreviewLayout(options.previewLayoutMode ?? 'list', options.previewText, options.listPreviewFontSize).token
  }

  function cacheMissKey(font: FontItem): string {
    return previewRequestKey(font)
  }

  function isPreviewRequestCurrent(requestToken: string): boolean {
    return `${options.previewRequestTokenRef.current}::${loadGeneration}` === requestToken
  }

  function syncCacheMissText(): void {
    const previewToken = cacheMissToken()
    if (cachedPreviewMissText === previewToken) return
    cachedPreviewMissText = previewToken
    cachedPreviewMissKeys.clear()
  }

  function rememberCacheMiss(font: FontItem): void {
    syncCacheMissText()
    const key = cacheMissKey(font)
    if (cachedPreviewMissKeys.has(key)) cachedPreviewMissKeys.delete(key)
    cachedPreviewMissKeys.add(key)
    while (cachedPreviewMissKeys.size > CACHE_MISS_LRU_LIMIT) {
      const oldest = cachedPreviewMissKeys.keys().next().value
      if (!oldest) break
      cachedPreviewMissKeys.delete(oldest)
    }
  }

  function hasCacheMiss(font: FontItem): boolean {
    syncCacheMissText()
    return cachedPreviewMissKeys.has(cacheMissKey(font))
  }

  function forgetCacheMiss(font: FontItem): void {
    syncCacheMissText()
    cachedPreviewMissKeys.delete(cacheMissKey(font))
  }

  function rememberNativeCardPreview(font: FontItem, image: string, requestToken: string): void {
    if (!isPreviewRequestCurrent(requestToken)) return
    settledImages.set(font.id, { key: previewRequestKey(font), value: image })
    options.setNativePreviewImages((prev) => pruneRecordByKeyLimit({ ...prev, [font.id]: image }, PREVIEW_STATE_LRU_LIMIT, previewKeepIds(font.id)))
    forgetCacheMiss(font)
  }

  function rememberNativeCardPreviewBatch(entries: Array<{ font: FontItem; image: string }>, requestToken: string): void {
    if (!entries.length || !isPreviewRequestCurrent(requestToken)) return
    const keepIds = new Set<string>()
    for (const entry of entries) {
      settledImages.set(entry.font.id, { key: previewRequestKey(entry.font), value: entry.image })
      forgetCacheMiss(entry.font)
      for (const id of previewKeepIds(entry.font.id)) keepIds.add(id)
    }
    options.setNativePreviewImages((prev) => {
      const next = { ...prev }
      for (const entry of entries) next[entry.font.id] = entry.image
      return pruneRecordByKeyLimit(next, PREVIEW_STATE_LRU_LIMIT, keepIds)
    })
  }

  async function loadCachedNativeCardPreviews(fonts: FontItem[], acceptsResult: (font?: FontItem) => boolean = () => true): Promise<Set<string>> {
    const seen = new Set<string>()
    const uniqueFonts: FontItem[] = []
    for (const font of fonts || []) {
      if (!font?.id || seen.has(font.id) || font.fileAvailability === 'missing' || font.fileAvailability === 'unavailable') continue
      seen.add(font.id)
      preparePreviewFont(font)
      const ready = previewStateForFont(font)
      if (ready.family || ready.image || ready.loading) continue
      if (hasLegacyMissingPreviewFlag(font) || hasCacheMiss(font)) continue
      uniqueFonts.push(font)
    }
    const hitIds = new Set<string>()
    if (!uniqueFonts.length || typeof options.hfm.getCachedPreviewImages !== 'function') return hitIds

    const requestToken = `${cacheMissToken()}::${loadGeneration}`
    const sourceTokens = new Map(uniqueFonts.map(font => [font.id, fontSourceKey(font)]))
    const sourceOwners = new Map(uniqueFonts.map(font => [font.id, ownershipTokens.get(font.id)]))
    const previewLayout = getCardPreviewLayout(options.previewLayoutMode ?? 'list', options.previewText, options.listPreviewFontSize)
    const previewText = previewLayout.text
    const memberTraces = uniqueFonts.map(font => previewTrace(font.id, previewText, previewLayout.fontSize))
    const batchTrace = previewBatchTrace(memberTraces)
    const cachedImages = await options.hfm.getCachedPreviewImages(uniqueFonts, previewText, previewLayout.fontSize, previewLayout.width, previewLayout.height, batchTrace, previewLayout.nativeLayout)
    const accepted = isPreviewRequestCurrent(requestToken) && acceptsResult()
    previewEvent(batchTrace, 'cache-batch-result', accepted ? 'current' : 'stale')
    if (!accepted) return hitIds
    const hitEntries: Array<{ font: FontItem; image: string }> = []
    for (const [index, font] of uniqueFonts.entries()) {
      if (!acceptsResult(font) || ownershipTokens.get(font.id) !== sourceOwners.get(font.id) || sourceKeys.get(font.id) !== sourceTokens.get(font.id) || fontSourceKey(font) !== sourceTokens.get(font.id)) continue
      const image = cachedImages[font.id]
      const trace = memberTraces[index]
      previewEvent(trace, 'cache-result', image ? 'hit' : 'miss')
      if (image) rememberPreviewImageTrace(image, trace, font.id)
      if (image) {
        hitEntries.push({ font, image })
        hitIds.add(font.id)
      } else {
        rememberCacheMiss(font)
      }
    }
    rememberNativeCardPreviewBatch(hitEntries, requestToken)
    return hitIds
  }

  async function ensurePreviewFont(font: FontItem, skipCachedPreview = false, acceptsResult: () => boolean = () => true): Promise<string> {
    if (!acceptsResult() || font.fileAvailability === 'missing' || font.fileAvailability === 'unavailable') return ''
    const previewLayout = getCardPreviewLayout(options.previewLayoutMode ?? 'list', options.previewText, options.listPreviewFontSize)
    const previewText = previewLayout.text
    const trace = previewLoadTrace(font.id, previewText, previewLayout.fontSize)
    previewEvent(trace, 'load-attempt')
    const startedAt = performance.now()
    const failureKey = preparePreviewFont(font)
    if ((failedPreviewUntil.get(failureKey) || 0) > Date.now()) return ''
    failedPreviewUntil.delete(failureKey)
    const previewRoute = resolveFontPreviewRoute(font)
    const ready = previewStateForFont(font)
    if (ready.family) return ready.family
    if (ready.image || ready.loading) return ''
    if (options.isBadFontRecord(previewRecordForProbe(font))) {
      failureKeys.set(font.id, fontSourceKey(font))
      options.setFailedPreviewFontIds((prev) => pruneRecordByKeyLimit({ ...prev, [font.id]: true }, PREVIEW_STATE_LRU_LIMIT, previewKeepIds(font.id)))
      return ''
    }

    options.loadingFonts.current.add(font.id)
    const requestToken = `${cacheMissToken()}::${loadGeneration}`
    const ownerToken = { key: failureKey }
    loadingOwners.set(font.id, ownerToken)
    const sourceToken = fontSourceKey(font)
    const current = () => acceptsResult() && isPreviewRequestCurrent(requestToken) && loadingOwners.get(font.id) === ownerToken && sourceKeys.get(font.id) === sourceToken && sourceToken === fontSourceKey(font)
    const identity = sourceToken
    const rememberWebFontFailure = (): void => {
      failureKeys.set(font.id, sourceToken)
      options.setFailedPreviewFontIds((prev) => pruneRecordByKeyLimit({ ...prev, [font.id]: true }, PREVIEW_STATE_LRU_LIMIT, previewKeepIds(font.id)))
    }
    let loadedFace: FontFace | undefined
    const family = createPreviewFamilyName(font.id)

    const loadCachedNativeCardPreview = async (): Promise<boolean> => {
      if (skipCachedPreview || hasLegacyMissingPreviewFlag(font) || hasCacheMiss(font)) return false
      if (typeof options.hfm.getCachedPreviewImage !== 'function') return false
      const cachedImage = await options.hfm.getCachedPreviewImage(font, previewText, previewLayout.fontSize, previewLayout.width, previewLayout.height, trace, previewLayout.nativeLayout).catch((error) => {
        if (previewFailureKind(error) === 'cancelled') throw error
        reportRendererTrace({
          kind: 'font-preview-cache-read-failed',
          label: 'getCachedPreviewImage',
          severity: 'warn',
          page: 'library',
          details: {
            fontId: font.id,
            fileName: font.fileName,
            path: font.path,
            previewText,
            error: error instanceof Error ? error.message : String(error)
          }
        }, `preview-cache-read-failed:${font.id}`)
        return ''
      })
      if (!current()) return false
      if (!cachedImage) {
        rememberCacheMiss(font)
        return false
      }
      rememberPreviewImageTrace(cachedImage, trace, font.id)
      previewEvent(trace, 'cache-result', 'hit')
      rememberNativeCardPreview(font, cachedImage, requestToken)
      return true
    }

    const renderNativeCardPreview = async (message: string): Promise<string> => {
      if (await loadCachedNativeCardPreview()) return ''
      if (!current()) return ''
      try {
        const image = await options.hfm.renderPreviewImage(font, previewText, previewLayout.fontSize, previewLayout.width, previewLayout.height, trace, previewLayout.nativeLayout)
        previewEvent(trace, 'image-return', current() ? 'current' : 'stale', startedAt)
        if (!current()) return ''
        rememberPreviewImageTrace(image, trace, font.id)
        if (!image.startsWith('data:image/png;base64,')) throw previewFailure('failed')
        rememberNativeCardPreview(font, image, requestToken)
        options.updateFont(font.id, current => hasLegacyMissingPreviewFlag(current) || current.previewError === '预览失败。'
          ? { ...current, previewDisabled: false, previewError: undefined } : current)

      } catch (error) {
        if (!current()) return ''
        if (previewFailureKind(error) === 'cancelled') return ''
        failedPreviewUntil.set(failureKey, Date.now() + 30000)
        while (failedPreviewUntil.size > CACHE_MISS_LRU_LIMIT) {
          failedPreviewUntil.delete(failedPreviewUntil.keys().next().value!)
        }
        reportRendererTrace({
          kind: 'font-preview-native-render-failed',
          label: 'renderPreviewImage',
          severity: 'warn',
          page: 'library',
          details: {
            fontId: font.id,
            fileName: font.fileName,
            path: font.path,
            previewText,
            error: error instanceof Error ? error.message : String(error)
          }
        }, `preview-native-render-failed:${font.id}`)
        // Failure is session state only. A later successful source read is required to clear old flags.
        previewEvent(trace, 'preview-failure', previewFailureKind(error))

      }
      return ''
    }

    try {
      if (ready.failed) {
        return await renderNativeCardPreview('Chromium WebFont 预览失败，已直接使用 Windows 原生图片预览。')
      }

      if (await loadCachedNativeCardPreview()) return ''
      if (!current()) return ''

      if (previewRoute.shouldSkipWebFontFileLoad) {
        return await renderNativeCardPreview('已安装字体直接使用 Windows 系统字体名原生预览。')
      }

      const quickPreviewStartedAt = performance.now()
      let protocolLoadError: unknown = null
      let loadedByProtocolUrl = false

      try {
        const url = await options.hfm.toFontUrl(font.path)
        if (!current()) return ''
        const protocolTimeoutMs = Math.min(QUICK_WEBFONT_URL_TIMEOUT_MS, remainingQuickPreviewBudget(quickPreviewStartedAt))
        previewEvent(trace, 'webfont-start')
        const observedUrl = trace ? `${url}?hfmTrace=${encodeURIComponent(JSON.stringify(trace))}` : url
        loadedFace = await loadFontFaceFromUrlWithinBudget(family, observedUrl, protocolTimeoutMs, trace ? outcome => previewEvent(trace, 'webfont-physical-settled', outcome, startedAt) : undefined, faceOwner ||= createFontFaceLoadOwner(), identity)
        previewEvent(trace, 'webfont-loaded')
        loadedByProtocolUrl = true
      } catch (error) {
        previewEvent(trace, 'webfont-fallback')
        protocolLoadError = error
        if (previewFailureKind(error) === 'cancelled') return ''
      }

      if (!current()) return ''
      if (!loadedByProtocolUrl) {
        if (isFontCollectionOrLargeFont(font)) {
          if (!(protocolLoadError instanceof QuickPreviewTimeoutError)) rememberWebFontFailure()
          return await renderNativeCardPreview('大型字体或字体集合已直接使用 Windows 原生图片预览。')
        }

        if (quickPreviewBudgetExpired(quickPreviewStartedAt) || !canUseBinaryWebFontQuickFallback(font)) {
          if (!(protocolLoadError instanceof QuickPreviewTimeoutError)) rememberWebFontFailure()
          return await renderNativeCardPreview('快速 WebFont 预览未在预算内完成，已直接使用 Windows 原生图片预览。')
        }

        if (typeof options.hfm.readPreviewFontData !== 'function') {
          throw new Error(`协议 URL 加载失败：${protocolLoadError instanceof Error ? protocolLoadError.message : String(protocolLoadError)}`)
        }

        try {
          const binaryBudgetMs = Math.min(QUICK_WEBFONT_BINARY_TIMEOUT_MS, remainingQuickPreviewBudget(quickPreviewStartedAt))
          const physicalRead = options.hfm.readPreviewFontData(font)
          let fontData: unknown
          try { fontData = await (faceOwner ||= createFontFaceLoadOwner()).withinBudget(physicalRead, binaryBudgetMs, '读取二进制字体数据') }
          finally { await physicalRead.catch(() => undefined) }
          if (!current()) return ''
          const source = normalizeFontFaceBinarySource(fontData)
          if (!source) throw new Error('主进程返回的字体数据不是有效 ArrayBuffer。')
          loadedFace = await loadFontFaceFromBinaryWithinBudget(family, source, Math.min(QUICK_WEBFONT_BINARY_TIMEOUT_MS, remainingQuickPreviewBudget(quickPreviewStartedAt)), trace ? outcome => previewEvent(trace, 'webfont-physical-settled', outcome, startedAt) : undefined, faceOwner ||= createFontFaceLoadOwner(), identity)
        } catch (error) {
          if (error instanceof QuickPreviewTimeoutError) throw error
          const protocolMessage = protocolLoadError ? `协议 URL 加载失败：${protocolLoadError instanceof Error ? protocolLoadError.message : String(protocolLoadError)}；` : ''
          throw new Error(`${protocolMessage}FontFace 快速预览失败：${error instanceof Error ? error.message : String(error)}；快速预览总预算 ${QUICK_WEBFONT_TOTAL_BUDGET_MS}ms。`)
        }
      }

      if (!current()) return ''
      if (loadedFace) { document.fonts.add(loadedFace); attachedFaces.set(font.id, loadedFace) }
      previewEvent(trace, 'webfont-applied', 'current', startedAt)
      settledFamilies.set(font.id, { key: sourceToken, value: family })
      options.setPreviewFamilies((prev) => pruneRecordByKeyLimit({ ...prev, [font.id]: family }, PREVIEW_STATE_LRU_LIMIT, previewKeepIds(font.id)))
      options.setNativePreviewImages((prev) => {
        if (!prev[font.id]) return prev
        const next = { ...prev }
        delete next[font.id]
        return next
      })
      options.updateFont(font.id, (current) => current.previewDisabled || current.previewError
        ? {
            ...current,
            previewDisabled: false,
            previewError: undefined
          }
        : current)
      return family
    } catch (error) {
      if (!current()) return ''
      if (previewFailureKind(error) === 'cancelled') return ''
      reportRendererTrace({
        kind: 'font-preview-webfont-failed',
        label: 'FontFace.load',
        severity: 'warn',
        page: 'library',
        details: {
          fontId: font.id,
          fileName: font.fileName,
          path: font.path,
          previewText,
          postscriptName: font.postscriptName,
          fullName: font.fullName,
          error: error instanceof Error ? error.message : String(error)
        }
      }, `preview-webfont-failed:${font.id}`)
      if (!(error instanceof QuickPreviewTimeoutError)) rememberWebFontFailure()
      return await renderNativeCardPreview('Chromium WebFont 预览失败，已改用 Windows 原生图片预览。')
    } finally {
      previewEvent(trace, 'load-settled', current() ? 'current' : 'stale', startedAt)
      if (loadingOwners.get(font.id) === ownerToken) {
        loadingOwners.delete(font.id)
        options.loadingFonts.current.delete(font.id)
      }
    }
  }

  return { ensurePreviewFont, loadCachedNativeCardPreviews, resetPreviewLoads, previewStateForFont, previewRequestKey, preparePreviewFont, removePreviewFontLoads, disposePreviewLoads: () => { resetPreviewLoads(); faceOwner?.dispose() } }
}
