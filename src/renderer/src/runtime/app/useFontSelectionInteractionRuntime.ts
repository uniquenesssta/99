import type { FontItem } from '@shared/types'
import type { Dispatch,KeyboardEvent,MouseEvent,MutableRefObject,SetStateAction } from 'react'
import type { SelectionRectState } from '../../appRuntime'
import { beginMarqueeSelectionRuntime,handleFontOpenDetailRuntime,handleFontSelectRuntime } from '../../fontSelectionEventRuntime'

export function createAppFontSelectionInteractionRuntime(options: {
  visibleFonts: FontItem[]
  selectedFontId: string
  selectionAnchorFontId: string
  selectedFontIds: string[]
  selectionBaseFontIdsRef: MutableRefObject<string[]>
  setSelectedFontIds: Dispatch<SetStateAction<string[]>>
  setSelectionAnchorFontId: Dispatch<SetStateAction<string>>
  setSelectedFontId: Dispatch<SetStateAction<string>>
  setDetailVisible: Dispatch<SetStateAction<boolean>>
  detailVisible: boolean
  detailCardClickLockUntilRef: MutableRefObject<number>
  setSelectionRect: Dispatch<SetStateAction<SelectionRectState | null>>
  setStatus: Dispatch<SetStateAction<string>>
  setSingleFontSelection: (fontId: string) => void
  requestDetailReveal: (fontId: string) => void
  toggleFontDetail: (font: FontItem) => void
  reportUserActivity: (reason?: string, durationMs?: number) => void
  userActivityIdleWindowMs: number
}) {
  function handleFontSelect(event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>, font: FontItem): void {
    handleFontSelectRuntime(event, font, {
      visibleFonts: options.visibleFonts,
      selectedFontId: options.selectedFontId,
      selectionAnchorFontId: options.selectionAnchorFontId,
      selectedFontIds: options.selectedFontIds,
      setSelectedFontIds: options.setSelectedFontIds,
      setSelectionAnchorFontId: options.setSelectionAnchorFontId,
      setSelectedFontId: options.setSelectedFontId,
      setDetailVisible: options.setDetailVisible,
      detailVisible: options.detailVisible,
      detailCardClickLockUntilRef: options.detailCardClickLockUntilRef,
      setStatus: options.setStatus,
      setSingleFontSelection: options.setSingleFontSelection,
      requestDetailReveal: options.requestDetailReveal,
      toggleFontDetail: options.toggleFontDetail
    })
  }

  function handleFontOpenDetail(event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>, font: FontItem): void {
    handleFontOpenDetailRuntime(event, font, {
      setSingleFontSelection: options.setSingleFontSelection,
      setSelectedFontId: options.setSelectedFontId,
      requestDetailReveal: options.requestDetailReveal,
      setDetailVisible: options.setDetailVisible,
      detailCardClickLockUntilRef: options.detailCardClickLockUntilRef
    })
  }

  function beginMarqueeSelection(event: MouseEvent<HTMLDivElement>): void {
    beginMarqueeSelectionRuntime(event, {
      windowObject: window,
      selectedFontIds: options.selectedFontIds,
      selectionBaseFontIdsRef: options.selectionBaseFontIdsRef,
      setSelectedFontIds: options.setSelectedFontIds,
      setSelectionAnchorFontId: options.setSelectionAnchorFontId,
      setSelectedFontId: options.setSelectedFontId,
      setDetailVisible: options.setDetailVisible,
      setSelectionRect: options.setSelectionRect,
      setStatus: options.setStatus,
      reportUserActivity: options.reportUserActivity,
      userActivityIdleWindowMs: options.userActivityIdleWindowMs
    })
  }

  return { handleFontSelect, handleFontOpenDetail, beginMarqueeSelection }
}
