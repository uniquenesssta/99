#!/usr/bin/env node
// Windows regression: real DTO, polling owner, footer, IPC registrar and both preloads.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const modelFile = 'src/shared/sharedWatchStatus.ts'
const runtimeFile = 'src/renderer/src/runtime/app/sharedWatchStatusRuntime.ts'
const componentFile = 'src/renderer/src/components/app/SharedWatchStatusBar.tsx'
const plain = value => JSON.parse(JSON.stringify(value))
const settle = async () => { for (let n = 0; n < 12; n++) await Promise.resolve() }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function loader(mocks = {}, globals = {}) {
  const cache = new Map()
  return function load(relative) {
    const file = path.resolve(root, relative)
    assert(file.startsWith(root + path.sep), 'module escaped repository')
    if (Object.hasOwn(mocks, file)) return mocks[file]
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }
    cache.set(file, module)
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
    }).outputText
    const localRequire = id => {
      if (Object.hasOwn(mocks, id)) return mocks[id]
      if (id.startsWith('node:')) return require(id)
      if (id.startsWith('.')) {
        const base = path.resolve(path.dirname(file), id)
        return load(fs.existsSync(base + '.ts') ? base + '.ts' : base + '.tsx')
      }
      throw Error(`Unmocked port: ${id}`)
    }
    vm.runInNewContext(code, { module, exports: module.exports, require: localRequire, process, Buffer, console, Date, setTimeout, clearTimeout, ...globals }, { filename: file })
    return module.exports
  }
}

function clock() {
  let now = 0, id = 0
  const timers = new Map()
  return {
    timers,
    setTimer(callback, delay) { const key = ++id; timers.set(key, { at: now + delay, callback }); return key },
    clearTimer(key) { timers.delete(key) },
    advance(ms) {
      const until = now + ms
      for (;;) {
        const due = [...timers].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        now = due[1].at
        timers.delete(due[0])
        due[1].callback()
      }
      now = until
    }
  }
}

const rootStatus = (changes = {}) => ({ rootPath: '\\\\server\\fonts', phase: 'idle', lastCheckedAt: 1000, pendingCount: 0, ...changes })
const snapshot = (...roots) => ({ roots })

function checkPresentation() {
  const load = loader()
  const { isSharedWatchStatus } = load(modelFile)
  const { sharedWatchStatusPresentation: present } = load(runtimeFile)
  const format = value => `T${value}`
  assert(isSharedWatchStatus(snapshot(rootStatus())))
  for (const value of [null, [], {}, { roots: null }, snapshot({}), snapshot(rootStatus({ phase: 'success' })), snapshot(rootStatus({ pendingCount: -1 })), snapshot(rootStatus({ pendingCount: 1.5 })), snapshot(rootStatus({ pendingCount: NaN })), snapshot(rootStatus({ pendingCount: Infinity })), snapshot(rootStatus({ pendingCount: undefined, pending: true })), snapshot(rootStatus({ lastCheckedAt: -1 })), snapshot(rootStatus({ lastCheckedAt: 8640000000000001 })), snapshot(rootStatus({ rootPath: '' }))]) {
    assert.equal(isSharedWatchStatus(value), false, JSON.stringify(value))
  }
  assert.equal(present(snapshot()), null, 'local-only library gained NAS success status')
  assert.match(present(null).text, /状态待确认.*未知.*数量待确认/)
  assert.match(present(snapshot(rootStatus()), format).text, /正在处理：0 项.*上次检查时间：T1000/)
  assert.match(present(snapshot(rootStatus({ phase: 'applying', pendingCount: 14 })), format).text, /正在处理：14 项/)
  assert.match(present(snapshot(rootStatus({ phase: 'checking', lastCheckedAt: null, pendingCount: null })), format).text, /正在检查.*数量待确认.*尚未完成/)
  const offline = present(snapshot(rootStatus({ phase: 'offline', pendingCount: null })), format)
  assert.match(offline.text, /离线.*数量待确认.*T1000/)
  assert(!offline.text.includes('成功'), 'offline was presented as success')
  assert.match(present(snapshot(rootStatus({ phase: 'error', pendingCount: null })), format).text, /检查异常/)
  assert.match(present(snapshot(rootStatus({ phase: 'stopped', pendingCount: null })), format).text, /已暂停/)
  const mixed = present(snapshot(rootStatus({ phase: 'applying', pendingCount: 7 }), rootStatus({ rootPath: 'Z:\\other', phase: 'offline', pendingCount: null, lastCheckedAt: 2000 })), format)
  assert.match(mixed.text, /已确认 7 项，其余待确认/)
  assert.match(mixed.text, /T1000（最早）/)
  assert.match(mixed.detail, /T2000/)
  assert.match(present(snapshot(rootStatus(), rootStatus({ rootPath: 'Z:\\other', lastCheckedAt: null })), format).text, /部分位置尚未完成/)
  const many = present(snapshot(...Array.from({ length: 10 }, (_, n) => rootStatus({ rootPath: `Z:\\${n}`, pendingCount: 1 }))), format)
  assert.match(many.text, /正在处理：10 项/)
  assert.match(many.detail, /另有 2 处/)
  assert(!many.detail.includes('Z:\\8：'), 'unbounded per-root detail')
}

async function checkPolling() {
  const { createSharedWatchStatusPoller } = loader()(runtimeFile)
  const time = clock(), seen = []
  const requests = []
  const poller = createSharedWatchStatusPoller({ ...time, read: () => { const item = deferred(); requests.push(item); return item.promise } })
  const stop = poller.start(value => seen.push(value && plain(value)))
  assert.equal(requests.length, 1)
  requests[0].resolve(snapshot(rootStatus()))
  await settle()
  assert.equal(seen.length, 2)
  time.advance(2000)
  assert.equal(requests.length, 2)
  requests[1].resolve(snapshot(rootStatus()))
  await settle()
  assert.equal(seen.length, 2, 'unchanged memory snapshot rerendered footer')
  time.advance(2000)
  assert.equal(requests.length, 3)
  time.advance(6000)
  assert.equal(seen.at(-1), null, 'hung IPC kept displaying old success')
  time.advance(600000)
  assert.equal(requests.length, 3, 'deadline abandoned request and flooded IPC')
  stop()
  assert.equal(time.timers.size, 0)
  const resumed = []
  const stopAgain = poller.start(value => resumed.push(value && plain(value)))
  stop() // Stale cleanup must not cancel a newer effect.
  assert.equal(requests.length, 3, 'effect restart overlapped unsettled request')
  requests[2].resolve(snapshot(rootStatus({ lastCheckedAt: 9999 })))
  await settle()
  assert.deepEqual(resumed, [null], 'retired request published after effect restart')
  time.advance(2000)
  assert.equal(requests.length, 4)
  requests[3].resolve(snapshot(rootStatus({ phase: 'offline', pendingCount: null })))
  await settle()
  assert.equal(resumed.at(-1).roots[0].phase, 'offline')
  time.advance(2000)
  requests[4].resolve({ roots: 'invalid' })
  await settle()
  assert.equal(resumed.at(-1), null, 'malformed status became an empty/successful library')
  time.advance(2000)
  requests[5].reject(Error('IPC unavailable'))
  await settle()
  assert.equal(time.timers.size, 1, 'failed read did not settle to a single bounded retry')
  time.advance(2000)
  stopAgain()
  const count = resumed.length
  requests[6].resolve(snapshot(rootStatus()))
  await settle()
  assert.equal(resumed.length, count, 'unmounted view received late result')
  assert.equal(time.timers.size, 0)
}

async function checkFooter() {
  const time = clock(), hooks = [], effects = []
  let cursor = 0, current = snapshot(rootStatus({ phase: 'applying', pendingCount: 12 })), cleanup
  const react = {
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], value => { hooks[i] = value }] },
    useRef(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i] },
    useEffect(effect) { const i = cursor++; if (!(i in hooks)) { hooks[i] = true; effects.push(effect) } }
  }
  const jsx = (type, props) => ({ type, props })
  const load = loader({ react, 'react/jsx-runtime': { jsx, jsxs: jsx } }, { window: { hfm: { getSharedWatchStatus: async () => current } }, setTimeout: time.setTimer, clearTimeout: time.clearTimer })
  const { SharedWatchStatusBar } = load(componentFile)
  const render = props => { cursor = 0; return SharedWatchStatusBar(props) }
  const text = node => node == null || node === false ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props.children)
  assert.match(text(render({})), /状态待确认/)
  cleanup = effects[0]()
  await settle()
  const busy = render({ developerStatus: '开发状态保留' })
  assert.equal(busy.type, 'footer')
  assert.equal(busy.props.className, 'statusbar')
  assert.match(text(busy), /正在处理：12 项/)
  assert.match(text(busy), /开发状态保留/)
  assert.equal(busy.props.children[0].props.role, 'status')
  current = snapshot()
  time.advance(2000)
  await settle()
  assert.equal(render({}), null)
  assert.equal(text(render({ developerStatus: '开发状态保留' })), '开发状态保留')
  cleanup()
  assert.equal(time.timers.size, 0, 'footer cleanup retained status timer')
}

async function checkBridge(runtimePreload) {
  let api, trusted = true, reads = 0, availabilityReads = 0, rootGuardRuns = 0
  const handlers = new Map(), calls = []
  const expected = snapshot(rootStatus({ phase: 'applying', pendingCount: 23 }))
  const { withStartupPathRootGuard } = loader()('src/main/path/startupPathAvailabilityRuntime.ts')
  const electron = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    ipcRenderer: { invoke: (channel, ...args) => { calls.push({ channel, args }); return Promise.resolve().then(() => handlers.has(channel) ? handlers.get(channel)({ sender: { id: 1 } }, ...args) : true) } },
    contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'hfm'); api = value } }
  }
  const mocks = {
    electron,
    [path.join(root, 'src/main/security/ipcSenderValidation.ts')]: { assertTrustedIpcSender() { if (!trusted) throw Error('untrusted sender') } },
    [path.join(root, 'src/main/preview/runtime/previewInputPolicy.ts')]: { PreviewInputError: class PreviewInputError extends Error {} },
    [path.join(root, 'src/main/logging/startupLogPolicy.ts')]: { detailedStartupLogsEnabled: () => false },
    [path.join(root, 'src/main/logging/operationTraceContext.ts')]: { withOperationTrace: (_trace, _log, fn) => fn(), logOperation() {} },
    [path.join(root, 'src/main/path/startupPathAvailabilityRuntime.ts')]: {
      withStartupPathRootGuard: (guard, operation) => withStartupPathRootGuard(() => { rootGuardRuns++; guard() }, operation)
    },
    [path.join(root, 'src/main/library/fontQueryTaskRuntime.ts')]: { createFontQueryConsumers: () => ({}), assertFontQueryActive() {} },
    [path.join(root, 'src/main/app/shutdownCoordinatorRuntime.ts')]: { assertApplicationOpen() {}, applicationWorkEpoch: () => 0 }
  }
  for (const name of ['fontSystem', 'fontTag', 'maintenance', 'previewAndFolder', 'security']) {
    const fn = `register${name[0].toUpperCase() + name.slice(1)}IpcHandlers`
    mocks[path.join(root, `src/main/ipc/handlers/${name}IpcHandlers.ts`)] = { [fn]() {} }
  }
  const load = loader(mocks)
  load('src/main/ipc/ipcHandlers.ts').registerIpcHandlers({
    getSharedWatchStatus: () => { reads++; return expected },
    getSharedAvailability: async () => { availabilityReads++; throw Error('status read must not probe NAS') }
  })
  if (runtimePreload) {
    vm.runInNewContext(load('src/main/preload/runtimePreloadSource.ts').runtimePreloadSource, { require: id => id === 'electron' ? electron : require(id), Buffer, process, Date })
  } else load('src/preload/index.ts')
  assert.equal(typeof api.getSharedWatchStatus, 'function')
  assert.deepEqual(plain(await api.getSharedWatchStatus()), expected)
  assert.equal(reads, 1)
  assert.equal(rootGuardRuns, 1, 'trusted status handler bypassed the production guard scope')
  assert.equal(availabilityReads, 0, 'read-only status queried filesystem availability')
  assert.equal(calls[0].channel, 'folders:getWatchStatus')
  assert.deepEqual(calls[0].args, [])
  trusted = false
  await assert.rejects(() => api.getSharedWatchStatus(), /untrusted sender/)
  assert.equal(reads, 1, 'untrusted sender reached status owner')
  assert.equal(rootGuardRuns, 1, 'untrusted sender reached the guarded handler')
}

async function main() {
  assert.equal(process.platform, 'win32', 'HFM diagnostics execute only on Windows')
  checkPresentation()
  await checkPolling()
  await checkFooter()
  await checkBridge(false)
  await checkBridge(true)
  console.log('[diagnostics:shared-watch-status] validated counts/ACK labels, offline/unknown, bounded polling/restart/cleanup, footer and both trusted IPC bridges passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
