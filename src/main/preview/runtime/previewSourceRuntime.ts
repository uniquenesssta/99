import { sharedIoResourceKeys } from '../../rust-core/rustSharedIoCommandRuntime'
import { tracePreviewPhase } from './previewTraceRuntime'
import { sharedFileSystem as fsp, withSharedPreviewReads } from '../../path/sharedFileSystemRuntime'
import { withIoDeadlineResult, fileExistsTimeoutMs, awaitPhysicalIoClose } from '../../path/ioDeadlineRuntime'
import { previewFailure, previewFailureKind } from '../../../shared/previewFailure'
import { isTerminalPreviewRenderFailure, type PreviewRenderLifetime } from './previewRenderLifetimeRuntime'

export async function resolvePreviewSource(path: string, resolver: (path: string) => Promise<string | undefined>, localReadBudget?: Pick<PreviewRenderLifetime, 'assertCurrent' | 'remainingMs'>) {
  localReadBudget?.assertCurrent()
  const resourceKeys = await sharedIoResourceKeys([path])
  localReadBudget?.assertCurrent()
  if (resourceKeys.length) {
    // The isolated executor owns a bounded queue wait and starts the 500ms stat
    // deadline only when its child starts. Do not race that queue with another
    // 500ms timer or send shared paths through the local legacy resolver.
    try {
      const stat = await withSharedPreviewReads(() => tracePreviewPhase('font-stat', () => fsp.stat(path)))
      return { path, stat }
    } catch (error) {
      await awaitPhysicalIoClose(error)
      if (isTerminalPreviewRenderFailure(error)) throw error
      const code = (error as { code?: string })?.code
      throw previewFailure(code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : previewFailureKind(error))
    }
  }
  // Only proven local active-font reads may borrow the existing render budget.
  // Separate 500ms timers can reject a healthy local callback during contention;
  // neither hop may mint a new budget, and shared/unknown paths stay above.
  const localTimeoutMs = () => {
    localReadBudget?.assertCurrent()
    return localReadBudget?.remainingMs() ?? fileExistsTimeoutMs()
  }
  const resolved = await withIoDeadlineResult('preview-font-resolve', () => resolver(path), localTimeoutMs())
  if (!resolved.ok) {
    await awaitPhysicalIoClose(resolved.error)
    if (isTerminalPreviewRenderFailure(resolved.error)) throw resolved.error
    throw previewFailure(resolved.timedOut ? 'timeout' : previewFailureKind(resolved.error))
  }
  localReadBudget?.assertCurrent()
  // The legacy resolver also returns undefined on timeout/permission errors and caches misses.
  // Only an authoritative stat of the source can establish absence.
  const sourcePath = resolved.value || path
  const stat = await withIoDeadlineResult('preview-font-stat', () => tracePreviewPhase('font-stat', () => fsp.stat(sourcePath)), localTimeoutMs())
  if (!stat.ok) {
    await awaitPhysicalIoClose(stat.error)
    if (isTerminalPreviewRenderFailure(stat.error)) throw stat.error
    const code = (stat.error as { code?: string })?.code
    throw previewFailure(stat.timedOut ? 'timeout' : code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : previewFailureKind(stat.error))
  }
  localReadBudget?.assertCurrent()
  return { path: sourcePath, stat: stat.value }
}
