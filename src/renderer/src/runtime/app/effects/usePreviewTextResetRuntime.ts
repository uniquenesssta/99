import { useEffect, useRef } from 'react'
export function usePreviewTextResetRuntime(args: {
  previewToken: string
  resetPreviewRuntimeState: () => void
}): boolean {
  const { previewToken, resetPreviewRuntimeState } = args
  const resetRef = useRef(resetPreviewRuntimeState)
  const previousPreviewTokenRef = useRef(previewToken)
  resetRef.current = resetPreviewRuntimeState
  const current = previousPreviewTokenRef.current === previewToken

  useEffect(() => {
    if (previousPreviewTokenRef.current === previewToken) return
    previousPreviewTokenRef.current = previewToken
    resetRef.current()
  }, [previewToken])
  // Hide the previous generation during the render before the reset effect.
  return current
}
