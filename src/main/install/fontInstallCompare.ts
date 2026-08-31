import { extname,parse,resolve } from 'node:path'
import type { FontItem,InstallCompareResult,SystemInstalledFont } from '../../shared/types'
import { normalizePathForCacheCompare } from '../path/cachePath'
import { DEFAULT_WINDOWS_CLEAN_FONT_FILES,cleanFontFileName } from './windowsDefaultFonts'

export interface PreparedInstalledFontRecord {
  record: SystemInstalledFont
  normalizedPath: string
  fileName: string
  managedFileName: string
  normalizedRegistryName: string
  nameCandidates: string[]
  temporaryActive: boolean
  system: boolean
}

export interface InstalledFontLookupIndex {
  records: PreparedInstalledFontRecord[]
  pathMap: Map<string, PreparedInstalledFontRecord[]>
  fileMap: Map<string, PreparedInstalledFontRecord[]>
  registryMap: Map<string, PreparedInstalledFontRecord[]>
  candidateMap: Map<string, PreparedInstalledFontRecord[]>
}

export interface InstallCompareRuntimeOptions {
  appName: string
}

export function createInstallCompareRuntime(options: InstallCompareRuntimeOptions) {
  const appName = options.appName || '字体管理器'

  function safeManagedFontName(item: FontItem): string {
    const cleanStem = parse(item.fileName).name.replace(/[^\w\u4e00-\u9fa5 -]/g, '').trim().slice(0, 80) || 'font'
    return `${appName}_${item.id.slice(0, 12)}_${cleanStem}${extname(item.fileName).toLowerCase()}`
  }

  function registryNameFor(item: FontItem): string {
    const ext = extname(item.fileName).toLowerCase()
    const type = ext === '.otf' || ext === '.otc' ? 'OpenType' : 'TrueType'
    return `${item.fullName || item.family || parse(item.fileName).name} (${type})`
  }

  function safeTemporaryActiveFontName(item: FontItem): string {
    const ext = extname(item.fileName).toLowerCase() || '.ttf'
    const cleanStem = parse(item.fileName).name
      .replace(/[^\w\u4e00-\u9fa5 -]/g, '')
      .trim()
      .slice(0, 64) || 'font'
    return `${appName}_ACTIVE_${item.id.slice(0, 12)}_${Date.now().toString(36)}_${cleanStem}${ext}`
  }

  function temporaryActiveRegistryNameFor(item: FontItem): string {
    const ext = extname(item.fileName).toLowerCase()
    const type = ext === '.otf' || ext === '.otc' ? 'OpenType' : 'TrueType'
    const name = item.fullName || item.family || parse(item.fileName).name
    return `${name} (${type})`
  }

  function normalizeCompareText(input: string): string {
    return input
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/\(truetype\)|\(opentype\)|truetype|opentype|regular|bold|italic|字体|常规|粗体|斜体/gi, '')
      .replace(/[^\p{L}\p{N}\u4e00-\u9fa5]+/gu, '')
  }

  function isUsableInstalledNameCandidate(value: string): boolean {
    if (!value) return false
    if (value.length >= 6) return true
    return value.length >= 2 && /[\u4e00-\u9fa5]/.test(value)
  }

  function normalizeInstalledPath(value?: string): string {
    if (!value) return ''
    try {
      return normalizePathForCacheCompare(resolve(value.replace(/^"|"$/g, '')))
    } catch {
      return value.replace(/^"|"$/g, '').replaceAll('/', '\\').toLowerCase()
    }
  }

  function isTemporaryActiveInstalledRecord(record: SystemInstalledFont): boolean {
    const fileName = cleanFontFileName(record.fileName || record.path || record.value)
    const registryName = (record.registryName || '').toLowerCase()
    return fileName.startsWith(`${appName.toLowerCase()}_active_`) || registryName.startsWith(`${appName.toLowerCase()} active `)
  }

  function installedRecordMatchesManagedItem(item: FontItem, record: SystemInstalledFont): boolean {
    const managedPath = normalizeInstalledPath(item.managedInstallPath)
    const recordPath = normalizeInstalledPath(record.path || record.value)
    const recordFile = cleanFontFileName(record.fileName || record.path || record.value)
    const managedFile = cleanFontFileName(item.managedInstallPath || safeManagedFontName(item))

    if (managedPath && recordPath && managedPath === recordPath) return true
    return !!managedFile && recordFile === managedFile
  }

  function compareNameCandidatesForFont(item: FontItem): string[] {
    const values = [
      item.fileName,
      parse(item.fileName || '').name,
      item.family,
      item.fullName,
      item.postscriptName,
      registryNameFor(item)
    ]

    return Array.from(new Set(
      values
        .map((value) => normalizeCompareText(String(value || '')))
        .filter(isUsableInstalledNameCandidate)
    ))
  }

  function compareNameCandidatesForInstalledRecord(record: SystemInstalledFont): string[] {
    const fileName = cleanFontFileName(record.fileName || record.path || record.value)
    const values = [
      fileName,
      parse(fileName || '').name,
      record.registryName,
      record.value,
      ...(record.nameCandidates || [])
    ]

    return Array.from(new Set(
      values
        .map((value) => normalizeCompareText(String(value || '')))
        .filter(isUsableInstalledNameCandidate)
    ))
  }

  function addPreparedInstalledRecord(map: Map<string, PreparedInstalledFontRecord[]>, key: string, record: PreparedInstalledFontRecord): void {
    if (!key) return
    const rows = map.get(key)
    if (rows) rows.push(record)
    else map.set(key, [record])
  }

  function isPathInWindowsFonts(value?: string): boolean {
    const clean = normalizeInstalledPath(value || '')
    return clean.includes('\\windows\\fonts\\')
  }

  function isSystemInstalledRecord(record: SystemInstalledFont): boolean {
    return record.source === 'HKLM' || record.source === 'WindowsFontsFolder' || isPathInWindowsFonts(record.path || record.value)
  }

  function buildInstalledFontLookupIndex(installed: SystemInstalledFont[]): InstalledFontLookupIndex {
    const lookup: InstalledFontLookupIndex = {
      records: [],
      pathMap: new Map(),
      fileMap: new Map(),
      registryMap: new Map(),
      candidateMap: new Map()
    }

    for (const record of installed || []) {
      const fileName = cleanFontFileName(record.fileName || record.path || record.value)
      const prepared: PreparedInstalledFontRecord = {
        record,
        normalizedPath: normalizeInstalledPath(record.path || record.value),
        fileName,
        managedFileName: fileName,
        normalizedRegistryName: normalizeCompareText(record.registryName || ''),
        nameCandidates: compareNameCandidatesForInstalledRecord(record),
        temporaryActive: isTemporaryActiveInstalledRecord(record),
        system: isSystemInstalledRecord(record)
      }

      lookup.records.push(prepared)
      addPreparedInstalledRecord(lookup.pathMap, prepared.normalizedPath, prepared)
      addPreparedInstalledRecord(lookup.fileMap, prepared.fileName, prepared)
      addPreparedInstalledRecord(lookup.registryMap, prepared.normalizedRegistryName, prepared)
      if (prepared.normalizedRegistryName) {
        for (const candidate of prepared.nameCandidates) addPreparedInstalledRecord(lookup.candidateMap, candidate, prepared)
      }
    }

    return lookup
  }

  function compareFontInstalledWithLookupIndex(item: FontItem, lookup: InstalledFontLookupIndex): InstallCompareResult {
    const seen = new Set<SystemInstalledFont>()
    const matches: SystemInstalledFont[] = []

    const addMatches = (rows: PreparedInstalledFontRecord[] | undefined, predicate?: (row: PreparedInstalledFontRecord) => boolean): void => {
      for (const row of rows || []) {
        if (row.temporaryActive) continue
        if (predicate && !predicate(row)) continue
        if (seen.has(row.record)) continue
        seen.add(row.record)
        matches.push(row.record)
      }
    }

    const itemPath = normalizeInstalledPath(item.path)
    const managedPath = normalizeInstalledPath(item.managedInstallPath)
    const itemFile = cleanFontFileName(item.fileName || item.path)
    const managedFile = cleanFontFileName(item.managedInstallPath || safeManagedFontName(item))
    const expectedRegistryName = normalizeCompareText(registryNameFor(item))

    addMatches(lookup.pathMap.get(itemPath))
    addMatches(lookup.pathMap.get(managedPath), (row) => installedRecordMatchesManagedItem(item, row.record))
    addMatches(lookup.fileMap.get(managedFile), (row) => installedRecordMatchesManagedItem(item, row.record))
    addMatches(lookup.fileMap.get(itemFile))
    addMatches(lookup.registryMap.get(expectedRegistryName))

    for (const candidate of compareNameCandidatesForFont(item)) {
      addMatches(lookup.candidateMap.get(candidate))
    }

    const managed = matches.some((installedFont) => installedRecordMatchesManagedItem(item, installedFont))
    const system = matches.some((installedFont) => isSystemInstalledRecord(installedFont))
    const user = matches.some((installedFont) => !installedRecordMatchesManagedItem(item, installedFont) && !isSystemInstalledRecord(installedFont))

    return {
      installed: managed || system || user,
      by: managed && system ? 'both' : managed ? 'managed' : system ? 'system' : user ? 'user' : 'none',
      matches
    }
  }

  function installedRecordFileNames(record: SystemInstalledFont): string[] {
    const names = [record.fileName, record.path, record.value]
      .map((value) => cleanFontFileName(value || ''))
      .filter(Boolean)
    return Array.from(new Set(names))
  }

  function isDefaultWindowsCleanRecord(record: SystemInstalledFont): boolean {
    if (!isSystemInstalledRecord(record)) return false
    return installedRecordFileNames(record).some((name) => DEFAULT_WINDOWS_CLEAN_FONT_FILES.has(name))
  }

  function isCleanWindowsDefaultCompareResult(item: FontItem, result: InstallCompareResult): boolean {
    if (!result.installed) return false
    return result.matches.some((record) => isSystemInstalledRecord(record)) || item.systemImported || isPathInWindowsFonts(item.path)
  }

  function installedRecordMatchesFontStrictly(item: FontItem, record: SystemInstalledFont): boolean {
    if (isTemporaryActiveInstalledRecord(record)) return false

    const itemPath = normalizeInstalledPath(item.path)
    const recordPath = normalizeInstalledPath(record.path || record.value)
    if (itemPath && recordPath && itemPath === recordPath) return true

    if (installedRecordMatchesManagedItem(item, record)) return true

    const itemFile = cleanFontFileName(item.fileName || item.path)
    const recordFile = cleanFontFileName(record.fileName || record.path || record.value)
    const expectedRegistryName = normalizeCompareText(registryNameFor(item))
    const recordRegistryName = normalizeCompareText(record.registryName || '')

    if (itemFile && recordFile && itemFile === recordFile) return true
    if (expectedRegistryName && recordRegistryName && expectedRegistryName === recordRegistryName) return true

    if (recordRegistryName) {
      const recordCandidates = new Set(compareNameCandidatesForInstalledRecord(record))
      const fontCandidates = compareNameCandidatesForFont(item)
      if (fontCandidates.some((candidate) => recordCandidates.has(candidate))) return true
    }

    return false
  }

  function compareFontInstalledWithList(item: FontItem, installed: SystemInstalledFont[]): InstallCompareResult {
    const matches = installed.filter((installedFont) => installedRecordMatchesFontStrictly(item, installedFont))
    const managed = matches.some((installedFont) => installedRecordMatchesManagedItem(item, installedFont))
    const system = matches.some((installedFont) => isSystemInstalledRecord(installedFont))
    const user = matches.some((installedFont) => !installedRecordMatchesManagedItem(item, installedFont) && !isSystemInstalledRecord(installedFont))

    return {
      installed: managed || system || user,
      by: managed && system ? 'both' : managed ? 'managed' : system ? 'system' : user ? 'user' : 'none',
      matches
    }
  }

  function applyCompare(item: FontItem, result: InstallCompareResult): FontItem {
    return {
      ...item,
      systemInstalled: result.installed,
      systemInstallMatches: result.matches
    }
  }

  return {
    safeManagedFontName,
    registryNameFor,
    safeTemporaryActiveFontName,
    temporaryActiveRegistryNameFor,
    normalizeCompareText,
    isUsableInstalledNameCandidate,
    normalizeInstalledPath,
    isTemporaryActiveInstalledRecord,
    installedRecordMatchesManagedItem,
    compareNameCandidatesForFont,
    compareNameCandidatesForInstalledRecord,
    buildInstalledFontLookupIndex,
    compareFontInstalledWithLookupIndex,
    isPathInWindowsFonts,
    isSystemInstalledRecord,
    installedRecordFileNames,
    isDefaultWindowsCleanRecord,
    isCleanWindowsDefaultCompareResult,
    installedRecordMatchesFontStrictly,
    compareFontInstalledWithList,
    applyCompare
  }
}
