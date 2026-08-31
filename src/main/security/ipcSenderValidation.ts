import { app } from 'electron'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

function packagedRendererUrlPrefix(): string {
  return pathToFileURL(join(app.getAppPath(), 'out', 'renderer')).href
}

function isTrustedPackagedUrl(url: string): boolean {
  if (!url) return false
  return url.startsWith(packagedRendererUrlPrefix())
}

function isTrustedDevelopmentUrl(url: string): boolean {
  if (!url) return false
  return url.startsWith('http://127.0.0.1:39217/') ||
    url.startsWith('http://localhost:39217/') ||
    url.startsWith(pathToFileURL(join(process.cwd(), 'out', 'renderer')).href)
}

export function assertTrustedIpcSender(event: Electron.IpcMainInvokeEvent, channel: string, appendLog?: (message: string) => void): void {
  const senderUrl = event.senderFrame?.url || event.sender.getURL() || ''
  const trusted = app.isPackaged ? isTrustedPackagedUrl(senderUrl) : isTrustedDevelopmentUrl(senderUrl)
  if (trusted) return

  appendLog?.(`blocked untrusted ipc sender: channel=${channel}, sender=${event.sender.id}, url=${senderUrl || '<empty>'}`)
  throw new Error('Blocked untrusted renderer IPC sender')
}
