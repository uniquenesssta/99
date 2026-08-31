import type { FontIndexChangePayload, FontItem, LibraryState } from '@shared/types'

export function isEarlyVisibleOnlyFontIndexChangePayload(payload: FontIndexChangePayload): boolean {
  const upserts = payload.upserts || []
  return payload.source === 'scan-stream' &&
    upserts.length > 0 &&
    !(payload.deletes || []).length &&
    upserts.every((font) => !!font.__earlyVisible)
}

function mergeEarlyVisibleFont(oldFont: FontItem | undefined, nextFont: FontItem): FontItem | null {
  if (oldFont && !oldFont.__earlyVisible) {
    return null
  }

  if (!oldFont) {
    return nextFont
  }

  return {
    ...oldFont,
    ...nextFont,
    favorite: oldFont.favorite || nextFont.favorite,
    collectionIds: oldFont.collectionIds || [],
    tagNames: oldFont.tagNames || [],
    localTagNames: oldFont.localTagNames || [],
    systemInstalled: oldFont.systemInstalled || nextFont.systemInstalled,
    systemInstallMatches: oldFont.systemInstallMatches || nextFont.systemInstallMatches || [],
    active: oldFont.active || nextFont.active,
    activeSince: oldFont.activeSince || nextFont.activeSince,
    managedInstallPath: oldFont.managedInstallPath || nextFont.managedInstallPath,
    managedRegistryName: oldFont.managedRegistryName || nextFont.managedRegistryName,
    deleteProtected: oldFont.deleteProtected || nextFont.deleteProtected,
    previewDisabled: oldFont.previewDisabled || nextFont.previewDisabled,
    previewError: oldFont.previewError || nextFont.previewError,
    __earlyVisible: true
  }
}

export function applyEarlyVisibleFontIndexChangeToLibrary(
  state: LibraryState,
  payload: FontIndexChangePayload
): { library: LibraryState; removedIds: string[]; upsertedFonts: FontItem[] } {
  const nextFonts = { ...(state.fonts || {}) }
  const upsertedFonts: FontItem[] = []

  for (const font of payload.upserts || []) {
    if (!font?.id) continue
    const merged = mergeEarlyVisibleFont(nextFonts[font.id], font)
    if (!merged) continue
    nextFonts[merged.id] = merged
    upsertedFonts.push(merged)
  }

  if (!upsertedFonts.length) {
    return { library: state, removedIds: [], upsertedFonts: [] }
  }

  return {
    library: {
      ...state,
      fonts: nextFonts
    },
    removedIds: [],
    upsertedFonts
  }
}
