export function buildDbQueryWorkerMergedPageSource(): string {
  return String.raw`
function queryMergedIndexPage(payload) {
  const startedAt = nowMs()
  const timings = {}
  const openStartedAt = nowMs()
  const db = new Database(payload.mergedIndexDbPath, { readonly: true, fileMustExist: true })
  try {
    timings.open = nowMs() - openStartedAt
    if (!hasSqliteJson(db)) throw Object.assign(new Error('sqlite JSON1 unavailable'), { code: 'json-unavailable' })
    try { db.function('hfm_shared_font_id', { deterministic: true }, (cacheIdentity, size, mtimeMs) => sharedFontId(cacheIdentity, size, mtimeMs)) } catch {}
    if (!rootsSnapshotUsable(db, payload.roots || [], payload.schemaVersion)) throw Object.assign(new Error('merged index snapshot is not usable'), { code: 'snapshot-unusable' })
    const needsLocalDb = /local_db\./i.test(payload.sql.sql) || /local_db\./i.test(payload.sql.countSql)
    let localAttached = false
    try {
      const attachStartedAt = nowMs()
      db.exec('ATTACH DATABASE ' + sqliteLiteral(payload.libraryDbPath) + ' AS local_db')
      timings.attachLocal = nowMs() - attachStartedAt
      localAttached = true
    } catch (error) {
      if (needsLocalDb) throw error
    }
    db.pragma('query_only = ON')
    const countStartedAt = nowMs()
    const totalRow = db.prepare(payload.sql.countSql).get(...(payload.sql.countParams || []))
    timings.count = nowMs() - countStartedAt
    let total = Number(totalRow && totalRow.count || 0)
    const selectStartedAt = nowMs()
    const rows = db.prepare(payload.sql.sql).all(...(payload.sql.params || []))
    timings.select = nowMs() - selectStartedAt
    if (total === 0 && rows.length > 0) total = rows.length
    const parseStartedAt = nowMs()
    let items = rows.map(fontFromMergedRow).filter(Boolean)
    timings.parse = nowMs() - parseStartedAt
    if (localAttached && items.length) {
      try {
        const localStartedAt = nowMs()
        items = hydrateLocalTags(db, items)
        timings.localTags = nowMs() - localStartedAt
      } catch {
        items = items.map((item) => Object.assign({}, item, { localTagNames: Array.isArray(item.localTagNames) ? item.localTagNames : [] }))
      }
    }
    return {
      queryKey: payload.queryKey,
      items,
      total,
      offset: payload.offset,
      limit: payload.limit,
      truncated: payload.offset + items.length < total,
      engine: payload.sql.usedLike || (payload.request && payload.request.keyword) ? 'like' : 'sql',
      elapsedMs: nowMs() - startedAt,
      workerMode: 'db-worker-snapshot',
      timings
    }
  } finally {
    db.close()
  }
}
`;
}
