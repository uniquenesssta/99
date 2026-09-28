const electron = require('electron'), { app, BrowserWindow, ipcMain } = electron
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { createRuntime } = require('./preview-chain-performance-runtime.cjs')
const { loader } = require('../check-operation-chain.cjs')
const [directory, html, preload] = process.argv.slice(2)
process.env.HFM_LOG_DETAIL = 'debug'
const logs = [], reports = [], appendLog = line => logs.push(line)
const watchdog = setTimeout(() => { console.error('preview chain integration timed out'); app.exit(1) }, 120000)
app.whenReady().then(async () => {
  const bootstrap = loader({ electron, '../security/ipcSenderValidation': { assertTrustedIpcSender() {} } })
  const source = bootstrap('src/main/preload/runtimePreloadSource.ts').runtimePreloadSource
  fs.writeFileSync(preload, source)
  let active
  const traced = bootstrap('src/main/ipc/ipcTraceRuntime.ts').registerTracedIpcHandler
  // Forward only the fixture runtime; real handler scheduling and trace wrapping remain.
  const runtime = new Proxy({ appendLog }, { get(target, key) { return key in target ? target[key] : (...args) => active.runtime[key](...args) } })
  bootstrap('src/main/ipc/handlers/previewAndFolderIpcHandlers.ts').registerPreviewAndFolderIpcHandlers((channel, handler) => traced({ appendLog }, channel, handler), runtime)
  ipcMain.handle('performance:rendererTrace', (_event, payload) => { appendLog(JSON.stringify(payload)); return true })
  const win = new BrowserWindow({ show: true, width: 900, height: 700, webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  await win.loadFile(html)
  const fontDir = path.join(directory, 'fonts'); fs.mkdirSync(fontDir, { recursive: true })
  const fonts = ['a', 'b'].map(id => {
    const file = path.join(fontDir, id + '.ttf'); fs.copyFileSync(path.join(process.env.WINDIR, 'Fonts/arial.ttf'), file)
    const stat = fs.statSync(file)
    return { id, path: file, fileName: id + '.ttf', family: 'Arial', active: true, fileSize: stat.size, modifiedAt: stat.mtimeMs }
  })
  for (const mode of ['list', 'grid']) for (const variant of ['before', 'after']) {
    const cacheDir = path.join(directory, mode, variant)
    for (const cache of ['cold', 'disk-hot', 'memory-hot']) {
      if (cache !== 'memory-hot') {
        active?.close()
        active = await createRuntime({ directory: cacheDir, baseline: variant === 'before', appendLog, electron, traceContext: bootstrap('src/main/logging/operationTraceContext.ts') })
      }
      const nativeBefore = active.native(), countsBefore = active.counts()
      const result = await win.webContents.executeJavaScript(`window.measurePreviewChain(${JSON.stringify(fonts)},${JSON.stringify(mode)})`)
      const row = { ...result, variant, cache, source: 'local active file', backend: 'rust-directwrite', sharedCounterDelayMs: 400,
        sharedCounts: active.counts() - countsBefore, nativeRenders: active.native() - nativeBefore }
      assert.equal(row.sharedCounts, variant === 'before' && cache !== 'memory-hot' ? 1 : 0)
      assert.equal(row.nativeRenders, cache === 'cold' ? 2 : 0)
      reports.push(row); console.log('[preview-chain-performance]', JSON.stringify(row))
    }
  }
  active.close()
  for (const mode of ['list', 'grid']) for (const cache of ['cold', 'disk-hot']) {
    const before = reports.find(r => r.mode === mode && r.cache === cache && r.variant === 'before')
    const after = reports.find(r => r.mode === mode && r.cache === cache && r.variant === 'after')
    assert(before.firstValidPreviewMs >= 350, 'old wiring did not reproduce controlled count wait')
    // Timing is reported, never a machine-speed assertion. Counts prove causality.
    assert(after.sharedCounts === 0)
  }
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ sha: process.env.GITHUB_SHA || null, platform: process.platform, versions: process.versions,
    scope: 'real renderer queues/runtime preload/IPC/local SQLite/preview runtime/Rust PNG/browser decode; controlled 400ms shared counter, fixture DOM; not real NAS or full App', reports }, null, 2))
  fs.writeFileSync(path.join(directory, 'operation-chain.log'), logs.join('\n'))
  clearTimeout(watchdog); app.exit(0)
}).catch(error => { console.error(error); fs.writeFileSync(path.join(directory, 'failure.log'), String(error) + '\n' + logs.join('\n')); clearTimeout(watchdog); app.exit(1) })
