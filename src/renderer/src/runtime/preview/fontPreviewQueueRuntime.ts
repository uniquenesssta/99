import { createFontAutoPreviewCacheQueueRuntime } from './queue/fontAutoPreviewCacheQueueRuntime'
import { createFontPreviewLoadRuntime } from './queue/fontPreviewLoadRuntime'
import type { FontPreviewQueueRuntime,FontPreviewQueueRuntimeOptions } from './queue/fontPreviewQueueTypes'
import { createFontPreviewStateRuntime } from './queue/fontPreviewStateRuntime'
import { createFontVisiblePreviewQueueRuntime } from './queue/fontVisiblePreviewQueueRuntime'

export type { AutoPreviewCacheStats,FontPreviewQueueRuntime,FontPreviewQueueRuntimeOptions } from './queue/fontPreviewQueueTypes'

export function createFontPreviewQueueRuntime(options: FontPreviewQueueRuntimeOptions): FontPreviewQueueRuntime {
  const stateRuntime = createFontPreviewStateRuntime(options)
  const loadRuntime = createFontPreviewLoadRuntime(options)
  const visibleQueueRuntime = createFontVisiblePreviewQueueRuntime(options, stateRuntime, loadRuntime)
  const autoPreviewCacheQueueRuntime = createFontAutoPreviewCacheQueueRuntime(options)

  return {
    ...stateRuntime,
    ...loadRuntime,
    ...visibleQueueRuntime,
    ...autoPreviewCacheQueueRuntime
  }
}
