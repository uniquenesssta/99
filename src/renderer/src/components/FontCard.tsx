import { memo,useEffect,useMemo,useRef } from 'react'
import type { CSSProperties } from 'react'
import type { FontCardProps } from '../appRuntime'
import { getPreviewTextFit,previewTextLines } from '@shared/preview-layout/previewTextFitRuntime'
import { fontDisplayName,fontFileDisplayName,formatSize,installLabel,isInstalled,scriptLabels } from '../appRuntime'
import { clampListPreviewFontSize,listPreviewNativeImageHeight } from '../runtime/preview/listPreviewSizeRuntime'
import { buildListPreviewCssFamily } from '../runtime/preview/fontPreviewCssFamilyRuntime'
import { isWindowResizeActive,subscribeWindowResizeSettled } from '../runtime/app/windowResizePhaseRuntime'
import { useResizeFrozenPreviewRuntime } from '../runtime/preview/useResizeFrozenPreviewRuntime'
import { gridNativePreviewImageClassName } from '../runtime/preview/gridNativePreviewImageRuntime'
import { useGridNativePreviewImageTrim } from '../runtime/preview/gridNativePreviewImageTrimRuntime'
import { useGridPreviewVisualFitText } from '../runtime/preview/gridPreviewVisualFitRuntime'

function previewStatusLabel(font: FontCardProps['font']): string {
  const message = font.previewError || ''
  if (!message) return installLabel(font)
  if (message.includes('字体文件不存在') || message.includes('路径已失效')) return '路径失效'
  if (message.includes('Chromium WebFont') || message.includes('原生图片预览') || message.includes('Windows 原生')) return '原生预览'
  if (message.includes('预览失败') || message.includes('Native preview')) return '预览异常'
  return '解析异常'
}

function isPreviewErrorState(font: FontCardProps['font']): boolean {
  const message = font.previewError || ''
  if (!message) return false
  if (message.includes('Chromium WebFont') || message.includes('原生图片预览') || message.includes('Windows 原生')) return false
  return true
}

function previewSampleStyle(font: FontCardProps['font'], mode: 'grid' | 'list', previewFamily?: string, previewText?: string, listPreviewFontSize?: number): CSSProperties {
  const fit = getPreviewTextFit(mode, previewText)
  const fontSize = mode === 'list' && listPreviewFontSize !== undefined
    ? clampListPreviewFontSize(listPreviewFontSize)
    : fit.fontSize
  return {
    fontFamily: buildListPreviewCssFamily(font, previewFamily) || undefined,
    fontSize: `${fontSize}px`,
    lineHeight: String(fit.lineHeight),
    textAlign: fit.textAlign
  }
}


function FontCardImpl({ font, active, selected, compact, previewFamily, previewImage, previewText, listPreviewFontSize, onSelect, onOpenDetail, onVisible, onContextMenu, draggable, onDragStart, onDragEnd }: FontCardProps): JSX.Element {
  const ref = useRef<HTMLButtonElement | null>(null)
  const frozenPreview = useResizeFrozenPreviewRuntime(font.id, {
    previewFamily,
    previewImage,
    previewText,
    listPreviewFontSize
  })
  const displayPreviewFamily = frozenPreview.previewFamily
  const displayPreviewImage = frozenPreview.previewImage
  const displayPreviewText = frozenPreview.previewText
  const displayListPreviewFontSize = frozenPreview.listPreviewFontSize
  const gridPreviewLines = useMemo(() => previewTextLines(displayPreviewText, 2), [displayPreviewText])
  const listPreviewLines = useMemo(() => previewTextLines(displayPreviewText, 2), [displayPreviewText])
  const hasLoadedPreviewFamily = Boolean(displayPreviewFamily)
  const useNativePreviewImage = Boolean(displayPreviewImage && !hasLoadedPreviewFamily)
  const useGridNativePreviewImage = Boolean(displayPreviewImage && !hasLoadedPreviewFamily)
  const {
    fittedText: gridVisualPreviewText,
    visualFitRef: gridVisualFitRef,
    visualFitActive: gridVisualFitActive,
  } = useGridPreviewVisualFitText(displayPreviewText || '', gridPreviewLines, !useGridNativePreviewImage)
  const gridVisualPreviewLines = useMemo(() => previewTextLines(gridVisualPreviewText, 2), [gridVisualPreviewText])
  const gridSampleStyle = useMemo(() => previewSampleStyle(font, 'grid', displayPreviewFamily, gridVisualPreviewText), [font, displayPreviewFamily, gridVisualPreviewText])
  const listSampleStyle = useMemo(() => previewSampleStyle(font, 'list', displayPreviewFamily, displayPreviewText, displayListPreviewFontSize), [font, displayPreviewFamily, displayPreviewText, displayListPreviewFontSize])
  const listNativePreviewImageStyle = useMemo<CSSProperties>(() => ({
    height: `${listPreviewNativeImageHeight(displayListPreviewFontSize ?? 44, listPreviewLines.length)}px`,
    maxHeight: 'none'
  }), [displayListPreviewFontSize, listPreviewLines.length])
  const hasListTextPreviewFamily = Boolean(listSampleStyle.fontFamily)
  const hasGridTextPreviewFamily = Boolean(gridSampleStyle.fontFamily)
  const gridNativePreviewImageSrc = useGridNativePreviewImageTrim(useGridNativePreviewImage ? displayPreviewImage : undefined) || displayPreviewImage
  const displayName = fontDisplayName(font)
  const fileDisplayName = fontFileDisplayName(font)
  const secondaryName = font.fullName && font.fullName !== displayName
    ? font.fullName
    : font.postscriptName || font.fileName || fileDisplayName
  const postscriptName = font.postscriptName || font.fileName || fileDisplayName
  const installed = isInstalled(font) || font.active
  const installStatusLabel = previewStatusLabel(font)
  const previewErrorState = isPreviewErrorState(font)
  const previewStatusTitle = font.previewError ? `预览状态：${font.previewError}` : installStatusLabel

  useEffect(() => {
    const node = ref.current
    if (!node) return

    let revealed = false
    let deferVisibleUntilResizeSettled = false
    let unsubscribeResizeSettled: (() => void) | null = null
    let observer: IntersectionObserver | null = null

    const reveal = (): void => {
      if (revealed) return
      revealed = true
      onVisible()
      observer?.disconnect()
      unsubscribeResizeSettled?.()
      unsubscribeResizeSettled = null
    }

    observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        if (isWindowResizeActive()) {
          deferVisibleUntilResizeSettled = true
          if (!unsubscribeResizeSettled) {
            unsubscribeResizeSettled = subscribeWindowResizeSettled(() => {
              if (!deferVisibleUntilResizeSettled) return
              deferVisibleUntilResizeSettled = false
              reveal()
            })
          }
          return
        }
        reveal()
      },
      { root: null, rootMargin: '260px' }
    )

    observer.observe(node)
    return () => {
      observer?.disconnect()
      unsubscribeResizeSettled?.()
    }
  }, [onVisible])

  if (compact) {
    return (
      <button
        ref={ref}
        data-font-id={font.id}
        className={`font-card font-list-row font-list-row-simple${active ? ' active' : ''}${selected ? ' selected' : ''}${font.deleteProtected ? ' delete-protected' : ''}${previewErrorState ? ' has-error' : ''}`}
        onMouseDown={(event) => {
          if (event.button !== 0) return
          const target = event.target as HTMLElement
          const interactive = target.closest('input, select, textarea, a, [data-no-card-toggle]')
          if (interactive && event.currentTarget.contains(interactive)) return

          event.preventDefault()
          event.stopPropagation()

          const node = event.currentTarget
          node.classList.add('pressed')
          window.setTimeout(() => node.classList.remove('pressed'), 110)
          onSelect(event)
        }}
        onClick={(event) => {
          event.preventDefault()
        }}
        onDoubleClick={(event) => {
          if (!onOpenDetail) return
          event.preventDefault()
          event.stopPropagation()
          onOpenDetail(event)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          const node = event.currentTarget
          node.classList.add('pressed')
          window.setTimeout(() => node.classList.remove('pressed'), 110)
          if (event.key === 'Enter' && onOpenDetail) {
            onOpenDetail(event)
            return
          }
          onSelect(event)
        }}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onContextMenu={onContextMenu}
        title="左键选择；详情打开时点击不同字体切换详情，点击当前字体关闭详情；双击打开详情；右键安装、移除、激活、取消激活；可拖入文件夹做软件内归类"
      >
        <span className="font-row-select" aria-hidden="true">
          <span className="font-row-checkbox">{selected ? '✓' : ''}</span>
        </span>

        <span className="font-row-name font-row-name-simple">
          <span className="font-row-title-line">
            <span className="font-row-title">{displayName}</span>
            {font.favorite && <span className="font-row-favorite">★</span>}
            {font.deleteProtected && <span className="font-row-mini protect">保护</span>}
          </span>
          <span className="font-row-subtitle">{secondaryName}</span>
          <span className="font-row-postscript">{postscriptName}</span>
          <span className="font-row-status-chips">
            <span title={previewStatusTitle} className={previewErrorState ? 'font-row-state-chip error' : font.previewError ? 'font-row-state-chip idle' : installed ? 'font-row-state-chip installed' : 'font-row-state-chip idle'}>
              {installStatusLabel}
            </span>
            {font.active && <span className="font-row-state-chip active">已激活</span>}
            {font.previewDisabled && !font.previewError && !hasListTextPreviewFamily && <span className="font-row-state-chip idle">原生预览中</span>}
          </span>
        </span>

        <span className="font-row-preview font-row-preview-wide">
          <span className="font-row-preview-box">
            {useNativePreviewImage ? (
              <img className="font-sample-image compact" src={displayPreviewImage} alt="字体预览" loading="lazy" decoding="async" style={listNativePreviewImageStyle} />
            ) : (
              <span
                className="font-sample compact preview-layout-text preview-layout-list preview-hard-fit-text"
                style={listSampleStyle}
              >
                {font.previewDisabled && !hasListTextPreviewFamily ? (
                  <>
                    <span className="font-sample-line">原生预览生成中</span>
                    <span className="font-sample-line font-sample-latin">AaBb 123</span>
                  </>
                ) : (
                  <>
                    {listPreviewLines.map((line, index) => (
                      <span key={`${index}-${line}`} className={/^[\x00-\x7F\s]+$/.test(line) ? 'font-sample-line font-sample-latin' : 'font-sample-line'}>{line}</span>
                    ))}
                  </>
                )}
              </span>
            )}
          </span>
        </span>
      </button>
    )
  }

  return (
    <button
      ref={ref}
      data-font-id={font.id}
      className={`font-card${active ? ' active' : ''}${selected ? ' selected' : ''}${font.deleteProtected ? ' delete-protected' : ''}`}
      onMouseDown={(event) => {
        if (event.button !== 0) return
        const target = event.target as HTMLElement
        const interactive = target.closest('input, select, textarea, a, [data-no-card-toggle]')
        if (interactive && event.currentTarget.contains(interactive)) return

        event.preventDefault()
        event.stopPropagation()

        const node = event.currentTarget
        node.classList.add('pressed')
        window.setTimeout(() => node.classList.remove('pressed'), 110)
        onSelect(event)
      }}
      onClick={(event) => {
        // 选择已经在 mouseDown 完成，避免 click 阶段再次触发。
        event.preventDefault()
      }}
      onDoubleClick={(event) => {
        if (!onOpenDetail) return
        event.preventDefault()
        event.stopPropagation()
        onOpenDetail(event)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        const node = event.currentTarget
        node.classList.add('pressed')
        window.setTimeout(() => node.classList.remove('pressed'), 110)
        if (event.key === 'Enter' && onOpenDetail) {
          onOpenDetail(event)
          return
        }
        onSelect(event)
      }}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onContextMenu={onContextMenu}
      title="左键选择；详情打开时点击不同字体切换详情，点击当前字体关闭详情；双击打开详情；右键安装、移除、激活、取消激活；可拖入文件夹做软件内归类"
    >
      <div className="font-card-head">
        <span className="font-name">{fontFileDisplayName(font)}</span>
        <span className="font-format">{font.format.toUpperCase()}</span>
      </div>
      <div className="script-row small">
        {scriptLabels(font).slice(0, 4).map((label) => <span key={label} className="script-pill">{label}</span>)}
      </div>
      {useGridNativePreviewImage ? (
        <img className={gridNativePreviewImageClassName(gridNativePreviewImageSrc)} src={gridNativePreviewImageSrc} alt="字体预览" loading="lazy" decoding="async" />
      ) : (
        <div ref={gridVisualFitRef} className={`font-sample preview-layout-text preview-layout-grid${gridVisualFitActive ? ' grid-preview-visual-fit-active' : ''}`} style={gridSampleStyle}>
          {font.previewDisabled && !hasGridTextPreviewFamily ? (
            <>
              <span className="font-sample-line">原生预览生成中</span>
              <span className="font-sample-line font-sample-latin">AaBb 123</span>
            </>
          ) : (
            <>
              {gridVisualPreviewLines.map((line, index) => (
                <span key={`${index}-${line}`} className={/^[\x00-\x7F\s]+$/.test(line) ? 'font-sample-line font-sample-latin' : 'font-sample-line'}>{line}</span>
              ))}
            </>
          )}
        </div>
      )}
      <div className="tag-row small">
        {(font.tagNames || []).slice(0, 4).map((tag) => <span key={tag} className="tag-pill">{tag}</span>)}
      </div>
      <div className="font-meta">
        {font.favorite ? '★ 收藏 · ' : ''}
        {font.style || 'Regular'} · {formatSize(font.fileSize)}
      </div>
      <div className={isInstalled(font) || font.active ? 'install-badge installed' : 'install-badge'}>
        {installLabel(font)}
      </div>
      {font.deleteProtected && <div className="protect-badge">保护</div>}
    </button>
  )
}


export const FontCard = memo(FontCardImpl)
