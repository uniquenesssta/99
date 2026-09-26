import type { FontItem } from '@shared/types'
const selections = new WeakMap<object, Promise<boolean>>()
export function usesResidentPreview(hfm: typeof window.hfm): Promise<boolean> {
  let selected = selections.get(hfm)
  if (!selected) {
    selected = typeof hfm.getPreviewBackend === 'function'
      ? hfm.getPreviewBackend().then(value => value === 'directwrite-resident') : Promise.resolve(false)
    selections.set(hfm, selected)
  }
  return selected
}
export async function renderNativePreviewRequest(hfm: typeof window.hfm, font: FontItem, text: string,
  layout: { fontSize: number; width: number; height: number }, current: () => boolean): Promise<string> {
  if (!current()) throw new Error('DW_STALE')
  if (!await usesResidentPreview(hfm)) return hfm.renderPreviewImage(font, text, layout.fontSize, layout.width, layout.height)
  const token = crypto.randomUUID()
  // Observe the existing renderer generation owner, including disposal/scroll/text changes.
  const timer = window.setInterval(() => {
    if (!current()) { window.clearInterval(timer); void hfm.cancelPreviewImage(token).catch(() => undefined) }
  }, 50)
  try {
    if (!current()) throw new Error('DW_STALE')
    const result = await hfm.renderPreviewImage(font, text, layout.fontSize, layout.width, layout.height, token)
    if (!current()) throw new Error('DW_STALE')
    return result
  } finally { window.clearInterval(timer) }
}
