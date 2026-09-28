import type { CSSProperties } from 'react'
import type { getCardPreviewLayout } from '@shared/preview-layout/previewTextFitRuntime'
import { useGridNativePreviewImageTrim } from '../runtime/preview/gridNativePreviewImageTrimRuntime'
import { useGridPreviewVisualFit } from '../runtime/preview/gridPreviewVisualFitRuntime'

export function GridFontPreview({ layout, image, enabled = true, fontFamily, onImageLoad, onImageError }: {
  layout: ReturnType<typeof getCardPreviewLayout>
  image?: string
  enabled?: boolean
  fontFamily?: string
  onImageLoad: () => void
  onImageError: () => void
}): JSX.Element {
  const nativeImage = image?.startsWith('data:image/png') ? image : undefined
  const trimmed = useGridNativePreviewImageTrim(enabled ? nativeImage : undefined)
  const fit = useGridPreviewVisualFit(`${layout.token}:${fontFamily || ''}`, layout.fontSize, trimmed?.clipped, trimmed?.image)
  const style: CSSProperties = { fontFamily, fontSize: layout.fontSize, lineHeight: layout.lineHeight,
    transform: `scale(${fit.scale})` }
  const hints = [layout.hasHiddenLines ? '仅展示前两行' : '', layout.lengthLimited ? '已达预览长度上限' : '',
    fit.overflow ? '内容超出预览范围，请打开详情' : ''].filter(Boolean)
  return <div className="grid-preview" data-overflow={fit.overflow || undefined}>
    <div className="grid-preview-viewport" ref={fit.viewportRef}>
      <div className={`grid-preview-content${nativeImage ? ' grid-preview-png' : ' preview-layout-text preview-layout-grid'}`} ref={fit.contentRef} style={style}>
        {nativeImage ? trimmed && <img src={trimmed.image} alt="字体预览" decoding="async" onLoad={onImageLoad} onError={onImageError} />
          : layout.lines.map((line, index) => <span key={index} className="font-sample-line">{line}</span>)}
      </div>
    </div>
    <div className="grid-preview-hint" title={hints.join('；')}>{hints.join(' · ')}</div>
  </div>
}
