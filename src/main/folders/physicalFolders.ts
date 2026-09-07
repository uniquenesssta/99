import fs,{ promises as fsp } from 'node:fs'
import { dirname,join,resolve } from 'node:path'
import type { FolderNode,PhysicalFolderTreeResult,RenameFolderResult } from '../../shared/types'
import { isIgnoredInternalDirectoryName } from '../cache/cachePaths'
import type {
  AuthorizedFontDirectory,
  FontPathAuthorizationResult,
} from '../path/fontPathAuthorizationRuntime'
import { withSharedLeaseLock } from '../storage/runtime/sharedLeaseLockRuntime'

type AuthorizeFontDirectory = (rawPath: unknown) => Promise<FontPathAuthorizationResult<AuthorizedFontDirectory>>
export interface PhysicalFolderDeps {
  ensureWindows: () => void
  appendStartupLog: (message: string) => void
  authorizePhysicalFolderParent: AuthorizeFontDirectory
  authorizePhysicalFolderRename: AuthorizeFontDirectory
  reconcileWatchedRoot: (rootPath: string) => Promise<unknown>
  runRustPhysicalFolderTree?: (input: { folders: string[] }) => Promise<PhysicalFolderTreeResult | null>
}

export function assertSafeFolderName(name: string): string {
  const clean = String(name || '').trim()

  if (!clean) {
    throw new Error('文件夹名称不能为空。')
  }

  if (/[<>:"/\\|?*\x00-\x1F]/.test(clean)) {
    throw new Error('文件夹名称包含 Windows 不允许的字符。')
  }

  if (clean === '.' || clean === '..') {
    throw new Error('文件夹名称无效。')
  }

  return clean
}

export function pathInsideFolder(filePath: string, folderPath: string): boolean {
  const file = filePath.replaceAll('/', '\\').toLowerCase()
  const folder = folderPath.replaceAll('/', '\\').replace(/\\+$/g, '').toLowerCase()
  return file === folder || file.startsWith(`${folder}\\`)
}

function authorizationError(
  action: string,
  result: Exclude<FontPathAuthorizationResult<unknown>, { ok: true }>,
  retryable = false,
): Error {
  const retrySuffix = retryable ? ' 文件系统状态可能已变化，请重试。' : ''
  return new Error(`${action}路径授权失败（${result.reason}）：${result.message}${retrySuffix}`)
}

function changedAuthorizationError(action: string): Error {
  return new Error(`${action}路径在等待文件锁期间发生变化，已停止操作，请重试。`)
}

function sameDirectoryAuthorization(left: AuthorizedFontDirectory, right: AuthorizedFontDirectory): boolean {
  return left.realComparePath === right.realComparePath && left.rootComparePath === right.rootComparePath
}

export function createPhysicalFolderActions(deps: PhysicalFolderDeps) {
  const reconcileAuthorizedRoots = async (
    operation: string,
    authorizations: AuthorizedFontDirectory[],
  ): Promise<void> => {
    const roots = new Map<string, string>()
    for (const authorization of authorizations) {
      if (!authorization.rootPath || !authorization.rootComparePath) continue
      roots.set(authorization.rootComparePath, authorization.rootPath)
    }
    for (const rootPath of roots.values()) {
      try {
        await deps.reconcileWatchedRoot(rootPath)
      } catch (error) {
        deps.appendStartupLog(
          `physical mutation index reconcile failed: operation=${operation}, root=${rootPath}, ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  const createPhysicalFolder = async (parentPath: string, name: string): Promise<string> => {
    deps.ensureWindows()

    const cleanName = assertSafeFolderName(name)
    const initialParent = await deps.authorizePhysicalFolderParent(parentPath)
    if (!initialParent.ok) throw authorizationError('创建文件夹父目录', initialParent)

    let targetPath = ''
    let committed = false
    try {
      await withSharedLeaseLock({
        operation: 'create-folder',
        resourcePath: initialParent.value.ioPath,
        roots: [initialParent.value.rootPath],
        appendStartupLog: deps.appendStartupLog
      }, async () => {
        const lockedParent = await deps.authorizePhysicalFolderParent(initialParent.value.requestedPath)
        if (!lockedParent.ok) throw authorizationError('创建文件夹父目录', lockedParent, true)
        if (!sameDirectoryAuthorization(initialParent.value, lockedParent.value)) {
          throw changedAuthorizationError('创建文件夹父目录')
        }

        targetPath = join(lockedParent.value.ioPath, cleanName)
        await fsp.mkdir(targetPath, { recursive: false })
        committed = true

        const created = await deps.authorizePhysicalFolderParent(targetPath)
        if (!created.ok) throw authorizationError('新建文件夹', created, true)
        if (created.value.rootComparePath !== lockedParent.value.rootComparePath) {
          throw changedAuthorizationError('新建文件夹')
        }
      })
    } finally {
      if (committed) await reconcileAuthorizedRoots('create-folder', [initialParent.value])
    }
    deps.appendStartupLog(`physical folder created: ${targetPath}`)
    return targetPath
  }

  const renamePhysicalFolder = async (folderPath: string, name: string): Promise<RenameFolderResult> => {
    deps.ensureWindows()

    const cleanName = assertSafeFolderName(name)
    const initialFolder = await deps.authorizePhysicalFolderRename(folderPath)
    if (!initialFolder.ok) {
      return {
        ok: false,
        message: authorizationError('重命名文件夹', initialFolder).message,
        oldPath: typeof folderPath === 'string' ? folderPath : ''
      }
    }

    const oldPath = initialFolder.value.ioPath
    let targetPath = join(dirname(oldPath), cleanName)
    const normalizedOld = oldPath.replaceAll('/', '\\').replace(/\\+$/g, '').toLowerCase()
    const normalizedTarget = targetPath.replaceAll('/', '\\').replace(/\\+$/g, '').toLowerCase()

    if (normalizedOld === normalizedTarget) {
      return {
        ok: true,
        message: '文件夹名称没有变化。',
        oldPath,
        newPath: oldPath
      }
    }

    let committed = false
    try {
      await withSharedLeaseLock({
        operation: 'rename-folder',
        resourcePath: oldPath,
        roots: [initialFolder.value.rootPath],
        appendStartupLog: deps.appendStartupLog
      }, async () => {
        const lockedFolder = await deps.authorizePhysicalFolderRename(initialFolder.value.requestedPath)
        if (!lockedFolder.ok) throw authorizationError('重命名文件夹', lockedFolder, true)
        if (!sameDirectoryAuthorization(initialFolder.value, lockedFolder.value)) {
          throw changedAuthorizationError('重命名文件夹')
        }

        const lockedParent = await deps.authorizePhysicalFolderParent(dirname(lockedFolder.value.ioPath))
        if (!lockedParent.ok) throw authorizationError('重命名目标父目录', lockedParent, true)
        if (lockedParent.value.rootComparePath !== lockedFolder.value.rootComparePath) {
          throw changedAuthorizationError('重命名目标父目录')
        }

        targetPath = join(lockedParent.value.ioPath, cleanName)
        if (await fsp.lstat(targetPath).then(() => true).catch(() => false)) {
          throw new Error('同级目录下已存在同名文件夹。')
        }

        await fsp.rename(lockedFolder.value.ioPath, targetPath)
        committed = true

        const renamed = await deps.authorizePhysicalFolderParent(targetPath)
        if (!renamed.ok) throw authorizationError('重命名结果', renamed, true)
        if (renamed.value.rootComparePath !== lockedFolder.value.rootComparePath) {
          throw changedAuthorizationError('重命名结果')
        }
      })
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        oldPath,
        ...(committed ? { newPath: targetPath } : {})
      }
    } finally {
      if (committed) await reconcileAuthorizedRoots('rename-folder', [initialFolder.value])
    }
    deps.appendStartupLog(`physical folder renamed: ${oldPath} -> ${targetPath}`)

    return {
      ok: true,
      message: `已物理重命名为：${targetPath}`,
      oldPath,
      newPath: targetPath
    }
  }

  const listPhysicalFolderTree = async (folders: string[]): Promise<PhysicalFolderTreeResult> => {
    const rustResult = await deps.runRustPhysicalFolderTree?.({ folders }).catch((error) => {
      deps.appendStartupLog(`rust physical folder tree route failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    })
    if (rustResult) return { folders: rustResult.folders, nodes: rustResult.nodes }

    const resultFolders: string[] = []
    const nodes: FolderNode[] = []
    const seenFolders = new Set<string>()
    const seenNodes = new Set<string>()

    async function walk(rootPath: string, parentId: string, dir: string): Promise<void> {
      let entries: fs.Dirent[]
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch (error) {
        deps.appendStartupLog(`folder tree read failed: ${dir} ${error instanceof Error ? error.message : String(error)}`)
        return
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (isIgnoredInternalDirectoryName(entry.name)) continue

        const full = join(dir, entry.name)
        const key = full.replaceAll('/', '\\').replace(/\\+$/g, '').toLowerCase()
        if (seenNodes.has(key)) continue
        seenNodes.add(key)

        let createdAt = new Date().toISOString()
        try {
          const stat = await fsp.stat(full)
          createdAt = new Date(stat.birthtimeMs || stat.ctimeMs || Date.now()).toISOString()
        } catch {
          // ignore
        }

        nodes.push({
          id: full,
          name: entry.name,
          parentId,
          rootPath,
          createdAt
        })

        await walk(rootPath, full, full)
      }
    }

    for (const rawFolder of folders || []) {
      if (!rawFolder) continue
      const folder = resolve(rawFolder)
      const key = folder.replaceAll('/', '\\').replace(/\\+$/g, '').toLowerCase()
      if (seenFolders.has(key)) continue
      seenFolders.add(key)

      try {
        const stat = await fsp.stat(folder)
        if (!stat.isDirectory()) continue
      } catch (error) {
        deps.appendStartupLog(`folder tree root skipped: ${folder} ${error instanceof Error ? error.message : String(error)}`)
        continue
      }

      resultFolders.push(folder)
      await walk(folder, folder, folder)
    }

    return { folders: resultFolders, nodes }
  }

  return {
    createPhysicalFolder,
    renamePhysicalFolder,
    listPhysicalFolderTree,
  }
}
