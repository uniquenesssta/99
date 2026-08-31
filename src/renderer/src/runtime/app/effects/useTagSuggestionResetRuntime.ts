import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'

export function useTagSuggestionResetRuntime(args: {
  assignTagName: string
  assignSharedTagName: string
  selectedFontId: string
  setActiveLocalTagSuggestionIndex: Dispatch<SetStateAction<number>>
  setActiveSharedTagSuggestionIndex: Dispatch<SetStateAction<number>>
}): void {
  const { assignTagName, assignSharedTagName, selectedFontId, setActiveLocalTagSuggestionIndex, setActiveSharedTagSuggestionIndex } = args

  useEffect(() => {
    setActiveLocalTagSuggestionIndex(0)
  }, [assignTagName, selectedFontId])

  useEffect(() => {
    setActiveSharedTagSuggestionIndex(0)
  }, [assignSharedTagName, selectedFontId])
}
