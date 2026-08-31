#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8') }
function assert(condition, message) {
  if (!condition) {
    console.error(`[diagnostics:window-close-flush] ${message}`)
    process.exit(1)
  }
}

const mainWindow = read('src/main/app/windowRuntime.ts')
for (const needle of [
  "ipcMain.handle('app-window:flushComplete'",
  "createdWindow.webContents.send('app-window:flush-before-close'",
  "createdWindow.on('close'",
  'event.preventDefault()',
  'completePendingWindowClose',
  "title: '尚有数据未保存'",
  "completePendingWindowClose(requestId, false, 'timeout')",
  '}, 12000)',
  'requestRendererWindowsCloseForQuit',
  'pendingCloseFlushes.get(existingRequestId)?.completion',
  "target.once('closed', onClosed)",
  'return outcomes.every(Boolean)'
]) assert(mainWindow.includes(needle), `main window close protocol missing ${needle}`)

const preload = read('src/preload/index.ts')
const runtimePreload = read('src/main/preload/runtimePreloadSource.ts')
for (const source of [preload, runtimePreload]) {
  assert(source.includes('onWindowFlushBeforeClose'), 'preload must expose the close flush request event')
  assert(source.includes('completeWindowCloseFlush'), 'preload must expose the close flush acknowledgement')
  assert(source.includes('app-window:flush-before-close'), 'preload must subscribe to the main close flush channel')
  assert(source.includes('app-window:flushComplete'), 'preload must acknowledge close flush completion')
}

const rendererFlush = read('src/renderer/src/runtime/app/effects/useAppFlushOnUnloadRuntime.ts')
for (const needle of [
  'flushApplicationState',
  'const result = await current.flushFontWriteQueue(reason)',
  'if (result === false) fontWritesSaved = false',
  'flushLibraryPersistence()',
  'onWindowFlushBeforeClose',
  'completeWindowCloseFlush(payload.requestId, saved)'
]) assert(rendererFlush.includes(needle), `renderer close flush runtime missing ${needle}`)

const app = read('src/renderer/src/App.tsx')
assert(app.includes('flushLibraryPersistence'), 'App must pass the library flush into the close lifecycle')
assert(app.includes('hfm: window.hfm'), 'App close lifecycle must receive the preload close protocol')

console.log('[diagnostics:window-close-flush] ok')
