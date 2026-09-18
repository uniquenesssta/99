import type { FontItem } from '@shared/types'
import { useEffect,useRef,useState } from 'react'
import type { Dispatch,KeyboardEvent,MouseEvent,SetStateAction } from 'react'
import type { ContextMenuState,EditableMenuTarget,SelectionRectState } from '../../appRuntime'
import { createAppFontSelectionInteractionRuntime } from './useFontSelectionInteractionRuntime'

export type SelectionInteractionRuntimeOptions = {
  visibleFonts: FontItem[]
  setStatus: Dispatch<SetStateAction<string>>
  setSingleFontSelection: (fontId: string) => void
  toggleFontDetail: (font: FontItem) => void
  hydrateFont: (font: FontItem, keepFontIds?: string[]) => void
  reportUserActivity: (reason?: string, durationMs?: number) => void
  userActivityIdleWindowMs: number
}

export function useSelectionController(scopeKey = '') {
  const [selectedFontId, setSelectedFontId] = useState<string>('')
  const selectedFontIdRef = useRef('')
  selectedFontIdRef.current = selectedFontId
  const [selectedFontIds, setSelectedFontIds] = useState<string[]>([])
  const [selectionAnchorFontId, setSelectionAnchorFontId] = useState<string>('')
  const [selectionRect, setSelectionRect] = useState<SelectionRectState | null>(null)
  const [detailVisible, setDetailVisible] = useState(false)
  const detailCardClickLockUntilRef = useRef(0)
  const [pendingDetailRevealFontId, setPendingDetailRevealFontId] = useState('')
  const [assignTagName, setAssignTagName] = useState('')
  const [assignSharedTagName, setAssignSharedTagName] = useState('')
  const [activeLocalTagSuggestionIndex, setActiveLocalTagSuggestionIndex] = useState(0)
  const [activeSharedTagSuggestionIndex, setActiveSharedTagSuggestionIndex] = useState(0)
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null)
  const [renameTarget, setRenameTarget] = useState<EditableMenuTarget | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<EditableMenuTarget | null>(null)
  const selectionBaseFontIdsRef = useRef<string[]>([])

  const previousScopeRef = useRef(scopeKey)
  useEffect(() => {
    if (previousScopeRef.current === scopeKey) return
    previousScopeRef.current = scopeKey
    setSelectedFontIds([])
    setSelectionAnchorFontId('')
    setSelectedFontId('')
    setDetailVisible(false)
    setSelectionRect(null)
    setContextMenu(null)
  }, [scopeKey])

  function removeFontIds(removedFontIds: ReadonlySet<string>): boolean {
    if (!removedFontIds.size) return false
    setSelectedFontIds((prev) => prev.filter((id) => !removedFontIds.has(id)))
    const selectedFontRemoved = removedFontIds.has(selectedFontIdRef.current)
    if (selectedFontRemoved) {
      setSelectedFontId('')
      setDetailVisible(false)
    }
    return selectedFontRemoved
  }

  function createInteractionRuntime(options: SelectionInteractionRuntimeOptions): {
    handleFontSelect: (event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>, font: FontItem) => void
    handleFontOpenDetail: (event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>, font: FontItem) => void
    beginMarqueeSelection: (event: MouseEvent<HTMLDivElement>) => void
  } {
    const inCurrentScope = () => previousScopeRef.current === scopeKey
    const runtime = createAppFontSelectionInteractionRuntime({
      visibleFonts: options.visibleFonts,
      selectedFontId,
      selectionAnchorFontId,
      selectedFontIds,
      selectionBaseFontIdsRef,
      setSelectedFontIds: value => { if (inCurrentScope()) setSelectedFontIds(value) },
      setSelectionAnchorFontId: value => { if (inCurrentScope()) setSelectionAnchorFontId(value) },
      setSelectedFontId: value => { if (inCurrentScope()) setSelectedFontId(value) },
      setDetailVisible: value => { if (inCurrentScope()) setDetailVisible(value) },
      detailVisible,
      detailCardClickLockUntilRef,
      setSelectionRect: value => { if (inCurrentScope()) setSelectionRect(value) },
      setStatus: value => { if (inCurrentScope()) options.setStatus(value) },
      setSingleFontSelection: options.setSingleFontSelection,
      requestDetailReveal: setPendingDetailRevealFontId,
      toggleFontDetail: options.toggleFontDetail,
      reportUserActivity: options.reportUserActivity,
      userActivityIdleWindowMs: options.userActivityIdleWindowMs
    })

    return {
      handleFontSelect(event, font): void {
        if (!inCurrentScope()) return
        options.hydrateFont(font, selectedFontIds)
        runtime.handleFontSelect(event, font)
      },
      handleFontOpenDetail(event, font): void {
        if (!inCurrentScope()) return
        options.hydrateFont(font, selectedFontIds)
        runtime.handleFontOpenDetail(event, font)
      },
      beginMarqueeSelection: event => { if (inCurrentScope()) runtime.beginMarqueeSelection(event) }
    }
  }

  return {
    selectedFontId,
    selectedFontIdRef,
    setSelectedFontId,
    selectedFontIds,
    setSelectedFontIds,
    selectionAnchorFontId,
    setSelectionAnchorFontId,
    selectionRect,
    detailVisible,
    setDetailVisible,
    pendingDetailRevealFontId,
    setPendingDetailRevealFontId,
    assignTagName,
    setAssignTagName,
    assignSharedTagName,
    setAssignSharedTagName,
    activeLocalTagSuggestionIndex,
    setActiveLocalTagSuggestionIndex,
    activeSharedTagSuggestionIndex,
    setActiveSharedTagSuggestionIndex,
    contextMenu,
    setContextMenu,
    renameTarget,
    setRenameTarget,
    renameValue,
    setRenameValue,
    deleteTarget,
    setDeleteTarget,
    removeFontIds,
    createInteractionRuntime
  }
}
