import { createContext, useContext, useEffect, useState, useRef, type ReactNode } from 'react'
import { isSharedAvailability, type SharedAvailability } from '../../shared/sharedAvailability'

const AvailabilityContext = createContext<SharedAvailability | null>(null)
export function useSharedAvailability(): SharedAvailability | null { return useContext(AvailabilityContext) }

export function SharedAvailabilityProvider({ children }: { children: ReactNode }): JSX.Element {
  const [snapshot, setSnapshot] = useState<SharedAvailability | null>(null)
  const inFlight = useRef<Promise<SharedAvailability | undefined> | null>(null)
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      // Exactly one IPC in flight. A hung bridge disables controls without spawning more calls.
      let expired = false
      deadline = setTimeout(() => { expired = true; if (!disposed) setSnapshot(null) }, 6000)
      try {
        inFlight.current ||= Promise.resolve().then(() => window.hfm.getSharedAvailability?.())
        const value = await inFlight.current
        if (!disposed && !expired) setSnapshot(isSharedAvailability(value) ? value : null)
      } catch { if (!disposed) setSnapshot(null) }
      finally {
        inFlight.current = null
        clearTimeout(deadline)
        if (!disposed) timer = setTimeout(() => void poll(), 2000)
      }
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer); clearTimeout(deadline) }
  }, [])
  return <AvailabilityContext.Provider value={snapshot}>{children}</AvailabilityContext.Provider>
}
