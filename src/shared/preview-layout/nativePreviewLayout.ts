// Versioned pixel contract. Absent layout retains the legacy rendering path.
// v1 deliberately fixes the scale and alignment; unsupported contracts fail closed.
export type NativePreviewLayout = {
  version: 'list-v1' | 'grid-v1'
  fontSizeCssPx: number
  lineHeight: number
  paddingTop: number
  paddingRight: number
  paddingBottom: number
  paddingLeft: number
  textAlign: 'left' | 'center'
  whiteSpace: 'pre'
  canvasWidth: number
  canvasHeight: number
  pixelRatio: 1
}

export function listNativeLayout(fontSize: number, lineCount: number): NativePreviewLayout {
  return {
    version: 'list-v1', fontSizeCssPx: fontSize, lineHeight: 1.16,
    paddingTop: 20, paddingRight: 36, paddingBottom: 20, paddingLeft: 36,
    textAlign: 'left', whiteSpace: 'pre', canvasWidth: 4096,
    canvasHeight: Math.ceil(fontSize * 1.16 * lineCount + 40), pixelRatio: 1,
  }
}

export function gridNativeLayout(fontSize: number, lineCount: number): NativePreviewLayout {
  return {
    version: 'grid-v1', fontSizeCssPx: fontSize, lineHeight: 1.04,
    paddingTop: 20, paddingRight: 28, paddingBottom: 20, paddingLeft: 28,
    textAlign: 'center', whiteSpace: 'pre', canvasWidth: 4096,
    canvasHeight: Math.ceil(fontSize * 1.04 * lineCount + 40), pixelRatio: 1,
  }
}

export function validateNativePreviewLayout(value: unknown, text: string, fontSize: number, width: number, height: number): NativePreviewLayout | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value) || /\r/.test(text) || text.split('\n').length > 2 || fontSize < 18 || fontSize > 72) throw Error('PREVIEW_INPUT_INVALID: layout')
  const grid = (value as NativePreviewLayout).version === 'grid-v1'
  if (grid && (fontSize < 26 || fontSize > 42)) throw Error('PREVIEW_INPUT_INVALID: layout')
  const expected = (grid ? gridNativeLayout : listNativeLayout)(fontSize, text.split('\n').length)
  const supplied = value as Record<string, unknown>
  if (Object.keys(supplied).length !== Object.keys(expected).length || Object.entries(expected).some(([key, item]) => supplied[key] !== item) || width !== expected.canvasWidth || height !== expected.canvasHeight) throw Error('PREVIEW_INPUT_INVALID: layout')
  return expected
}

export function nativePreviewLayoutKey(layout?: NativePreviewLayout): string {
  if (!layout) return ''
  return JSON.stringify([layout.version, layout.fontSizeCssPx, layout.lineHeight,
    layout.paddingTop, layout.paddingRight, layout.paddingBottom, layout.paddingLeft,
    layout.textAlign, layout.whiteSpace, layout.canvasWidth, layout.canvasHeight, layout.pixelRatio])
}
