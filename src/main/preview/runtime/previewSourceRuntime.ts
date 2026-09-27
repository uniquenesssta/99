import { sharedIoResourceKeys } from '../../rust-core/rustSharedIoCommandRuntime'
import { tracePreviewPhase } from './previewTraceRuntime'
import { sharedFileSystem as fsp, withSharedPreviewReads } from '../../path/sharedFileSystemRuntime'
import { withIoDeadlineResult, fileExistsTimeoutMs } from '../../path/ioDeadlineRuntime'
import { previewFailure, previewFailureKind } from '../../../shared/previewFailure'

export async function resolvePreviewSource(path: string, resolver: (path: string) => Promise<string | undefined>) {
  if ((await sharedIoResourceKeys([path])).length) {
    // The isolated executor owns a bounded queue wait and starts the 500ms stat
    // deadline only when its child starts. Do not race that queue with another
    // 500ms timer or send shared paths through the local legacy resolver.
    try {
      const stat = await withSharedPreviewReads(() => tracePreviewPhase('font-stat', () => fsp.stat(path)))
      return { path, stat }
    } catch (error) {
      await (error as { closed?: Promise<void> })?.closed
      const code = (error as { code?: string })?.code
      throw previewFailure(code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : previewFailureKind(error))
    }
  }
  const resolved = await withIoDeadlineResult('preview-font-resolve', () => resolver(path), fileExistsTimeoutMs())
  if (!resolved.ok) throw previewFailure(resolved.timedOut ? 'timeout' : previewFailureKind(resolved.error))
  // The legacy resolver also returns undefined on timeout/permission errors and caches misses.
  // Only an authoritative stat of the source can establish absence.
  const sourcePath = resolved.value || path
  const stat = await withIoDeadlineResult('preview-font-stat', () => tracePreviewPhase('font-stat', () => fsp.stat(sourcePath)), fileExistsTimeoutMs())
  if (!stat.ok) {
    const code = (stat.error as { code?: string })?.code
    throw previewFailure(stat.timedOut ? 'timeout' : code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : previewFailureKind(stat.error))
  }
  return { path: sourcePath, stat: stat.value }
}
