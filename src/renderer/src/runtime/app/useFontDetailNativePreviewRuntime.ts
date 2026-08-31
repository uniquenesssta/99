import type { FontItem } from '@shared/types'
import { getNativePreviewRequestLayout } from '@shared/preview-layout/previewTextFitRuntime'
import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

export function useFontDetailNativePreviewRuntime(options: {
  hfm: typeof window.hfm
  detailVisible: boolean
  selectedFont: FontItem | undefined
  selectedFontPreviewFamily: string
  selectedFailedPreview: true | undefined
  selectedNativePreviewImage: string
  previewText: string
  requestSeqRef: MutableRefObject<number>
  setNativeDetailImage: Dispatch<SetStateAction<string>>
  isBadFontRecord: (font: FontItem) => boolean
}): void {
  const {
    hfm,
    detailVisible,
    selectedFont,
    selectedFontPreviewFamily,
    selectedFailedPreview,
    selectedNativePreviewImage,
    previewText,
    requestSeqRef,
    setNativeDetailImage,
    isBadFontRecord
  } = options

  useEffect(() => {
    const requestId = requestSeqRef.current + 1
    requestSeqRef.current = requestId

    if (!detailVisible || !selectedFont || isBadFontRecord(selectedFont)) {
      setNativeDetailImage('')
      return undefined
    }

    if (selectedFontPreviewFamily && !selectedFont.previewDisabled) {
      setNativeDetailImage('')
      return undefined
    }

    const shouldRenderNativeDetail = Boolean(selectedFont.previewDisabled || selectedFailedPreview || selectedNativePreviewImage)
    if (!shouldRenderNativeDetail) {
      setNativeDetailImage('')
      return undefined
    }

    const fontForPreview = selectedFont
    const previewTextForRequest = previewText
    const detailNativeLayout = getNativePreviewRequestLayout('detail', previewTextForRequest)
    setNativeDetailImage(selectedNativePreviewImage || '')

    const timer = window.setTimeout(() => {
      const loadDetailPreview = async (): Promise<void> => {
        if (typeof hfm.getCachedPreviewImage === 'function') {
          const cachedImage = await hfm.getCachedPreviewImage(fontForPreview, previewTextForRequest, detailNativeLayout.fontSize, detailNativeLayout.width, detailNativeLayout.height).catch(() => '')
          if (requestSeqRef.current !== requestId) return
          if (cachedImage) {
            setNativeDetailImage(cachedImage)
            return
          }
        }

        const image = await hfm.renderPreviewImage(fontForPreview, previewTextForRequest, detailNativeLayout.fontSize, detailNativeLayout.width, detailNativeLayout.height)
        if (requestSeqRef.current !== requestId) return
        setNativeDetailImage(image)
      }

      void loadDetailPreview().catch(() => {
        if (requestSeqRef.current !== requestId) return
        setNativeDetailImage(selectedNativePreviewImage || '')
      })
    }, 180)

    return () => {
      window.clearTimeout(timer)
    }
  }, [selectedFont?.id, selectedFont?.previewDisabled, selectedFontPreviewFamily, selectedFailedPreview, selectedNativePreviewImage, previewText, detailVisible])
}
