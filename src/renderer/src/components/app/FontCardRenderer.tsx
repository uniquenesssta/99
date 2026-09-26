import type { FontItem } from '@shared/types'
import { useCallback,useLayoutEffect,useRef } from 'react'
import type { KeyboardEvent,MouseEvent } from 'react'
import { fontDisplayName } from '../../appRuntime'
import type { FontCardProps } from '../../appRuntime'
import { FontCard } from '../FontCard'

interface FontCardRendererOptions {
  closingLifecycle?: FontCardProps['closingLifecycle']
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
}

interface FontCardHandlers {
  onSelect: FontCardProps['onSelect']
  onOpenDetail: NonNullable<FontCardProps['onOpenDetail']>
  onVisible: FontCardProps['onVisible']
  onContextMenu: FontCardProps['onContextMenu']
  onDragStart: NonNullable<FontCardProps['onDragStart']>
  onDragEnd: NonNullable<FontCardProps['onDragEnd']>
}

export function useFontCardRenderer(options: FontCardRendererOptions) {
  const latestOptionsRef = useRef(options)
  useLayoutEffect(() => {
    latestOptionsRef.current = options
  }, [options])
  const handlerCacheRef = useRef(new WeakMap<FontItem, FontCardHandlers>())
  const {
    closingLifecycle,
    detailVisible,
    selectedFontId,
    selectedFontIdSet,
    previewFamilies,
    nativePreviewImages,
    previewText,
    listPreviewFontSize
  } = options

  const renderFontCard = useCallback((font: FontItem, compact = false): JSX.Element => {
    let handlers = handlerCacheRef.current.get(font)
    if (!handlers) {
      handlers = {
        onSelect: (event) => latestOptionsRef.current.handleFontSelect(event, font),
        onOpenDetail: (event) => latestOptionsRef.current.handleFontOpenDetail(event, font),
        onVisible: () => {
          const current = latestOptionsRef.current
          current.requestPreviewFont(font, current.fontListScrolling() ? 'normal' : 'high')
        },
        onContextMenu: (event) => latestOptionsRef.current.openFontMenu(event, font),
        onDragStart: (event) => {
          const current = latestOptionsRef.current
          const dragIds = current.selectedFontIds.length > 1 && current.selectedFontIds.includes(font.id) ? current.selectedFontIds : [font.id]
          current.setDraggingFontId(font.id)
          event.dataTransfer.effectAllowed = 'copy'
          event.dataTransfer.setData('application/x-hfm-font-id', font.id)
          event.dataTransfer.setData('application/x-hfm-font-ids', JSON.stringify(dragIds))
          event.dataTransfer.setData('text/plain', dragIds.length > 1 ? `已选 ${dragIds.length} 个字体` : fontDisplayName(font))
        },
        onDragEnd: () => latestOptionsRef.current.setDraggingFontId('')
      }
      handlerCacheRef.current.set(font, handlers)
    }

    const active = detailVisible && selectedFontId === font.id
    const selected = selectedFontIdSet.has(font.id)

    return (
      <FontCard
        key={font.id}
        closingLifecycle={closingLifecycle}
        font={font}
        active={active}
        selected={selected}
        compact={compact}
        previewFamily={previewFamilies[font.id]}
        previewImage={nativePreviewImages[font.id]}
        previewText={previewText}
        listPreviewFontSize={listPreviewFontSize}
        onSelect={handlers.onSelect}
        onOpenDetail={handlers.onOpenDetail}
        onVisible={handlers.onVisible}
        onContextMenu={handlers.onContextMenu}
        draggable
        onDragStart={handlers.onDragStart}
        onDragEnd={handlers.onDragEnd}
      />
    )
  }, [closingLifecycle, detailVisible, selectedFontId, selectedFontIdSet, previewFamilies, nativePreviewImages, previewText, listPreviewFontSize])

  return { renderFontCard }
}
