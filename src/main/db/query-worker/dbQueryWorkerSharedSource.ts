export function buildDbQueryWorkerSharedSource(): string {
  return String.raw`
const { parentPort } = require('node:worker_threads')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const betterSqlite3ModulePath = process.env.HFM_BETTER_SQLITE3_MODULE || 'better-sqlite3'
const Database = require(betterSqlite3ModulePath)

function nowMs() { return Date.now() }
function sha1(input) { return crypto.createHash('sha1').update(String(input)).digest('hex') }
function fileCacheSignature(cacheIdentity, size, mtimeMs) { return String(cacheIdentity || '').toLowerCase() + '|' + Number(size || 0) + '|' + Math.round(Number(mtimeMs || 0)) }
function sharedFontId(cacheIdentity, size, mtimeMs) { return sha1(fileCacheSignature(cacheIdentity, size, mtimeMs)) }
function normalizePathText(value) {
  let clean = String(value || '').trim().replaceAll('/', '\\')
  clean = clean.replace(/^\\\\\?\\UNC\\/i, '\\\\')
  clean = clean.replace(/^\\\\\?\\/i, '')
  if (/^[a-zA-Z]:\\?$/.test(clean)) return clean.slice(0, 2) + '\\'
  return clean.replace(/\\+$/g, '')
}
function normalizePathForCompare(value) {
  return normalizePathText(value).toLowerCase()
}
function sqliteLiteral(value) { return "'" + String(value || '').replace(/'/g, "''") + "'" }
function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try { return JSON.parse(String(value)) } catch { return fallback }
}
function isAbs(input) {
  const value = String(input || '')
  return path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
}
function runtimePath(rootPath, entryPath) {
  const clean = String(entryPath || '').replaceAll('\\', '/')
  if (isAbs(entryPath)) return entryPath
  return path.join(rootPath, ...clean.split('/').filter(Boolean))
}
function normalizeFontFormat(value) {
  const raw = String(value || '').toLowerCase()
  if (raw === 'ttf' || raw.includes('truetype')) return 'ttf'
  if (raw === 'otf' || raw.includes('opentype')) return 'otf'
  if (raw === 'ttc') return 'ttc'
  if (raw === 'otc') return 'otc'
  return 'unknown'
}
function fontSearchCategoryText(font) {
  return [
    font && font.fileName,
    font && font.path,
    font && font.family,
    font && font.fullName,
    font && font.postscriptName,
    font && font.style,
    ...((font && Array.isArray(font.tagNames)) ? font.tagNames : [])
  ].join(' ').toLowerCase()
}
function inferFontSearchCategory(font) {
  const text = fontSearchCategoryText(font)
  const rules = [
    ['monospace', /(mono|monospace|code|console|consola|courier|等宽|等寬)/i],
    ['handwriting', /(handwriting|handwritten|marker|brush|calligraphy|手写|手寫|马克笔|麥克筆)/i],
    ['script', /(script|cursive|sign|signature|swash|草书|草書|行书|行書|连笔|連筆)/i],
    ['slabSerif', /(slab|egyptian|rockwell|clarendon|粗衬线|粗襯線)/i],
    ['hei', /(黑体|黑體|雅黑|heiti|hei|gothic|sans cjk|source han sans|noto sans cjk|思源黑|苹方|蘋方)/i],
    ['serif', /(serif|song|sung|mincho|ming|宋体|宋體|明体|明體|明朝|思源宋|source han serif|noto serif cjk|times|georgia)/i],
    ['art', /(display|decorative|poster|headline|banner|art|pop|title|装饰|裝飾|海报|海報|标题|標題|综艺|綜藝)/i],
    ['sansSerif', /(sans|gothic|ui|arial|helvetica|calibri|verdana|tahoma|无衬线|無襯線)/i]
  ]
  for (const [category, pattern] of rules) if (pattern.test(text)) return category
  return 'sansSerif'
}
function defaultFontMetricsResult() {
  return {
    total: 0,
    favoriteCount: 0,
    installedCount: 0,
    notInstalledCount: 0,
    installStatusKnownCount: 0,
    installStatusMissingCount: 0,
    installStatusReady: true,
    activeCount: 0,
    systemDefaultCount: 0,
    formatCounts: { ttf: 0, otf: 0, ttc: 0, otc: 0, unknown: 0 },
    categoryCounts: { all: 0, serif: 0, slabSerif: 0, sansSerif: 0, script: 0, monospace: 0, handwriting: 0, hei: 0, art: 0 },
    scriptCounts: {},
    collectionCounts: {},
    tagCounts: {},
    localTagCounts: {},
    sharedTagCounts: {},
    folderCounts: {},
    elapsedMs: 0
  }
}
function fontDirectoryKeyForMetrics(filePath) {
  const clean = normalizePathForCompare(filePath || '')
  const index = clean.lastIndexOf('\\')
  return index > -1 ? clean.slice(0, index) : clean
}
function fontFolderAncestorKeysForMetrics(filePath) {
  const keys = []
  let current = fontDirectoryKeyForMetrics(filePath)
  while (current) {
    keys.push(current)
    const index = current.lastIndexOf('\\')
    if (index <= 2) break
    current = current.slice(0, index)
  }
  return keys
}
function pathMatchesPrefixes(filePath, folders) {
  const normalized = normalizePathForCompare(filePath || '')
  return (folders || []).some((folder) => {
    const prefix = normalizePathForCompare(folder || '')
    return normalized === prefix || normalized.startsWith(prefix + '\\')
  })
}
function fontFromMergedRow(row) {
  const source = parseJson(row.font_json, null)
  if (!source || String(row.status || '') !== 'ok') return null
  const filePath = runtimePath(row.root_path || '', row.relative_path || '')
  const size = Number(row.file_size || 0)
  const modifiedAt = Number(row.modified_at || 0)
  const createdAt = row.created_at === null || row.created_at === undefined ? modifiedAt : Number(row.created_at)
  const installedBy = String(row.installed_by || 'none')
  const sourceId = String(source.id || '')
  const font = Object.assign({}, source, {
    id: sharedFontId(row.relative_path || source.path || filePath, size, modifiedAt),
    sourceId,
    path: filePath,
    fileName: path.basename(filePath),
    fileSize: size,
    modifiedAt,
    createdAt,
    installStatusKnown: false,
    active: !!source.active || installedBy === 'managed' || installedBy === 'both',
    activeSince: source.activeSince
  })
  if (row.installed !== null && row.installed !== undefined) {
    font.installStatusKnown = true
    font.systemInstalled = !!row.installed && installedBy !== 'managed'
    font.systemInstallMatches = parseJson(row.matches_json, [])
  }
  return font
}
function tableColumns(db, tableName) {
  try { return new Set(db.prepare('PRAGMA table_info(' + tableName + ')').all().map((column) => column.name)) } catch { return new Set() }
}
function tableHasColumns(db, tableName, columns) {
  const existing = tableColumns(db, tableName)
  return columns.every((column) => existing.has(column))
}
function mergedIndexRequiredSchemaUsable(db) {
  try {
    return tableHasColumns(db, 'sources', ['root_path', 'index_db_path', 'install_db_path', 'index_signature', 'install_signature', 'synced_at'])
      && tableHasColumns(db, 'entries', ['root_path', 'relative_path', 'cache_key', 'file_size', 'modified_at', 'created_at', 'status', 'font_json', 'message', 'cached_at', 'is_deleted', 'installed', 'installed_by', 'matches_json', 'category_index', 'search_text'])
  } catch { return false }
}
function rootsSnapshotUsable(db, roots, schemaVersion) {
  try {
    const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion' LIMIT 1").get()
    if (String(metaRow && metaRow.value || '') !== String(schemaVersion)) return false
    if (!mergedIndexRequiredSchemaUsable(db)) return false
    const sourceRows = db.prepare('SELECT root_path FROM sources ORDER BY root_path').all()
    const expected = Array.from(new Set((roots || []).map(normalizePathForCompare).filter(Boolean))).sort()
    const actual = Array.from(new Set(sourceRows.map((row) => normalizePathForCompare(row.root_path || '')).filter(Boolean))).sort()
    if (expected.length !== actual.length) return false
    for (let i = 0; i < expected.length; i += 1) if (expected[i] !== actual[i]) return false
    return true
  } catch {
    return false
  }
}
function normalizeLocalTagFontPath(value) {
  return normalizePathForCompare(value)
}
function localDbTableColumns(db, tableName) {
  try { return new Set(db.prepare('PRAGMA local_db.table_info(' + tableName + ')').all().map((column) => column.name)) } catch { return new Set() }
}
function hydrateLocalTags(db, items) {
  if (!items.length) return items.map((item) => Object.assign({}, item, { localTagNames: Array.isArray(item.localTagNames) ? item.localTagNames : [] }))
  const aliasToRuntimeId = Object.create(null)
  const pathToRuntimeId = Object.create(null)
  const ids = []
  const paths = []
  for (const item of items) {
    if (!item || !item.id) continue
    const runtimeId = String(item.id)
    for (const raw of [item.id, item.sourceId]) {
      const id = String(raw || '').trim()
      if (!id) continue
      if (!aliasToRuntimeId[id]) ids.push(id)
      aliasToRuntimeId[id] = runtimeId
    }
    const fontPath = normalizeLocalTagFontPath(item.path)
    if (fontPath) {
      if (!pathToRuntimeId[fontPath]) paths.push(fontPath)
      pathToRuntimeId[fontPath] = runtimeId
    }
  }
  const tagMap = Object.create(null)
  function addTag(runtimeId, tagName) {
    if (!runtimeId || !tagName) return
    if (!tagMap[runtimeId]) tagMap[runtimeId] = []
    if (!tagMap[runtimeId].includes(tagName)) tagMap[runtimeId].push(tagName)
  }
  const chunkSize = 500
  const localTagColumns = localDbTableColumns(db, 'local_font_tags')
  if (!localTagColumns.has('font_id') || !localTagColumns.has('tag_name')) {
    return items.map((item) => Object.assign({}, item, { localTagNames: Array.isArray(item.localTagNames) ? item.localTagNames : [] }))
  }
  for (let index = 0; index < ids.length; index += chunkSize) {
    const chunk = ids.slice(index, index + chunkSize)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = db.prepare('SELECT font_id, tag_name FROM local_db.local_font_tags WHERE font_id IN (' + placeholders + ') ORDER BY tag_name').all(...chunk)
    for (const row of rows) addTag(aliasToRuntimeId[row.font_id] || row.font_id, row.tag_name)
  }
  if (localTagColumns.has('font_path')) {
    for (let index = 0; index < paths.length; index += chunkSize) {
      const chunk = paths.slice(index, index + chunkSize)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = db.prepare('SELECT font_path, tag_name FROM local_db.local_font_tags WHERE font_path IN (' + placeholders + ') ORDER BY tag_name').all(...chunk)
      for (const row of rows) addTag(pathToRuntimeId[row.font_path] || '', row.tag_name)
    }
  }
  return items.map((item) => Object.assign({}, item, { localTagNames: tagMap[item.id] || [] }))
}
function hasSqliteJson(db) {
  try {
    const row = db.prepare("SELECT json_extract('{\"a\":1}', '$.a') AS value").get()
    return Number(row && row.value || 0) === 1
  } catch { return false }
}
`;
}
