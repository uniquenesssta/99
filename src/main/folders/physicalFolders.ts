import fs,{ promises as fsp } from 'node:fs'
import { basename,dirname,extname,join,parse,resolve } from 'node:path'
import type { FolderNode,FontItem,MoveFontFileResult,MoveFontFilesResult,PhysicalFolderTreeResult,RenameFolderResult } from '../../shared/types'
import { isIgnoredInternalDirectoryName } from '../cache/cachePaths'
import type {
  AuthorizedFontDirectory,
  AuthorizedFontFile,
  FontPathAuthorizationResult,
} from '../path/fontPathAuthorizationRuntime'
import { withSharedLeaseLock, withSharedLeaseLocks } from '../storage/runtime/sharedLeaseLockRuntime'

type AuthorizeFontDirectory = (rawPath: unknown) => Promise<FontPathAuthorizationResult<AuthorizedFontDirectory>>
type AuthorizeFontFile = (rawPath: unknown) => Promise<FontPathAuthorizationResult<AuthorizedFontFile>>

export interface PhysicalFolderDeps {
  ensureWindows: () => void
  resolveExistingFontFilePath: (rawPath?: string, options?: { logMissing?: boolean; logResolved?: boolean }) => Promise<string | undefined>
  windowsFontsDir: () => string
  appendStartupLog: (message: string) => void
  fontExtensions: Set<string>
  authorizePhysicalFolderParent: AuthorizeFontDirectory
  authorizePhysicalFolderRename: AuthorizeFontDirectory
  authorizeFontMoveSource: AuthorizeFontFile
  authorizeFontMoveTarget: AuthorizeFontDirectory
  authorizeFontMoveDestination: AuthorizeFontFile
  reconcileWatchedRoot: (rootPath: string) => Promise<unknown>
  runRustPhysicalFolderTree?: (input: { folders: string[] }) => Promise<PhysicalFolderTreeResult | null>
}

type PreparedMoveFont = {
  item: FontItem
  sourcePath: string
  authorization: AuthorizedFontFile
}

type ValidatedMoveTarget = {
  ok: true
  targetFolder: string
  authorization: AuthorizedFontDirectory
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

async function uniqueDestinationPath(targetFolder: string, fileName: string): Promise<string> {
  const parsed = parse(fileName)
  let candidate = join(targetFolder, fileName)
  let index = 1

  while (fs.existsSync(candidate)) {
    candidate = join(targetFolder, `${parsed.name} (${index})${parsed.ext}`)
    index += 1
  }

  return candidate
}

function moveFailure(item: FontItem, message: string, sourcePath?: string, destination?: string): MoveFontFileResult {
  return {
    ok: false,
    message,
    oldPath: sourcePath || item.path,
    ...(destination ? { newPath: destination } : {})
  }
}

function failedMoveRow(item: FontItem, result: MoveFontFileResult): { id: string; fileName: string; message: string } {
  return {
    id: item.id,
    fileName: item.fileName || basename(result.oldPath || item.path || item.id),
    message: result.message
  }
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

function sameFileAuthorization(left: AuthorizedFontFile, right: AuthorizedFontFile): boolean {
  return left.realComparePath === right.realComparePath && left.rootComparePath === right.rootComparePath
}

function sameDirectoryAuthorization(left: AuthorizedFontDirectory, right: AuthorizedFontDirectory): boolean {
  return left.realComparePath === right.realComparePath && left.rootComparePath === right.rootComparePath
}

async function moveFileWithCrossDeviceFallback(
  sourcePath: string,
  destination: string,
  hooks: {
    beforeRename: () => Promise<void>
    beforeCopy: () => Promise<void>
    beforeUnlink: () => Promise<void>
    committed: () => void
  },
): Promise<void> {
  await hooks.beforeRename()
  try {
    await fsp.rename(sourcePath, destination)
    hooks.committed()
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code) : ''
    if (code !== 'EXDEV') throw error

    await hooks.beforeCopy()
    await fsp.copyFile(sourcePath, destination)
    hooks.committed()
    await hooks.beforeUnlink()
    await fsp.unlink(sourcePath)
  }
}

export function createPhysicalFolderActions(deps: PhysicalFolderDeps) {
  const isWindowsFontsPath = (filePath: string): boolean => pathInsideFolder(filePath, deps.windowsFontsDir())

  const reconcileAuthorizedRoots = async (
    operation: string,
    authorizations: Array<AuthorizedFontDirectory | AuthorizedFontFile>,
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

  const validateTargetFolder = async (targetFolder: string): Promise<ValidatedMoveTarget | { ok: false; message: string }> => {
    const authorization = await deps.authorizeFontMoveTarget(targetFolder)
    if (!authorization.ok) {
      return { ok: false, message: authorizationError('移动目标', authorization).message }
    }
    return {
      ok: true,
      targetFolder: authorization.value.ioPath,
      authorization: authorization.value
    }
  }

  const prepareMoveFont = async (item: FontItem, target: ValidatedMoveTarget): Promise<PreparedMoveFont | MoveFontFileResult> => {
    const sourcePath = await deps.resolveExistingFontFilePath(item.path)
    if (!sourcePath) return moveFailure(item, '字体文件不存在或路径已失效，无法物理移动。')

    if (isWindowsFontsPath(sourcePath)) {
      return moveFailure(item, '系统字体目录中的字体已保护，不允许物理移动。', sourcePath)
    }

    if (!deps.fontExtensions.has(extname(sourcePath).toLowerCase())) {
      return moveFailure(item, '不是受支持的字体文件，已取消移动。', sourcePath)
    }

    const authorization = await deps.authorizeFontMoveSource(sourcePath)
    if (!authorization.ok) {
      return moveFailure(item, authorizationError('移动源', authorization).message, sourcePath)
    }

    const normalizedSourceDir = dirname(authorization.value.ioPath).replaceAll('/', '\\').replace(/\\+$/g, '').toLowerCase()
    const normalizedTarget = target.targetFolder.replaceAll('/', '\\').replace(/\\+$/g, '').toLowerCase()
    if (normalizedSourceDir === normalizedTarget) {
      return {
        ok: true,
        message: '字体已经在目标文件夹中。',
        oldPath: authorization.value.ioPath,
        newPath: authorization.value.ioPath
      }
    }

    return { item, sourcePath: authorization.value.ioPath, authorization: authorization.value }
  }

  const reauthorizeMove = async (
    prepared: PreparedMoveFont,
    target: ValidatedMoveTarget,
  ): Promise<{ source: AuthorizedFontFile; target: AuthorizedFontDirectory }> => {
    const [source, destinationFolder] = await Promise.all([
      deps.authorizeFontMoveSource(prepared.authorization.requestedPath),
      deps.authorizeFontMoveTarget(target.authorization.requestedPath),
    ])
    if (!source.ok) throw authorizationError('移动源', source, true)
    if (!destinationFolder.ok) throw authorizationError('移动目标', destinationFolder, true)
    if (!sameFileAuthorization(prepared.authorization, source.value)) {
      throw changedAuthorizationError('移动源')
    }
    if (!sameDirectoryAuthorization(target.authorization, destinationFolder.value)) {
      throw changedAuthorizationError('移动目标')
    }
    return { source: source.value, target: destinationFolder.value }
  }

  const verifyMovedDestination = async (
    destination: string,
    target: AuthorizedFontDirectory,
  ): Promise<AuthorizedFontFile> => {
    const result = await deps.authorizeFontMoveDestination(destination)
    if (!result.ok) throw authorizationError('移动结果', result, true)
    if (result.value.rootComparePath !== target.rootComparePath) {
      throw changedAuthorizationError('移动结果')
    }
    return result.value
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

  const movePreparedFont = async (
    prepared: PreparedMoveFont,
    target: ValidatedMoveTarget,
    onCommitted: () => void,
  ): Promise<string> => {
    const destination = await uniqueDestinationPath(target.targetFolder, basename(prepared.sourcePath))
    await moveFileWithCrossDeviceFallback(prepared.sourcePath, destination, {
      beforeRename: async () => {
        await reauthorizeMove(prepared, target)
      },
      beforeCopy: async () => {
        await reauthorizeMove(prepared, target)
      },
      beforeUnlink: async () => {
        const locked = await reauthorizeMove(prepared, target)
        await verifyMovedDestination(destination, locked.target)
      },
      committed: onCommitted,
    })
    const lockedTarget = await deps.authorizeFontMoveTarget(target.authorization.requestedPath)
    if (!lockedTarget.ok) throw authorizationError('移动结果目标', lockedTarget, true)
    if (!sameDirectoryAuthorization(target.authorization, lockedTarget.value)) {
      throw changedAuthorizationError('移动结果目标')
    }
    await verifyMovedDestination(destination, lockedTarget.value)
    return destination
  }

  const moveFontFileToFolder = async (item: FontItem, targetFolder: string): Promise<MoveFontFileResult> => {
    deps.ensureWindows()

    const target = await validateTargetFolder(targetFolder)
    if (!target.ok) return moveFailure(item, target.message)

    const prepared = await prepareMoveFont(item, target)
    if ('ok' in prepared) return prepared

    let destination = ''
    let committed = false
    try {
      await withSharedLeaseLocks({
        operation: 'move-font',
        resourcePaths: [prepared.sourcePath, target.targetFolder],
        roots: [prepared.authorization.rootPath, target.authorization.rootPath].filter((rootPath): rootPath is string => !!rootPath),
        appendStartupLog: deps.appendStartupLog
      }, async () => {
        destination = await movePreparedFont(prepared, target, () => { committed = true })
      })
    } catch (error) {
      return moveFailure(
        item,
        error instanceof Error ? error.message : String(error),
        prepared.sourcePath,
        committed ? destination : undefined,
      )
    } finally {
      if (committed) {
        await reconcileAuthorizedRoots('move-font', [prepared.authorization, target.authorization])
      }
    }

    deps.appendStartupLog(`font physically moved: ${prepared.sourcePath} -> ${destination}`)
    return {
      ok: true,
      message: `已物理移动到：${destination}`,
      oldPath: prepared.sourcePath,
      newPath: destination
    }
  }

  const moveFontFilesToFolder = async (items: FontItem[], targetFolder: string): Promise<MoveFontFilesResult> => {
    deps.ensureWindows()

    const target = await validateTargetFolder(targetFolder)
    const uniqueItems = Array.from(new Map((items || []).filter((item) => item?.id && item.path).map((item) => [item.id, item])).values())
    const failed: MoveFontFilesResult['failed'] = []
    const moved: MoveFontFilesResult['moved'] = []
    let batchFailureMessage = ''

    if (!uniqueItems.length) {
      return { ok: true, moved, movedCount: 0, failed, message: '没有可移动的字体。' }
    }

    if (!target.ok) {
      return {
        ok: false,
        moved,
        movedCount: 0,
        failed: uniqueItems.map((item) => failedMoveRow(item, moveFailure(item, target.message))),
        message: target.message
      }
    }

    const prepared: PreparedMoveFont[] = []
    for (const item of uniqueItems) {
      const row = await prepareMoveFont(item, target)
      if ('ok' in row) {
        if (row.ok) {
          moved.push({ id: item.id, result: row })
        } else {
          failed.push(failedMoveRow(item, row))
        }
        continue
      }
      prepared.push(row)
    }

    const committedAuthorizations: Array<AuthorizedFontDirectory | AuthorizedFontFile> = []
    if (prepared.length) {
      try {
        await withSharedLeaseLocks({
          operation: 'move-font-batch',
          resourcePaths: [target.targetFolder, ...prepared.map((row) => row.sourcePath)],
          roots: Array.from(new Set([
            target.authorization.rootPath,
            ...prepared.map((row) => row.authorization.rootPath),
          ].filter((rootPath): rootPath is string => !!rootPath))),
          appendStartupLog: deps.appendStartupLog
        }, async () => {
          for (const row of prepared) {
            let destination = ''
            let committed = false
            try {
              destination = await movePreparedFont(row, target, () => { committed = true })
              const result = {
                ok: true,
                message: `已物理移动到：${destination}`,
                oldPath: row.sourcePath,
                newPath: destination
              }
              moved.push({ id: row.item.id, result })
              deps.appendStartupLog(`font physically moved in batch: ${row.sourcePath} -> ${destination}`)
            } catch (error) {
              failed.push({
                id: row.item.id,
                fileName: row.item.fileName || basename(row.sourcePath),
                message: error instanceof Error ? error.message : String(error)
              })
            } finally {
              if (committed) committedAuthorizations.push(row.authorization, target.authorization)
            }
          }
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        batchFailureMessage = message
        for (const row of prepared) {
          failed.push({ id: row.item.id, fileName: row.item.fileName || basename(row.sourcePath), message })
        }
      } finally {
        if (committedAuthorizations.length) {
          await reconcileAuthorizedRoots('move-font-batch', committedAuthorizations)
        }
      }
    }

    const movedCount = moved.filter((row) => row.result.newPath && row.result.oldPath !== row.result.newPath).length
    const alreadyInTarget = moved.length - movedCount
    const parts = [
      `批量移动完成：成功 ${movedCount} 个`,
      alreadyInTarget ? `已在目标文件夹 ${alreadyInTarget} 个` : '',
      failed.length ? `失败 ${failed.length} 个` : '',
      batchFailureMessage ? `失败原因：${batchFailureMessage}` : ''
    ].filter(Boolean)

    return {
      ok: failed.length === 0,
      moved,
      movedCount,
      failed,
      message: parts.join('，')
    }
  }

  return {
    createPhysicalFolder,
    renamePhysicalFolder,
    listPhysicalFolderTree,
    moveFontFileToFolder,
    moveFontFilesToFolder,
    isWindowsFontsPath
  }
}
