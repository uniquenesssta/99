import type { FontScanCacheEntry, FontScanCacheFile } from './rootIndexTypes'

type PersistedSharedFontMetadata = Pick<NonNullable<FontScanCacheEntry['font']>, 'tagNames' | 'favorite' | 'deleteProtected'>

export function mergeSharedFontMetadataFromExistingIndex(cache: FontScanCacheFile, existingEntries: FontScanCacheFile): { merged: number } {
  const metadataByRelativePath = new Map<string, PersistedSharedFontMetadata>()
  const metadataByFontId = new Map<string, PersistedSharedFontMetadata>()

  for (const [relativePath, entry] of Object.entries(existingEntries.entries || {})) {
    const font = entry.font
    if (!font) continue
    const metadata = {
      tagNames: Array.isArray(font.tagNames) ? [...font.tagNames] : [],
      favorite: !!font.favorite,
      deleteProtected: !!font.deleteProtected
    }
    metadataByRelativePath.set(relativePath, metadata)
    if (font.id) metadataByFontId.set(font.id, metadata)
  }

  let merged = 0
  for (const [relativePath, entry] of Object.entries(cache.entries || {})) {
    const font = entry.font
    if (!font) continue
    const metadata = metadataByRelativePath.get(relativePath) || metadataByFontId.get(font.id || '')
    if (!metadata) continue
    const nextFont = {
      ...font,
      tagNames: metadata.tagNames,
      favorite: metadata.favorite,
      deleteProtected: metadata.deleteProtected
    }
    cache.entries[relativePath] = { ...entry, font: nextFont }
    merged += 1
  }

  return { merged }
}
