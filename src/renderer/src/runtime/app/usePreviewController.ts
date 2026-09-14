import type { FontItem } from '@shared/types'
import { normalizePreviewText } from '@shared/preview-layout/previewTextFitRuntime'
import { useRef,useState } from 'react'
import type { PreviewQueueEntry } from '../../appRuntime'
import { clampListPreviewFontSize } from '../preview/listPreviewSizeRuntime'
import { createFontPreviewQueueRuntime } from '../preview/fontPreviewQueueRuntime'
import type { FontPreviewQueueRuntimeOptions } from '../preview/fontPreviewQueueRuntime'
import { usePreviewTextResetRuntime } from './effects/usePreviewTextResetRuntime'

type PreviewControllerOwnedOptions =
  'previewFamilies' |
  'nativePreviewImages' |
  'failedPreviewFontIds' |
  'previewRequestTokenRef' |
  'fontListScrollingRef' |
  'loadingFonts' |
  'previewQueue' |
  'queuedPreviewFontIds' |
  'activePreviewLoads' |
  'autoPreviewCacheQueue' |
  'queuedAutoPreviewCacheIds' |
  'activeAutoPreviewCacheLoads' |
  'autoPreviewCacheRunId' |
  'autoPreviewCacheStats' |
  'setPreviewFamilies' |
  'setFailedPreviewFontIds' |
  'setNativePreviewImages' |
  'setNativeDetailImage'

export type PreviewControllerOptions = Omit<FontPreviewQueueRuntimeOptions, PreviewControllerOwnedOptions>

export function usePreviewController(options: PreviewControllerOptions) {
  const [previewFamilies, setPreviewFamilies] = useState<Record<string, string>>({})
  const [nativePreviewImages, setNativePreviewImages] = useState<Record<string, string>>({})
  const [nativeDetailImage, setNativeDetailImage] = useState<string>('')
  const detailNativePreviewRequestSeqRef = useRef(0)
  const [failedPreviewFontIds, setFailedPreviewFontIds] = useState<Record<string, true>>({})
  const loadingFonts = useRef<Set<string>>(new Set())
  const previewRequestTokenRef = useRef('')
  previewRequestTokenRef.current = `${normalizePreviewText(options.previewText)}::${clampListPreviewFontSize(options.listPreviewFontSize)}`
  const previewQueue = useRef<PreviewQueueEntry[]>([])
  const queuedPreviewFontIds = useRef<Set<string>>(new Set())
  const fontListScrollingRef = useRef(false)
  const fontListScrollIdleTimerRef = useRef<number | null>(null)
  const activePreviewLoads = useRef(0)
  const autoPreviewCacheQueue = useRef<FontItem[]>([])
  const queuedAutoPreviewCacheIds = useRef<Set<string>>(new Set())
  const activeAutoPreviewCacheLoads = useRef(0)
  const autoPreviewCacheRunId = useRef(0)
  const autoPreviewCacheStats = useRef({ total: 0, done: 0, cached: 0, generated: 0, failed: 0 })

  const queueRuntime = createFontPreviewQueueRuntime({
    ...options,
    previewFamilies,
    nativePreviewImages,
    failedPreviewFontIds,
    previewRequestTokenRef,
    fontListScrollingRef,
    loadingFonts,
    previewQueue,
    queuedPreviewFontIds,
    activePreviewLoads,
    autoPreviewCacheQueue,
    queuedAutoPreviewCacheIds,
    activeAutoPreviewCacheLoads,
    autoPreviewCacheRunId,
    autoPreviewCacheStats,
    setPreviewFamilies,
    setFailedPreviewFontIds,
    setNativePreviewImages,
    setNativeDetailImage
  })

  usePreviewTextResetRuntime({
    previewText: options.previewText,
    listPreviewFontSize: options.listPreviewFontSize,
    resetPreviewRuntimeState: queueRuntime.resetPreviewRuntimeState
  })

  function removeFontIds(removedFontIds: ReadonlySet<string>, clearDetailImage: boolean): void {
    if (!removedFontIds.size) return
    previewQueue.current = previewQueue.current.filter((entry) => !removedFontIds.has(entry.font.id))
    autoPreviewCacheQueue.current = autoPreviewCacheQueue.current.filter((font) => !removedFontIds.has(font.id))
    for (const id of removedFontIds) {
      queuedPreviewFontIds.current.delete(id)
      queuedAutoPreviewCacheIds.current.delete(id)
      loadingFonts.current.delete(id)
    }
    setNativePreviewImages((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !removedFontIds.has(id))))
    setFailedPreviewFontIds((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !removedFontIds.has(id))))
    if (clearDetailImage) setNativeDetailImage('')
  }

  function beginFontListScroll(previewScrollIdleMs: number): void {
    fontListScrollingRef.current = true
    if (fontListScrollIdleTimerRef.current !== null) window.clearTimeout(fontListScrollIdleTimerRef.current)
    fontListScrollIdleTimerRef.current = window.setTimeout(() => {
      fontListScrollingRef.current = false
      fontListScrollIdleTimerRef.current = null
      queueRuntime.processPreviewQueue()
      queueRuntime.processAutoPreviewCacheQueue()
    }, previewScrollIdleMs)
  }

  function clearFontListScrollIdleTimer(): void {
    if (fontListScrollIdleTimerRef.current === null) return
    window.clearTimeout(fontListScrollIdleTimerRef.current)
    fontListScrollIdleTimerRef.current = null
  }

  function isFontListScrolling(): boolean {
    return fontListScrollingRef.current
  }

  return {
    previewFamilies,
    nativePreviewImages,
    nativeDetailImage,
    setNativeDetailImage,
    detailNativePreviewRequestSeqRef,
    failedPreviewFontIds,
    resetPreviewRuntimeState: queueRuntime.resetPreviewRuntimeState,
    processPreviewQueue: queueRuntime.processPreviewQueue,
    requestPreviewFont: queueRuntime.requestPreviewFont,
    processAutoPreviewCacheQueue: queueRuntime.processAutoPreviewCacheQueue,
    removeFontIds,
    beginFontListScroll,
    clearFontListScrollIdleTimer,
    fontListScrollingRef: fontListScrollingRef as Readonly<{ current: boolean }>,
    isFontListScrolling
  }
}
