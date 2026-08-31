import type { FontItem } from '../../../shared/types'
import type { ScanOrchestratorDeps } from './scanOrchestratorTypes'

export function createFontScanHashBufferRuntime(
  deps: Pick<ScanOrchestratorDeps, 'upsertFontHashIndex' | 'scanHashFlushBatchSize'>,
): {
  queueHashFont: (font: FontItem) => Promise<void>
  flushHashBuffer: () => Promise<void>
  getHashFlushes: () => number
} {
  let hashFlushes = 0
  const hashBuffer: FontItem[] = []

  const flushHashBuffer = async (): Promise<void> => {
    if (!hashBuffer.length) return
    const chunk = hashBuffer.splice(0, hashBuffer.length)
    await deps.upsertFontHashIndex(chunk)
    hashFlushes += 1
  }

  const queueHashFont = async (font: FontItem): Promise<void> => {
    if (!font?.id || !font.path) return
    hashBuffer.push(font)
    if (hashBuffer.length >= deps.scanHashFlushBatchSize) await flushHashBuffer()
  }

  return {
    queueHashFont,
    flushHashBuffer,
    getHashFlushes: () => hashFlushes,
  }
}
