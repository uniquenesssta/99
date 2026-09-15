import { app, BrowserWindow, session } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEV_SERVER_ENV_KEYS = ['ELECTRON_RENDERER_URL', 'VITE_DEV_SERVER_URL'] as const
const DEFAULT_DEV_RENDERER_URLS = ['http://127.0.0.1:39217/', 'http://localhost:39217/'] as const
const BLOCKED_PRODUCTION_SHORTCUTS = new Set(['i', 'j', 'r'])

function packagedRendererUrl(): string {
  return pathToFileURL(join(app.getAppPath(), 'out', 'renderer', 'index.html')).href
}

function developmentRendererUrls(): string[] {
  const configuredUrl = resolveRendererDevUrl()
  return Array.from(new Set([
    ...(configuredUrl ? [configuredUrl] : []),
    ...DEFAULT_DEV_RENDERER_URLS,
    pathToFileURL(join(process.cwd(), 'out', 'renderer', 'index.html')).href
  ]))
}

function normalizedRendererPath(url: URL): string {
  return url.protocol === 'file:' && process.platform === 'win32' ? url.pathname.toLowerCase() : url.pathname
}

function isSameRendererDocument(actualValue: string, expectedValue: string): boolean {
  let actual: URL
  let expected: URL
  try {
    actual = new URL(actualValue)
    expected = new URL(expectedValue)
  } catch {
    return false
  }

  const actualPath = normalizedRendererPath(actual)
  const expectedPath = normalizedRendererPath(expected)
  return actual.protocol === expected.protocol &&
    actual.origin === expected.origin &&
    actual.host === expected.host &&
    actual.username === expected.username &&
    actual.password === expected.password &&
    actualPath === expectedPath &&
    actual.search === expected.search
}

export function resolveRendererDevUrl(): string {
  if (app.isPackaged || process.env.HFM_FORCE_DIST === '1') return ''
  return DEV_SERVER_ENV_KEYS.map((key) => process.env[key]).find((value): value is string => Boolean(value)) || ''
}

export function isTrustedRendererUrl(url: string): boolean {
  if (!url) return false
  const expectedUrls = app.isPackaged ? [packagedRendererUrl()] : developmentRendererUrls()
  return expectedUrls.some((expectedUrl) => isSameRendererDocument(url, expectedUrl))
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

  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url)) return
    appendLog(`${app.isPackaged ? 'blocked packaged navigation' : 'blocked navigation'}: ${url}`)
    event.preventDefault()
  })

  if (!app.isPackaged) return

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
