export function buildDbQueryWorkerMetricsSource(): string {
  return String.raw`
function readLibraryShell(db) {
  const stateRows = db.prepare('SELECT key, value FROM local_db.app_state').all()
  const appState = Object.create(null)
  for (const row of stateRows) appState[row.key] = row.value
  const folders = db.prepare('SELECT path FROM local_db.folders ORDER BY sort_order').all().map((row) => path.resolve(row.path))
  const folderNodes = db.prepare('SELECT json FROM local_db.folder_nodes ORDER BY sort_order').all().map((row) => parseJson(row.json, {}))
  const collections = db.prepare('SELECT json FROM local_db.collections ORDER BY sort_order').all().map((row) => parseJson(row.json, {}))
  const tags = db.prepare('SELECT name FROM local_db.tags ORDER BY sort_order').all().map((row) => row.name)
  return {
    folders,
    folderNodes,
    collections,
    tags,
    localTags: parseJson(appState.localTags, []),
    previewText: appState.previewText || '字体预览 AaBb 123',
    previewMode: appState.previewMode || 'waterfall'
  }
}
function localDbTableColumns(db, tableName) {
  try { return new Set(db.prepare('PRAGMA local_db.table_info(' + tableName + ')').all().map((column) => column.name)) } catch { return new Set() }
}
function localTagCounts(db) {
  const result = Object.create(null)
  try {
    const columns = localDbTableColumns(db, 'local_font_tags')
    if (!columns.has('tag_name') || !columns.has('font_id')) return result
    const sql = columns.has('font_path')
      ? "SELECT tag_name, COUNT(DISTINCT COALESCE(NULLIF(font_path, ''), font_id)) AS count FROM local_db.local_font_tags GROUP BY tag_name"
      : "SELECT tag_name, COUNT(DISTINCT font_id) AS count FROM local_db.local_font_tags GROUP BY tag_name"
    const rows = db.prepare(sql).all()
    for (const row of rows) result[row.tag_name] = Number(row.count || 0)
  } catch {}
  return result
}
function queryMergedIndexMetrics(payload) {
  const startedAt = nowMs()
  const timings = {}
  const db = new Database(payload.mergedIndexDbPath, { readonly: true, fileMustExist: true })
  try {
    const openStartedAt = nowMs()
    timings.open = nowMs() - openStartedAt
    if (!rootsSnapshotUsable(db, payload.roots || [], payload.schemaVersion)) throw Object.assign(new Error('merged index snapshot is not usable'), { code: 'snapshot-unusable' })
    const attachStartedAt = nowMs()
    db.exec('ATTACH DATABASE ' + sqliteLiteral(payload.libraryDbPath) + ' AS local_db')
    timings.attachLocal = nowMs() - attachStartedAt
    db.pragma('query_only = ON')
    const shellStartedAt = nowMs()
    const shell = readLibraryShell(db)
    timings.shell = nowMs() - shellStartedAt
    const selectStartedAt = nowMs()
    const rows = db.prepare("SELECT root_path, relative_path, cache_key, file_size, modified_at, created_at, status, font_json, installed, installed_by, matches_json FROM entries WHERE COALESCE(is_deleted, 0) = 0 AND status = 'ok' AND font_json IS NOT NULL").all()
    timings.select = nowMs() - selectStartedAt
    const metrics = defaultFontMetricsResult()
    let validFontCount = 0
    for (const collection of shell.collections || []) if (collection && collection.id) metrics.collectionCounts[collection.id] = 0
    for (const tag of shell.localTags || []) metrics.localTagCounts[tag] = 0
    for (const tag of shell.tags || []) metrics.sharedTagCounts[tag] = 0
    const folderIdByKey = new Map()
    for (const folder of shell.folders || []) {
      metrics.folderCounts[folder] = 0
      folderIdByKey.set(normalizePathForCompare(folder), folder)
    }
    for (const node of shell.folderNodes || []) {
      if (!node || !node.id) continue
      metrics.folderCounts[node.id] = 0
      folderIdByKey.set(normalizePathForCompare(node.id), node.id)
    }
    const localCounts = localTagCounts(db)
    for (const key of Object.keys(localCounts)) metrics.localTagCounts[key] = localCounts[key]
    let installedKnown = 0
    let installedCount = 0
    const parseStartedAt = nowMs()
    for (const row of rows) {
      const font = fontFromMergedRow(row)
      if (!font) continue
      validFontCount += 1
      const format = normalizeFontFormat(font.format)
      metrics.formatCounts[format] = (metrics.formatCounts[format] || 0) + 1
      const category = inferFontSearchCategory(font)
      metrics.categoryCounts[category] = (metrics.categoryCounts[category] || 0) + 1
      if (font.favorite) metrics.favoriteCount += 1
      if (font.active) metrics.activeCount += 1
      if (font.installStatusKnown) {
        installedKnown += 1
        if (font.systemInstalled) installedCount += 1
      }
      for (const script of font.scripts || []) metrics.scriptCounts[script] = (metrics.scriptCounts[script] || 0) + 1
      for (const collectionId of font.collectionIds || []) metrics.collectionCounts[collectionId] = (metrics.collectionCounts[collectionId] || 0) + 1
      for (const tagName of font.tagNames || []) metrics.sharedTagCounts[tagName] = (metrics.sharedTagCounts[tagName] || 0) + 1
      const countedFolders = new Set()
      for (const key of fontFolderAncestorKeysForMetrics(font.path)) {
        const folderId = folderIdByKey.get(key)
        if (!folderId || countedFolders.has(folderId)) continue
        metrics.folderCounts[folderId] = (metrics.folderCounts[folderId] || 0) + 1
        countedFolders.add(folderId)
      }
      for (const folder of payload.roots || shell.folders || []) {
        if (countedFolders.has(folder) || !pathMatchesPrefixes(font.path, [folder])) continue
        metrics.folderCounts[folder] = (metrics.folderCounts[folder] || 0) + 1
        countedFolders.add(folder)
      }
    }
    timings.parse = nowMs() - parseStartedAt
    metrics.total = validFontCount
    metrics.categoryCounts.all = validFontCount
    metrics.installStatusKnownCount = installedKnown
    metrics.installStatusMissingCount = Math.max(0, validFontCount - installedKnown)
    metrics.installStatusReady = metrics.installStatusMissingCount === 0
    metrics.installedCount = installedCount
    metrics.notInstalledCount = Math.max(0, installedKnown - installedCount)
    metrics.systemDefaultCount = 0
    metrics.tagCounts = Object.assign({}, metrics.sharedTagCounts, metrics.localTagCounts)
    metrics.elapsedMs = nowMs() - startedAt
    metrics.workerMode = 'db-worker-metrics'
    metrics.timings = timings
    return metrics
  } finally {
    db.close()
  }
}
`;
}
