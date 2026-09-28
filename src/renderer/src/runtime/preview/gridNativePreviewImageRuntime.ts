export function isGridNativePreviewImage(value?: string): boolean {
  return !!value && value.startsWith('data:image/png')
}
