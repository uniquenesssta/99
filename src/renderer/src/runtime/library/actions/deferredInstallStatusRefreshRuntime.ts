import { requestIdleWindow } from '../../../rendererMemory'

export type DeferredInstallStatusRefreshOptions = {
  statusText: string
  setStatus: (message: string) => void
  startRefresh: () => Promise<void>
  delayMs?: number
}

export function scheduleDeferredInstallStatusRefresh(options: DeferredInstallStatusRefreshOptions): void {
  const delayMs = Math.max(300, options.delayMs ?? 1800)
  options.setStatus(`${options.statusText} 已安装状态将在界面空闲后后台刷新。`)

  window.setTimeout(() => {
    requestIdleWindow(() => {
      void options.startRefresh().catch((error) => {
        options.setStatus(`启动后台刷新已安装状态失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }, 2200)
  }, delayMs)
}
