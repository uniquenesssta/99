import { createHash, randomUUID } from 'node:crypto'
import { constants, lstatSync, type Stats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { sharedFileSystem as fsp } from '../path/sharedFileSystemRuntime'

type FileIdentity = { size: number; sha256: string; dev: number; ino: number; mtimeMs: number; ctimeMs: number }
type FamilyEntry = { path: string; identity: FileIdentity | null }
export type SqlitePreservationReceipt = {
  version: 1
  complete: true
  sourcePath: string
  createdAt: string
  directory: string
  files: FamilyEntry[]
}

export class SqliteRestoreFailure extends Error {
  constructor(message: string, readonly preservationPath: string | undefined, readonly rollbackComplete: boolean, cause: unknown) {
    super(message, { cause })
  }
}

const detail = (error: unknown): string => error instanceof Error ? error.message : String(error)
// A missing main file does not imply that its committed WAL or rollback journal
// is absent. Never use a boolean exists() helper at this preservation boundary.
const family = (path: string): string[] => [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]
export const sqliteRestoreIntentPath = (path: string): string => `${path}.hfm-restore.json`

/** Only call for known local application database paths, never derived NAS reads. */
export function assertNoSqliteRestoreIntent(path: string): void {
  const marker = sqliteRestoreIntentPath(path)
  try { lstatSync(marker) }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw new Error(`无法确认数据库恢复标记是否存在，拒绝打开：${marker}；${detail(error)}`, { cause: error })
  }
  // Even a truncated marker means recovery was not confirmed. Do not construct
  // SQLite (which could create an empty main) or guess how external files changed.
  throw new Error(`存在未完成的数据库恢复事务，拒绝打开；请先检查恢复标记及其保全目录：${marker}`)
}
const sameStat = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
const sameContent = (a: FileIdentity | null, b: FileIdentity | null): boolean => a === null || b === null
  ? a === b : a.size === b.size && a.sha256 === b.sha256

async function statIfPresent(path: string): Promise<Stats | null> {
  try {
    const stat = await fsp.lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`数据库文件不是普通文件：${path}`)
    return stat
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw error
  }
}

async function identity(path: string): Promise<FileIdentity | null> {
  const before = await statIfPresent(path)
  if (!before) return null
  const handle = await fsp.open(path, 'r')
  let failed = false
  try {
    if (!sameStat(before, await handle.stat())) throw new Error(`数据库文件在读取前发生变化：${path}`)
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead
    }
    const after = await statIfPresent(path)
    if (!after || !sameStat(before, after) || !sameStat(before, await handle.stat()) || position !== before.size) {
      throw new Error(`数据库文件在读取时发生变化：${path}`)
    }
    return { size: before.size, sha256: hash.digest('hex'), dev: before.dev, ino: before.ino,
      mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs }
  } catch (error) { failed = true; throw error }
  finally { try { await handle.close() } catch (error) { if (!failed) throw error } }
}

async function syncFile(path: string): Promise<void> {
  const handle = await fsp.open(path, 'r+')
  let failed = false
  try { await handle.sync() } catch (error) { failed = true; throw error }
  finally { try { await handle.close() } catch (error) { if (!failed) throw error } }
}

async function snapshot(path: string): Promise<FamilyEntry[]> {
  const files: FamilyEntry[] = []
  for (const file of family(path)) files.push({ path: file, identity: await identity(file) })
  return files
}

async function assertUnchanged(files: FamilyEntry[]): Promise<void> {
  for (const file of files) {
    if (JSON.stringify(await identity(file.path)) !== JSON.stringify(file.identity)) {
      throw new Error(`数据库文件族发生变化，已取消恢复：${file.path}`)
    }
  }
}

async function copyVerified(source: string, destination: string, expected: FileIdentity): Promise<void> {
  await fsp.copyFile(source, destination, constants.COPYFILE_EXCL)
  await syncFile(destination)
  if (!sameContent(await identity(destination), expected)) throw new Error(`数据库保全副本校验失败：${destination}`)
}

async function uniqueDirectory(parent: string, prefix: string): Promise<string> {
  await fsp.mkdir(parent, { recursive: true })
  const directory = join(parent, `${prefix}-${randomUUID()}`)
  // No recursive mkdir for the unique directory: an existing destination must fail.
  await fsp.mkdir(directory)
  return directory
}

async function preserve(path: string, root: string): Promise<SqlitePreservationReceipt> {
  const files = await snapshot(path)
  // Manual restore archives are deliberately outside automatic corrupt retention.
  const directory = await uniqueDirectory(join(root, 'manual-restores'), 'restore')
  for (const file of files) {
    if (file.identity) await copyVerified(file.path, join(directory, basename(file.path)), file.identity)
  }
  await assertUnchanged(files)
  const receipt: SqlitePreservationReceipt = { version: 1, complete: true, sourcePath: path,
    createdAt: new Date().toISOString(), directory, files }
  const manifestPath = join(directory, 'recovery-manifest.json')
  const manifest = JSON.stringify(receipt, null, 2)
  await fsp.writeFile(manifestPath, manifest, { encoding: 'utf8', flag: 'wx' })
  await syncFile(manifestPath)
  await verifyReceipt(receipt)
  return receipt
}

async function verifyReceipt(receipt: SqlitePreservationReceipt): Promise<void> {
  const manifest = JSON.parse(await fsp.readFile(join(receipt.directory, 'recovery-manifest.json'), 'utf8'))
  if (JSON.stringify(manifest) !== JSON.stringify(receipt)) throw new Error('数据库保全清单读回校验失败。')
  for (const file of receipt.files) {
    if (!sameContent(await identity(join(receipt.directory, basename(file.path))), file.identity)) {
      throw new Error(`数据库保全文件读回校验失败：${file.path}`)
    }
  }
}

/** The caller owns the closed-handle/open-admission gate for the entire operation. */
export async function restoreSqliteWithPreservation(options: {
  targetPath: string
  backupPath: string
  preservationRoot: string
  beforePreserve: () => Promise<void>
  assertClosed: () => void
  assertHealthy: (path: string) => void
  log: (message: string) => void
}): Promise<SqlitePreservationReceipt> {
  const { targetPath, backupPath } = options
  let work: string | undefined, receipt: SqlitePreservationReceipt | undefined
  let candidateIdentity: FileIdentity | null = null
  let mutationStarted = false, rollbackComplete = true, publicationVerified = false
  const marker = sqliteRestoreIntentPath(targetPath)
  let markerOwned = false, markerContents: string | undefined
  const warn = (message: string): void => { try { options.log(message) } catch { /* never mask a storage failure */ } }
  const writeIntent = async (): Promise<void> => {
    if (!markerContents) throw new Error('缺少数据库恢复事务内容。')
    const handle = await fsp.open(marker, 'wx')
    markerOwned = true
    let failed = false
    try { await handle.writeFile(markerContents, 'utf8'); await handle.sync() }
    catch (error) { failed = true; throw error }
    finally { try { await handle.close() } catch (error) { if (!failed) throw error } }
    if (await fsp.readFile(marker, 'utf8') !== markerContents) throw new Error('数据库恢复标记读回校验失败。')
  }
  const removeIntent = async (allowAbsent = false): Promise<void> => {
    let contents: string
    try { contents = await fsp.readFile(marker, 'utf8') }
    catch (error) {
      if (allowAbsent && (error as NodeJS.ErrnoException)?.code === 'ENOENT') { markerOwned = false; return }
      throw error
    }
    if (contents !== markerContents) throw new Error(`恢复标记已改变，拒绝清除：${marker}`)
    await fsp.rm(marker)
    markerOwned = false
  }
  try {
    work = await uniqueDirectory(dirname(targetPath), '.hfm-restore')
    await fsp.mkdir(join(work, 'originals'))
    const candidate = join(work, 'candidate.sqlite')
    const backupIdentity = await identity(backupPath)
    if (!backupIdentity) throw new Error('备份文件已消失。')
    await copyVerified(backupPath, candidate, backupIdentity)
    await assertUnchanged([{ path: backupPath, identity: backupIdentity }])
    options.assertHealthy(candidate)
    candidateIdentity = await identity(candidate)
    if (!sameContent(candidateIdentity, backupIdentity)) throw new Error('候选备份健康检查期间发生变化。')
    await options.beforePreserve()
    options.assertClosed()
    receipt = await preserve(targetPath, options.preservationRoot)
    await verifyReceipt(receipt)
    await assertUnchanged(receipt.files)
    options.assertClosed()
    markerContents = JSON.stringify({ version: 1, phase: 'prepared', targetPath, receipt,
      holdingDirectory: join(work, 'originals'), candidatePath: candidate, createdAt: new Date().toISOString() }, null, 2)
    await writeIntent()
    // Move originals only after the complete durable archive is verified. Keep
    // these originals until publication succeeds so rollback needs no new copies.
    for (const file of receipt.files) {
      if (!file.identity) continue
      await assertUnchanged([file])
      mutationStarted = true
      const held = join(work, 'originals', basename(file.path))
      await fsp.rename(file.path, held)
      if (!sameContent(await identity(held), file.identity)) throw new Error(`替换期间原数据库发生变化：${file.path}`)
    }
    for (const file of family(targetPath)) {
      if (await statIfPresent(file)) throw new Error(`替换期间出现新的数据库文件：${file}`)
    }
    options.assertClosed()
    mutationStarted = true
    // Same-directory hard-link publication is atomic and refuses to overwrite a
    // newly appeared target. Unsupported volumes fail closed and restore originals.
    await fsp.link(candidate, targetPath)
    await syncFile(targetPath)
    if (!sameContent(await identity(targetPath), candidateIdentity)) throw new Error('恢复文件发布后校验失败。')
    for (const sidecar of family(targetPath).slice(1)) {
      if (await statIfPresent(sidecar)) throw new Error(`恢复发布期间出现新的旁路文件：${sidecar}`)
    }
    publicationVerified = true
    await removeIntent()
    return receipt
  } catch (error) {
    if (publicationVerified && receipt) {
      // Marker removal may have taken effect before its error was reported.
      // Never start destructive rollback after this commit boundary: the target
      // is already verified. Re-establish the persistent barrier if necessary.
      let markerError = ''
      try {
        if (!(await statIfPresent(marker))) await writeIntent()
        else if (await fsp.readFile(marker, 'utf8') !== markerContents) throw new Error('恢复标记已被外部修改。')
      } catch (error) { markerError = ` 标记保全也未确认：${detail(error)}。` }
      rollbackComplete = false
      throw new SqliteRestoreFailure(`恢复数据已发布并验证，但事务清理未确认：${detail(error)}。请勿重新打开数据库；恢复标记：${marker}；保全目录：${receipt.directory}；暂存目录：${work}。${markerError}`,
        receipt.directory, false, error)
    }
    const rollbackErrors: string[] = []
    if (mutationStarted && receipt && work) {
      try {
        const installed = await statIfPresent(targetPath)
        if (installed && candidateIdentity && installed.dev === candidateIdentity.dev && installed.ino === candidateIdentity.ino) {
          await fsp.rm(targetPath)
        }
      } catch (rollbackError) { rollbackErrors.push(detail(rollbackError)) }
      for (const file of receipt.files) {
        const held = join(work, 'originals', basename(file.path))
        try {
          if (!(await statIfPresent(held))) continue
          if (await statIfPresent(file.path)) throw new Error(`回滚目标已被占用：${file.path}`)
          await fsp.rename(held, file.path)
        } catch (rollbackError) { rollbackErrors.push(detail(rollbackError)) }
      }
    }
    if (receipt && (mutationStarted || markerOwned)) {
      try {
        // Rename changes ctime; byte verification, including absent members, is
        // the rollback contract. Never replace a conflicting file with stale bytes.
        for (const file of receipt.files) {
          if (!sameContent(await identity(file.path), file.identity)) throw new Error(`回滚校验失败：${file.path}`)
        }
      } catch (rollbackError) { rollbackErrors.push(detail(rollbackError)) }
    }
    if (!rollbackErrors.length && markerOwned) {
      try { await removeIntent(true) } catch (rollbackError) { rollbackErrors.push(detail(rollbackError)) }
    }
    rollbackComplete = rollbackErrors.length === 0
    const location = receipt ? ` 保全目录：${receipt.directory}。` : ''
    const rollback = rollbackComplete ? '' : ` 自动回滚未完成或事务清理未确认，请勿重新打开数据库；恢复标记：${marker}；暂存目录：${work}。${rollbackErrors.join('; ')}`
    throw new SqliteRestoreFailure(`数据库恢复已取消：${detail(error)}。${location}${rollback}`, receipt?.directory, rollbackComplete, error)
  } finally {
    if (work && rollbackComplete) {
      try { await fsp.rm(work, { recursive: true, force: true }) }
      catch (error) { warn(`sqlite restore temporary cleanup deferred: ${work}, ${detail(error)}`) }
    }
  }
}
