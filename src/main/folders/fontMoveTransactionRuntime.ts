import { basename,dirname,extname } from 'node:path'
import { createFontFileMoveCommitRuntime,FontMoveExecutionError } from './fontFileMoveCommitRuntime'
import type { FontItem,MoveFontFileResult,MoveFontFilesResult } from '../../shared/types'
import type {
  AuthorizedFontDirectory,
  AuthorizedFontFile,
  FontPathAuthorizationResult,
} from '../path/fontPathAuthorizationRuntime'
import { withSharedLeaseLocks } from '../storage/runtime/sharedLeaseLockRuntime'

type AuthorizeFontDirectory = (rawPath: unknown) => Promise<FontPathAuthorizationResult<AuthorizedFontDirectory>>
type AuthorizeFontFile = (rawPath: unknown) => Promise<FontPathAuthorizationResult<AuthorizedFontFile>>

export interface FontMoveTransactionDeps {
  ensureWindows: () => void
  resolveExistingFontFilePath: (rawPath?: string, options?: { logMissing?: boolean; logResolved?: boolean }) => Promise<string | undefined>
  isProtectedFontPath: (filePath: string) => boolean
  appendStartupLog: (message: string) => void
  fontExtensions: Set<string>
  authorizeFontMoveSource: AuthorizeFontFile
  authorizeFontMoveTarget: AuthorizeFontDirectory
  authorizeFontMoveDestination: AuthorizeFontFile
  reconcileWatchedRoot: (rootPath: string) => Promise<unknown>
  fileCommitRuntime?: ReturnType<typeof createFontFileMoveCommitRuntime>
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

function moveFailure(item: FontItem, message: string, sourcePath?: string): MoveFontFileResult {
  return {
    ok: false,
    outcome: 'not-moved',
    message,
    oldPath: sourcePath || item.path,
  }
}

function failedMoveRow(item: FontItem, result: MoveFontFileResult): MoveFontFilesResult['failed'][number] {
  return {
    id: item.id,
    fileName: item.fileName || basename(result.oldPath || item.path || item.id),
    message: result.message,
    result,
  }
}

export function createFontMoveTransactionRuntime(deps: FontMoveTransactionDeps) {
  const fileCommitRuntime = deps.fileCommitRuntime || createFontFileMoveCommitRuntime()

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
          `font move index reconcile failed: operation=${operation}, root=${rootPath}, ${error instanceof Error ? error.message : String(error)}`,
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
      authorization: authorization.value,
    }
  }

  const prepareMoveFont = async (item: FontItem, target: ValidatedMoveTarget): Promise<PreparedMoveFont | MoveFontFileResult> => {
    const sourcePath = await deps.resolveExistingFontFilePath(item.path)
    if (!sourcePath) return moveFailure(item, '字体文件不存在或路径已失效，无法物理移动。')

    if (deps.isProtectedFontPath(sourcePath)) {
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
        outcome: 'unchanged',
        message: '字体已经在目标文件夹中。',
        oldPath: authorization.value.ioPath,
        newPath: authorization.value.ioPath,
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
    if (!sameFileAuthorization(prepared.authorization, source.value)) throw changedAuthorizationError('移动源')
    if (!sameDirectoryAuthorization(target.authorization, destinationFolder.value)) throw changedAuthorizationError('移动目标')
    return { source: source.value, target: destinationFolder.value }
  }

  const verifyMovedDestination = async (
    destination: string,
    target: AuthorizedFontDirectory,
  ): Promise<AuthorizedFontFile> => {
    const result = await deps.authorizeFontMoveDestination(destination)
    if (!result.ok) throw authorizationError('移动结果', result, true)
    if (result.value.rootComparePath !== target.rootComparePath) throw changedAuthorizationError('移动结果')
    return result.value
  }

  const movePreparedFont = (prepared: PreparedMoveFont, target: ValidatedMoveTarget) =>
    fileCommitRuntime.moveFile(prepared.sourcePath, target.targetFolder, {
      revalidate: async () => { await reauthorizeMove(prepared, target) },
      verifyDestination: async (destination) => {
        const lockedTarget = await deps.authorizeFontMoveTarget(target.authorization.requestedPath)
        if (!lockedTarget.ok) throw authorizationError('移动结果目标', lockedTarget, true)
        if (!sameDirectoryAuthorization(target.authorization, lockedTarget.value)) throw changedAuthorizationError('移动结果目标')
        await verifyMovedDestination(destination, lockedTarget.value)
      },
    })

  const resultForExecutionError = (item: FontItem, prepared: PreparedMoveFont, error: unknown): MoveFontFileResult => {
    if (!(error instanceof FontMoveExecutionError)) return moveFailure(item, error instanceof Error ? error.message : String(error), prepared.sourcePath)
    if (error.state.targetCommitted === undefined) {
      return {
        ok: false,
        outcome: 'commit-uncertain',
        message: `无法确认目标提交状态，未继续删除源文件。请恢复连接并核对 ${error.state.destination} 后再操作：${error.message}`,
        oldPath: prepared.sourcePath,
        newPath: error.state.destination,
        ...(error.state.recoveryPath ? { recoveryPath: error.state.recoveryPath } : {}),
      }
    }
    if (error.state.targetCommitted && error.state.sourceRetained) {
      return {
        ok: false,
        outcome: 'target-committed-source-retained',
        message: `目标文件已提交至 ${error.state.destination}，但源文件仍保留：${error.message} 请先核对两份文件，不要直接重复移动。`,
        oldPath: prepared.sourcePath,
        newPath: error.state.destination,
        ...(error.state.recoveryPath ? { recoveryPath: error.state.recoveryPath } : {}),
      }
    }
    if (error.state.targetCommitted) {
      const sourceUnknown = error.state.sourceRetained === undefined
      return {
        ok: false,
        outcome: sourceUnknown ? 'target-committed-source-unknown' : 'target-committed-source-removed',
        message: `${sourceUnknown ? '目标已提交，但暂时无法确认源文件状态' : '文件已移动，但提交后验证失败'}：${error.message}`,
        oldPath: prepared.sourcePath,
        newPath: error.state.destination,
        ...(error.state.recoveryPath ? { recoveryPath: error.state.recoveryPath } : {}),
      }
    }
    return {
      ...moveFailure(item, error.message, prepared.sourcePath),
      ...(error.state.recoveryPath ? { recoveryPath: error.state.recoveryPath } : {}),
    }
  }

  const moveFontFileToFolder = async (item: FontItem, targetFolder: string): Promise<MoveFontFileResult> => {
    deps.ensureWindows()
    const target = await validateTargetFolder(targetFolder)
    if (!target.ok) return moveFailure(item, target.message)
    const prepared = await prepareMoveFont(item, target)
    if ('ok' in prepared) return prepared

    let result: MoveFontFileResult
    try {
      const state = await withSharedLeaseLocks({
        operation: 'move-font',
        resourcePaths: [prepared.sourcePath, target.targetFolder],
        roots: [prepared.authorization.rootPath, target.authorization.rootPath].filter((rootPath): rootPath is string => !!rootPath),
        appendStartupLog: deps.appendStartupLog,
      }, () => movePreparedFont(prepared, target))
      result = {
        ok: true,
        outcome: 'moved',
        message: `已物理移动到：${state.destination}`,
        oldPath: prepared.sourcePath,
        newPath: state.destination,
      }
    } catch (error) {
      result = resultForExecutionError(item, prepared, error)
    }

    if (result.outcome === 'moved' || result.outcome === 'commit-uncertain' || result.outcome?.startsWith('target-committed-')) {
      await reconcileAuthorizedRoots('move-font', [prepared.authorization, target.authorization])
    }
    if (result.ok) deps.appendStartupLog(`font physically moved: ${prepared.sourcePath} -> ${result.newPath}`)
    else deps.appendStartupLog(`font physical move incomplete: outcome=${result.outcome}, source=${prepared.sourcePath}, destination=${result.newPath || ''}, ${result.message}`)
    return result
  }

  const moveFontFilesToFolder = async (items: FontItem[], targetFolder: string): Promise<MoveFontFilesResult> => {
    deps.ensureWindows()
    const target = await validateTargetFolder(targetFolder)
    const uniqueItems = Array.from(new Map((items || []).filter((item) => item?.id && item.path).map((item) => [item.id, item])).values())
    const failed: MoveFontFilesResult['failed'] = []
    const moved: MoveFontFilesResult['moved'] = []
    let batchFailureMessage = ''
    if (!uniqueItems.length) return { ok: true, moved, movedCount: 0, failed, message: '没有可移动的字体。' }
    if (!target.ok) {
      return {
        ok: false,
        moved,
        movedCount: 0,
        failed: uniqueItems.map((item) => failedMoveRow(item, moveFailure(item, target.message))),
        message: target.message,
      }
    }

    const preparedRows: PreparedMoveFont[] = []
    for (const item of uniqueItems) {
      const row = await prepareMoveFont(item, target)
      if ('ok' in row) {
        if (row.ok) moved.push({ id: item.id, result: row })
        else failed.push(failedMoveRow(item, row))
      } else {
        preparedRows.push(row)
      }
    }

    const committedAuthorizations: Array<AuthorizedFontDirectory | AuthorizedFontFile> = []
    if (preparedRows.length) {
      try {
        await withSharedLeaseLocks({
          operation: 'move-font-batch',
          resourcePaths: [target.targetFolder, ...preparedRows.map((row) => row.sourcePath)],
          roots: Array.from(new Set([
            target.authorization.rootPath,
            ...preparedRows.map((row) => row.authorization.rootPath),
          ].filter((rootPath): rootPath is string => !!rootPath))),
          appendStartupLog: deps.appendStartupLog,
        }, async () => {
          for (const row of preparedRows) {
            let result: MoveFontFileResult
            try {
              const state = await movePreparedFont(row, target)
              result = {
                ok: true,
                outcome: 'moved',
                message: `已物理移动到：${state.destination}`,
                oldPath: row.sourcePath,
                newPath: state.destination,
              }
            } catch (error) {
              result = resultForExecutionError(row.item, row, error)
            }

            if (result.outcome === 'moved' || result.outcome === 'commit-uncertain' || result.outcome?.startsWith('target-committed-')) {
              committedAuthorizations.push(row.authorization, target.authorization)
            }
            if (result.ok) {
              moved.push({ id: row.item.id, result })
              deps.appendStartupLog(`font physically moved in batch: ${row.sourcePath} -> ${result.newPath}`)
            } else {
              failed.push(failedMoveRow(row.item, result))
              deps.appendStartupLog(`font physical batch move incomplete: outcome=${result.outcome}, source=${row.sourcePath}, destination=${result.newPath || ''}, ${result.message}`)
            }
          }
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        batchFailureMessage = message
        const settledIds = new Set([...moved.map((row) => row.id), ...failed.map((row) => row.id)])
        for (const row of preparedRows) {
          if (!settledIds.has(row.item.id)) failed.push(failedMoveRow(row.item, moveFailure(row.item, message, row.sourcePath)))
        }
      } finally {
        if (committedAuthorizations.length) await reconcileAuthorizedRoots('move-font-batch', committedAuthorizations)
      }
    }

    const movedCount = moved.filter((row) => row.result.outcome === 'moved').length
    const alreadyInTarget = moved.filter((row) => row.result.outcome === 'unchanged').length
    const partialCount = failed.filter((row) => row.result?.outcome === 'target-committed-source-retained').length
    const parts = [
      `批量移动完成：成功 ${movedCount} 个`,
      alreadyInTarget ? `已在目标文件夹 ${alreadyInTarget} 个` : '',
      partialCount ? `目标已提交但源仍保留 ${partialCount} 个` : '',
      failed.length ? `失败 ${failed.length} 个` : '',
      batchFailureMessage ? `失败原因：${batchFailureMessage}` : '',
    ].filter(Boolean)

    return { ok: failed.length === 0, moved, movedCount, failed, message: parts.join('，') }
  }

  return { moveFontFileToFolder, moveFontFilesToFolder }
}
