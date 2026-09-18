import { promises as fsp } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import type { TemporaryActiveFontRecord } from '../../windows/runtime/fontRuntimeTypes'

const tails = new Map<string, Promise<unknown>>()

export function isTemporaryActiveFontRecord(value: unknown): value is TemporaryActiveFontRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return ['fontId', 'sourcePath', 'installPath', 'registryName', 'activatedAt', 'fileName'].every(key => typeof record[key] === 'string')
    && Boolean(String(record.installPath).trim())
}

// Recovery data must keep its old destination if publication fails. Cache writers
// that delete the destination before retrying rename must not be used here.
export function createLocalRecoveryFileRuntime<T>(filePath: () => string, valid: (record: unknown) => boolean) {
  function validate(value: unknown): T[] {
    const file = value as { version?: unknown; records?: unknown } | null
    if (!file || typeof file !== 'object') throw new Error(`本地字体恢复记录格式无效，已保留原文件：${filePath()}`)
    if (file.version !== 1) throw new Error(`本地字体恢复记录版本不支持，已保留原文件：${filePath()}`)
    if (!Array.isArray(file.records) || !file.records.every(valid)) throw new Error(`本地字体恢复记录条目无效，已保留原文件：${filePath()}`)
    return file.records as T[]
  }
  async function read(path: string): Promise<T[]> {
    let raw: string
    try { raw = await fsp.readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
      throw error
    }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch (error) {
      throw new Error(`本地字体恢复记录 JSON 损坏，已保留原文件：${path}`, { cause: error })
    }
    return validate(parsed)
  }
  function serial<R>(action: (path: string) => Promise<R>): Promise<R> {
    const path = resolve(filePath()), key = process.platform === 'win32' ? path.toLowerCase() : path
    const task = (tails.get(key) || Promise.resolve()).catch(() => undefined).then(() => action(path))
    tails.set(key, task)
    void task.finally(() => { if (tails.get(key) === task) tails.delete(key) }).catch(() => undefined)
    return task
  }
  async function write(path: string, records: T[]): Promise<void> {
    const text = JSON.stringify({ version: 1, records })
    validate(JSON.parse(text))
    await fsp.mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof fsp.open>> | undefined
    let owned = false
    try {
      handle = await fsp.open(temporary, 'wx', 0o600)
      owned = true
      await handle.writeFile(text, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await fsp.rename(temporary, path)
    } finally {
      if (handle) await handle.close().catch(() => undefined)
      if (owned) await fsp.rm(temporary, { force: true }).catch(() => undefined)
    }
  }
  return {
    load: () => serial(read),
    save: (records: T[]) => {
      const snapshot = validate(JSON.parse(JSON.stringify({ version: 1, records })))
      return serial(async path => { await read(path); await write(path, snapshot) })
    },
    update: (mutation: (records: T[]) => T[] | Promise<T[]>) => serial(async path => {
      const previous = await read(path), before = JSON.stringify(previous)
      const records = await mutation(previous)
      if (JSON.stringify(records) !== before) await write(path, records)
      return records
    }),
  }
}
