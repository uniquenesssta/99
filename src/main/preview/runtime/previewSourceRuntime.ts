import { tracePreviewPhase } from './previewTraceRuntime'
import { sharedFileSystem as fsp } from '../../path/sharedFileSystemRuntime'
import { withIoDeadlineResult, fileExistsTimeoutMs } from '../../path/ioDeadlineRuntime'
import { previewFailure, previewFailureKind } from '../../../shared/previewFailure'

export async function resolvePreviewSource(path: string, resolver: (path: string) => Promise<string | undefined>) {
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
