// Windows integration fixture: real renderer demand/cache/native queues and
// browser PNG decoding. The containing DOM is deliberately small, not App.tsx.
import { createFontPreviewQueueRuntime } from '../../../src/renderer/src/runtime/preview/fontPreviewQueueRuntime'
import { getCardPreviewLayout } from '../../../src/shared/preview-layout/previewTextFitRuntime'
import { resetPreviewTrace } from '../../../src/renderer/src/runtime/preview/previewTraceRuntime'

;(window as any).measurePreviewChain = async (fonts: any[], mode: 'list' | 'grid') => {
  resetPreviewTrace()
  document.body.replaceChildren()
  const ref = (current: any) => ({ current })
  const text = '字体 Ag fj', size = 44
  const spec = getCardPreviewLayout(mode, text, size)
  const started = performance.now(), applied = new Set<string>(), images = new Map<string, HTMLImageElement>()
  let first = 0, completed = 0, resolveDone: (value?: unknown) => void, rejectDone: (error: unknown) => void
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  const options: any = {
    hfm: window.hfm, previewText: text, previewLayoutMode: mode, listPreviewFontSize: size,
    previewRequestTokenRef: ref(spec.token), selectedFontId: '', selectedFontIds: [], indexingActive: false,
    previewFamilies: {}, nativePreviewImages: {}, failedPreviewFontIds: {}, loadingFonts: ref(new Set()),
    queuedPreviewFontIds: ref(new Set()), previewQueue: ref([]), activePreviewLoads: ref(0), fontListScrollingRef: ref(false),
    autoPreviewCacheRunId: ref(0), autoPreviewCacheQueue: ref([]), queuedAutoPreviewCacheIds: ref(new Set()), activeAutoPreviewCacheLoads: ref(0), autoPreviewCacheStats: ref({}),
    isBadFontRecord: () => false, rendererUserActive: () => false,
    setPreviewFamilies(update: any) { options.previewFamilies = typeof update === 'function' ? update(options.previewFamilies) : update },
    setNativePreviewImages(update: any) {
      options.nativePreviewImages = typeof update === 'function' ? update(options.nativePreviewImages) : update
      for (const font of fonts) {
        const source = options.nativePreviewImages[font.id]
        if (!source || applied.has(font.id)) continue
        applied.add(font.id)
        const image = new Image(); image.style.maxWidth = '600px'; image.style.display = 'block'
        images.set(font.id, image); image.src = source; document.body.append(image)
        void image.decode().then(() => {
          if (image.naturalWidth !== spec.width || image.naturalHeight !== spec.height) throw Error('wrong PNG layout')
          const elapsed = performance.now() - started
          if (!first) first = elapsed
          completed++
          if (completed === fonts.length) resolveDone(elapsed)
        }).catch(rejectDone)
      }
    },
    setFailedPreviewFontIds(update: any) {
      options.failedPreviewFontIds = typeof update === 'function' ? update(options.failedPreviewFontIds) : update
      if (Object.keys(options.failedPreviewFontIds).length) rejectDone(Error('preview failed'))
    },
    setNativeDetailImage() {}, updateFont() {}, setStatus() {},
  }
  const runtime = createFontPreviewQueueRuntime(options)
  const timeout = window.setTimeout(() => rejectDone(Error('visible demand did not complete')), 15000)
  try {
    for (const font of fonts) runtime.requestPreviewFont(font, 'high')
    const all = await done
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return { mode, text, size, fontCount: fonts.length, firstValidPreviewMs: first, visibleCompleteMs: all, decoded: completed, dimensions: [spec.width, spec.height] }
  } finally {
    clearTimeout(timeout); runtime.disposePreviewQueue()
    for (const image of images.values()) image.removeAttribute('src')
  }
}
