import type { FontItem,InstallCompareResult,LibraryState } from '@shared/types'

export type FontActiveRuntimeUpdate = {
  active: boolean
  patch?: Partial<FontItem>
}

export function applyInstallCompareToFont(font: FontItem, result: InstallCompareResult): FontItem {
  return {
    ...font,
    installStatusKnown: true,
    systemInstalled: result.installed,
    systemInstallMatches: result.matches || []
  }
}

export function applyInstallCompareEntriesToLibrary(
  library: LibraryState,
  entries: Array<[string, InstallCompareResult]>,
  onKnownId?: (id: string) => void
): LibraryState {
  if (!entries.length) return library
  const nextFonts = { ...library.fonts }
  let changed = false
  for (const [id, compare] of entries) {
    const font = nextFonts[id]
    if (!font) continue
    onKnownId?.(id)
    nextFonts[id] = applyInstallCompareToFont(font, compare)
    changed = true
  }
  return changed ? { ...library, fonts: nextFonts } : library
}

export function applyFontActiveRuntimePatch(
  font: FontItem,
  active: boolean,
  patch: Partial<FontItem> = {},
  nowIso = new Date().toISOString()
): FontItem {
  return {
    ...font,
    ...patch,
    active,
    activeSince: active ? patch.activeSince || font.activeSince || nowIso : undefined,
    managedInstallPath: active ? patch.managedInstallPath || font.managedInstallPath : undefined,
    managedRegistryName: active ? patch.managedRegistryName || font.managedRegistryName : undefined
  }
}

export function applyFontActiveRuntimeUpdatesToLibrary(
  library: LibraryState,
  updates: Record<string, FontActiveRuntimeUpdate>,
  nowIso = new Date().toISOString()
): LibraryState {
  const entries = Object.entries(updates)
  if (!entries.length) return library
  const nextFonts = { ...library.fonts }
  let changed = false
  for (const [fontId, update] of entries) {
    const current = nextFonts[fontId]
    if (!current) continue
    nextFonts[fontId] = applyFontActiveRuntimePatch(current, update.active, update.patch || {}, nowIso)
    changed = true
  }
  return changed ? { ...library, fonts: nextFonts } : library
}
