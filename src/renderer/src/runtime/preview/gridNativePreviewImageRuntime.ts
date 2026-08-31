export const GRID_NATIVE_PREVIEW_IMAGE_CLASS = 'grid-native-preview-image'
export const GRID_NATIVE_PREVIEW_IMAGE_CLIP_SAFE_CLASS = 'grid-native-preview-image-clip-safe'

export function isGridNativePreviewImage(value?: string): boolean {
  const source = value || ''
  return !!source && !source.startsWith('data:image/svg+xml')
}

export function gridNativePreviewImageClassName(value?: string): string {
  return isGridNativePreviewImage(value)
    ? `font-sample-image ${GRID_NATIVE_PREVIEW_IMAGE_CLASS} ${GRID_NATIVE_PREVIEW_IMAGE_CLIP_SAFE_CLASS}`
    : 'font-sample-image'
}
