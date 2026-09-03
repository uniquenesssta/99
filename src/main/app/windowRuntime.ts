import { app,BrowserWindow,dialog,ipcMain,protocol } from 'electron'
import { createWindowRoundedShapeRuntime } from './windowRoundedShapeRuntime'
import fs from 'node:fs'
import { dirname,join } from 'node:path'
import { productionDevToolsEnabled, registerWindowSecurityGuards, resolveRendererDevUrl } from '../security/appSecurityRuntime'
import type { AuthorizeFontRead } from '../path/fontPathAuthorizationRuntime'
import { createFontProtocolRuntime } from './fontProtocolRuntime'

export interface WindowRuntimeOptions {
  appName: string
  appInstallDir: () => string
  dataPath: (...parts: string[]) => string
  runtimePreloadSource: string
  loadErrorHtml: (title: string, detail: string) => string
  appendLog: (message: string) => void
  verboseRendererLogs: boolean
  authorizeFontRead: AuthorizeFontRead
}

export interface WindowRuntime {
  getMainWindow: () => BrowserWindow | null
  showExistingWindow: () => void
  registerFontProtocol: () => void
  createWindow: () => void
  requestRendererWindowsCloseForQuit: () => Promise<boolean>
  sendToRendererWindows: (channel: string, payload: unknown) => void
}

export function createWindowRuntime(options: WindowRuntimeOptions): WindowRuntime {
  let mainWindow: BrowserWindow | null = null
  let windowControlHandlersRegistered = false
  let startupRevealFallbackTimer: ReturnType<typeof setTimeout> | null = null
  let nextCloseFlushRequestId = 0
  const rendererReadyWindows = new WeakSet<BrowserWindow>()
  const closeFlushAllowedWindows = new WeakSet<BrowserWindow>()
  const pendingCloseFlushes = new Map<number, {
    target: BrowserWindow
    timeout: ReturnType<typeof setTimeout>
    completion: Promise<boolean>
    resolveCompletion: (closed: boolean) => void
  }>()
  const fontProtocolRuntime = createFontProtocolRuntime({
    authorizeFontRead: options.authorizeFontRead,
    appendLog: options.appendLog
  })

  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'hfm-font',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true
      }
    }
  ])

  function getMainWindow(): BrowserWindow | null {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  }

  function rendererTargets(): BrowserWindow[] {
    const active = getMainWindow()
    return active ? [active] : BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
  }

  function sendToRendererWindows(channel: string, payload: unknown): void {
    for (const target of rendererTargets()) {
      target.webContents.send(channel, payload)
    }
  }

  function targetWindowForEvent(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    return senderWindow && !senderWindow.isDestroyed() ? senderWindow : getMainWindow()
  }

  function pendingCloseFlushForWindow(target: BrowserWindow): number | null {
    for (const [requestId, pending] of pendingCloseFlushes) {
      if (pending.target === target) return requestId
    }
    return null
  }

  async function completePendingWindowClose(requestId: number, saved: boolean, reason: string, forceClose = false): Promise<boolean> {
    const pending = pendingCloseFlushes.get(requestId)
    if (!pending) return false

    clearTimeout(pending.timeout)
    options.appendLog(`window close flush completed: request=${requestId}, saved=${saved ? 'yes' : 'no'}, reason=${reason}`)

    const target = pending.target
    if (target.isDestroyed()) {
      pendingCloseFlushes.delete(requestId)
      pending.resolveCompletion(true)
      return true
    }
    if (!saved && !forceClose) {
      const result = await dialog.showMessageBox(target, {
        type: 'warning',
        title: '尚有数据未保存',
        message: '字体写入队列或库配置未能完整保存。',
        detail: '返回软件后可以检查磁盘、数据库或 NAS 状态并再次关闭。仍然关闭可能丢失刚刚的设置或标签操作。',
        buttons: ['返回软件', '仍然关闭'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      if (result.response !== 1) {
        pendingCloseFlushes.delete(requestId)
        pending.resolveCompletion(false)
        if (target.isMinimized()) target.restore()
        if (!target.isVisible()) target.show()
        target.focus()
        return true
      }
    }
    closeFlushAllowedWindows.add(target)
    target.close()
    return true
  }

  async function requestRendererWindowsCloseForQuit(): Promise<boolean> {
    const targets = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
    if (!targets.length) return true

    const outcomes = await Promise.all(targets.map(async (target) => {
      const existingRequestId = pendingCloseFlushForWindow(target)
      if (existingRequestId !== null) {
        return pendingCloseFlushes.get(existingRequestId)?.completion || false
      }

      let closeFallbackTimer: ReturnType<typeof setTimeout> | null = null
      let resolveClosed: (closed: boolean) => void = () => undefined
      const closed = new Promise<boolean>((resolve) => {
        resolveClosed = resolve
        closeFallbackTimer = setTimeout(() => resolve(false), 13000)
      })
      const onClosed = (): void => {
        if (closeFallbackTimer) clearTimeout(closeFallbackTimer)
        resolveClosed(true)
      }
      target.once('closed', onClosed)
      target.close()

      if (target.isDestroyed()) {
        target.removeListener('closed', onClosed)
        if (closeFallbackTimer) clearTimeout(closeFallbackTimer)
        return true
      }
      const requestId = pendingCloseFlushForWindow(target)
      if (requestId !== null) {
        target.removeListener('closed', onClosed)
        if (closeFallbackTimer) clearTimeout(closeFallbackTimer)
        return pendingCloseFlushes.get(requestId)?.completion || false
      }
      return closed
    }))
    return outcomes.every(Boolean)
  }


  function registerWindowControlHandlers(): void {
    if (windowControlHandlersRegistered) return
    windowControlHandlersRegistered = true

    ipcMain.handle('app-window:minimize', (event) => {
      const target = targetWindowForEvent(event)
      if (!target) return false
      target.minimize()
      return true
    })

    ipcMain.handle('app-window:toggleMaximize', (event) => {
      const target = targetWindowForEvent(event)
      if (!target) return false
      if (target.isMaximized()) {
        target.unmaximize()
      } else {
        target.maximize()
      }
      return true
    })

    ipcMain.handle('app-window:close', (event) => {
      const target = targetWindowForEvent(event)
      if (!target) return false
      target.close()
      return true
    })

    ipcMain.handle('app-window:flushComplete', async (event, requestId: number, saved: boolean) => {
      const pending = pendingCloseFlushes.get(Number(requestId))
      if (!pending || pending.target.webContents !== event.sender) return false
      return completePendingWindowClose(Number(requestId), saved === true, 'renderer-ack')
    })

    ipcMain.handle('app-window:rendererReady', (event) => {
      const target = targetWindowForEvent(event)
      if (target) rendererReadyWindows.add(target)
      return revealWindow(target, 'renderer-ready')
    })
  }

  function clearStartupRevealFallback(): void {
    if (startupRevealFallbackTimer) {
      clearTimeout(startupRevealFallbackTimer)
      startupRevealFallbackTimer = null
    }
  }

  function revealWindow(targetWindow: BrowserWindow | null, reason: string): boolean {
    if (!targetWindow || targetWindow.isDestroyed()) return false
    clearStartupRevealFallback()
    if (targetWindow.isMinimized()) targetWindow.restore()
    if (!targetWindow.isVisible()) {
      options.appendLog(`main window show: ${reason}`)
      targetWindow.show()
    }
    targetWindow.focus()
    targetWindow.moveTop()
    return true
  }

  function scheduleStartupRevealFallback(targetWindow: BrowserWindow, reason: string, delayMs: number): void {
    if (targetWindow.isDestroyed() || targetWindow.isVisible()) return
    clearStartupRevealFallback()
    startupRevealFallbackTimer = setTimeout(() => {
      startupRevealFallbackTimer = null
      revealWindow(targetWindow, reason)
    }, delayMs)
  }

  function showExistingWindow(): void {
    const targetWindow = getMainWindow() || BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
    if (!targetWindow) return
    revealWindow(targetWindow, 'show-existing-window')
  }

  function registerFontProtocol(): void {
    protocol.handle('hfm-font', fontProtocolRuntime.handleRequest)
  }

  async function loadRenderer(window: BrowserWindow): Promise<void> {
    const devUrl = resolveRendererDevUrl()

    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      const detail = `did-fail-load\ncode: ${errorCode}\ndescription: ${errorDescription}\nurl: ${validatedURL}`
      options.appendLog(detail)
      void window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(options.loadErrorHtml('页面加载失败', detail)))
    })

    window.webContents.on('render-process-gone', (_event, details) => {
      options.appendLog(`render-process-gone: ${JSON.stringify(details)}`)
    })

    window.webContents.on('console-message', (event) => {
      const consoleDetails = event as unknown as { level?: number; message?: string; lineNumber?: number; sourceId?: string }
      const rawLevel = Number(consoleDetails.level)
      const level = Number.isFinite(rawLevel) ? rawLevel : 0
      const message = String(consoleDetails.message || '')
      const rawLineNumber = Number(consoleDetails.lineNumber)
      const lineNumber = Number.isFinite(rawLineNumber) ? rawLineNumber : 0
      const sourceId = String(consoleDetails.sourceId || '')

      if (!options.verboseRendererLogs) {
        const noisy =
          message.includes('Failed to decode downloaded font') ||
          message.includes('OTS parsing error') ||
          message.includes('Download the React DevTools') ||
          message.includes('Electron Security Warning') ||
          message.includes('Autofill.enable') ||
          message.includes('net::ERR_FILE_NOT_FOUND') ||
          message.includes('SimpleURLLoaderWrapper')
        if (noisy) return

        if (level < 2) return
      }

      options.appendLog(`console[${level}] ${message} (${sourceId}:${lineNumber})`)
    })

    if (!app.isPackaged) {
      window.webContents.on('before-input-event', (event, input) => {
        if (input.control && input.shift && input.key.toLowerCase() === 'i') {
          window.webContents.openDevTools({ mode: 'detach' })
          event.preventDefault()
        }
      })
    }

    try {
      if (devUrl) {
        options.appendLog(`renderer source: mode=dev, url=${devUrl}`)
        await window.loadURL(devUrl)
        return
      }

      const candidates = [
        join(__dirname, '../renderer/index.html'),
        join(app.getAppPath(), 'out/renderer/index.html'),
        join(process.cwd(), 'out/renderer/index.html')
      ]

      for (const htmlPath of candidates) {
        if (fs.existsSync(htmlPath)) {
          options.appendLog(`renderer source: mode=file, html=${htmlPath}`)
          await window.loadFile(htmlPath)
          return
        }
      }

      throw new Error(`找不到 renderer/index.html。\n尝试路径：\n${candidates.join('\n')}`)
    } catch (error) {
      const detail = error instanceof Error ? error.stack || error.message : String(error)
      options.appendLog(detail)
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(options.loadErrorHtml('字体管理器 启动失败', detail)))
    }
  }

  function writeRuntimePreload(): string {
    const preloadPath = options.dataPath('runtime', 'runtime-preload.cjs')
    fs.mkdirSync(dirname(preloadPath), { recursive: true })
    fs.writeFileSync(preloadPath, options.runtimePreloadSource, 'utf-8')
    options.appendLog('runtime preload written: ' + preloadPath)
    return preloadPath
  }

  function appIconPath(): string | undefined {
    const candidates = app.isPackaged
      ? [join(process.resourcesPath, 'app.ico'), join(options.appInstallDir(), 'resources', 'app.ico')]
      : [join(process.cwd(), 'build', 'app.ico')]

    return candidates.find((candidate) => fs.existsSync(candidate))
  }

  function createWindow(): void {
    registerWindowControlHandlers()
    const iconPath = appIconPath()
    mainWindow = new BrowserWindow({
      width: 1320,
      height: 820,
      minWidth: 980,
      minHeight: 680,
      title: options.appName,
      frame: false,
      titleBarStyle: 'hidden',
      show: false,
      paintWhenInitiallyHidden: true,
      transparent: true,
      backgroundColor: '#00000000',
      roundedCorners: true,
      // Windows DWM draws a rectangular native shadow for transparent frameless windows.
      // Keep the CSS-rounded surface authoritative so the square shadow cannot bleed through.
      hasShadow: process.platform !== 'win32',
      autoHideMenuBar: true,
      ...(iconPath ? { icon: iconPath } : {}),
      webPreferences: {
        preload: writeRuntimePreload(),
        contextIsolation: true,
        nodeIntegration: false,
        devTools: productionDevToolsEnabled(),
        webSecurity: true,
        allowRunningInsecureContent: false,
        sandbox: false,
        backgroundThrottling: false
      }
    })

    const createdWindow = mainWindow
    const roundedShapeRuntime = createWindowRoundedShapeRuntime(createdWindow, {
      radius: 18,
      appendLog: options.appendLog,
    })

    createdWindow.setMenu(null)
    createdWindow.setAutoHideMenuBar(true)
    createdWindow.setMenuBarVisibility(false)
    registerWindowSecurityGuards(createdWindow, options.appendLog)

    createdWindow.on('close', (event) => {
      if (closeFlushAllowedWindows.delete(createdWindow)) return
      if (!rendererReadyWindows.has(createdWindow) || createdWindow.webContents.isDestroyed()) return

      event.preventDefault()
      if (pendingCloseFlushForWindow(createdWindow) !== null) return

      const requestId = ++nextCloseFlushRequestId
      let resolveCompletion: (closed: boolean) => void = () => undefined
      const completion = new Promise<boolean>((resolve) => {
        resolveCompletion = resolve
      })
      const timeout = setTimeout(() => {
        void completePendingWindowClose(requestId, false, 'timeout')
      }, 12000)
      pendingCloseFlushes.set(requestId, {
        target: createdWindow,
        timeout,
        completion,
        resolveCompletion,
      })
      options.appendLog(`window close flush requested: request=${requestId}`)
      createdWindow.webContents.send('app-window:flush-before-close', { requestId })
    })

    createdWindow.on('closed', () => {
      roundedShapeRuntime.dispose()
      clearStartupRevealFallback()
      for (const [requestId, pending] of pendingCloseFlushes) {
        if (pending.target !== createdWindow) continue
        clearTimeout(pending.timeout)
        pendingCloseFlushes.delete(requestId)
        pending.resolveCompletion(true)
      }
      if (mainWindow === createdWindow) mainWindow = null
    })

    createdWindow.webContents.once('did-finish-load', () => {
      options.appendLog('renderer finished load')
      scheduleStartupRevealFallback(createdWindow, 'did-finish-load-fallback', 900)
    })

    scheduleStartupRevealFallback(createdWindow, 'startup-timeout-fallback', 5000)
    void loadRenderer(createdWindow)
  }

  return {
    getMainWindow,
    showExistingWindow,
    registerFontProtocol,
    createWindow,
    requestRendererWindowsCloseForQuit,
    sendToRendererWindows
  }
}
