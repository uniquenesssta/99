const DEFAULT_PREVIEW_RENDER_CONCURRENCY = 5
const DEFAULT_PREVIEW_RENDER_GLOBAL_MAX = 6

function parseEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

export function previewRenderConcurrency(): number {
  return parseEnvInt('HFM_PREVIEW_RENDER_CONCURRENCY', DEFAULT_PREVIEW_RENDER_CONCURRENCY, 1, 8)
}

export function previewRenderGlobalConcurrencyFloor(): number {
  const renderConcurrency = previewRenderConcurrency()
  const fallback = Math.max(DEFAULT_PREVIEW_RENDER_GLOBAL_MAX, renderConcurrency + 1)
  return parseEnvInt('HFM_RUST_CORE_GLOBAL_MAX_CONCURRENCY', fallback, Math.max(2, renderConcurrency), 8)
}

export function normalizePreviewRenderConcurrency(command: string, maxConcurrency: number): number {
  if (command !== '--preview-render-image') return maxConcurrency
  return previewRenderConcurrency()
}
