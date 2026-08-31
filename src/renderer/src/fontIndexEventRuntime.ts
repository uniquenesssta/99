import type { FontIndexProgressPayload } from '@shared/types'
import type { MutableRefObject } from 'react'
import type { PreviewQueueEntry } from './appTypes'

export type RendererFontIndexCleanupOptions = {
  removedIds: string[]
  selectedFontId: string
  previewQueue: MutableRefObject<PreviewQueueEntry[]>
  autoPreviewCacheQueue: MutableRefObject<Array<{ id: string }>>
  queuedPreviewFontIds: MutableRefObject<Set<string>>
  queuedAutoPreviewCacheIds: MutableRefObject<Set<string>>
  loadingFonts: MutableRefObject<Set<string>>
  setSelectedFontIds: (updater: (ids: string[]) => string[]) => void
  setNativePreviewImages: (updater: (images: Record<string, string>) => Record<string, string>) => void
  setFailedPreviewFontIds: (updater: (flags: Record<string, true>) => Record<string, true>) => void
  setSelectedFontId: (fontId: string) => void
  setDetailVisible: (visible: boolean) => void
  setNativeDetailImage: (image: string) => void
}

export function isIndexProgressActive(payload: FontIndexProgressPayload): boolean {
  return payload.stage !== 'done' && payload.stage !== 'cancelled' && payload.stage !== 'error'
}

export function folderChangeStatusText(payload: { fileName?: string; folder?: string }): string {
  return `检测到字体文件夹变化：${payload.fileName || payload.folder}，等待增量索引事件……`
}

export function fontIndexChangeStatusText(stats: { upserted: number; removed: number; errors?: number }): string {
  const errorText = stats.errors ? `，错误 ${stats.errors} 个` : ''
  return `增量索引已更新：新增/更新 ${stats.upserted} 个，移除 ${stats.removed} 个${errorText}。`
}

export function cleanupRemovedIndexedFontsFromRendererState(options: RendererFontIndexCleanupOptions): void {
  if (!options.removedIds.length) return
  const removed = new Set(options.removedIds)

  options.previewQueue.current = options.previewQueue.current.filter((entry) => !removed.has(entry.font.id))
  options.autoPreviewCacheQueue.current = options.autoPreviewCacheQueue.current.filter((font) => !removed.has(font.id))
  for (const id of removed) {
    options.queuedPreviewFontIds.current.delete(id)
    options.queuedAutoPreviewCacheIds.current.delete(id)
    options.loadingFonts.current.delete(id)
  }

  options.setSelectedFontIds((prev) => prev.filter((id) => !removed.has(id)))
  options.setNativePreviewImages((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !removed.has(id))))
  options.setFailedPreviewFontIds((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !removed.has(id))))
  if (removed.has(options.selectedFontId)) {
    options.setSelectedFontId('')
    options.setDetailVisible(false)
    options.setNativeDetailImage('')
  }
}
