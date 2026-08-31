import fs,{ promises as fsp } from 'node:fs'
import { basename,dirname,extname,join,parse,resolve } from 'node:path'
import type { FolderNode,FontItem,MoveFontFileResult,MoveFontFilesResult,PhysicalFolderTreeResult,RenameFolderResult } from '../../shared/types'
import { isIgnoredInternalDirectoryName } from '../cache/cachePaths'
import { withSharedLeaseLock, withSharedLeaseLocks } from '../storage/runtime/sharedLeaseLockRuntime'

export interface PhysicalFolderDeps {
  ensureWindows: () => void
  resolveExistingFontFilePath: (rawPath?: string, options?: { logMissing?: boolean; logResolved?: boolean }) => Promise<string | undefined>
  windowsFontsDir: () => string
  appendStartupLog: (message: string) => void
  fontExtensions: Set<string>
  runRustPhysicalFolderTree?: (input: { folders: string[] }) => Promise<PhysicalFolderTreeResult | null>
}

type PreparedMoveFont = {
  item: FontItem
  sourcePath: string
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

function moveFailure(item: FontItem, message: string, sourcePath?: string): MoveFontFileResult {
  return {
    ok: false,
    message,
    oldPath: sourcePath || item.path
  }
}

function failedMoveRow(item: FontItem, result: MoveFontFileResult): { id: string; fileName: string; message: string } {
  return {
    id: item.id,
    fileName: item.fileName || basename(result.oldPath || item.path || item.id),
    message: result.message
  }
}

async function moveFileWithCrossDeviceFallback(sourcePath: string, destination: string): Promise<void> {
  try {
    await fsp.rename(sourcePath, destination)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code) : ''
    if (code !== 'EXDEV') throw error

    await fsp.copyFile(sourcePath, destination)
    await fsp.unlink(sourcePath)
  }
}

export function createPhysicalFolderActions(deps: PhysicalFolderDeps) {
  const isWindowsFontsPath = (filePath: string): boolean => pathInsideFolder(filePath, deps.windowsFontsDir())

  const validateTargetFolder = async (targetFolder: string): Promise<{ ok: true; targetFolder: string } | { ok: false; message: string }> => {
    const target = resolve(targetFolder)
    const stat = await fsp.stat(target).catch(() => null)
    if (!stat || !stat.isDirectory()) {
      return { ok: false, message: '目标文件夹不存在。' }
    }
    return { ok: true, targetFolder: target }
  }

  const prepareMoveFont = async (item: FontItem, targetFolder: string): Promise<PreparedMoveFont | MoveFontFileResult> => {
    const sourcePath = await deps.resolveExistingFontFilePath(item.path)
    if (!sourcePath) return moveFailure(item, '字体文件不存在或路径已失效，无法物理移动。')

    if (isWindowsFontsPath(sourcePath)) {
      return moveFailure(item, '系统字体目录中的字体已保护，不允许物理移动。', sourcePath)
    }

    if (!deps.fontExtensions.has(extname(sourcePath).toLowerCase())) {
      return moveFailure(item, '不是受支持的字体文件，已取消移动。', sourcePath)
    }

    const normalizedSourceDir = dirname(sourcePath).replaceAll('/', '\\').replace(/\\+$/g, '').toLowerCase()
    const normalizedTarget = targetFolder.replaceAll('/', '\\').replace(/\\+$/g, '').toLowerCase()
    if (normalizedSourceDir === normalizedTarget) {
      return {
        ok: true,
        message: '字体已经在目标文件夹中。',
        oldPath: sourcePath,
        newPath: sourcePath
      }
    }

    return { item, sourcePath }
  }

  const createPhysicalFolder = async (parentPath: string, name: string): Promise<string> => {
    deps.ensureWindows()

    const resolvedParent = await deps.resolveExistingFontFilePath(parentPath) || parentPath
    const cleanName = assertSafeFolderName(name)
    const targetPath = join(resolvedParent, cleanName)

    const relative = targetPath.replaceAll('/', '\\').toLowerCase()
    const parentNormalized = resolvedParent.replaceAll('/', '\\').replace(/\\+$/g, '').toLowerCase()
    if (!relative.startsWith(`${parentNormalized}\\`)) {
      throw new Error('目标文件夹路径不安全。')
    }

    await fsp.mkdir(targetPath, { recursive: false })
    deps.appendStartupLog(`physical folder created: ${targetPath}`)
    return targetPath
  }

  const renamePhysicalFolder = async (folderPath: string, name: string): Promise<RenameFolderResult> => {
    deps.ensureWindows()

    const cleanName = assertSafeFolderName(name)
    const oldPath = resolve(folderPath)
    const stat = await fsp.stat(oldPath).catch(() => null)

    if (!stat || !stat.isDirectory()) {
      return {
        ok: false,
        message: '文件夹不存在，无法重命名。',
        oldPath
      }
    }

    const targetPath = join(dirname(oldPath), cleanName)
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

    if (fs.existsSync(targetPath)) {
      return {
        ok: false,
        message: '同级目录下已存在同名文件夹。',
        oldPath
      }
    }

    await withSharedLeaseLock({
      operation: 'rename-folder',
      resourcePath: oldPath,
      appendStartupLog: deps.appendStartupLog
    }, async () => {
      await fsp.rename(oldPath, targetPath)
    })
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

  const moveFontFileToFolder = async (item: FontItem, targetFolder: string): Promise<MoveFontFileResult> => {
    deps.ensureWindows()

    const target = await validateTargetFolder(targetFolder)
    if (!target.ok) return moveFailure(item, target.message)

    const prepared = await prepareMoveFont(item, target.targetFolder)
    if ('ok' in prepared) return prepared

    let destination = ''

    await withSharedLeaseLocks({
      operation: 'move-font',
      resourcePaths: [prepared.sourcePath, target.targetFolder],
      appendStartupLog: deps.appendStartupLog
    }, async () => {
      destination = await uniqueDestinationPath(target.targetFolder, basename(prepared.sourcePath))
      await moveFileWithCrossDeviceFallback(prepared.sourcePath, destination)
    })

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
      const row = await prepareMoveFont(item, target.targetFolder)
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

    if (prepared.length) {
      try {
        await withSharedLeaseLocks({
          operation: 'move-font-batch',
          resourcePaths: [target.targetFolder, ...prepared.map((row) => row.sourcePath)],
          appendStartupLog: deps.appendStartupLog
        }, async () => {
          for (const row of prepared) {
            try {
              const destination = await uniqueDestinationPath(target.targetFolder, basename(row.sourcePath))
              await moveFileWithCrossDeviceFallback(row.sourcePath, destination)
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
            }
          }
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        batchFailureMessage = message
        for (const row of prepared) {
          failed.push({ id: row.item.id, fileName: row.item.fileName || basename(row.sourcePath), message })
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
