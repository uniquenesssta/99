import type { FontItem } from '@shared/types'
import type { Dispatch,MutableRefObject,SetStateAction } from 'react'
import type { PreviewQueueEntry } from '../../../appRuntime'

export type AutoPreviewCacheStats = {
  total: number
  done: number
  cached: number
  generated: number
  failed: number
}

export type FontPreviewQueueRuntimeOptions = {
  hfm: typeof window.hfm
  previewFamilies: Record<string, string>
  nativePreviewImages: Record<string, string>
  failedPreviewFontIds: Record<string, true>
  previewText: string
  listPreviewFontSize: number
  previewRequestTokenRef: MutableRefObject<string>
  selectedFontId: string
  selectedFontIds: string[]
  indexingActive: boolean
  fontListScrollingRef: MutableRefObject<boolean>
  loadingFonts: MutableRefObject<Set<string>>
  previewQueue: MutableRefObject<PreviewQueueEntry[]>
  queuedPreviewFontIds: MutableRefObject<Set<string>>
  activePreviewLoads: MutableRefObject<number>
  autoPreviewCacheQueue: MutableRefObject<FontItem[]>
  queuedAutoPreviewCacheIds: MutableRefObject<Set<string>>
  activeAutoPreviewCacheLoads: MutableRefObject<number>
  autoPreviewCacheRunId: MutableRefObject<number>
  autoPreviewCacheStats: MutableRefObject<AutoPreviewCacheStats>
  rendererUserActive: () => boolean
  isBadFontRecord: (font: FontItem) => boolean
  setPreviewFamilies: Dispatch<SetStateAction<Record<string, string>>>
  setFailedPreviewFontIds: Dispatch<SetStateAction<Record<string, true>>>
  setNativePreviewImages: Dispatch<SetStateAction<Record<string, string>>>
  setNativeDetailImage: Dispatch<SetStateAction<string>>
  setStatus: Dispatch<SetStateAction<string>>
  updateFont: (fontId: string, updater: (font: FontItem) => FontItem) => void
}

export type FontPreviewStateRuntime = {
  resetPreviewRuntimeState: () => void
  canRequestPreviewFont: (font: FontItem) => boolean
}

export type FontPreviewLoadRuntime = {
  ensurePreviewFont: (font: FontItem) => Promise<string>
  loadCachedNativeCardPreviews: (fonts: FontItem[]) => Promise<Set<string>>
}

export type FontVisiblePreviewQueueRuntime = {
  processPreviewQueue: () => void
  requestPreviewFont: (font: FontItem, priority?: 'normal' | 'high') => void
}

export type FontAutoPreviewCacheQueueRuntime = {
  startAutoPreviewCache: (fonts: FontItem[]) => Promise<void>
  processAutoPreviewCacheQueue: (runId?: number) => void
}

export type FontPreviewQueueRuntime = FontPreviewStateRuntime & FontPreviewLoadRuntime & FontVisiblePreviewQueueRuntime & FontAutoPreviewCacheQueueRuntime
