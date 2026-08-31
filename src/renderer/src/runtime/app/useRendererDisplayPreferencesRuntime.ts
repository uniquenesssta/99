import { useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { CardPoolViewMode, ThemeMode } from '../../appRuntime'
import { clampListPreviewFontSize, readStoredListPreviewFontSize, writeStoredListPreviewFontSize } from '../preview/listPreviewSizeRuntime'

type RendererDisplayPreferencesRuntime = {
  themeMode: ThemeMode
  setThemeMode: Dispatch<SetStateAction<ThemeMode>>
  cardPoolViewMode: CardPoolViewMode
  setStoredCardPoolViewMode: (mode: CardPoolViewMode) => void
  listPreviewFontSize: number
  setListPreviewFontSize: (value: number) => void
}

export function useRendererDisplayPreferences(): RendererDisplayPreferencesRuntime {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const stored = window.localStorage.getItem('hfm.themeMode')
    return stored === 'light' ? 'light' : 'dark'
  })
  const [cardPoolViewMode, setCardPoolViewModeState] = useState<CardPoolViewMode>(() => {
    const stored = window.localStorage.getItem('hfm.cardPoolViewMode')
    return stored === 'list' || stored === 'family' ? stored : 'grid'
  })
  const [listPreviewFontSize, setListPreviewFontSizeState] = useState<number>(() => readStoredListPreviewFontSize())

  function setStoredCardPoolViewMode(mode: CardPoolViewMode): void {
    setCardPoolViewModeState(mode)
    window.localStorage.setItem('hfm.cardPoolViewMode', mode)
  }

  function setListPreviewFontSize(value: number): void {
    const next = clampListPreviewFontSize(value)
    setListPreviewFontSizeState(next)
    writeStoredListPreviewFontSize(next)
  }

  return {
    themeMode,
    setThemeMode,
    cardPoolViewMode,
    setStoredCardPoolViewMode,
    listPreviewFontSize,
    setListPreviewFontSize,
  }
}
