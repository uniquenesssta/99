export type PreviewCacheFailureKind = 'missing' | 'busy' | 'denied' | 'corrupt' | 'incompatible' | 'unavailable'

// Native cache failures keep their category through one-shot/daemon Error
// serialization. Only an explicit native marker proves a missing database.
export function previewCacheFailureKind(error: unknown): PreviewCacheFailureKind | undefined {
  const value = (error as { message?: unknown } | null)?.message
  const message = typeof value === 'string' ? value : String(error)
  return message.match(/\[HFM_PREVIEW_CACHE:(missing|busy|denied|corrupt|incompatible|unavailable)\]/)?.[1] as PreviewCacheFailureKind | undefined
}
