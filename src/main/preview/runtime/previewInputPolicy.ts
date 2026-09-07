// Native mirrors in preview_render/types.rs and preview-input-policy.h are
// checked by diagnostics:preview-input-boundary. PowerShell uses these directly.
export const PREVIEW_INPUT_LIMITS = Object.freeze({
  minWidth: 64, maxWidth: 4096,
  minHeight: 32, maxHeight: 2048,
  minFontSize: 8, maxFontSize: 320,
  maxTextLength: 4096, // UTF-16 code units, matching Windows and JavaScript.
})
export const DEFAULT_PREVIEW_TEXT = '字体预览 AaBb 123'

export type PreviewInput = { text: string; fontSize: number; width: number; height: number }
type UntrustedPreviewInput = { [K in keyof PreviewInput]: unknown }

export class PreviewInputError extends Error {
  constructor(field: keyof PreviewInput) {
    super(`PREVIEW_INPUT_INVALID: ${field} exceeds preview limits or has an invalid type`)
    this.name = 'PreviewInputError'
  }
}

export function normalizePreviewInput(input: UntrustedPreviewInput): PreviewInput {
  const limits = PREVIEW_INPUT_LIMITS
  const invalid = (field: keyof PreviewInput): never => {
    throw new PreviewInputError(field)
  }
  function number(field: 'width' | 'height' | 'fontSize', min: number, max: number, integer: boolean): number {
    const value = input[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) return invalid(field)
    return value
  }
  const width = number('width', limits.minWidth, limits.maxWidth, true)
  const height = number('height', limits.minHeight, limits.maxHeight, true)
  const fontSize = number('fontSize', limits.minFontSize, limits.maxFontSize, false)
  if (typeof input.text !== 'string' || input.text.length > limits.maxTextLength) return invalid('text')
  // Rust JSON rejects unpaired surrogates; do not route those to a fallback.
  for (let i = 0; i < input.text.length; i++) {
    const unit = input.text.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = input.text.charCodeAt(++i)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return invalid('text')
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return invalid('text')
  }
  return { width, height, fontSize, text: input.text || DEFAULT_PREVIEW_TEXT }
}

// One bounded stream per application log sink; never log supplied text/paths.
const rejectionLogs = new WeakMap<(message: string) => void, { at: number; suppressed: number }>()
export function validatePreviewInput(input: UntrustedPreviewInput, log?: (message: string) => void): PreviewInput {
  try {
    return normalizePreviewInput(input)
  } catch (error) {
    if (log) {
      const now = Date.now()
      const previous = rejectionLogs.get(log)
      if (!previous || now - previous.at >= 5000) {
        rejectionLogs.set(log, { at: now, suppressed: 0 })
        log(`${(error as Error).message}; suppressed=${previous?.suppressed || 0}`)
      } else {
        previous.suppressed = Math.min(Number.MAX_SAFE_INTEGER, previous.suppressed + 1)
      }
    }
    throw error
  }
}
