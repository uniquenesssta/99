import { assertApplicationOpen, applicationWorkEpoch } from '../app/shutdownCoordinatorRuntime'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { assertSqliteIntegrity, isRecoverableDerivedSqliteError, DerivedSqliteIncompatibleError } from '../db/sqliteRecoveryPolicy'

export async function resolveMergedIndexDbPath(defaultPath: string): Promise<string> {
  try {
    const pointer = JSON.parse(await fs.readFile(`${defaultPath}.active.json`, 'utf8')) as { activeDatabase?: string }
    if (!/^merged-index\.[a-f0-9-]+\.sqlite$/.test(pointer.activeDatabase || '')) throw new Error('合并索引恢复指针无效，已保留原文件。')
    return join(dirname(defaultPath), pointer.activeDatabase!)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultPath
    throw error
  }
}

// The only recovery owner for local-derived merged indexes. The previous file
// (and its WAL) is retained; app.sqlite is never passed to this owner.
export function createMergedIndexRecoveryRuntime(options: {
  defaultPath: string
  open: (path: string) => any
  initialize: (db: any) => void
  close: (db: any) => void
  log: (message: string) => void
}) {
  const pointerPath = `${options.defaultPath}.active.json`
  let activePath = options.defaultPath
  let initialized = false
  let opening: Promise<void> | null = null
  let rebuild: ((db: any, candidatePath: string) => Promise<void>) | undefined

  async function prepare(): Promise<void> {
    if (initialized) return
    if (opening) return opening
    opening = (async () => {
      const epoch = applicationWorkEpoch()
      await fs.mkdir(dirname(options.defaultPath), { recursive: true })
      activePath = await resolveMergedIndexDbPath(options.defaultPath)
      let db: any
      try {
        if (activePath !== options.defaultPath) {
          try { await fs.stat(activePath) }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DerivedSqliteIncompatibleError('合并索引快照缺失，需要完整重建。'); throw error }
        }
        db = options.open(activePath)
        options.initialize(db)
        initialized = true
      } catch (error) {
        if (db) { options.close(db); db = undefined }
        if (!isRecoverableDerivedSqliteError(error) || !rebuild) throw error
        const previousPath = activePath
        const candidatePath = join(dirname(options.defaultPath), `merged-index.${randomUUID()}.sqlite.tmp`)
        const finalPath = candidatePath.slice(0, -4)
        const pointerTemp = `${pointerPath}.${randomUUID()}.tmp`
        let candidate: any
        try {
          candidate = options.open(candidatePath)
          options.initialize(candidate)
          await rebuild(candidate, candidatePath)
          assertSqliteIntegrity(candidate)
          const sourceKey = candidate.prepare("SELECT value FROM meta WHERE key='sourcesKey'").get()?.value
          if (!sourceKey || sourceKey === '[]') throw new Error('合并索引恢复来源不完整，保留原索引。')
          const checkpoint = candidate.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined
          if (Number(checkpoint?.busy || 0)) throw new Error('合并索引候选仍被占用，保留原索引。')
          options.close(candidate); candidate = undefined
          await fs.rename(candidatePath, finalPath)
          await fs.writeFile(pointerTemp, JSON.stringify({ version: 1, activeDatabase: basename(finalPath), previousDatabase: basename(previousPath) }), { flag: 'wx' })
          // A locked/read-only destination fails without deleting the old pointer.
          assertApplicationOpen(epoch)
          await fs.rename(pointerTemp, pointerPath)
          activePath = finalPath
          initialized = true
          options.log(`local merged index recovery published: active=${finalPath}, retained=${previousPath}`)
        } finally {
          if (candidate) options.close(candidate)
          await fs.rm(pointerTemp, { force: true }).catch(() => undefined)
          // Unpublished candidate files are never selected by a directory scan.
        }
      } finally { if (db) options.close(db) }
    })()
    try { await opening } finally { opening = null }
  }

  return {
    path: () => activePath,
    setRebuild: (handler: (db: any, path: string) => Promise<void>) => { rebuild = handler },
    open: async () => {
      await prepare()
      let db: any
      try { db = options.open(activePath); options.initialize(db); return db }
      catch (error) {
        if (db) options.close(db)
        initialized = false
        if (!isRecoverableDerivedSqliteError(error)) throw error
        await prepare()
        const retried = options.open(activePath)
        try { options.initialize(retried); return retried }
        catch (retryError) { options.close(retried); initialized = false; throw retryError }
      }
    },
  }
}
