import { RENDERER_MEMORY_HARD_LIMIT_BYTES,RENDERER_MEMORY_SOFT_LIMIT_BYTES } from './appConstants'
import type { RendererMemoryInfo } from './appTypes'

export function rendererMemoryInfo(): RendererMemoryInfo {
  return ((performance as unknown as { memory?: RendererMemoryInfo }).memory || {})
}

export function rendererMemoryPressure(): 'normal' | 'soft' | 'hard' {
  const info = rendererMemoryInfo()
  const used = info.usedJSHeapSize || 0
  if (!used) return 'normal'
  if (used >= RENDERER_MEMORY_HARD_LIMIT_BYTES) return 'hard'
  if (used >= RENDERER_MEMORY_SOFT_LIMIT_BYTES) return 'soft'
  return 'normal'
}

export function requestIdleWindow(callback: () => void, timeout = 800): number {
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, options?: { timeout?: number }) => number }).requestIdleCallback
  if (typeof idle === 'function') return idle(callback, { timeout })
  return window.setTimeout(callback, Math.min(timeout, 120))
}

export function cancelIdleWindow(id: number): void {
  const cancelIdle = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback
  if (typeof cancelIdle === 'function') cancelIdle(id)
  else window.clearTimeout(id)
}
