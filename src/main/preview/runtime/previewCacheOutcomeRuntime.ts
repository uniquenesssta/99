import { previewFailureKind } from '../../../shared/previewFailure'

export type PreviewCacheHydrationOutcome = 'hydrated' | 'miss' | 'unavailable' | 'timeout' | 'cancelled' | 'error'

export function previewCacheErrorOutcome(error: unknown): Exclude<PreviewCacheHydrationOutcome, 'hydrated'> {
  const code = (error as { code?: string })?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'miss'
  const kind = previewFailureKind(error)
  return kind === 'missing' ? 'miss' : kind === 'failed' ? 'error' : kind
}
