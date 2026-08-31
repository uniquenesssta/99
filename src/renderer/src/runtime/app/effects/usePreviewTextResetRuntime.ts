import { useEffect, useRef } from 'react'
export function usePreviewTextResetRuntime(args: {
  previewText: string
  listPreviewFontSize: number
  resetPreviewRuntimeState: () => void
}): void {
  const { previewText, listPreviewFontSize, resetPreviewRuntimeState } = args
  const resetRef = useRef(resetPreviewRuntimeState)
  const previousPreviewTokenRef = useRef(`${previewText}::${listPreviewFontSize}`)
  resetRef.current = resetPreviewRuntimeState

  useEffect(() => {
    const token = `${previewText}::${listPreviewFontSize}`
    if (previousPreviewTokenRef.current === token) return
    previousPreviewTokenRef.current = token
    resetRef.current()
  }, [previewText, listPreviewFontSize])
}
