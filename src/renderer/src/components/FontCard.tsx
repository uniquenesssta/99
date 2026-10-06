import { ListPreviewViewport } from './ListPreviewViewport'
import { sharedPathBlocked } from '@shared/sharedAvailability'
import { useSharedAvailability } from '../sharedAvailabilityRuntime'
import { previewTrace, previewEvent, previewImageTrace, previewTraceEnabled } from '../runtime/preview/previewTraceRuntime'
import { memo,useEffect,useMemo,useRef,useState } from 'react'
import type { CSSProperties } from 'react'
import type { FontCardProps } from '../appRuntime'
import { getCardPreviewLayout } from '@shared/preview-layout/previewTextFitRuntime'
import { fontDisplayName,fontFileDisplayName,formatSize,installLabel,isInstalled,scriptLabels } from '../appRuntime'
import { buildListPreviewCssFamily } from '../runtime/preview/fontPreviewCssFamilyRuntime'
import { isWindowResizeActive,subscribeWindowResizeSettled } from '../runtime/app/windowResizePhaseRuntime'
import { useResizeFrozenPreviewRuntime } from '../runtime/preview/useResizeFrozenPreviewRuntime'
import { GridFontPreview } from './GridFontPreview'

function previewStatusLabel(font: FontCardProps['font']): string {
  if (font.fileAvailability === 'missing' || font.fileAvailability === 'unavailable') return installLabel(font)
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
  const fit = getCardPreviewLayout(mode, previewText, listPreviewFontSize)
  return {
    fontFamily: buildListPreviewCssFamily(font, previewFamily) || undefined,
    fontSize: `${fit.fontSize}px`,
    lineHeight: String(fit.lineHeight),
    textAlign: fit.textAlign
  }
}


function FontCardImpl({ closingLifecycle, font, active, selected, compact, previewStateForFont, previewFamily, previewImage, previewText, listPreviewFontSize, onSelect, onOpenDetail, onVisible, onContextMenu, draggable, onDragStart, onDragEnd }: FontCardProps): JSX.Element {
  const ready = previewStateForFont?.(font)
  if (ready) { previewFamily = ready.family; previewImage = ready.image }
  const ref = useRef<HTMLElement | null>(null)
  const [previewIntersecting, setPreviewIntersecting] = useState(false)
  const requestedLayout = useMemo(() => getCardPreviewLayout(compact ? 'list' : 'grid', previewText, listPreviewFontSize), [compact, previewText, listPreviewFontSize])
  // Re-arm after reset commits: the text/size render can still contain the old image.
  const previewReady = Boolean(previewFamily || previewImage)
  const availability = useSharedAvailability()
  const fileUnavailable = font.fileAvailability === 'missing' || font.fileAvailability === 'unavailable'
  const retryBlocked = fileUnavailable || sharedPathBlocked(availability, font.path)
  const knownRootBlocked = availability !== null && retryBlocked
  const previewIdentity = ready?.key || JSON.stringify([font.id, font.path, font.fileSize, font.modifiedAt, requestedLayout.token])
  const frozenPreview = useResizeFrozenPreviewRuntime(previewIdentity, {
    previewFamily,
    previewImage,
    previewText,
    listPreviewFontSize
  })
  const displayPreviewFamily = fileUnavailable ? undefined : frozenPreview.previewFamily
  const displayPreviewImage = fileUnavailable ? undefined : frozenPreview.previewImage
  const imageTrace = previewImageTrace(displayPreviewImage, font.id)
  const displayPreviewText = frozenPreview.previewText
  const displayListPreviewFontSize = frozenPreview.listPreviewFontSize
  const displayLayout = useMemo(() => getCardPreviewLayout(compact ? 'list' : 'grid', displayPreviewText, displayListPreviewFontSize), [compact, displayPreviewText, displayListPreviewFontSize])
  useEffect(() => {
    if (displayPreviewImage && !displayPreviewFamily) previewEvent(imageTrace, 'card-image-applied')
    else if (displayPreviewFamily) previewEvent(previewTrace(font.id, displayLayout.text, displayLayout.fontSize), 'card-webfont-applied')
  }, [font.id, displayPreviewImage, displayPreviewFamily, displayLayout.text, displayLayout.fontSize, imageTrace])
  const listPreviewLines = displayLayout.lines
  const hasLoadedPreviewFamily = Boolean(displayPreviewFamily)
  const useNativePreviewImage = Boolean(displayPreviewImage && !hasLoadedPreviewFamily)
  const listSampleStyle = useMemo(() => previewSampleStyle(font, 'list', displayPreviewFamily, displayPreviewText, displayListPreviewFontSize), [font, displayPreviewFamily, displayPreviewText, displayListPreviewFontSize])
  const listNativePreviewImageStyle = useMemo<CSSProperties>(() => ({
    height: `${displayLayout.height}px`,
    maxHeight: 'none'
  }), [displayLayout.height])
  const hasListTextPreviewFamily = Boolean(listSampleStyle.fontFamily)
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
    if (!node || knownRootBlocked || fileUnavailable) return

    let cancelled = false
    let intersecting = false
    let retryTimer: number | undefined
    let retryCount = 0
    const retryDelays = [31000, 61000, 121000]
    const stopRetry = (): void => { window.clearTimeout(retryTimer); retryTimer = undefined }
    const scheduleRetry = (): void => {
      if (cancelled || closingLifecycle?.isClosing() || !intersecting || previewReady || retryBlocked || retryTimer !== undefined || retryCount >= retryDelays.length) return
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined
        if (cancelled || closingLifecycle?.isClosing() || !intersecting) return
        retryCount += 1
        if (!isWindowResizeActive()) onVisible(() => !cancelled && intersecting && !closingLifecycle?.isClosing() && !knownRootBlocked)
        scheduleRetry()
      }, retryDelays[retryCount])
    }
    let revealed = false
    let deferVisibleUntilResizeSettled = false
    let unsubscribeResizeSettled: (() => void) | null = null
    let observer: IntersectionObserver | null = null

    const reveal = (): void => {
      if (cancelled || closingLifecycle?.isClosing()) return
      if (revealed) { scheduleRetry(); return }
      revealed = true
      previewEvent(previewTrace(font.id, requestedLayout.text, requestedLayout.fontSize), 'visible')
      onVisible(() => !cancelled && intersecting && !closingLifecycle?.isClosing() && !knownRootBlocked)
      scheduleRetry()
      unsubscribeResizeSettled?.()
      unsubscribeResizeSettled = null
    }

    observer = new IntersectionObserver(
      (entries) => {
        if (cancelled) return
        intersecting = entries[entries.length - 1]?.isIntersecting === true
        if (!compact) setPreviewIntersecting(intersecting)
        if (!intersecting) {
          stopRetry()
          revealed = false
          deferVisibleUntilResizeSettled = false
          return
        }
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
      { root: null, rootMargin: '0px' }
    )

    const unsubscribeClosing = closingLifecycle?.subscribe(closing => {
      if (closing) stopRetry()
      else { revealed = false; if (intersecting) reveal() }
    })
    observer.observe(node)
    return () => {
      cancelled = true
      stopRetry()
      unsubscribeClosing?.()
      deferVisibleUntilResizeSettled = false
      observer?.disconnect()
      unsubscribeResizeSettled?.()
    }
  }, [onVisible, closingLifecycle, font.id, previewIdentity, font.__earlyVisible, requestedLayout.token, previewReady, retryBlocked, knownRootBlocked, fileUnavailable, compact])

  useEffect(() => {
    if (!previewTraceEnabled() || !ref.current) return
    let lastTrace: ReturnType<typeof previewTrace>
    const observer = new IntersectionObserver(entries => {
      lastTrace = previewTrace(font.id, requestedLayout.text, requestedLayout.fontSize)
      previewEvent(lastTrace, entries.some(entry => entry.isIntersecting) ? 'viewport-enter' : 'viewport-leave')
    }, { root: null, rootMargin: '0px' })
    observer.observe(ref.current)
    return () => { observer.disconnect(); previewEvent(lastTrace, 'viewport-unmount') }
  }, [font.id, requestedLayout.token])

  if (compact) {
    return (
      <div role="group" tabIndex={0} aria-label={displayName}
        ref={node => { ref.current = node }}
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
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
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
          <ListPreviewViewport key={displayLayout.token} layout={displayLayout.nativeLayout!}>
            {useNativePreviewImage ? (
              <img onLoad={() => previewEvent(imageTrace, 'image-load')} onError={() => previewEvent(imageTrace, 'image-error')} className="font-sample-image compact" src={displayPreviewImage} alt="字体预览" loading="lazy" decoding="async" style={listNativePreviewImageStyle} />
            ) : (
              <span
                className="font-sample compact preview-layout-text preview-layout-list preview-hard-fit-text"
                style={listSampleStyle}
              >
                {fileUnavailable ? <span className="font-sample-line">{font.fileRelinkRequired || font.fileAvailability === 'missing' ? '请右键重新链接文件' : installLabel(font)}</span> : font.previewDisabled && !hasListTextPreviewFamily ? (
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
          </ListPreviewViewport>
        </span>
      </div>
    )
  }

  return (
    <button
      ref={node => { ref.current = node }}
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
      {fileUnavailable ? <div className="font-sample" style={{ height: displayLayout.height }}>
        {font.fileRelinkRequired || font.fileAvailability === 'missing' ? '请右键重新链接文件' : installLabel(font)}
      </div> : <GridFontPreview layout={displayLayout} image={useNativePreviewImage ? displayPreviewImage : undefined}
        enabled={previewIntersecting}
        fontFamily={buildListPreviewCssFamily(font, displayPreviewFamily) || undefined}
        onImageLoad={() => previewEvent(imageTrace, 'image-load')}
        onImageError={() => previewEvent(imageTrace, 'image-error')} />}
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
