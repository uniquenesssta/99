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
  async function inspect(path: string, registryName?: string): Promise<ManagedActivationFileIdentity | null> {
    if (unsettledCopies.has(path)) throw new Error('复制执行者尚未关闭，已保留记录并暂停清理。');
    if (!safeManagedActivationPath(path, deps.currentUserFontsDir(), deps.appName)) throw new Error('目标不属于本机临时字体目录，已停止操作。')
    const result = await deps.runRustFontActivationFiles?.({ inspects: [path], registryExpectations: registryName ? { [registryName]: path } : undefined, allowedDeleteDir: deps.currentUserFontsDir(), allowedNamePrefix: `${deps.appName}_ACTIVE_` })
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
    if (!validManagedIdentity(record.identity)) throw new Error('旧记录缺少文件身份，请在残留处理面板核验后重试。')
    const identity = await inspect(record.installPath, record.registryName)
    if (identity && !sameManagedIdentity(identity, record.identity)) throw new Error('目标字体已经替换，旧清理任务已拒绝。')
    return identity !== null
  }
  return { inspect, verify }
}
