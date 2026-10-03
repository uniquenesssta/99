export type FloatingScrollbarState = {
  host: HTMLElement
  verticalBar: HTMLDivElement
  verticalThumb: HTMLDivElement
  horizontalBar: HTMLDivElement
  horizontalThumb: HTMLDivElement
  hovered: boolean
  focused: boolean
  scrolling: boolean
  barHovered: boolean
  dragging: boolean
  blocked: boolean
  cancelDrag: Array<() => void>
  hideTimer: number | null
  cleanup: Array<() => void>
}

export function setupFloatingScrollbars(): () => void {
  const popupSelector = '.context-menu, .cache-menu, .toolbar-popover, .tag-suggestion-list'
  const selector = `.sidebar, .font-list, .font-waterfall, .font-virtual-scroller, .detail-panel, .toolbar-left, .list-preview-scroll, .modal-card, ${popupSelector}`
  const states = new Map<HTMLElement, FloatingScrollbarState>()
  let activeOverlay: HTMLElement | null = null
  let updateRaf = 0
  let syncRaf = 0

  function findActiveOverlay(): HTMLElement | null {
    const visible = (node: HTMLElement) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden'
    const modals = [...document.querySelectorAll<HTMLElement>('.modal-backdrop')].filter(visible)
    const modal = modals.at(-1) || null
    // A modal owns input even if a background popup has not unmounted yet.
    const popups = [...(modal || document).querySelectorAll<HTMLElement>(popupSelector)].filter(visible)
    return popups.at(-1) || modal
  }

  function acceptsInput(state: FloatingScrollbarState): boolean {
    activeOverlay = findActiveOverlay()
    if (!document.body.contains(state.host) || (activeOverlay && !activeOverlay.contains(state.host))) {
      updateState(state)
      return false
    }
    return true
  }

  function createBar(axis: 'vertical' | 'horizontal'): { bar: HTMLDivElement; thumb: HTMLDivElement } {
    const bar = document.createElement('div')
    const thumb = document.createElement('div')
    bar.className = `hfm-floating-scrollbar ${axis}`
    thumb.className = 'hfm-floating-scrollbar-thumb'
    bar.setAttribute('role', 'scrollbar')
    bar.setAttribute('aria-orientation', axis)
    bar.setAttribute('aria-label', axis === 'vertical' ? '垂直滚动' : '水平滚动')
    bar.tabIndex = 0
    bar.appendChild(thumb)
    document.body.appendChild(bar)
    return { bar, thumb }
  }

  function isActive(state: FloatingScrollbarState): boolean {
    return state.hovered || state.focused || state.scrolling || state.barHovered || state.dragging
  }

  function scheduleUpdate(): void {
    if (updateRaf) return
    updateRaf = window.requestAnimationFrame(() => {
      updateRaf = 0
      activeOverlay = findActiveOverlay()
      states.forEach(updateState)
    })
  }

  function showTemporarily(state: FloatingScrollbarState): void {
    state.scrolling = true
    if (state.hideTimer !== null) window.clearTimeout(state.hideTimer)
    state.hideTimer = window.setTimeout(() => {
      state.scrolling = false
      state.hideTimer = null
      scheduleUpdate()
    }, 900)
    scheduleUpdate()
  }

  function updateState(state: FloatingScrollbarState): void {
    const host = state.host
    if (!document.body.contains(host)) {
      removeState(host)
      return
    }

    const blocked = !!activeOverlay && !activeOverlay.contains(host)
    if (blocked && !state.blocked) {
      state.cancelDrag.forEach(cancel => cancel())
      if (state.hideTimer !== null) window.clearTimeout(state.hideTimer)
      state.hideTimer = null
      state.hovered = state.barHovered = state.focused = state.scrolling = false
      for (const bar of [state.verticalBar, state.horizontalBar]) {
        if (document.activeElement === bar) bar.blur()
      }
    } else if (!blocked && state.blocked) {
      state.hovered = host.matches(':hover')
      state.focused = host.contains(document.activeElement)
    }
    state.blocked = blocked
    for (const bar of [state.verticalBar, state.horizontalBar]) {
      bar.tabIndex = blocked ? -1 : 0
      bar.setAttribute('aria-hidden', String(blocked))
      if (blocked) {
        bar.classList.remove('visible')
        bar.style.display = 'none'
      }
    }
    if (blocked) return

    const rect = host.getBoundingClientRect()
    // Per-card horizontal bars must be clipped to the actual scroll viewport,
    // including when virtualization keeps overscan cards outside the screen.
    let left = Math.max(0, rect.left), top = Math.max(0, rect.top)
    let right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom)
    for (let parent = host.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      const bounds = parent.getBoundingClientRect()
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right) }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom) }
    }
    const visible = isActive(state) && right - left > 8 && bottom - top > 8
    const maxTop = host.scrollHeight - host.clientHeight
    const maxLeft = host.scrollWidth - host.clientWidth
    const hasVertical = maxTop > 1 && right - left > 8 && bottom - top > 8
    const hasHorizontal = maxLeft > 1 && right - left > 8 && bottom - top > 8

    state.verticalBar.style.display = hasVertical ? 'block' : 'none'
    state.horizontalBar.style.display = hasHorizontal ? 'block' : 'none'
    state.verticalBar.classList.toggle('visible', visible && hasVertical)
    state.horizontalBar.classList.toggle('visible', visible && hasHorizontal)

    if (hasVertical) {
      const trackHeight = Math.max(0, bottom - top - 8)
      const thumbHeight = Math.min(trackHeight, Math.max(28, (host.clientHeight / host.scrollHeight) * trackHeight))
      const thumbTop = (Math.max(0, Math.min(maxTop, host.scrollTop)) / maxTop) * Math.max(0, trackHeight - thumbHeight)
      state.verticalBar.style.width = '6px'
      state.verticalBar.style.height = `${trackHeight}px`
      state.verticalBar.style.transform = `translate3d(${Math.round(right - 9)}px, ${Math.round(top + 4)}px, 0)`
      state.verticalBar.setAttribute('aria-valuemin', '0')
      state.verticalBar.setAttribute('aria-valuemax', String(maxTop))
      state.verticalBar.setAttribute('aria-valuenow', String(Math.round(host.scrollTop)))
      state.verticalThumb.style.height = `${thumbHeight}px`
      state.verticalThumb.style.transform = `translate3d(0, ${thumbTop}px, 0)`
    }

    if (hasHorizontal) {
      const trackWidth = Math.max(0, right - left - 8)
      const thumbWidth = Math.min(trackWidth, Math.max(28, (host.clientWidth / host.scrollWidth) * trackWidth))
      const thumbLeft = (Math.max(0, Math.min(maxLeft, host.scrollLeft)) / maxLeft) * Math.max(0, trackWidth - thumbWidth)
      state.horizontalBar.style.width = `${trackWidth}px`
      state.horizontalBar.style.height = '6px'
      state.horizontalBar.style.transform = `translate3d(${Math.round(left + 4)}px, ${Math.round(bottom - 9)}px, 0)`
      state.horizontalBar.setAttribute('aria-valuemin', '0')
      state.horizontalBar.setAttribute('aria-valuemax', String(maxLeft))
      state.horizontalBar.setAttribute('aria-valuenow', String(Math.round(host.scrollLeft)))
      state.horizontalThumb.style.width = `${thumbWidth}px`
      state.horizontalThumb.style.transform = `translate3d(${thumbLeft}px, 0, 0)`
    }
  }

  function addListener<K extends keyof HTMLElementEventMap>(host: HTMLElement, type: K, listener: (event: HTMLElementEventMap[K]) => void, state: FloatingScrollbarState, options?: AddEventListenerOptions): void {
    host.addEventListener(type, listener as EventListener, options)
    state.cleanup.push(() => host.removeEventListener(type, listener as EventListener, options))
  }

  function ensureState(host: HTMLElement): void {
    if (states.has(host)) return

    const vertical = createBar('vertical')
    const horizontal = createBar('horizontal')
    const state: FloatingScrollbarState = {
      host,
      verticalBar: vertical.bar,
      verticalThumb: vertical.thumb,
      horizontalBar: horizontal.bar,
      horizontalThumb: horizontal.thumb,
      hovered: false,
      focused: false,
      scrolling: false,
      barHovered: false,
      dragging: false,
      blocked: false,
      cancelDrag: [],
      hideTimer: null,
      cleanup: []
    }

    addListener(host, 'scroll', () => showTemporarily(state), state, { passive: true })
    addListener(host, 'mouseenter', () => { state.hovered = true; scheduleUpdate() }, state)
    addListener(host, 'mouseleave', () => { state.hovered = false; scheduleUpdate() }, state)
    addListener(host, 'focusin', () => { state.focused = true; scheduleUpdate() }, state)
    addListener(host, 'focusout', () => { state.focused = false; scheduleUpdate() }, state)

    for (const axis of ['vertical', 'horizontal'] as const) {
      const bar = axis === 'vertical' ? vertical.bar : horizontal.bar
      const thumb = axis === 'vertical' ? vertical.thumb : horizontal.thumb
      const position = axis === 'vertical' ? 'scrollTop' : 'scrollLeft'
      let pointerId: number | null = null
      let grabOffset = 0
      const move = (event: PointerEvent) => {
        if (!acceptsInput(state)) return
        const bounds = bar.getBoundingClientRect()
        const length = axis === 'vertical' ? bounds.height : bounds.width
        const thumbLength = axis === 'vertical' ? thumb.offsetHeight : thumb.offsetWidth
        const coordinate = axis === 'vertical' ? event.clientY - bounds.top : event.clientX - bounds.left
        const max = axis === 'vertical' ? host.scrollHeight - host.clientHeight : host.scrollWidth - host.clientWidth
        if (length > thumbLength) host[position] = Math.max(0, Math.min(max, (coordinate - grabOffset) / (length - thumbLength) * max))
        showTemporarily(state)
      }
      addListener(bar, 'pointerdown', event => {
        if (event.button !== 0 || !acceptsInput(state)) return
        event.preventDefault()
        event.stopPropagation()
        const bounds = thumb.getBoundingClientRect()
        grabOffset = event.target === thumb
          ? axis === 'vertical' ? event.clientY - bounds.top : event.clientX - bounds.left
          : (axis === 'vertical' ? bounds.height : bounds.width) / 2
        pointerId = event.pointerId
        state.dragging = true
        bar.setPointerCapture(pointerId)
        move(event)
      }, state)
      addListener(bar, 'pointermove', event => { if (event.pointerId === pointerId) move(event) }, state)
      const endDrag = () => {
        if (pointerId === null) return
        pointerId = null
        state.dragging = false
        showTemporarily(state)
      }
      state.cancelDrag.push(() => {
        const captured = pointerId
        pointerId = null
        state.dragging = false
        if (captured !== null && bar.hasPointerCapture(captured)) bar.releasePointerCapture(captured)
      })
      addListener(bar, 'pointerup', event => {
        if (event.pointerId !== pointerId) return
        // Clear our state before releasing browser capture: capture may already
        // have ended, and its loss event must not restart the idle timer.
        endDrag()
        if (bar.hasPointerCapture(event.pointerId)) bar.releasePointerCapture(event.pointerId)
      }, state)
      addListener(bar, 'lostpointercapture', endDrag, state)
      addListener(bar, 'pointercancel', endDrag, state)
      addListener(bar, 'mouseenter', () => { state.barHovered = true; scheduleUpdate() }, state)
      // Leaving/hiding the overlay is not fresh scroll activity. In particular,
      // a hit-test change when pointer-events turns off must not revive its timer.
      addListener(bar, 'mouseleave', () => { state.barHovered = false; scheduleUpdate() }, state)
      addListener(bar, 'focus', () => { state.focused = true; scheduleUpdate() }, state)
      addListener(bar, 'blur', () => { state.focused = false; scheduleUpdate() }, state)
      addListener(bar, 'click', event => event.stopPropagation(), state)
      addListener(bar, 'keydown', event => {
        if (!acceptsInput(state)) return
        const extent = axis === 'vertical' ? host.clientHeight : host.clientWidth
        const max = axis === 'vertical' ? host.scrollHeight - extent : host.scrollWidth - extent
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? max
          : event.key === 'PageDown' ? host[position] + extent : event.key === 'PageUp' ? host[position] - extent
            : event.key === (axis === 'vertical' ? 'ArrowDown' : 'ArrowRight') ? host[position] + 40
              : event.key === (axis === 'vertical' ? 'ArrowUp' : 'ArrowLeft') ? host[position] - 40 : null
        if (next === null) return
        event.preventDefault()
        event.stopPropagation()
        host[position] = Math.max(0, Math.min(max, next))
        showTemporarily(state)
      }, state)
    }

    states.set(host, state)
    resizeObserver?.observe(host)
    updateState(state)
  }

  function removeState(host: HTMLElement): void {
    const state = states.get(host)
    if (!state) return
    states.delete(host)
    state.cancelDrag.forEach(cancel => cancel())
    if (state.hideTimer !== null) window.clearTimeout(state.hideTimer)
    state.cleanup.forEach((cleanup) => cleanup())
    resizeObserver?.unobserve(host)
    state.verticalBar.remove()
    state.horizontalBar.remove()
  }

  function syncHosts(): void {
    activeOverlay = findActiveOverlay()
    const hosts = new Set(Array.from(document.querySelectorAll<HTMLElement>(selector)))
    hosts.forEach(ensureState)
    Array.from(states.keys()).forEach((host) => {
      if (!hosts.has(host) || !document.body.contains(host)) removeState(host)
    })
    scheduleUpdate()
  }

  function scheduleSync(): void {
    if (syncRaf) return
    syncRaf = window.requestAnimationFrame(() => {
      syncRaf = 0
      syncHosts()
    })
  }

  const mutationObserver = new MutationObserver(records => {
    // Our own geometry/ARIA/class writes must not create a perpetual RAF loop.
    if (records.some(record => {
      if (record.target instanceof Element && record.target.closest('.hfm-floating-scrollbar')) return false
      if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => node instanceof Element && node.matches('.hfm-floating-scrollbar'))) return false
      return true
    })) scheduleSync()
  })
  mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleUpdate) : null
  const syncTimer = window.setInterval(scheduleSync, 1200)
  window.addEventListener('resize', scheduleSync)
  document.addEventListener('scroll', scheduleUpdate, true)

  syncHosts()

  return () => {
    window.cancelAnimationFrame(updateRaf)
    window.cancelAnimationFrame(syncRaf)
    window.clearInterval(syncTimer)
    window.removeEventListener('resize', scheduleSync)
    document.removeEventListener('scroll', scheduleUpdate, true)
    mutationObserver.disconnect()
    resizeObserver?.disconnect()
    Array.from(states.keys()).forEach(removeState)
  }
}
