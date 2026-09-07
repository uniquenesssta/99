import { constants,createReadStream,promises as fsp } from 'node:fs'
import { createHash,randomUUID } from 'node:crypto'
import { basename,join,parse } from 'node:path'

type FontMoveFileSystem = {
  copyFile: (source: string, destination: string, mode?: number) => Promise<void>
  lstat: (filePath: string) => Promise<FontMoveFileStat>
  open: (filePath: string, flags: string) => Promise<{
    sync: () => Promise<void>
    close: () => Promise<void>
  }>
  link: (source: string, destination: string) => Promise<void>
  unlink: (filePath: string) => Promise<void>
}

type FontMoveFileStat = {
  size: number
  mtimeMs: number
  dev: number
  ino: number
  isFile: () => boolean
}

export interface FontMoveCommitOptions {
  fileSystem?: FontMoveFileSystem
  createTempId?: () => string
  digestFile?: (filePath: string) => Promise<string>
}

type FontMoveCommitHooks = {
  revalidate: () => Promise<void>
  verifyDestination: (destination: string) => Promise<void>
}

export type MoveExecutionState = {
  destination: string
  targetCommitted: boolean | undefined
  sourceRetained: boolean | undefined
  recoveryPath?: string
}

export class FontMoveExecutionError extends Error {
  readonly state: MoveExecutionState

  constructor(error: unknown, state: MoveExecutionState) {
    super(error instanceof Error ? error.message : String(error))
    this.name = 'FontMoveExecutionError'
    this.state = { ...state }
  }
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : ''
}

async function defaultDigestFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

function sameFileSnapshot(left: FontMoveFileStat, right: FontMoveFileStat): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs
}

export function createFontFileMoveCommitRuntime(options: FontMoveCommitOptions = {}) {
  const fileSystem = options.fileSystem || fsp
  const createTempId = options.createTempId || randomUUID
  const digestFile = options.digestFile || defaultDigestFile

  const publishExclusive = async (filePath: string, state: MoveExecutionState): Promise<void> => {
    try {
      await fileSystem.link(filePath, state.destination)
      state.targetCommitted = true
    } catch (error) {
      // A NAS can complete an operation but lose the acknowledgement. Do not
      // invent an uncommitted result for an I/O/transport/unknown failure.
      const definitelyRejected = ['EXDEV', 'EEXIST', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EACCES', 'ENOENT', 'ENOSPC', 'EROFS', 'EMLINK']
      if (!definitelyRejected.includes(errorCode(error))) state.targetCommitted = undefined
      throw error
    }
  }

  const pathExists = async (filePath: string): Promise<boolean> => {
    try {
      await fileSystem.lstat(filePath)
      return true
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false
      throw error
    }
  }

  const uniqueDestinationPath = async (targetFolder: string, fileName: string): Promise<string> => {
    const parsed = parse(fileName)
    let candidate = join(targetFolder, fileName)
    let index = 1
    while (await pathExists(candidate)) {
      candidate = join(targetFolder, `${parsed.name} (${index})${parsed.ext}`)
      index += 1
    }
    return candidate
  }

  const flushFile = async (filePath: string): Promise<void> => {
    // Windows FlushFileBuffers needs a write-capable handle.
    const handle = await fileSystem.open(filePath, 'r+')
    let failure: unknown = null
    try {
      await handle.sync()
    } catch (error) {
      failure = error
    }
    try {
      await handle.close()
    } catch (error) {
      failure = failure
        ? new Error(`${String(failure)}；关闭临时文件失败：${String(error)}`)
        : error
    }
    if (failure) throw failure
  }

  const removePrecommitTemp = async (tempPath: string): Promise<string> => {
    try {
      await fileSystem.unlink(tempPath)
      return ''
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return ''
      return `；临时文件清理失败（${tempPath}）：${error instanceof Error ? error.message : String(error)}`
    }
  }

  const moveAcrossDevices = async (
    sourcePath: string,
    targetFolder: string,
    state: MoveExecutionState,
    hooks: FontMoveCommitHooks,
  ): Promise<void> => {
    const tempPath = join(targetFolder, `.hfm-move-${createTempId()}.tmp`)
    let mayOwnTemp = false
    try {
      await hooks.revalidate()
      const sourceBefore = await fileSystem.lstat(sourcePath)
      if (!sourceBefore.isFile()) throw new Error('移动源不再是普通字体文件，请重试。')
      try {
        mayOwnTemp = true
        await fileSystem.copyFile(sourcePath, tempPath, constants.COPYFILE_EXCL)
      } catch (error) {
        if (errorCode(error) === 'EEXIST') mayOwnTemp = false
        throw error
      }

      await flushFile(tempPath)
      const tempStat = await fileSystem.lstat(tempPath)
      if (!tempStat.isFile()) throw new Error('临时文件身份变化，源文件已保留。')
      const sourceDigest = await digestFile(sourcePath)
      const tempDigest = await digestFile(tempPath)
      const sourceAfter = await fileSystem.lstat(sourcePath)
      if (!sameFileSnapshot(sourceBefore, sourceAfter) || sourceAfter.size !== tempStat.size) {
        throw new Error('跨卷复制尺寸校验失败，源文件已保留。')
      }
      if (sourceDigest !== tempDigest) {
        throw new Error('跨卷复制摘要校验失败，源文件已保留。')
      }

      await hooks.revalidate()
      if (await pathExists(state.destination)) {
        throw new Error('移动目标在提交前已存在，未覆盖现有文件。')
      }
      // Node rename overwrites an existing target. link is an atomic no-replace
      // publication; source and completed temp are on the target volume here.
      await publishExclusive(tempPath, state)

      await hooks.revalidate()
      await hooks.verifyDestination(state.destination)
      const currentSourceDigest = await digestFile(sourcePath)
      const committedDigest = await digestFile(state.destination)
      const currentSourceStat = await fileSystem.lstat(sourcePath)
      if (currentSourceDigest !== sourceDigest || committedDigest !== sourceDigest || !sameFileSnapshot(sourceAfter, currentSourceStat)) {
        throw new Error('目标已提交，但源文件内容在删除前发生变化；源文件已保留。')
      }
      await fileSystem.unlink(tempPath)
      mayOwnTemp = false
      await hooks.revalidate()
      if (!sameFileSnapshot(currentSourceStat, await fileSystem.lstat(sourcePath))) {
        throw new Error('删除前源文件身份变化，请重试。')
      }
      await fileSystem.unlink(sourcePath)
      state.sourceRetained = false
    } catch (error) {
      let cleanupSuffix = ''
      if (mayOwnTemp) {
        cleanupSuffix = await removePrecommitTemp(tempPath)
        if (cleanupSuffix) state.recoveryPath = tempPath
      }
      const message = `${error instanceof Error ? error.message : String(error)}${cleanupSuffix}`
      throw new FontMoveExecutionError(new Error(message), state)
    }
  }

  const moveFile = async (
    sourcePath: string,
    targetFolder: string,
    hooks: FontMoveCommitHooks,
  ): Promise<MoveExecutionState> => {
    const state: MoveExecutionState = {
      destination: await uniqueDestinationPath(targetFolder, basename(sourcePath)),
      targetCommitted: false,
      sourceRetained: true,
    }
    try {
      await hooks.revalidate()
      if (await pathExists(state.destination)) throw new Error('移动目标已存在，未覆盖现有文件。')
      try {
        await publishExclusive(sourcePath, state)
      } catch (error) {
        if (errorCode(error) !== 'EXDEV') throw error
        await moveAcrossDevices(sourcePath, targetFolder, state, hooks)
      }

      if (state.sourceRetained) {
        await hooks.revalidate()
        await hooks.verifyDestination(state.destination)
        const sourceStat = await fileSystem.lstat(sourcePath)
        const destinationStat = await fileSystem.lstat(state.destination)
        if (!sameFileSnapshot(sourceStat, destinationStat)) throw new Error('提交后文件身份变化，请重试。')
        await fileSystem.unlink(sourcePath)
        state.sourceRetained = false
      }

      await hooks.verifyDestination(state.destination)
      return state
    } catch (error) {
      const failure = error instanceof FontMoveExecutionError ? error : new FontMoveExecutionError(error, state)
      if (failure.state.targetCommitted && failure.state.sourceRetained) {
        try {
          await fileSystem.lstat(sourcePath)
        } catch (sourceError) {
          failure.state.sourceRetained = errorCode(sourceError) === 'ENOENT' ? false : undefined
        }
      }
      throw failure
    }
  }

  return { moveFile }
}
