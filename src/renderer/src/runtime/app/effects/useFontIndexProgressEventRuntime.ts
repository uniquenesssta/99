import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { FontIndexProgressPayload } from '@shared/types'
import { isIndexProgressActive } from '../../../fontIndexEventRuntime'

export function useFontIndexProgressEventRuntime(args: {
  hfm: Window['hfm']
  setLatestIndexProgress: Dispatch<SetStateAction<FontIndexProgressPayload | null>>
  setIndexingActive: Dispatch<SetStateAction<boolean>>
  setStatus: Dispatch<SetStateAction<string>>
  appendDeveloperStatus: (source: string, message: string, payload?: unknown) => void
}): void {
  const { hfm, setLatestIndexProgress, setIndexingActive, setStatus, appendDeveloperStatus } = args

  useEffect(() => {
    if (typeof hfm.onFontIndexProgress !== 'function') {
      return
    }

    const dispose = hfm.onFontIndexProgress((payload: FontIndexProgressPayload) => {
      setLatestIndexProgress(payload)
      setIndexingActive(isIndexProgressActive(payload))
      appendDeveloperStatus('font-index', payload.message, payload)
      setStatus(payload.message)
    })

    return () => dispose()
  }, [])
}
