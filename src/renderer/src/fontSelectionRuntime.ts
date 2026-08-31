import type { FontItem } from '@shared/types';
import type { SelectionRectState } from './appTypes';
import { isCleanWindowsDefaultFont,isInstalled } from './fontDisplay';

export function clampContextMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuMaxHeight: number,
  viewport: { innerWidth: number; innerHeight: number }
): { x: number; y: number } {
  return {
    x: Math.min(x, Math.max(12, viewport.innerWidth - menuWidth - 12)),
    y: Math.min(y, Math.max(12, viewport.innerHeight - menuMaxHeight - 12))
  }
}

export function singleFontSelection(fontId: string): {
  selectedFontId: string
  selectedFontIds: string[]
  selectionAnchorFontId: string
} {
  return {
    selectedFontId: fontId,
    selectedFontIds: fontId ? [fontId] : [],
    selectionAnchorFontId: fontId
  }
}

export function shiftFontSelection(
  visibleFonts: FontItem[],
  targetFontId: string,
  anchorFontId: string,
  existingSelectedFontIds: string[],
  additive: boolean
): string[] {
  const currentIndex = visibleFonts.findIndex((item) => item.id === targetFontId)
  if (currentIndex < 0) return existingSelectedFontIds

  const anchorIndex = anchorFontId ? visibleFonts.findIndex((item) => item.id === anchorFontId) : -1
  const start = anchorIndex >= 0 ? Math.min(anchorIndex, currentIndex) : currentIndex
  const end = anchorIndex >= 0 ? Math.max(anchorIndex, currentIndex) : currentIndex
  const rangeIds = visibleFonts.slice(start, end + 1).map((item) => item.id)
  return additive ? Array.from(new Set([...existingSelectedFontIds, ...rangeIds])) : rangeIds
}

export function toggleFontSelectionId(selectedFontIds: string[], fontId: string): string[] {
  return selectedFontIds.includes(fontId)
    ? selectedFontIds.filter((id) => id !== fontId)
    : [...selectedFontIds, fontId]
}

export function isFontDeleteProtected(font: FontItem): boolean {
  return !!font.deleteProtected || isCleanWindowsDefaultFont(font)
}

export function selectionLabel(
  fonts: FontItem[],
  displayName: (font: FontItem) => string = (font) => font.fullName || font.family || font.fileName
): string {
  return fonts.length > 1 ? `已选 ${fonts.length} 个字体` : (fonts[0] ? displayName(fonts[0]) : '字体')
}

export function fontsForTagFromLibrary(
  fonts: Record<string, FontItem>,
  tagName: string,
  scope: 'local' | 'shared' = 'local'
): FontItem[] {
  return Object.values(fonts || {}).filter((font) =>
    scope === 'shared'
      ? (font.tagNames || []).includes(tagName)
      : (font.localTagNames || []).includes(tagName)
  )
}

export function batchActivationCandidates(fonts: FontItem[]): FontItem[] {
  return fonts.filter((font) => !font.active && !isInstalled(font) && !isCleanWindowsDefaultFont(font))
}

export function normalizedSelectionRect(rect: SelectionRectState): DOMRect {
  const left = Math.min(rect.startX, rect.currentX)
  const top = Math.min(rect.startY, rect.currentY)
  const right = Math.max(rect.startX, rect.currentX)
  const bottom = Math.max(rect.startY, rect.currentY)
  return new DOMRect(left, top, right - left, bottom - top)
}

export function fontIdsInClientRect(rect: DOMRect, root: ParentNode = document): string[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('.font-card[data-font-id]'))
    .filter((node) => {
      const box = node.getBoundingClientRect()
      return box.right >= rect.left && box.left <= rect.right && box.bottom >= rect.top && box.top <= rect.bottom
    })
    .map((node) => node.dataset.fontId || '')
    .filter(Boolean)
}

export function marqueeSelectedFontIds(
  baseFontIds: string[],
  hitFontIds: string[],
  additive: boolean
): string[] {
  return additive ? Array.from(new Set([...baseFontIds, ...hitFontIds])) : hitFontIds
}

export function canStartMarqueeSelection(target: HTMLElement): boolean {
  return !target.closest('.font-card, input, select, textarea, button, a, [data-no-marquee]')
}
