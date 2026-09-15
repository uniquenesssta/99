import { isTrustedRendererUrl } from './appSecurityRuntime'

export function assertTrustedIpcSender(event: Electron.IpcMainInvokeEvent, channel: string, appendLog?: (message: string) => void): void {
  const senderUrl = event.senderFrame?.url || event.sender.getURL() || ''
  if (isTrustedRendererUrl(senderUrl)) return

  appendLog?.(`blocked untrusted ipc sender: channel=${channel}, sender=${event.sender.id}, url=${senderUrl || '<empty>'}`)
  throw new Error('Blocked untrusted renderer IPC sender')
}
