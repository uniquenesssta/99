import { createFontDetailPanelRuntime } from '../../fontDetailPanelRuntime'
import type { FontDetailPanelRuntimeOptions } from '../../fontDetailPanelRuntime'
import type { useSelectionController, SelectionInteractionRuntimeOptions } from './useSelectionController'
import { hydrateFontForSelectionDetail } from './fontSelectionHydrationRuntime'

type SelectionFactory = ReturnType<typeof useSelectionController>['createInteractionRuntime']

export function createAppDetailSelectionRuntime(options: FontDetailPanelRuntimeOptions) {
  const detail = createFontDetailPanelRuntime(options)
  function createSelection(createInteraction: SelectionFactory, selection: Omit<SelectionInteractionRuntimeOptions, 'toggleFontDetail' | 'hydrateFont'>) {
    return createInteraction({
      ...selection,
      toggleFontDetail: detail.toggleFontDetail,
      hydrateFont: (font, keepFontIds) => hydrateFontForSelectionDetail(font, options.setLibrary, keepFontIds)
    })
  }
  return { ...detail, createSelection }
}
