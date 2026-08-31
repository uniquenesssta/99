import type { FontItem } from '@shared/types'
import type { DragEvent,KeyboardEvent,MouseEvent } from 'react'
import { fontDisplayName } from '../../appRuntime'
import { FontCard } from '../FontCard'

export function createFontCardRenderer(options: {
  detailVisible: boolean
  selectedFontId?: string
  selectedFontIdSet: Set<string>
  previewFamilies: Record<string, string>
  nativePreviewImages: Record<string, string>
  previewText: string
  listPreviewFontSize: number
  selectedFontIds: string[]
  handleFontSelect: (event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>, font: FontItem) => void
  handleFontOpenDetail: (event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>, font: FontItem) => void
  requestPreviewFont: (font: FontItem, priority: 'normal' | 'high') => void
  fontListScrolling: () => boolean
  openFontMenu: (event: MouseEvent, font: FontItem) => void
  setDraggingFontId: (fontId: string) => void
}) {
  function renderFontCard(font: FontItem, compact = false): JSX.Element {
    const active = options.detailVisible && options.selectedFontId === font.id
    const selected = options.selectedFontIdSet.has(font.id)

    return (
      <FontCard
        key={font.id}
        font={font}
        active={active}
        selected={selected}
        compact={compact}
        previewFamily={options.previewFamilies[font.id]}
        previewImage={options.nativePreviewImages[font.id]}
        previewText={options.previewText}
        listPreviewFontSize={options.listPreviewFontSize}
        onSelect={(event) => options.handleFontSelect(event, font)}
        onOpenDetail={(event) => options.handleFontOpenDetail(event, font)}
        onVisible={() => {
          options.requestPreviewFont(font, options.fontListScrolling() ? 'normal' : 'high')
        }}
        onContextMenu={(event) => options.openFontMenu(event, font)}
        draggable
        onDragStart={(event: DragEvent<Element>) => {
          const dragIds = options.selectedFontIds.length > 1 && options.selectedFontIds.includes(font.id) ? options.selectedFontIds : [font.id]
          options.setDraggingFontId(font.id)
          event.dataTransfer.effectAllowed = 'copy'
          event.dataTransfer.setData('application/x-hfm-font-id', font.id)
          event.dataTransfer.setData('application/x-hfm-font-ids', JSON.stringify(dragIds))
          event.dataTransfer.setData('text/plain', dragIds.length > 1 ? `已选 ${dragIds.length} 个字体` : fontDisplayName(font))
        }}
        onDragEnd={() => options.setDraggingFontId('')}
      />
    )
  }

  return { renderFontCard }
}
