import type { RendererClosingLifecycleRuntime } from './rendererClosingLifecycleRuntime'
import type { FontItem } from '@shared/types'
import { getCardPreviewLayout } from '@shared/preview-layout/previewTextFitRuntime'
import { useEffect,useRef,useState } from 'react'
import type { PreviewQueueEntry } from '../../appRuntime'
import { createFontPreviewQueueRuntime } from '../preview/fontPreviewQueueRuntime'
import type { FontPreviewQueueRuntimeOptions } from '../preview/fontPreviewQueueRuntime'
import { usePreviewTextResetRuntime } from './effects/usePreviewTextResetRuntime'
import { gridPreviewPostprocess } from '../preview/gridNativePreviewImageTrimRuntime'

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

export type PreviewControllerOptions = Omit<FontPreviewQueueRuntimeOptions, PreviewControllerOwnedOptions> & { closingLifecycle?: RendererClosingLifecycleRuntime }

export function usePreviewController(options: PreviewControllerOptions) {
  const [previewFamilies, setPreviewFamilies] = useState<Record<string, string>>({})
  const [nativePreviewImages, setNativePreviewImages] = useState<Record<string, string>>({})
  const [nativeDetailImage, setNativeDetailImage] = useState<string>('')
  const detailNativePreviewRequestSeqRef = useRef(0)
  const [failedPreviewFontIds, setFailedPreviewFontIds] = useState<Record<string, true>>({})
  const loadingFonts = useRef<Set<string>>(new Set())
  const previewRequestTokenRef = useRef('')
  previewRequestTokenRef.current = getCardPreviewLayout(options.previewLayoutMode ?? 'list', options.previewText, options.listPreviewFontSize).token
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

  const queueOptions: FontPreviewQueueRuntimeOptions = {
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
  }
  const runtimeOptionsRef = useRef(queueOptions)
  Object.assign(runtimeOptionsRef.current, queueOptions)
  const queueRuntimeRef = useRef<ReturnType<typeof createFontPreviewQueueRuntime> | null>(null)
  if (!queueRuntimeRef.current) queueRuntimeRef.current = createFontPreviewQueueRuntime(runtimeOptionsRef.current)
  const queueRuntime = queueRuntimeRef.current
  useEffect(() => {
    const sync = (closing: boolean) => {
      gridPreviewPostprocess.setPaused(closing)
      if (closing) { clearFontListScrollIdleTimer(); queueRuntime.disposePreviewQueue() }
      else queueRuntime.resumePreviewQueue()
    }
    sync(options.closingLifecycle?.isClosing() || false)
    const unsubscribe = options.closingLifecycle?.subscribe(sync)
    return () => { unsubscribe?.(); clearFontListScrollIdleTimer(); queueRuntime.disposePreviewQueue(); gridPreviewPostprocess.setPaused(true) }
  }, [queueRuntime, options.closingLifecycle])

  const previewImagesCurrent = usePreviewTextResetRuntime({
    previewToken: previewRequestTokenRef.current,
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
    gridPreviewPostprocess.setPaused(true, false)
    if (!fontListScrollingRef.current) queueRuntime.pausePreviewForScroll()
    fontListScrollingRef.current = true
    if (fontListScrollIdleTimerRef.current !== null) window.clearTimeout(fontListScrollIdleTimerRef.current)
    fontListScrollIdleTimerRef.current = window.setTimeout(() => {
      fontListScrollingRef.current = false
      fontListScrollIdleTimerRef.current = null
      if (!options.closingLifecycle?.isClosing()) gridPreviewPostprocess.setPaused(false)
      queueRuntime.resumePreviewAfterScroll()
      queueRuntime.processAutoPreviewCacheQueue()
    }, previewScrollIdleMs)
  }

  function clearFontListScrollIdleTimer(): void {
    fontListScrollingRef.current = false
    if (fontListScrollIdleTimerRef.current === null) return
    window.clearTimeout(fontListScrollIdleTimerRef.current)
    fontListScrollIdleTimerRef.current = null
  }

  function isFontListScrolling(): boolean {
    return fontListScrollingRef.current
  }

  return {
    previewFamilies,
    nativePreviewImages: previewImagesCurrent ? nativePreviewImages : {},
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
