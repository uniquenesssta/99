import type { SharedIoAccessPath } from './sharedIoAccessRuntime'
import { AsyncLocalStorage } from 'node:async_hooks'
import { recordOperationWork } from '../logging/operationTraceContext'
import type { IoTaskPriority } from '../performance/ioQueue'
import { getStartupPathRootState, markStartupPathRootUnavailable } from './startupPathAvailabilityRuntime'
import { promises as localFs } from 'node:fs'
import { sharedDatabaseTarget, sharedIoAvailabilityRoot, sharedIoResourceKeys } from '../rust-core/rustSharedIoCommandRuntime'
import { SharedIoProcessError } from './sharedIoProcessRuntime'

const sharedIoSignalScope = new AsyncLocalStorage<AbortSignal>()
export function withSharedIoSignal<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> { return sharedIoSignalScope.run(signal, operation) }
export function currentSharedIoSignal(): AbortSignal | undefined { return sharedIoSignalScope.getStore() }

const priorityScope = new AsyncLocalStorage<IoTaskPriority | number>()
export function withSharedIoPriority<T>(priority: IoTaskPriority | number, operation: () => Promise<T>): Promise<T> { return priorityScope.run(priority, operation) }
export function currentSharedIoPriority(): IoTaskPriority | number | undefined { return priorityScope.getStore() }

const previewReadScope = new AsyncLocalStorage<boolean>()
export function withSharedPreviewReads<T>(operation: () => Promise<T>): Promise<T> { return previewReadScope.run(true, operation) }
export function isSharedPreviewReadScope(): boolean { return previewReadScope.getStore() === true }

export type SharedFileRequest = {
  operation: string; path: string; availabilityRoot?: string; dest?: string; source?: string; transferPath?: string
  recursive?: boolean; force?: boolean; exclusive?: boolean; append?: boolean
  kind?: "events" | "hash" | "metrics" | "root-index" | "preview"; rootPath?: string
  limitBytes?: number; olderThanMs?: number;
  schemaVersion?: number; cacheVersion?: number; scriptDetectionVersion?: number; repairCorrupt?: boolean
  identity?: unknown
}
/** Actual effects of the native filesystem command, excluding local transfer files. */
export function sharedFileAccesses(request: SharedFileRequest): SharedIoAccessPath[] | undefined {
  const read = (path: string, scope: SharedIoAccessPath['scope'] = 'file'): SharedIoAccessPath => ({ path, scope, mode: 'read' })
  const write = (path: string, scope: SharedIoAccessPath['scope'] = 'file'): SharedIoAccessPath => ({ path, scope, mode: 'write' })
  switch (request.operation) {
    case 'stat': case 'lstat': case 'access': case 'readFile': return [read(request.path)]
    // Resolving arbitrary symbolic links requires the conservative alias barrier.
    case 'realpath': return undefined
    case 'readdir': case 'directoryMetadata': case 'treeSnapshot': return [read(request.path, 'tree')]
    case 'sqliteSnapshot': return [read(request.path, 'database')]
    case 'copyFile': case 'link': return request.dest ? [read(request.path), write(request.dest)] : undefined
    case 'renameOwnedFile': return request.source && request.dest ? [write(request.path), write(request.source), write(request.dest)] : undefined
    case 'initializeRootCache': return sharedDatabaseTarget(request.path, true).accesses
    case 'repairRootDatabase': return [...(sharedDatabaseTarget(request.path, true).accesses || []), ...(request.dest ? [write(request.dest, 'tree')] : [])]
    case 'rename': return request.dest ? [write(request.path, 'tree'), write(request.dest, 'tree')] : undefined
    case 'rm': return [write(request.path, request.recursive ? 'tree' : 'file')]
    case 'mkdir': return [write(request.path)]
    case 'writeFile': case 'appendFile': case 'openFile': case 'writeOwnedFile':
    case 'removeOwnedFile': case 'removeStaleLock': case 'syncFile': case 'unlink': return [write(request.path)]
    default: return undefined
  }
}
export type SharedFileResult = { ok: boolean; operation: string; value?: any; code?: string; message?: string }
export type SharedFileExecutor = (request: SharedFileRequest, bytes?: Buffer, signal?: AbortSignal) => Promise<{ result: SharedFileResult; bytes?: Buffer; snapshotPath?: string; dispose?: () => Promise<void> }>
let executor: SharedFileExecutor | undefined
const readsInFlight = new Map<string, ReturnType<SharedFileExecutor>>()
const shareableReads = new Set(['stat','lstat','access','realpath','readdir','readFile','treeSnapshot','directoryMetadata'])
export function configureSharedFileExecutor(value: SharedFileExecutor): void { executor = value }
export async function executeSharedFile(request: SharedFileRequest, bytes?: Buffer, signal?: AbortSignal) {
  signal ||= currentSharedIoSignal()
  if (!executor) throw new SharedIoProcessError('共享文件隔离执行器尚未就绪。', 'not-started', 'executor-unavailable')
  request = { ...request, availabilityRoot: sharedIoAvailabilityRoot(request.path) }
  const key = JSON.stringify(request)
  const root = request.availabilityRoot
  const rootState = root ? getStartupPathRootState(root) : undefined
  if (rootState?.state === 'offline') throw new SharedIoProcessError('共享根处于离线状态。','not-started','root-offline')
  const generation = rootState?.generation
  let task = !signal && shareableReads.has(request.operation) ? readsInFlight.get(key) : undefined
  if (!task) {
    task = executor(request, bytes, signal).then(output => {
      if (request.operation === 'readFile' && output.result.ok && output.result.operation === request.operation && output.bytes) {
        recordOperationWork({ reads: 1, [/\.(ttf|otf|ttc|otc)$/i.test(request.path) ? 'sourceBytes' : 'cacheBytes']: output.bytes.length })
      }
      return output
    })
    if (!signal && shareableReads.has(request.operation)) {
      readsInFlight.set(key, task)
      const pending = task
      void task.finally(() => { if (readsInFlight.get(key) === pending) readsInFlight.delete(key) }).catch(() => undefined)
    }
  }
  let output: Awaited<ReturnType<SharedFileExecutor>>
  try { output = await task }
  catch (error) {
    if (root && (error as SharedIoProcessError).reason === 'ENETUNREACH') markStartupPathRootUnavailable(root,error)
    throw error
  }
  if (root && shareableReads.has(request.operation) && getStartupPathRootState(root).generation !== generation)
    throw new SharedIoProcessError('共享根状态已变化，旧读取结果已丢弃。','unknown','stale-generation')
  if (output.result.operation !== request.operation) throw new SharedIoProcessError('共享文件操作回执不匹配。', 'unknown', 'invalid-receipt')
  if (!output.result.ok) {
    if (!['ENOENT','EEXIST','ENOTDIR','EISDIR'].includes(output.result.code || '')) {
      const error = new SharedIoProcessError(output.result.message || '共享文件状态未能确认。', 'unknown', output.result.code || 'EIO')
      if (root && output.result.code === 'ENETUNREACH') markStartupPathRootUnavailable(root,error)
      throw error
    }
    throw Object.assign(new Error(output.result.message || '共享文件操作失败。'), { code: output.result.code })
  }
  return output
}
function fileInfo(value: any) {
  return { ...value, mtime: new Date(value.mtimeMs), birthtime: new Date(value.birthtimeMs), atime: new Date(value.atimeMs),
    isFile: () => value.isFile === true, isDirectory: () => value.isDirectory === true, isSymbolicLink: () => value.isSymbolicLink === true,
    isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false }
}
const supported = new Set(['stat','lstat','access','realpath','readdir','readFile','writeFile','appendFile','mkdir','copyFile','link','rename','unlink','rm','open'])
function encoding(option: unknown): BufferEncoding | undefined {
  return (typeof option === 'string' ? option : (option as {encoding?: BufferEncoding})?.encoding) as BufferEncoding | undefined
}
// A narrow filesystem adapter keeps local Node semantics and moves only shared
// path operations to a killable native process. File handles never cross it.
export const sharedFileSystem: typeof localFs = new Proxy(localFs, { get(target, property) {
  const original = Reflect.get(target, property)
  if (typeof original !== 'function') return original
  return async (...args: any[]) => {
    const paths = [args[0], ...(['copyFile','rename','link','symlink'].includes(String(property)) ? [args[1]] : [])].filter(value => typeof value === 'string')
    if (!(await sharedIoResourceKeys(paths)).length) {
      const result = await original.apply(target, args)
      if (property === 'readFile' && (Buffer.isBuffer(result) || typeof result === 'string')) {
        const bytes = Buffer.isBuffer(result) ? result.length : Buffer.byteLength(result, encoding(args[1]) || 'utf8')
        recordOperationWork({ reads: 1, [/\.(ttf|otf|ttc|otc)$/i.test(String(args[0])) ? 'sourceBytes' : 'cacheBytes']: bytes })
      }
      if (property === 'open') return new Proxy(result, { get(handle, name) {
        const member = Reflect.get(handle, name)
        if (name === 'read') return async (...input: any[]) => {
          const read = await member.apply(handle, input)
          recordOperationWork({ reads: 1, [/\.(ttf|otf|ttc|otc)$/i.test(String(args[0])) ? 'sourceBytes' : 'cacheBytes']: read.bytesRead })
          return read
        }
        return typeof member === 'function' ? member.bind(handle) : member
      } })
      return result
    }
    const operation = String(property)
    if (!supported.has(operation)) throw new SharedIoProcessError(`共享文件操作尚无隔离协议：${operation}`, 'not-started', 'unsupported-file-operation')
    const option = args[1] && typeof args[1] === 'object' ? args[1] : {}
    const request: SharedFileRequest = { operation, path: args[0] }
    if (operation === 'mkdir' || operation === 'rm') Object.assign(request, {recursive:!!option.recursive,force:!!option.force})
    if (operation === 'copyFile' || operation === 'rename' || operation === 'link') Object.assign(request,{dest:args[1],exclusive:operation==='copyFile' && !!(Number(args[2]) & 1)})
    let bytes: Buffer | undefined
    if (operation === 'writeFile' || operation === 'appendFile') {
      bytes = Buffer.isBuffer(args[1]) ? Buffer.from(args[1]) : Buffer.from(args[1],encoding(args[2]))
      request.exclusive = String(args[2]?.flag || '').includes('x')
    }
    if (operation === 'open') {
      const flags=String(args[1] || 'r')
      if (flags === 'r+') {
        await executeSharedFile({...request,operation:'syncFile'})
        let closed = false
        return { close:async()=>{closed=true}, sync:async()=>{if(closed)throw new Error('文件已关闭。');await executeSharedFile({...request,operation:'syncFile'})} }
      }
      if (!['w','wx','a','ax'].includes(flags)) throw new SharedIoProcessError('共享只读文件请使用隔离 readFile。','not-started','unsupported-file-handle')
      const opened=await executeSharedFile({...request,operation:'openFile',exclusive:flags.includes('x'),append:flags.startsWith('a')})
      let identity=opened.result.value, closed=false
      const check=()=>{if(closed)throw new Error('共享锁文件句柄已关闭。')}
      return {renameOwned:async(source:string,dest:string)=>{check();await executeSharedFile({...request,operation:'renameOwnedFile',source,dest,identity})},removeOwned:async()=>{check();await executeSharedFile({...request,operation:'removeOwnedFile',identity})},close:async()=>{closed=true},sync:async()=>check(),stat:async()=>{check();return sharedFileSystem.stat(request.path)},writeFile:async(data:any,options?:any)=>{
        check();const write=await executeSharedFile({...request,operation:'writeOwnedFile',identity,append:flags.startsWith('a')},Buffer.isBuffer(data)?Buffer.from(data):Buffer.from(data,encoding(options)))
        identity=write.result.value
      }}
    }
    const output=await executeSharedFile(request,bytes,operation === 'readFile' ? option.signal : undefined), value=output.result.value
    if (operation==='stat'||operation==='lstat') return fileInfo(value)
    if (operation==='readdir') return option.withFileTypes ? value.map((entry:any)=>({...fileInfo(entry),parentPath:request.path,path:request.path})) : value.map((entry:any)=>entry.name)
    if (operation==='readFile') {
      return encoding(args[1]) ? output.bytes!.toString(encoding(args[1])) : Buffer.from(output.bytes!)
    }
    return value === null ? undefined : value
  }
} })

export async function sharedSqliteReadSnapshot(filePath: string): Promise<{ path: string; dispose: () => Promise<void> } | undefined> {
  if (!(await sharedIoResourceKeys([filePath])).length) return undefined
  const output=await executeSharedFile({operation:'sqliteSnapshot',path:filePath})
  if (!output.snapshotPath || !output.dispose) throw new Error('共享 SQLite 本地快照未确认。')
  return {path:output.snapshotPath,dispose:output.dispose}
}
