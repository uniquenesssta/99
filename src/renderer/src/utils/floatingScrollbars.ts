export type FloatingScrollbarState = {
  host: HTMLElement
  verticalBar: HTMLDivElement
  verticalThumb: HTMLDivElement
  horizontalBar: HTMLDivElement
  horizontalThumb: HTMLDivElement
  hovered: boolean
  focused: boolean
  scrolling: boolean
  hideTimer: number | null
  cleanup: Array<() => void>
}

export function setupFloatingScrollbars(): () => void {
  const selector = '.sidebar, .font-list, .font-waterfall, .font-virtual-scroller, .detail-panel, .toolbar-left'
  const states = new Map<HTMLElement, FloatingScrollbarState>()
  let updateRaf = 0
  let syncRaf = 0

  function createBar(axis: 'vertical' | 'horizontal'): { bar: HTMLDivElement; thumb: HTMLDivElement } {
    const bar = document.createElement('div')
    const thumb = document.createElement('div')
    bar.className = `hfm-floating-scrollbar ${axis}`
    thumb.className = 'hfm-floating-scrollbar-thumb'
    bar.appendChild(thumb)
    document.body.appendChild(bar)
    return { bar, thumb }
  }

  function isActive(state: FloatingScrollbarState): boolean {
    return state.hovered || state.focused || state.scrolling
  }

  function scheduleUpdate(): void {
    if (updateRaf) return
    updateRaf = window.requestAnimationFrame(() => {
      updateRaf = 0
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

    const rect = host.getBoundingClientRect()
    const visible = isActive(state) && rect.width > 0 && rect.height > 0
    const maxTop = host.scrollHeight - host.clientHeight
    const maxLeft = host.scrollWidth - host.clientWidth
    const hasVertical = maxTop > 1
    const hasHorizontal = maxLeft > 1

    state.verticalBar.style.display = hasVertical ? 'block' : 'none'
    state.horizontalBar.style.display = hasHorizontal ? 'block' : 'none'
    state.verticalBar.classList.toggle('visible', visible && hasVertical)
    state.horizontalBar.classList.toggle('visible', visible && hasHorizontal)

    if (hasVertical) {
      const trackHeight = Math.max(0, rect.height - 8)
      const thumbHeight = Math.max(28, Math.min(trackHeight, (host.clientHeight / host.scrollHeight) * trackHeight))
      const thumbTop = maxTop > 0 ? (host.scrollTop / maxTop) * Math.max(0, trackHeight - thumbHeight) : 0
      state.verticalBar.style.width = '6px'
      state.verticalBar.style.height = `${trackHeight}px`
      state.verticalBar.style.transform = `translate3d(${Math.round(rect.right - 9)}px, ${Math.round(rect.top + 4)}px, 0)`
      state.verticalThumb.style.height = `${thumbHeight}px`
      state.verticalThumb.style.transform = `translate3d(0, ${thumbTop}px, 0)`
    }

    if (hasHorizontal) {
      const trackWidth = Math.max(0, rect.width - 8)
      const thumbWidth = Math.max(28, Math.min(trackWidth, (host.clientWidth / host.scrollWidth) * trackWidth))
      const thumbLeft = maxLeft > 0 ? (host.scrollLeft / maxLeft) * Math.max(0, trackWidth - thumbWidth) : 0
      state.horizontalBar.style.width = `${trackWidth}px`
      state.horizontalBar.style.height = '6px'
      state.horizontalBar.style.transform = `translate3d(${Math.round(rect.left + 4)}px, ${Math.round(rect.bottom - 9)}px, 0)`
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
      hideTimer: null,
      cleanup: []
    }

    addListener(host, 'scroll', () => showTemporarily(state), state, { passive: true })
    addListener(host, 'mouseenter', () => { state.hovered = true; scheduleUpdate() }, state)
    addListener(host, 'mouseleave', () => { state.hovered = false; scheduleUpdate() }, state)
    addListener(host, 'focusin', () => { state.focused = true; scheduleUpdate() }, state)
    addListener(host, 'focusout', () => { state.focused = false; scheduleUpdate() }, state)

    states.set(host, state)
    resizeObserver?.observe(host)
    updateState(state)
  }

  function removeState(host: HTMLElement): void {
    const state = states.get(host)
    if (!state) return
    states.delete(host)
    if (state.hideTimer !== null) window.clearTimeout(state.hideTimer)
    state.cleanup.forEach((cleanup) => cleanup())
    resizeObserver?.unobserve(host)
    state.verticalBar.remove()
    state.horizontalBar.remove()
  }

  function syncHosts(): void {
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

  const mutationObserver = new MutationObserver(scheduleSync)
  mutationObserver.observe(document.body, { childList: true, subtree: true })
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleUpdate) : null
  const syncTimer = window.setInterval(scheduleSync, 1200)
  window.addEventListener('resize', scheduleSync)

  syncHosts()

  return () => {
    window.cancelAnimationFrame(updateRaf)
    window.cancelAnimationFrame(syncRaf)
    window.clearInterval(syncTimer)
    window.removeEventListener('resize', scheduleSync)
    mutationObserver.disconnect()
    resizeObserver?.disconnect()
    Array.from(states.keys()).forEach(removeState)
  }
}
