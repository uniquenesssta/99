// Exercise both shipped bridges and the real traced IPC/preview handlers.
// Only Electron transport, sender trust and application shutdown are test ports.
const assert = require('node:assert/strict')
const { loader } = require('../check-operation-chain.cjs')

function previewBridge(runtime, { kind = 'runtime', transformSource = source => source } = {}) {
  const handlers = new Map()
  let api
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, value) => { api = value } },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    ipcRenderer: {
      invoke: (channel, ...args) => Promise.resolve().then(() => {
        if (channel === 'performance:rendererTrace') return true
        assert(handlers.has(channel), 'unregistered preview channel: ' + channel)
        return handlers.get(channel)({ sender: { id: 1 } }, ...args)
      }),
      on() {}, removeListener() {},
    },
  }
  const load = loader({
    electron,
    '../security/ipcSenderValidation': { assertTrustedIpcSender() {} },
    '../../app/shutdownCoordinatorRuntime': { onApplicationClosing() {} },
  })
  const traced = load('src/main/ipc/ipcTraceRuntime.ts').registerTracedIpcHandler
  const context = load('src/main/logging/operationTraceContext.ts')
  load('src/main/ipc/handlers/previewAndFolderIpcHandlers.ts').registerPreviewAndFolderIpcHandlers(
    (channel, handler) => traced({ appendLog() {} }, channel, handler), runtime,
  )
  if (kind === 'runtime') {
    const source = transformSource(load('src/main/preload/runtimePreloadSource.ts').runtimePreloadSource)
    new Function('require', 'process', 'Buffer', source)(id => { assert.equal(id, 'electron'); return electron }, process, Buffer)
  } else load('src/preload/index.ts')
  return { api, currentTrace: context.currentOperationTrace }
}

module.exports = { previewBridge }
