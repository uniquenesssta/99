import type { FontItem,FontQueryRequest,FontScript } from '../../shared/types'
import { legacyCollectionIdsForFont } from './legacy/legacyCollectionSearchRuntime'
import { sanitizeStringArray,timeRangeStartForSql } from './fontQuerySqlRuntime'
import { normalizeFontFormat } from './fontSqliteMapper'
import type { FontMemoryQueryRuntimeOptions } from './fontMemoryQueryTypes'

function fontTextForQuery(font: FontItem): string {
  return [
    font.fileName,
    font.family,
    font.fullName,
    font.postscriptName,
    font.style,
    font.format,
    font.path,
    ...(Array.isArray(font.scripts) ? font.scripts : []),
    ...(Array.isArray(font.tagNames) ? font.tagNames : []),
    ...(Array.isArray(font.localTagNames) ? font.localTagNames : []),
    ...legacyCollectionIdsForFont(font),
  ]
    .join(' ')
    .toLowerCase()
}

export function createFontMemoryQueryMatcher(options: FontMemoryQueryRuntimeOptions) {
  function sharedFontIsSystemDefault(font: FontItem): boolean {
    const matches = font.systemInstallMatches || []
    return (
      matches.some((record) => options.isSystemInstalledRecord(record)) ||
      font.systemImported ||
      options.isPathInWindowsFonts(font.path)
    )
  }

  function sharedFontMatchesPathPrefixes(
    font: FontItem,
    folders: string[],
  ): boolean {
    const cleanFolders = sanitizeStringArray(folders)
      .map((folder) => options.normalizePathForCacheCompare(folder))
      .filter(Boolean)
    if (!cleanFolders.length) return true
    const cleanPath = options.normalizePathForCacheCompare(font.path)
    return cleanFolders.some(
      (folder) => cleanPath === folder || cleanPath.startsWith(`${folder}\\`),
    )
  }

  function sharedFontMatchesRequest(
    font: FontItem,
    request: FontQueryRequest,
  ): boolean {
    const keyword = String(request.keyword || '')
      .trim()
      .toLowerCase()
    if (keyword && !fontTextForQuery(font).includes(keyword)) return false

    const start = timeRangeStartForSql(String(request.timeSortMode || ''))
    if (
      start &&
      Math.max(Number(font.modifiedAt || 0), Number(font.createdAt || 0)) < start
    )
      return false

    const sidebarPage = request.sidebarPage || 'library'
    if (sidebarPage === 'library') {
      const activeFilter = request.activeFilter || { kind: 'all' }
      switch (activeFilter.kind) {
        case 'favorites':
          if (!font.favorite) return false
          break
        case 'installed':
          if (!font.systemInstalled) return false
          break
        case 'notInstalled':
          if (!font.installStatusKnown || font.systemInstalled) return false
          break
        case 'active':
          if (!font.active) return false
          break
        case 'systemBuiltin':
        case 'cleanSystem':
          if (!sharedFontIsSystemDefault(font)) return false
          break
        case 'format':
          if (
            activeFilter.id &&
            normalizeFontFormat(font.format) !== activeFilter.id
          )
            return false
          break
        case 'script':
          if (
            activeFilter.id &&
            !(font.scripts || []).includes(activeFilter.id as FontScript)
          )
            return false
          break
        case 'collection':
          if (
            activeFilter.id &&
            !legacyCollectionIdsForFont(font).includes(activeFilter.id)
          )
            return false
          break
        case 'tag':
          if (
            activeFilter.name &&
            !(font.localTagNames || []).includes(activeFilter.name)
          )
            return false
          break
        case 'sharedTag':
          if (
            activeFilter.name &&
            !(font.tagNames || []).includes(activeFilter.name)
          )
            return false
          break
      }
    }

    if (sidebarPage !== 'library') {
      if (request.installStatus === 'installed' && !font.systemInstalled)
        return false
      if (
        request.installStatus === 'notInstalled' &&
        (!font.installStatusKnown || font.systemInstalled)
      )
        return false
    }
    if (sidebarPage === 'filters') {
      if (
        !sharedFontMatchesPathPrefixes(
          font,
          sanitizeStringArray(request.selectedWatchedFolders),
        )
      )
        return false
      const formats = sanitizeStringArray(request.selectedFormats)
      if (formats.length && !formats.includes(normalizeFontFormat(font.format)))
        return false
      const scripts = sanitizeStringArray(request.selectedScripts)
      if (
        scripts.length &&
        !(font.scripts || []).some((script) => scripts.includes(script))
      )
        return false
      const category = String(request.selectedCategory || 'all')
      if (category !== 'all' && options.inferFontSearchCategory(font) !== category)
        return false
    }
    if (sidebarPage === 'tags') {
      const tagName = String(request.selectedTagName || '').trim()
      if (tagName) {
        if (!(font.localTagNames || []).includes(tagName)) return false
      } else if (!(font.localTagNames || []).length) return false
    }
    if (sidebarPage === 'sharedTags') {
      const tagName = String(request.selectedTagName || '').trim()
      if (tagName) {
        if (!(font.tagNames || []).includes(tagName)) return false
      } else if (!(font.tagNames || []).length) return false
    }
    if (sidebarPage === 'folders') {
      const folderId = String(request.selectedFolderId || '').trim()
      if (folderId && !sharedFontMatchesPathPrefixes(font, [folderId]))
        return false
    }
    return true
  }

  return { sharedFontMatchesPathPrefixes, sharedFontMatchesRequest }
}
