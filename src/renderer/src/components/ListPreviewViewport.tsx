import type { CSSProperties, ReactNode } from 'react'
import type { NativePreviewLayout } from '@shared/preview-layout/nativePreviewLayout'

// Independent interaction surface, outside a native button. Selection remains
// owned by the card; scrolling and preview keyboard events never reach it.
export function ListPreviewViewport({ layout, children }: { layout: NativePreviewLayout; children: ReactNode }): JSX.Element {
  const style = {
    '--list-canvas-width': `${layout.canvasWidth}px`,
    '--list-canvas-height': `${layout.canvasHeight}px`,
    '--list-padding-x': `${layout.paddingLeft}px`,
    '--list-padding-y': `${layout.paddingTop}px`,
  } as CSSProperties
  return <span className="font-row-preview-box list-preview-viewport" style={style}>
    <span className="list-preview-hint">横向滚动查看 · 超出预览边界请打开详情</span>
    <span className="list-preview-scroll" role="region" aria-label="字体预览，方向键横向查看，预览宽度上限 4096 像素" tabIndex={0}
      data-no-card-toggle data-no-marquee draggable={false}
      onPointerDown={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
      onDragStart={event => { event.preventDefault(); event.stopPropagation() }}
      onKeyDown={event => {
        event.stopPropagation()
        const node = event.currentTarget
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault(); node.scrollLeft += event.key === 'ArrowLeft' ? -80 : 80
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault(); node.scrollLeft = event.key === 'Home' ? 0 : node.scrollWidth
        } else if (event.key === ' ' || event.key === 'Enter') event.preventDefault()
      }}>
      <span className="list-preview-canvas">{children}</span>
    </span>
  </span>
}
