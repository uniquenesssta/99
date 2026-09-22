import { useRef } from 'react'

export type RendererClosingLifecycleRuntime = {
  isClosing: () => boolean
  beginClosing: () => void
  resume: () => void
  subscribe: (listener: (closing: boolean) => void) => () => void
}

export function createRendererClosingLifecycleRuntime(): RendererClosingLifecycleRuntime {
  let closing = false
  const listeners = new Set<(closing: boolean) => void>()

  const publish = (next: boolean): void => {
    if (closing === next) return
    closing = next
    for (const listener of listeners) listener(closing)
  }

  return {
    isClosing: () => closing,
    beginClosing: () => publish(true),
    resume: () => publish(false),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

export function useRendererClosingLifecycleRuntime(): RendererClosingLifecycleRuntime {
  const runtimeRef = useRef<RendererClosingLifecycleRuntime | null>(null)
  if (!runtimeRef.current) runtimeRef.current = createRendererClosingLifecycleRuntime()
  return runtimeRef.current
}
