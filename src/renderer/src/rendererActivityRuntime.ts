export interface MutableNumberRef {
  current: number
}

export interface RendererActivityBridge {
  reportUserActivity?: (durationMs?: number, reason?: string) => Promise<unknown>
  reportRendererLongTask?: (payload: { durationMs?: number; name?: string; startTime?: number; source?: string }) => Promise<unknown>
}

export function reportRendererUserActivity(options: {
  activeUntilRef: MutableNumberRef
  lastReportAtRef: MutableNumberRef
  hfm: RendererActivityBridge
  reason: string
  durationMs: number
  reportIntervalMs: number
  now?: number
}): void {
  const now = options.now ?? Date.now()
  options.activeUntilRef.current = Math.max(options.activeUntilRef.current, now + options.durationMs)
  if (now - options.lastReportAtRef.current < options.reportIntervalMs) return
  options.lastReportAtRef.current = now
  if (typeof options.hfm.reportUserActivity === 'function') {
    void options.hfm.reportUserActivity(options.durationMs, options.reason).catch(() => undefined)
  }
}

export function isRendererUserActive(activeUntilRef: MutableNumberRef, now = Date.now()): boolean {
  return now < activeUntilRef.current
}

export function registerRendererActivityListeners(onActivity: () => void): () => void {
  window.addEventListener('pointerdown', onActivity, { passive: true })
  window.addEventListener('wheel', onActivity, { passive: true })
  window.addEventListener('keydown', onActivity)
  window.addEventListener('dragstart', onActivity)
  return () => {
    window.removeEventListener('pointerdown', onActivity)
    window.removeEventListener('wheel', onActivity)
    window.removeEventListener('keydown', onActivity)
    window.removeEventListener('dragstart', onActivity)
  }
}

export function startRendererLongTaskMonitor(options: {
  hfm: RendererActivityBridge
  source: string
  minDurationMs?: number
  throttleMs?: number
  eventLoopIntervalMs?: number
  eventLoopLagThresholdMs?: number
}): () => void {
  if (typeof options.hfm.reportRendererLongTask !== 'function') return () => undefined

  const minDurationMs = options.minDurationMs ?? 50
  const throttleMs = options.throttleMs ?? 900
  const eventLoopIntervalMs = options.eventLoopIntervalMs ?? 1000
  const eventLoopLagThresholdMs = options.eventLoopLagThresholdMs ?? 80
  const observerCtor = (window as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver
  let lastReportAt = 0
  let observer: PerformanceObserver | null = null

  const reportLongTask = (durationMs: number, name: string, startTime: number): void => {
    const now = performance.now()
    if (durationMs < minDurationMs || now - lastReportAt < throttleMs) return
    lastReportAt = now
    void options.hfm.reportRendererLongTask?.({
      durationMs,
      name,
      startTime: Math.round(startTime),
      source: options.source
    })
  }

  try {
    if (observerCtor) {
      observer = new observerCtor((list) => {
        for (const entry of list.getEntries()) {
          reportLongTask(Math.round(Number(entry.duration || 0)), entry.name || 'longtask', Number(entry.startTime || 0))
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    }
  } catch {
    observer = null
  }

  let expected = performance.now() + eventLoopIntervalMs
  const interval = window.setInterval(() => {
    const now = performance.now()
    const drift = now - expected
    expected = now + eventLoopIntervalMs
    if (drift > eventLoopLagThresholdMs) reportLongTask(Math.round(drift), 'event-loop-lag', now - drift)
  }, eventLoopIntervalMs)

  return () => {
    observer?.disconnect()
    window.clearInterval(interval)
  }
}
