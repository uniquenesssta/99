import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { nodeBridgeFallbackCompatibilityAllowed } from '../../rust-core/nodeBridgeFallbackCompatibilityRuntime'
import { posix, win32 } from 'node:path'
import type { ManagedActivationFileIdentity, TemporaryActiveFontRecord } from '../../windows/runtime/fontRuntimeTypes'
import type { FontActivationRuntimeDeps } from './fontActivationTypes'

const unsettledCopies = new Map<string, Promise<void>>()
export function retainManagedCopyUntilClosed(path: string, closed: Promise<void>): void {
  for (const target of [path, `${path}.partial`]) {
    unsettledCopies.set(target, closed)
    void closed.finally(() => { if (unsettledCopies.get(target) === closed) unsettledCopies.delete(target) }).catch(() => undefined)
  }
}
export function validManagedIdentity(value: unknown): value is ManagedActivationFileIdentity {
  const identity = value as ManagedActivationFileIdentity | undefined
  return !!identity && typeof identity.device === 'string' && /^\d+$/.test(identity.device)
    && typeof identity.inode === 'string' && /^\d+$/.test(identity.inode) && identity.inode !== '0'
    && typeof identity.sha1 === 'string' && /^[a-f0-9]{40}$/.test(identity.sha1)
    && Number.isSafeInteger(identity.size) && identity.size >= 0
}
export function sameManagedIdentity(left: ManagedActivationFileIdentity, right: ManagedActivationFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.sha1 === right.sha1 && left.size === right.size
}
export function safeManagedActivationPath(filePath: string, directory: string, appName: string): boolean {
  // A local cleanup target must never become an UNC request, even with a corrupt record.
  if (/^[\\/]{2}/.test(filePath) || /^[\\/]{2}/.test(directory)) return false
  const syntax = /^[a-z]:[\\/]/i.test(directory) ? win32 : posix
  if (!syntax.isAbsolute(filePath) || !syntax.isAbsolute(directory)) return false
  const normalize = (value: string) => syntax === win32 ? value.toLowerCase() : value
  return normalize(syntax.dirname(syntax.resolve(filePath))) === normalize(syntax.resolve(directory))
    && syntax.basename(filePath).startsWith(`${appName}_ACTIVE_`)
}
export function createManagedActivationIdentityRuntime(deps: Pick<FontActivationRuntimeDeps, 'appName' | 'currentUserFontsDir' | 'runRustFontActivationFiles'>) {
  function registryClaim(record: TemporaryActiveFontRecord) {
    if (!validManagedIdentity(record.identity)) throw new Error('旧记录缺少文件身份，请在残留处理面板核验后重试。')
    const sessionId = String(record.sessionId || '').trim()
    const syntax = /^[a-z]:[\\/]/i.test(record.installPath) ? win32 : posix
    const fileName = syntax.basename(record.installPath)
    const extension = syntax.extname(fileName)
    const stem = extension ? fileName.slice(0, -extension.length) : fileName
    if (!sessionId || !record.registryName || !record.registryName.endsWith(` [${sessionId}]`) || !stem.endsWith(`_${sessionId}`)) {
      throw new Error('旧记录缺少可验证的激活会话身份，已拒绝自动清理。')
    }
    if (!safeManagedActivationPath(record.installPath, deps.currentUserFontsDir(), deps.appName)) {
      throw new Error('目标不属于本机临时字体目录，已停止操作。')
    }
    return { registryName: record.registryName, installPath: record.installPath, sessionId, identity: record.identity }
  }
  async function inspect(path: string): Promise<ManagedActivationFileIdentity | null> {
    if (unsettledCopies.has(path)) throw new Error('复制执行者尚未关闭，已保留记录并暂停清理。');
    if (!safeManagedActivationPath(path, deps.currentUserFontsDir(), deps.appName)) throw new Error('目标不属于本机临时字体目录，已停止操作。')
    const result = await deps.runRustFontActivationFiles?.({ inspects: [path], allowedDeleteDir: deps.currentUserFontsDir(), allowedNamePrefix: `${deps.appName}_ACTIVE_` })
    if (!result && nodeBridgeFallbackCompatibilityAllowed()) {
      try {
        const stat = await fsp.lstat(path, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('不能接管链接或非字体文件。');
        const handle = await fsp.open(path, 'r');
        try {
          const before = await handle.stat({ bigint: true });
          const sha1 = createHash('sha1');
          for await (const chunk of handle.createReadStream({ autoClose: false })) sha1.update(chunk);
          const after = await handle.stat({ bigint: true });
          if (before.ino !== stat.ino || before.dev !== stat.dev || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new Error('文件身份已变化。');
          return { device: stat.dev.toString(), inode: stat.ino.toString(), sha1: sha1.digest('hex'), size: Number(stat.size) };
        } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    }
    const row = result?.inspectResults?.find(row => row.path === path)
    if (row?.missing) return null
    if (!validManagedIdentity(row?.identity)) throw new Error(row?.message || '无法核验临时字体文件身份，已保留记录。')
    return row.identity
  }
  async function verify(record: TemporaryActiveFontRecord): Promise<boolean> {
    const claim = registryClaim(record)
    if (record.stage === 'file-pending') return true
    if (unsettledCopies.has(record.installPath)) throw new Error('复制执行者尚未关闭，已保留记录并暂停清理。')
    const result = await deps.runRustFontActivationFiles?.({
      inspects: [record.installPath],
      registryClaims: [claim],
      allowedDeleteDir: deps.currentUserFontsDir(),
      allowedNamePrefix: `${deps.appName}_ACTIVE_`,
    })
    if (!result) throw new Error('原生临时激活所有权核验不可用，已保留记录。')
    const row = result.inspectResults?.find(value => value.path === record.installPath)
    if (row?.missing) return false
    if (!validManagedIdentity(row?.identity) || !sameManagedIdentity(row.identity, record.identity!)) {
      throw new Error(row?.message || '目标字体已经替换，旧清理任务已拒绝。')
    }
    const registry = result.registryResults?.find(value => value.registryName === record.registryName && value.installPath === record.installPath)
    if (!registry?.ok || registry.missing) throw new Error(registry?.message || '注册表所有权核验失败，已保留记录。')
    return true
  }
  async function deleteRegistryRecords(records: TemporaryActiveFontRecord[]): Promise<void> {
    if (!records.length) return
    const claims = records.map(registryClaim)
    const result = await deps.runRustFontActivationFiles?.({
      registryClaims: claims,
      deleteRegistryClaims: true,
      allowedDeleteDir: deps.currentUserFontsDir(),
      allowedNamePrefix: `${deps.appName}_ACTIVE_`,
    })
    if (!result) throw new Error('原生临时激活注册表清理不可用，已保留记录。')
    for (const record of records) {
      const row = result.registryResults?.find(value => value.registryName === record.registryName && value.installPath === record.installPath)
      if (!row?.ok || !row.deleted) throw new Error(row?.message || '原生注册表所有权清理失败，已保留记录。')
    }
  }
  async function deleteRegistry(record: TemporaryActiveFontRecord): Promise<void> {
    await deleteRegistryRecords([record])
  }
  async function confirmMissing(record: TemporaryActiveFontRecord): Promise<void> {
    const claim = registryClaim(record)
    const result = await deps.runRustFontActivationFiles?.({
      registryClaims: [claim],
      requireMissing: true,
      allowedDeleteDir: deps.currentUserFontsDir(),
      allowedNamePrefix: `${deps.appName}_ACTIVE_`,
    })
    const row = result?.registryResults?.find(value => value.registryName === record.registryName && value.installPath === record.installPath)
    if (!result?.ok || !row?.ok || !row.missing) throw new Error('未能确认文件及注册表均已清理，记录已保留。')
  }
  return { inspect, verify, deleteRegistry, deleteRegistryRecords, confirmMissing }
}
