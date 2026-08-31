import type { FontItem } from '@shared/types'
import type React from 'react'
import type { Dispatch,MutableRefObject,SetStateAction } from 'react'
import type { SelectionRectState } from './appRuntime'
import {
canStartMarqueeSelection,
fontIdsInClientRect,
marqueeSelectedFontIds,
normalizedSelectionRect,
shiftFontSelection,
toggleFontSelectionId
} from './fontSelectionRuntime'

export type FontSelectRuntimeOptions = {
  visibleFonts: FontItem[]
  selectedFontId: string
  selectionAnchorFontId: string
  selectedFontIds: string[]
  setSelectedFontIds: Dispatch<SetStateAction<string[]>>
  setSelectionAnchorFontId: (fontId: string) => void
  setSelectedFontId: (fontId: string) => void
  setDetailVisible: (visible: boolean) => void
  detailVisible: boolean
  detailCardClickLockUntilRef: MutableRefObject<number>
  setStatus: (status: string) => void
  setSingleFontSelection: (fontId: string) => void
  requestDetailReveal: (fontId: string) => void
  toggleFontDetail: (font: FontItem) => void
}

export function handleFontSelectRuntime(
  event: React.MouseEvent<HTMLButtonElement> | React.KeyboardEvent<HTMLButtonElement>,
  font: FontItem,
  options: FontSelectRuntimeOptions
): void {
  const isShift = 'shiftKey' in event && event.shiftKey
  const isCtrl = 'ctrlKey' in event && (event.ctrlKey || event.metaKey)

  if (isShift) {
    const next = shiftFontSelection(
      options.visibleFonts,
      font.id,
      options.selectionAnchorFontId,
      options.selectedFontIds,
      isCtrl
    )
    options.setSelectedFontIds(next)
    options.setSelectedFontId(font.id)
    options.setDetailVisible(false)
    options.setStatus(`已选择 ${next.length} 个字体。`)
    return
  }

  if (isCtrl) {
    options.setSelectedFontIds((prev) => {
      const next = toggleFontSelectionId(prev, font.id)
      options.setStatus(`已选择 ${next.length} 个字体。`)
      return next
    })
    options.setSelectionAnchorFontId(font.id)
    options.setSelectedFontId(font.id)
    options.setDetailVisible(false)
    return
  }

  const now = performance.now()
  const sameAsCurrentDetail = options.selectedFontId === font.id

  if (options.detailVisible && sameAsCurrentDetail) {
    if (now < options.detailCardClickLockUntilRef.current) {
      options.setSingleFontSelection(font.id)
      options.setSelectedFontId(font.id)
      return
    }
    options.setDetailVisible(false)
    return
  }

  options.setSingleFontSelection(font.id)
  options.setSelectedFontId(font.id)
  options.requestDetailReveal(font.id)
  options.detailCardClickLockUntilRef.current = now + 100
  options.setDetailVisible(true)
}

export function handleFontOpenDetailRuntime(
  event: React.MouseEvent<HTMLButtonElement> | React.KeyboardEvent<HTMLButtonElement>,
  font: FontItem,
  options: Pick<FontSelectRuntimeOptions, 'setSingleFontSelection' | 'setSelectedFontId' | 'setDetailVisible' | 'requestDetailReveal' | 'detailCardClickLockUntilRef'>
): void {
  const isShift = 'shiftKey' in event && event.shiftKey
  const isCtrl = 'ctrlKey' in event && (event.ctrlKey || event.metaKey)
  if (isShift || isCtrl) return
  options.setSingleFontSelection(font.id)
  options.setSelectedFontId(font.id)
  options.requestDetailReveal(font.id)
  options.detailCardClickLockUntilRef.current = performance.now() + 100
  options.setDetailVisible(true)
}

export type MarqueeSelectionRuntimeOptions = {
  selectedFontIds: string[]
  selectionBaseFontIdsRef: MutableRefObject<string[]>
  setSelectedFontIds: Dispatch<SetStateAction<string[]>>
  setSelectionAnchorFontId: (fontId: string) => void
  setSelectedFontId: (fontId: string) => void
  setDetailVisible: (visible: boolean) => void
  setSelectionRect: Dispatch<SetStateAction<SelectionRectState | null>>
  setStatus: (status: string) => void
  reportUserActivity: (reason?: string, durationMs?: number) => void
  userActivityIdleWindowMs: number
  windowObject: Window
}

export function applyMarqueeSelectionRuntime(
  rect: SelectionRectState,
  options: Pick<MarqueeSelectionRuntimeOptions,
    'selectionBaseFontIdsRef' |
    'setSelectedFontIds' |
    'setSelectionAnchorFontId' |
    'setSelectedFontId'
  >
): { hitCount: number; selectedIds: string[] } {
  const hitIds = fontIdsInClientRect(normalizedSelectionRect(rect))
  const next = marqueeSelectedFontIds(options.selectionBaseFontIdsRef.current, hitIds, rect.additive)
  options.setSelectedFontIds(next)
  if (next.length) {
    options.setSelectionAnchorFontId(next[next.length - 1])
    options.setSelectedFontId(next[next.length - 1])
  }
  return { hitCount: hitIds.length, selectedIds: next }
}

export function beginMarqueeSelectionRuntime(
  event: React.MouseEvent<HTMLDivElement>,
  options: MarqueeSelectionRuntimeOptions
): void {
  if (event.button !== 0) return
  options.reportUserActivity('marquee', options.userActivityIdleWindowMs)
  const target = event.target as HTMLElement
  if (!canStartMarqueeSelection(target)) return

  event.preventDefault()
  event.stopPropagation()

  const start: SelectionRectState = {
    startX: event.clientX,
    startY: event.clientY,
    currentX: event.clientX,
    currentY: event.clientY,
    additive: event.ctrlKey || event.metaKey
  }

  options.selectionBaseFontIdsRef.current = start.additive ? options.selectedFontIds : []
  options.setDetailVisible(false)
  options.setSelectionRect(start)

  const handleMove = (moveEvent: MouseEvent): void => {
    const next = { ...start, currentX: moveEvent.clientX, currentY: moveEvent.clientY }
    options.setSelectionRect(next)
    applyMarqueeSelectionRuntime(next, options)
  }

  const handleUp = (upEvent: MouseEvent): void => {
    options.windowObject.removeEventListener('mousemove', handleMove)
    options.windowObject.removeEventListener('mouseup', handleUp)
    const next = { ...start, currentX: upEvent.clientX, currentY: upEvent.clientY }
    const result = applyMarqueeSelectionRuntime(next, options)
    options.setSelectionRect(null)
    if (result.hitCount) options.setStatus(`框选完成：${result.hitCount} 个字体。`)
  }

  options.windowObject.addEventListener('mousemove', handleMove)
  options.windowObject.addEventListener('mouseup', handleUp, { once: true })
}
