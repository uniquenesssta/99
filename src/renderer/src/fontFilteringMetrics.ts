import type { FontFormat,FontItem,FontMetricsResult,FontScript,LibraryState } from '@shared/types'
import { FONT_CATEGORY_LABELS,SCRIPT_LANGUAGE_LABELS,SCRIPT_LANGUAGE_ORDER } from './appConstants'
import type { ActiveFilter,FontCategory,FontComputedIndex,FontMetrics,TimeSortMode } from './appTypes'
import { fontScripts,inferFontCategory } from './fontClassification'
import { installLabel,isCleanWindowsDefaultFont,isInstalled,isInstallStatusKnown,isSystemBuiltinFont } from './fontDisplay'
import { fontCreatedAtMs,isTimeRangeMode,timeRangeStartMs } from './fontSort'
import { isDefinitelyBadFontRecord,normalizeFolderPathForCompare } from './libraryNormalize'
import { addLegacyCollectionCounts,createLegacyCollectionCounts,legacyCollectionMatchesFilter } from './runtime/legacy/legacyCollectionRuntime'

export function filterMatchesFont(filter: ActiveFilter, font: FontItem): boolean {
  if (filter.kind === 'all') return true
  if (filter.kind === 'favorites') return font.favorite
  if (filter.kind === 'installed') return isInstalled(font)
  if (filter.kind === 'notInstalled') return isInstallStatusKnown(font) && !isInstalled(font)
  if (filter.kind === 'active') return !!font.active
  if (filter.kind === 'systemBuiltin') return isSystemBuiltinFont(font)
  if (filter.kind === 'cleanSystem') return isCleanWindowsDefaultFont(font)
  if (filter.kind === 'format') return !!filter.id && font.format === filter.id
  if (filter.kind === 'script') return !!filter.id && fontScripts(font).includes(filter.id as FontScript)
  if (filter.kind === 'collection') return legacyCollectionMatchesFilter(filter, font)
  if (filter.kind === 'tag') return !!filter.name && !!font.localTagNames?.includes(filter.name)
  if (filter.kind === 'sharedTag') return !!filter.name && !!font.tagNames?.includes(filter.name)
  return true
}

export function buildFontComputedIndex(font: FontItem): FontComputedIndex {
  const scripts = fontScripts(font)
  const category = inferFontCategory(font)
  const systemBuiltin = isSystemBuiltinFont(font)
  const cleanSystem = isCleanWindowsDefaultFont(font)
  const installed = isInstalled(font)
  const installStatusKnown = isInstallStatusKnown(font)
  const scriptNames = scripts.map((script) => SCRIPT_LANGUAGE_LABELS[script] || script)
  const searchText = [
    font.family,
    font.fullName,
    font.postscriptName,
    font.style,
    font.fileName,
    font.path,
    installLabel(font),
    font.systemImported ? '系统字体' : '',
    systemBuiltin ? 'Windows Fonts' : '',
    cleanSystem ? 'Windows default clean install' : '',
    font.deleteProtected ? '保护 不可删除 删除保护' : '',
    font.format,
    font.format.toUpperCase(),
    ...scriptNames,
    ...scripts,
    FONT_CATEGORY_LABELS[category],
    category,
    ...(font.tagNames || []),
    ...(font.localTagNames || [])
  ].join(' ').toLowerCase()

  return {
    id: font.id,
    searchText,
    scripts,
    category,
    installed,
    installStatusKnown,
    systemBuiltin,
    cleanSystem,
    bad: isDefinitelyBadFontRecord(font),
    createdAtMs: fontCreatedAtMs(font),
    modifiedAtMs: typeof font.modifiedAt === 'number' && Number.isFinite(font.modifiedAt) ? font.modifiedAt : fontCreatedAtMs(font)
  }
}

export function filterMatchesFontIndex(filter: ActiveFilter, font: FontItem, index: FontComputedIndex): boolean {
  if (filter.kind === 'all') return true
  if (filter.kind === 'favorites') return font.favorite
  if (filter.kind === 'installed') return index.installed
  if (filter.kind === 'notInstalled') return index.installStatusKnown && !index.installed
  if (filter.kind === 'active') return !!font.active
  if (filter.kind === 'systemBuiltin') return index.systemBuiltin
  if (filter.kind === 'cleanSystem') return index.cleanSystem
  if (filter.kind === 'format') return !!filter.id && font.format === filter.id
  if (filter.kind === 'script') return !!filter.id && index.scripts.includes(filter.id as FontScript)
  if (filter.kind === 'collection') return legacyCollectionMatchesFilter(filter, font)
  if (filter.kind === 'tag') return !!filter.name && !!font.localTagNames?.includes(filter.name)
  if (filter.kind === 'sharedTag') return !!filter.name && !!font.tagNames?.includes(filter.name)
  return true
}

export function inTimeSortRangeIndex(index: FontComputedIndex, mode: TimeSortMode): boolean {
  if (!isTimeRangeMode(mode)) return true
  if (!index.modifiedAtMs) return false
  return index.modifiedAtMs >= timeRangeStartMs(mode)
}

export function fontDirectoryKey(filePath: string): string {
  const clean = normalizeFolderPathForCompare(filePath)
  const index = clean.lastIndexOf('\\')
  return index > -1 ? clean.slice(0, index) : clean
}

export function fontFolderAncestorKeys(filePath: string): string[] {
  const keys: string[] = []
  let current = fontDirectoryKey(filePath)

  while (current) {
    keys.push(current)
    const index = current.lastIndexOf('\\')
    if (index <= 2) break
    current = current.slice(0, index)
  }

  return keys
}

export function buildFontMetrics(fonts: FontItem[], indexById: Map<string, FontComputedIndex>, library: LibraryState): FontMetrics {
  const formatCounts: Record<FontFormat, number> = { ttf: 0, otf: 0, ttc: 0, otc: 0, unknown: 0 }
  const categoryCounts: Record<FontCategory, number> = {
    all: fonts.length,
    serif: 0,
    slabSerif: 0,
    sansSerif: 0,
    script: 0,
    monospace: 0,
    handwriting: 0,
    hei: 0,
    art: 0
  }
  const scriptCounts: Record<FontScript, number> = Object.fromEntries(
    SCRIPT_LANGUAGE_ORDER.map((script) => [script, 0])
  ) as Record<FontScript, number>
  const collectionCounts = createLegacyCollectionCounts(library)
  const localTagCounts: Record<string, number> = {}
  const sharedTagCounts: Record<string, number> = {}
  const folderCounts: Record<string, number> = {}
  const folderIdByKey = new Map<string, string>()

  for (const tag of library.localTags || []) localTagCounts[tag] = 0
  for (const tag of library.tags || []) sharedTagCounts[tag] = 0

  for (const folder of library.folders || []) {
    folderCounts[folder] = 0
    folderIdByKey.set(normalizeFolderPathForCompare(folder), folder)
  }

  for (const node of library.folderNodes || []) {
    folderCounts[node.id] = 0
    folderIdByKey.set(normalizeFolderPathForCompare(node.id), node.id)
  }

  let favoriteCount = 0
  let installedCount = 0
  let notInstalledCount = 0
  let activeCount = 0
  let systemDefaultCount = 0

  for (const font of fonts) {
    const index = indexById.get(font.id) || buildFontComputedIndex(font)

    if (font.favorite) favoriteCount += 1
    if (index.installStatusKnown && index.installed) installedCount += 1
    if (index.installStatusKnown && !index.installed) notInstalledCount += 1
    if (font.active) activeCount += 1
    if (index.cleanSystem) systemDefaultCount += 1

    formatCounts[font.format || 'unknown'] += 1
    categoryCounts[index.category] += 1

    for (const script of index.scripts) {
      scriptCounts[script] = (scriptCounts[script] || 0) + 1
    }

    addLegacyCollectionCounts(collectionCounts, font)

    for (const tag of font.localTagNames || []) {
      localTagCounts[tag] = (localTagCounts[tag] || 0) + 1
    }

    for (const tag of font.tagNames || []) {
      sharedTagCounts[tag] = (sharedTagCounts[tag] || 0) + 1
    }

    const countedFolders = new Set<string>()
    for (const key of fontFolderAncestorKeys(font.path)) {
      const folderId = folderIdByKey.get(key)
      if (!folderId || countedFolders.has(folderId)) continue
      folderCounts[folderId] = (folderCounts[folderId] || 0) + 1
      countedFolders.add(folderId)
    }

    for (const folderId of library.fontFolderIds?.[font.id] || []) {
      if (countedFolders.has(folderId) || !(folderId in folderCounts)) continue
      folderCounts[folderId] = (folderCounts[folderId] || 0) + 1
      countedFolders.add(folderId)
    }
  }

  return {
    total: fonts.length,
    favoriteCount,
    installedCount,
    notInstalledCount,
    installStatusKnownCount: installedCount + notInstalledCount,
    installStatusMissingCount: Math.max(0, fonts.length - installedCount - notInstalledCount),
    installStatusReady: fonts.length === installedCount + notInstalledCount,
    activeCount,
    systemDefaultCount,
    formatCounts,
    categoryCounts,
    scriptCounts,
    collectionCounts,
    tagCounts: { ...sharedTagCounts, ...localTagCounts },
    localTagCounts,
    sharedTagCounts,
    folderCounts
  }
}


export function normalizeFontMetricsResult(result: FontMetricsResult): FontMetrics {
  const scriptCounts: Record<FontScript, number> = Object.fromEntries(
    SCRIPT_LANGUAGE_ORDER.map((script) => [script, result.scriptCounts?.[script as FontScript] || 0])
  ) as Record<FontScript, number>

  return {
    total: result.total || 0,
    favoriteCount: result.favoriteCount || 0,
    installedCount: result.installedCount || 0,
    notInstalledCount: result.notInstalledCount || 0,
    installStatusKnownCount: result.installStatusKnownCount || 0,
    installStatusMissingCount: result.installStatusMissingCount || 0,
    installStatusReady: result.installStatusReady !== false,
    activeCount: result.activeCount || 0,
    systemDefaultCount: result.systemDefaultCount || 0,
    formatCounts: { ...(result.formatCounts || { ttf: 0, otf: 0, ttc: 0, otc: 0, unknown: 0 }) },
    categoryCounts: { ...(result.categoryCounts || { all: 0, serif: 0, slabSerif: 0, sansSerif: 0, script: 0, monospace: 0, handwriting: 0, hei: 0, art: 0 }) } as Record<FontCategory, number>,
    scriptCounts,
    collectionCounts: result.collectionCounts || {},
    tagCounts: result.tagCounts || {},
    localTagCounts: result.localTagCounts || result.tagCounts || {},
    sharedTagCounts: result.sharedTagCounts || result.tagCounts || {},
    folderCounts: result.folderCounts || {}
  }
}
