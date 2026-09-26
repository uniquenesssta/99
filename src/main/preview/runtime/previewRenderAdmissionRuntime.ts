import type { WebContents } from 'electron'
import { applicationWorkEpoch, isApplicationClosing } from '../../app/shutdownCoordinatorRuntime'
import type { FontAdmission } from '../native-renderer/directwriteFontStore'

// IPC subscriptions belong to the invoking window. A cancellation cannot cross windows.
export function createPreviewRenderAdmissionRuntime() {
  const owners = new WeakMap<WebContents, Map<string, AbortController>>()
  function cancel(sender: WebContents, token: string): void { owners.get(sender)?.get(token)?.abort() }
  async function run<T>(sender: WebContents, token: string, action: (admission: FontAdmission) => Promise<T>): Promise<T> {
    if (typeof token !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(token)) throw new Error('DW_REQUEST_TOKEN_INVALID')
    let requests = owners.get(sender)
    if (!requests) {
      requests = new Map(); owners.set(sender, requests)
      const cancelAll = () => { for (const controller of requests!.values()) controller.abort() }
      sender.once('destroyed', cancelAll)
      sender.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) cancelAll() })
    }
    if (sender.isDestroyed() || isApplicationClosing()) throw new Error('DW_CLOSING')
    if (requests.size >= 64 || requests.has(token)) throw new Error('DW_REQUEST_LIMIT')
    const controller = new AbortController(), epoch = applicationWorkEpoch()
    requests.set(token, controller)
    const abort = () => controller.abort()
    const timer = setTimeout(abort, 30000)
    const current = () => !controller.signal.aborted && !sender.isDestroyed() && !isApplicationClosing()
      && applicationWorkEpoch() === epoch && requests!.get(token) === controller
    try {
      const cancelled = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('DW_CANCELLED')), { once: true })
      })
      const value = await Promise.race([action({ signal: controller.signal, isCurrent: current }), cancelled])
      if (!current()) throw new Error('DW_STALE')
      return value
    } finally { clearTimeout(timer); requests.delete(token) }
  }
  return { run, cancel }
}
