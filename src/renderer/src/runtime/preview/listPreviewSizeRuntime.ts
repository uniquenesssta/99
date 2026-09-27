import { clampListPreviewFontSize,LIST_PREVIEW_FONT_SIZE_DEFAULT } from '@shared/preview-layout/previewTextFitRuntime'
export { clampListPreviewFontSize,listPreviewNativeImageHeight,listPreviewFontSizeRowHeightPadding,LIST_PREVIEW_FONT_SIZE_MIN,LIST_PREVIEW_FONT_SIZE_MAX,LIST_PREVIEW_FONT_SIZE_DEFAULT } from '@shared/preview-layout/previewTextFitRuntime'

export const LIST_PREVIEW_FONT_SIZE_STORAGE_KEY = 'hfm.listPreviewFontSize'

export function readStoredListPreviewFontSize(storage: Storage | undefined = typeof window !== 'undefined' ? window.localStorage : undefined): number {
  if (!storage) return LIST_PREVIEW_FONT_SIZE_DEFAULT
  return clampListPreviewFontSize(storage.getItem(LIST_PREVIEW_FONT_SIZE_STORAGE_KEY))
}

export function writeStoredListPreviewFontSize(value: number, storage: Storage | undefined = typeof window !== 'undefined' ? window.localStorage : undefined): void {
  if (!storage) return
  storage.setItem(LIST_PREVIEW_FONT_SIZE_STORAGE_KEY, String(clampListPreviewFontSize(value)))
}
