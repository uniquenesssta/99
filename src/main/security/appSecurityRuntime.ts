import { app, BrowserWindow, session } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEV_SERVER_ENV_KEYS = ['ELECTRON_RENDERER_URL', 'VITE_DEV_SERVER_URL'] as const
const BLOCKED_PRODUCTION_SHORTCUTS = new Set(['i', 'j', 'r'])

function packagedRendererUrlPrefix(): string {
  return pathToFileURL(join(app.getAppPath(), 'out', 'renderer')).href
}

function isTrustedPackagedRendererUrl(url: string): boolean {
  return Boolean(url) && url.startsWith(packagedRendererUrlPrefix())
}

export function resolveRendererDevUrl(): string {
  if (app.isPackaged || process.env.HFM_FORCE_DIST === '1') return ''
  return DEV_SERVER_ENV_KEYS.map((key) => process.env[key]).find((value): value is string => Boolean(value)) || ''
}

export function productionDevToolsEnabled(): boolean {
  return !app.isPackaged
}

export function registerPackagedSessionSecurity(appendLog: (message: string) => void): void {
  if (!app.isPackaged) return

  const csp = [
    "default-src 'self' file: hfm-font: data:",
    "script-src 'self' file:",
    "style-src 'self' 'unsafe-inline' file:",
    "img-src 'self' file: hfm-font: data: blob:",
    "font-src 'self' file: hfm-font: data:",
    "connect-src 'self' hfm-font:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "worker-src 'self' file: blob:"
  ].join('; ')

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...(details.responseHeaders || {}) }
    responseHeaders['Content-Security-Policy'] = [csp]
    callback({ responseHeaders })
  })

  appendLog('packaged session security installed: permissions denied by default, CSP enabled')
}

export function registerWindowSecurityGuards(window: BrowserWindow, appendLog: (message: string) => void): void {
  window.webContents.setWindowOpenHandler((details) => {
    appendLog(`blocked new window request: ${details.url}`)
    return { action: 'deny' }
  })

  if (!app.isPackaged) return

  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedPackagedRendererUrl(url)) return
    appendLog(`blocked packaged navigation: ${url}`)
    event.preventDefault()
  })

  window.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toLowerCase()
    const modifierPressed = input.control || input.meta
    const isDevtoolsShortcut = modifierPressed && input.shift && BLOCKED_PRODUCTION_SHORTCUTS.has(key)
    const isReloadShortcut = key === 'f5' || (modifierPressed && key === 'r')

    if (isDevtoolsShortcut || isReloadShortcut) {
      appendLog(`blocked packaged shortcut: key=${input.key}`)
      event.preventDefault()
    }
  })
}
