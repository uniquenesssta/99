// Stable message codes survive Electron's Error serialization without changing IPC shapes.
export type PreviewFailureKind = 'missing' | 'timeout' | 'unavailable' | 'failed' | 'cancelled'
export function previewFailureMessage(kind: PreviewFailureKind): string {
  return {
    missing: '字体文件不存在，稍后可重新核验。',
    timeout: '预览读取超时，稍后重试。',
    unavailable: '字体或缓存暂不可访问，请检查连接和权限。',
    failed: '字体预览生成失败。',
    cancelled: '本次预览已取消或过期。'
  }[kind]
}
export function previewFailure(kind: PreviewFailureKind): Error {
  return new Error(`[HFM_PREVIEW:${kind}] ${previewFailureMessage(kind)}`)
}
export function previewFailureKind(error: unknown): PreviewFailureKind {
  const value = error as { message?: string; code?: string; reason?: string; name?: string }
  const message = value?.message || String(error)
  const encoded = message.match(/\[HFM_PREVIEW:(missing|timeout|unavailable|failed|cancelled)\]/)
  if (encoded) return encoded[1] as PreviewFailureKind
  const code = value?.code || value?.reason || ''
  if (message.includes('软件正在退出，此操作未继续执行。')) return 'cancelled'
  if (['stale-generation', 'aborted', 'closing', 'cancelled'].includes(code) || value?.name === 'AbortError') return 'cancelled'
  if (code === 'timeout' || code === 'ETIMEDOUT' || value?.name === 'IoDeadlineTimeoutError') return 'timeout'
  if (['EACCES', 'EPERM', 'EIO', 'ENETUNREACH', 'root-offline', 'executor-unavailable'].includes(code) || message.includes('共享位置离线')) return 'unavailable'
  return 'failed'
}
export function hasLegacyMissingPreviewFlag(font: { previewError?: string }): boolean {
  return font.previewError === '字体文件不存在或路径已失效。'
}
// Re-probe this legacy preview-only flag; structural bad-font checks still see all other fields.
export function previewRecordForProbe<T extends { previewError?: string; previewDisabled?: boolean }>(font: T): T {
  return hasLegacyMissingPreviewFlag(font) ? { ...font, previewError: undefined, previewDisabled: false } : font
}
