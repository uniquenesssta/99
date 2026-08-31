import type { FontItem } from '@shared/types'
import { getNativePreviewRequestLayout,normalizePreviewText,previewTextLines } from '@shared/preview-layout/previewTextFitRuntime'
import { clampListPreviewFontSize,listPreviewNativeImageHeight } from '../listPreviewSizeRuntime'
import { PREVIEW_STATE_LRU_LIMIT,pruneRecordByKeyLimit } from '../../../appRuntime'
import { createPreviewFamilyName,previewStateKeepIds } from '../../../fontPreviewStateRuntime'
import { reportRendererTrace } from '../../../rendererPerformance'
import { resolveFontPreviewRoute } from './fontPreviewRouteRuntime'
import type { FontPreviewLoadRuntime,FontPreviewQueueRuntimeOptions } from './fontPreviewQueueTypes'
import {
  QUICK_WEBFONT_BINARY_TIMEOUT_MS,
  QUICK_WEBFONT_TOTAL_BUDGET_MS,
  QUICK_WEBFONT_URL_TIMEOUT_MS,
  canUseBinaryWebFontQuickFallback,
  isFontCollectionOrLargeFont,
  loadFontFaceFromBinaryWithinBudget,
  loadFontFaceFromUrlWithinBudget,
  quickPreviewBudgetExpired,
  remainingQuickPreviewBudget,
  withQuickPreviewTimeout
} from './fontPreviewQuickFallbackRuntime'

const CARD_PREVIEW_LAYOUT_MODE = 'list' as const
const CACHE_MISS_LRU_LIMIT = 800

function currentCardPreviewText(text: string): string {
  return normalizePreviewText(text)
}

function currentCardPreviewLayout(text: string, listPreviewFontSize?: number): { fontSize: number; width: number; height: number } {
  const previewText = currentCardPreviewText(text)
  const layout = getNativePreviewRequestLayout(CARD_PREVIEW_LAYOUT_MODE, previewText)
  const fontSize = clampListPreviewFontSize(listPreviewFontSize ?? layout.fontSize)
  return {
    ...layout,
    fontSize,
    height: listPreviewNativeImageHeight(fontSize, previewTextLines(previewText, 2).length)
  }
}

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
  let cachedPreviewMissText = ''

  function previewKeepIds(fontId: string): Set<string> {
    return previewStateKeepIds(fontId, options.selectedFontId, options.selectedFontIds)
  }

  function cacheMissToken(): string {
    return `${currentCardPreviewText(options.previewText)}::${clampListPreviewFontSize(options.listPreviewFontSize)}`
  }

  function cacheMissKey(fontId: string): string {
    return `${fontId}::${cacheMissToken()}`
  }

  function isPreviewRequestCurrent(requestToken: string): boolean {
    return options.previewRequestTokenRef.current === requestToken
  }

  function syncCacheMissText(): void {
    const previewToken = cacheMissToken()
    if (cachedPreviewMissText === previewToken) return
    cachedPreviewMissText = previewToken
    cachedPreviewMissKeys.clear()
  }

  function rememberCacheMiss(fontId: string): void {
    syncCacheMissText()
    const key = cacheMissKey(fontId)
    if (cachedPreviewMissKeys.has(key)) cachedPreviewMissKeys.delete(key)
    cachedPreviewMissKeys.add(key)
    while (cachedPreviewMissKeys.size > CACHE_MISS_LRU_LIMIT) {
      const oldest = cachedPreviewMissKeys.keys().next().value
      if (!oldest) break
      cachedPreviewMissKeys.delete(oldest)
    }
  }

  function hasCacheMiss(fontId: string): boolean {
    syncCacheMissText()
    return cachedPreviewMissKeys.has(cacheMissKey(fontId))
  }

  function forgetCacheMiss(fontId: string): void {
    syncCacheMissText()
    cachedPreviewMissKeys.delete(cacheMissKey(fontId))
  }

  function rememberNativeCardPreview(font: FontItem, image: string, requestToken: string): void {
    if (!isPreviewRequestCurrent(requestToken)) return
    options.setNativePreviewImages((prev) => pruneRecordByKeyLimit({ ...prev, [font.id]: image }, PREVIEW_STATE_LRU_LIMIT, previewKeepIds(font.id)))
    forgetCacheMiss(font.id)
  }

  function rememberNativeCardPreviewBatch(entries: Array<{ font: FontItem; image: string }>, requestToken: string): void {
    if (!entries.length || !isPreviewRequestCurrent(requestToken)) return
    const keepIds = new Set<string>()
    for (const entry of entries) {
      forgetCacheMiss(entry.font.id)
      for (const id of previewKeepIds(entry.font.id)) keepIds.add(id)
    }
    options.setNativePreviewImages((prev) => {
      const next = { ...prev }
      for (const entry of entries) next[entry.font.id] = entry.image
      return pruneRecordByKeyLimit(next, PREVIEW_STATE_LRU_LIMIT, keepIds)
    })
  }

  async function loadCachedNativeCardPreviews(fonts: FontItem[]): Promise<Set<string>> {
    const seen = new Set<string>()
    const uniqueFonts: FontItem[] = []
    for (const font of fonts || []) {
      if (!font?.id || seen.has(font.id)) continue
      seen.add(font.id)
      const routeForcesNative = resolveFontPreviewRoute(font).shouldSkipWebFontFileLoad
      if ((!routeForcesNative && options.previewFamilies[font.id]) || options.nativePreviewImages[font.id] || options.loadingFonts.current.has(font.id)) continue
      if (hasCacheMiss(font.id)) continue
      uniqueFonts.push(font)
    }
    const hitIds = new Set<string>()
    if (!uniqueFonts.length || typeof options.hfm.getCachedPreviewImages !== 'function') return hitIds

    const requestToken = cacheMissToken()
    const previewText = currentCardPreviewText(options.previewText)
    const previewLayout = currentCardPreviewLayout(options.previewText, options.listPreviewFontSize)
    const cachedImages = await options.hfm.getCachedPreviewImages(uniqueFonts, previewText, previewLayout.fontSize, previewLayout.width, previewLayout.height).catch(() => ({} as Record<string, string>))
    if (!isPreviewRequestCurrent(requestToken)) return hitIds
    const hitEntries: Array<{ font: FontItem; image: string }> = []
    for (const font of uniqueFonts) {
      const image = cachedImages[font.id]
      if (image) {
        hitEntries.push({ font, image })
        hitIds.add(font.id)
      } else {
        rememberCacheMiss(font.id)
      }
    }
    rememberNativeCardPreviewBatch(hitEntries, requestToken)
    return hitIds
  }

  async function ensurePreviewFont(font: FontItem): Promise<string> {
    const previewRoute = resolveFontPreviewRoute(font)
    if (previewRoute.shouldSkipWebFontFileLoad && options.previewFamilies[font.id]) {
      options.setPreviewFamilies((prev) => {
        if (!prev[font.id]) return prev
        const next = { ...prev }
        delete next[font.id]
        return next
      })
    } else if (options.previewFamilies[font.id]) {
      return options.previewFamilies[font.id]
    }
    if (font.previewDisabled && (font.previewError?.includes('字体文件不存在') || font.previewError?.includes('路径已失效'))) return ''
    if (options.loadingFonts.current.has(font.id)) return ''
    if (options.isBadFontRecord(font)) {
      options.setFailedPreviewFontIds((prev) => pruneRecordByKeyLimit({ ...prev, [font.id]: true }, PREVIEW_STATE_LRU_LIMIT, previewKeepIds(font.id)))
      return ''
    }

    options.loadingFonts.current.add(font.id)
    const requestToken = cacheMissToken()
    const family = createPreviewFamilyName(font.id)

    const loadCachedNativeCardPreview = async (): Promise<boolean> => {
      if (hasCacheMiss(font.id)) return false
      if (typeof options.hfm.getCachedPreviewImage !== 'function') return false
      const previewText = currentCardPreviewText(options.previewText)
      const previewLayout = currentCardPreviewLayout(options.previewText, options.listPreviewFontSize)
      const cachedImage = await options.hfm.getCachedPreviewImage(font, previewText, previewLayout.fontSize, previewLayout.width, previewLayout.height).catch((error) => {
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
      if (!isPreviewRequestCurrent(requestToken)) return false
      if (!cachedImage) {
        rememberCacheMiss(font.id)
        return false
      }
      rememberNativeCardPreview(font, cachedImage, requestToken)
      return true
    }

    const renderNativeCardPreview = async (message: string, optionsOverride?: { rememberMissingPlaceholder?: boolean; markMissingAsDisabled?: boolean }): Promise<string> => {
      if (await loadCachedNativeCardPreview()) return ''
      try {
        const previewText = currentCardPreviewText(options.previewText)
        const previewLayout = currentCardPreviewLayout(options.previewText, options.listPreviewFontSize)
        const image = await options.hfm.renderPreviewImage(font, previewText, previewLayout.fontSize, previewLayout.width, previewLayout.height)
        if (!isPreviewRequestCurrent(requestToken)) return ''
        const missingFile = image.startsWith('data:image/svg+xml')
        const rememberMissingPlaceholder = optionsOverride?.rememberMissingPlaceholder !== false
        if (!missingFile || rememberMissingPlaceholder) rememberNativeCardPreview(font, image, requestToken)
        if (missingFile && optionsOverride?.markMissingAsDisabled !== false) {
          options.updateFont(font.id, (current) => ({
            ...current,
            previewDisabled: true,
            previewError: '字体文件不存在或路径已失效。'
          }))
        }
      } catch (error) {
        if (!isPreviewRequestCurrent(requestToken)) return ''
        reportRendererTrace({
          kind: 'font-preview-native-render-failed',
          label: 'renderPreviewImage',
          severity: 'warn',
          page: 'library',
          details: {
            fontId: font.id,
            fileName: font.fileName,
            path: font.path,
            previewText: currentCardPreviewText(options.previewText),
            error: error instanceof Error ? error.message : String(error)
          }
        }, `preview-native-render-failed:${font.id}`)
        options.updateFont(font.id, (current) => ({
          ...current,
          previewDisabled: true,
          previewError: '预览失败。'
        }))
      }
      return ''
    }

    try {
      if (options.failedPreviewFontIds[font.id]) {
        return await renderNativeCardPreview('Chromium WebFont 预览失败，已直接使用 Windows 原生图片预览。')
      }

      if (await loadCachedNativeCardPreview()) return ''

      if (previewRoute.shouldSkipWebFontFileLoad) {
        return await renderNativeCardPreview('已安装字体直接使用 Windows 系统字体名原生预览。', {
          rememberMissingPlaceholder: false,
          markMissingAsDisabled: false
        })
      }

      const quickPreviewStartedAt = performance.now()
      let protocolLoadError: unknown = null
      let loadedByProtocolUrl = false

      try {
        const url = await options.hfm.toFontUrl(font.path)
        const protocolTimeoutMs = Math.min(QUICK_WEBFONT_URL_TIMEOUT_MS, remainingQuickPreviewBudget(quickPreviewStartedAt))
        await loadFontFaceFromUrlWithinBudget(family, url, protocolTimeoutMs)
        loadedByProtocolUrl = true
      } catch (error) {
        protocolLoadError = error
      }

      if (!loadedByProtocolUrl) {
        if (isFontCollectionOrLargeFont(font)) {
          options.setFailedPreviewFontIds((prev) => pruneRecordByKeyLimit({ ...prev, [font.id]: true }, PREVIEW_STATE_LRU_LIMIT, previewKeepIds(font.id)))
          return await renderNativeCardPreview('大型字体或字体集合已直接使用 Windows 原生图片预览。')
        }

        if (quickPreviewBudgetExpired(quickPreviewStartedAt) || !canUseBinaryWebFontQuickFallback(font)) {
          options.setFailedPreviewFontIds((prev) => pruneRecordByKeyLimit({ ...prev, [font.id]: true }, PREVIEW_STATE_LRU_LIMIT, previewKeepIds(font.id)))
          return await renderNativeCardPreview('快速 WebFont 预览未在预算内完成，已直接使用 Windows 原生图片预览。')
        }

        if (typeof options.hfm.readPreviewFontData !== 'function') {
          throw new Error(`协议 URL 加载失败：${protocolLoadError instanceof Error ? protocolLoadError.message : String(protocolLoadError)}`)
        }

        try {
          const binaryBudgetMs = Math.min(QUICK_WEBFONT_BINARY_TIMEOUT_MS, remainingQuickPreviewBudget(quickPreviewStartedAt))
          const fontData = await withQuickPreviewTimeout(options.hfm.readPreviewFontData(font), binaryBudgetMs, '读取二进制字体数据')
          const source = normalizeFontFaceBinarySource(fontData)
          if (!source) throw new Error('主进程返回的字体数据不是有效 ArrayBuffer。')
          await loadFontFaceFromBinaryWithinBudget(family, source, Math.min(QUICK_WEBFONT_BINARY_TIMEOUT_MS, remainingQuickPreviewBudget(quickPreviewStartedAt)))
        } catch (error) {
          const protocolMessage = protocolLoadError ? `协议 URL 加载失败：${protocolLoadError instanceof Error ? protocolLoadError.message : String(protocolLoadError)}；` : ''
          throw new Error(`${protocolMessage}FontFace 快速预览失败：${error instanceof Error ? error.message : String(error)}；快速预览总预算 ${QUICK_WEBFONT_TOTAL_BUDGET_MS}ms。`)
        }
      }

      if (!isPreviewRequestCurrent(requestToken)) return ''
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
      if (!isPreviewRequestCurrent(requestToken)) return ''
      reportRendererTrace({
        kind: 'font-preview-webfont-failed',
        label: 'FontFace.load',
        severity: 'warn',
        page: 'library',
        details: {
          fontId: font.id,
          fileName: font.fileName,
          path: font.path,
          previewText: currentCardPreviewText(options.previewText),
          postscriptName: font.postscriptName,
          fullName: font.fullName,
          error: error instanceof Error ? error.message : String(error)
        }
      }, `preview-webfont-failed:${font.id}`)
      options.setFailedPreviewFontIds((prev) => pruneRecordByKeyLimit({ ...prev, [font.id]: true }, PREVIEW_STATE_LRU_LIMIT, previewKeepIds(font.id)))
      return await renderNativeCardPreview('Chromium WebFont 预览失败，已改用 Windows 原生图片预览。')
    } finally {
      options.loadingFonts.current.delete(font.id)
    }
  }

  return { ensurePreviewFont, loadCachedNativeCardPreviews }
}
