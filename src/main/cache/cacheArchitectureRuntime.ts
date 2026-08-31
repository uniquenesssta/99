import { promises as fsp } from 'node:fs'
import { dirname } from 'node:path'
import type { FontItem } from '../../shared/types'
import { createCacheArchitectureInfo,createCacheIdentityPayload } from './architecture/cacheArchitectureInfoRuntime'
import { initializeEventsDb,initializeHashDb,initializeKvsDb,initializeMetricsDb } from './architecture/cacheArchitectureSchemaRuntime'
import type { ApplicationCacheDbLabel,CacheArchitectureInfo,CacheArchitectureRuntimeOptions } from './architecture/cacheArchitectureTypes'

export function createCacheArchitectureRuntime(options: CacheArchitectureRuntimeOptions) {
  let kvsDb: any | null = null
  let kvsDbOpening: Promise<any> | null = null
  let eventsDb: any | null = null
  let eventsDbOpening: Promise<any> | null = null
  let hashDb: any | null = null
  let hashDbOpening: Promise<any> | null = null
  let metricsDb: any | null = null
  let metricsDbOpening: Promise<any> | null = null

  async function openKvsDb(): Promise<any> {
    if (kvsDb) return kvsDb
    if (kvsDbOpening) return kvsDbOpening
    kvsDbOpening = (async () => {
      await fsp.mkdir(dirname(options.kvsSqlitePath()), { recursive: true })
      const db = await options.openRecoverableApplicationSqliteDb(options.kvsSqlitePath(), 'kvs')
      try {
        initializeKvsDb(db, options)
        kvsDb = db
        return db
      } catch (error) {
        options.closeSqliteDb(db)
        throw error
      }
    })()
    try {
      return await kvsDbOpening
    } finally {
      kvsDbOpening = null
    }
  }

  function kvsSetOnOpenDb(db: any, key: string, value: unknown, valueType = typeof value): void {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    db.prepare('INSERT OR REPLACE INTO kvs (key, value, value_type, updated_at) VALUES (?, ?, ?, ?)').run(key, serialized, valueType || 'json', new Date().toISOString())
  }

  async function setCacheKvs(key: string, value: unknown, valueType = typeof value): Promise<void> {
    const db = await openKvsDb()
    kvsSetOnOpenDb(db, key, value, valueType)
  }

  async function openEventsDb(): Promise<any> {
    if (eventsDb) return eventsDb
    if (eventsDbOpening) return eventsDbOpening
    eventsDbOpening = (async () => {
      await fsp.mkdir(dirname(options.eventsSqlitePath()), { recursive: true })
      const db = await options.openRecoverableApplicationSqliteDb(options.eventsSqlitePath(), 'events')
      try {
        initializeEventsDb(db, options)
        eventsDb = db
        return db
      } catch (error) {
        options.closeSqliteDb(db)
        throw error
      }
    })()
    try {
      return await eventsDbOpening
    } finally {
      eventsDbOpening = null
    }
  }

  async function recordCacheEvent(source: string, eventType: string, payload: Record<string, unknown> = {}): Promise<void> {
    try {
      const db = await openEventsDb()
      db.prepare(`
        INSERT INTO index_events (source, root_path, event_type, font_id, relative_path, previous_relative_path, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        source,
        typeof payload.rootPath === 'string' ? payload.rootPath : null,
        eventType,
        typeof payload.fontId === 'string' ? payload.fontId : null,
        typeof payload.relativePath === 'string' ? payload.relativePath : null,
        typeof payload.previousRelativePath === 'string' ? payload.previousRelativePath : null,
        JSON.stringify(payload || {}),
        new Date().toISOString()
      )
    } catch (error) {
      options.appendStartupLog(`cache event write skipped: ${source}:${eventType} ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function openHashDb(): Promise<any> {
    if (hashDb) return hashDb
    if (hashDbOpening) return hashDbOpening
    hashDbOpening = (async () => {
      await fsp.mkdir(dirname(options.hashSqlitePath()), { recursive: true })
      const db = await options.openRecoverableApplicationSqliteDb(options.hashSqlitePath(), 'hash')
      try {
        initializeHashDb(db, options)
        hashDb = db
        return db
      } catch (error) {
        options.closeSqliteDb(db)
        throw error
      }
    })()
    try {
      return await hashDbOpening
    } finally {
      hashDbOpening = null
    }
  }

  async function upsertFontHashIndex(fonts: FontItem[]): Promise<void> {
    const uniqueFonts = Array.from(new Map((fonts || []).filter((font) => !!font?.id && !!font?.path).map((font) => [font.id, font])).values())
    if (!uniqueFonts.length) return
    try {
      const db = await openHashDb()
      const now = new Date().toISOString()
      const upsert = db.prepare(`
        INSERT INTO file_hashes (id, font_id, path, quick_signature, exact_hash, file_size, modified_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          font_id = excluded.font_id,
          path = excluded.path,
          quick_signature = excluded.quick_signature,
          file_size = excluded.file_size,
          modified_at = excluded.modified_at,
          updated_at = excluded.updated_at
      `)
      const tx = db.transaction(() => {
        for (const font of uniqueFonts) {
          const normalizedPath = options.normalizePathForCacheCompare(font.path)
          const quickSignature = options.fileCacheSignature(normalizedPath, font.fileSize || 0, font.modifiedAt || 0)
          upsert.run(options.sha1(normalizedPath), font.id, font.path, quickSignature, Math.round(font.fileSize || 0), Number(font.modifiedAt || 0), now, now)
        }
      })
      tx()
    } catch (error) {
      options.appendStartupLog(`hash index upsert skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function openMetricsDb(): Promise<any> {
    if (metricsDb) return metricsDb
    if (metricsDbOpening) return metricsDbOpening
    metricsDbOpening = (async () => {
      await fsp.mkdir(dirname(options.metricsSqlitePath()), { recursive: true })
      const db = await options.openRecoverableApplicationSqliteDb(options.metricsSqlitePath(), 'metrics')
      try {
        initializeMetricsDb(db, options)
        metricsDb = db
        return db
      } catch (error) {
        options.closeSqliteDb(db)
        throw error
      }
    })()
    try {
      return await metricsDbOpening
    } finally {
      metricsDbOpening = null
    }
  }

  async function saveMetricsSnapshot(_key: string, _value: unknown): Promise<void> {
    // v2.0 stable architecture: font metrics are computed from shared root indexes.
    // Persisted metrics snapshots are reserved for per-root .hfm-cache/database/metrics.sqlite.
  }

  function cacheArchitectureInfo(): CacheArchitectureInfo {
    return createCacheArchitectureInfo(options)
  }

  async function ensureCacheIdentity(): Promise<void> {
    if (await options.exists(options.cacheIdentityPath())) return
    await options.writeJsonAtomic(options.cacheIdentityPath(), createCacheIdentityPayload(options))
  }

  async function initializeCacheArchitectureV2(): Promise<void> {
    await ensureCacheIdentity()
    options.appendStartupLog(`v2.0 stable architecture ready: local=${options.appSqlitePath()} shared=${options.rootCacheDirName}+${options.rootPreviewCacheDirName}`)
  }


  function checkpointOpenCacheDbs(): void {
    for (const db of [kvsDb, eventsDb, hashDb, metricsDb]) {
      if (!db) continue
      try {
        db.exec('PRAGMA wal_checkpoint(PASSIVE);')
      } catch {
        // ignore checkpoint errors; quick_check will still report actual corruption
      }
    }
  }

  function closeCacheDb(label: ApplicationCacheDbLabel): void {
    if (label === 'kvs') {
      options.closeSqliteDb(kvsDb)
      kvsDb = null
      kvsDbOpening = null
    } else if (label === 'events') {
      options.closeSqliteDb(eventsDb)
      eventsDb = null
      eventsDbOpening = null
    } else if (label === 'hash') {
      options.closeSqliteDb(hashDb)
      hashDb = null
      hashDbOpening = null
    } else if (label === 'metrics') {
      options.closeSqliteDb(metricsDb)
      metricsDb = null
      metricsDbOpening = null
    }
  }

  return {
    openKvsDb,
    kvsSetOnOpenDb,
    setCacheKvs,
    openEventsDb,
    recordCacheEvent,
    openHashDb,
    upsertFontHashIndex,
    openMetricsDb,
    saveMetricsSnapshot,
    cacheArchitectureInfo,
    ensureCacheIdentity,
    initializeCacheArchitectureV2,
    checkpointOpenCacheDbs,
    closeCacheDb
  }
}
