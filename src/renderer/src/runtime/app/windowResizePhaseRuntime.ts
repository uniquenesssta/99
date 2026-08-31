export type WindowResizeSettledSubscriber = () => void

const WINDOW_RESIZE_SETTLE_MS = 220
const LAYOUT_TRANSITION_MS = 340

const resizeSettledSubscribers = new Set<WindowResizeSettledSubscriber>()
let resizeListenerCount = 0
let resizeSettledTimer = 0
let layoutTransitionTimer = 0
let resizeActive = false
let lastResizeActivityAt = 0

function setResizeActive(active: boolean): void {
  if (resizeActive === active) return
  resizeActive = active
  const root = document.documentElement
  if (active) root.setAttribute('data-hfm-window-resizing', '1')
  else root.removeAttribute('data-hfm-window-resizing')
}

function notifyResizeSettled(): void {
  setResizeActive(false)
  resizeSettledSubscribers.forEach((subscriber) => {
    try {
      subscriber()
    } catch {
      // Resize-settled subscribers must never block the resize interaction.
    }
  })
}

export function markWindowResizeActive(settleMs = WINDOW_RESIZE_SETTLE_MS): void {
  lastResizeActivityAt = performance.now()
  setResizeActive(true)
  if (resizeSettledTimer) window.clearTimeout(resizeSettledTimer)
  resizeSettledTimer = window.setTimeout(() => {
    resizeSettledTimer = 0
    notifyResizeSettled()
  }, Math.max(80, settleMs))
}


export function markLayoutTransitionActive(durationMs = LAYOUT_TRANSITION_MS): void {
  const root = document.documentElement
  root.setAttribute('data-hfm-layout-transitioning', '1')
  if (layoutTransitionTimer) window.clearTimeout(layoutTransitionTimer)
  layoutTransitionTimer = window.setTimeout(() => {
    layoutTransitionTimer = 0
    root.removeAttribute('data-hfm-layout-transitioning')
  }, Math.max(120, durationMs))
}

export function isWindowResizeActive(): boolean {
  if (resizeActive) return true
  if (document.documentElement.getAttribute('data-hfm-window-resizing') === '1') return true
  return performance.now() - lastResizeActivityAt < WINDOW_RESIZE_SETTLE_MS
}

function handleWindowResize(): void {
  markWindowResizeActive()
}

export function subscribeWindowResizeSettled(subscriber: WindowResizeSettledSubscriber): () => void {
  resizeSettledSubscribers.add(subscriber)
  if (resizeListenerCount === 0) {
    window.addEventListener('resize', handleWindowResize, { passive: true })
  }
  resizeListenerCount += 1

  return () => {
    resizeSettledSubscribers.delete(subscriber)
    resizeListenerCount = Math.max(0, resizeListenerCount - 1)
    if (resizeListenerCount === 0) {
      window.removeEventListener('resize', handleWindowResize)
      if (resizeSettledTimer) {
        window.clearTimeout(resizeSettledTimer)
        resizeSettledTimer = 0
      }
      if (layoutTransitionTimer) {
        window.clearTimeout(layoutTransitionTimer)
        layoutTransitionTimer = 0
      }
      document.documentElement.removeAttribute('data-hfm-layout-transitioning')
      setResizeActive(false)
    }
  }
}
