import { useEffect } from 'react'

export function useRendererDeveloperStatusLogRuntime(status: string, appendDeveloperStatus: (source: string, message: string, payload?: unknown) => void): void {
  useEffect(() => {
    appendDeveloperStatus('status', status)
  }, [status])
}
