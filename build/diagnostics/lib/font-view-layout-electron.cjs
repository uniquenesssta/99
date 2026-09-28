const { app, BrowserWindow } = require('electron')
const file = process.argv[2]
const watchdog = setTimeout(() => { console.error('DOM layout gate timed out'); app.exit(1) }, 180000)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1600, height: 900, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  console.log('[font-view-layout:electron] window ready')
  await win.loadFile(file)
  console.log('[font-view-layout:electron] fixture loaded')
  for (const width of [720, 1600]) {
    win.setContentSize(width, 900)
    console.log('[font-view-layout:electron] checking viewport', width)
    const result = await win.webContents.executeJavaScript('window.checkLayout()')
    console.log('[font-view-layout:electron]', JSON.stringify(result))
    const detail = await win.webContents.executeJavaScript('window.checkDetailTransitions()')
    console.log('[font-detail-transition:electron]', JSON.stringify(detail))
  }
  clearTimeout(watchdog); app.exit(0)
}).catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1) })
