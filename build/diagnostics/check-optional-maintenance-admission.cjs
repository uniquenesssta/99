#!/usr/bin/env node
// Windows diagnostic: production admission/diagnostics/preview owners with
// controlled activity, availability, process-close and storage ports.
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..')
const base = 'src/main/maintenance/'
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
function harness() {
  let closing = false, epoch = 1, busy = false, waits = 0, timerId = 0, idleAfter = Infinity
  const listeners = new Set(), states = new Map(), logs = [], timers = new Set(), scopes = []
  const availability = { assertStartupPathRootGuardCurrent() {}, getStartupPathRootState: value => states.get(value) || { rootId: value, state: 'online', generation: 1 } }
  const shutdown = { applicationWorkEpoch: () => epoch, isApplicationClosing: () => closing, assertApplicationOpen: ticket => { if (closing || ticket !== epoch) throw Error('application closing') }, onApplicationClosing: fn => { listeners.add(fn); return () => listeners.delete(fn) } }
  const shared = { withSharedIoPriority: (priority, fn) => { assert.equal(priority, 'background'); return fn() }, withSharedIoSignal: (signal, fn) => { scopes.push(signal); return fn() } }
  const globals = {
    setTimeout: (fn, ms) => { const id = ++timerId; timers.add(id); Promise.resolve().then(() => { if (!timers.delete(id)) return; if (ms) { waits++; if (waits >= idleAfter) busy = false } fn() }); return id },
    clearTimeout: id => timers.delete(id), setImmediate,
  }
  // Mock module identities, not one caller's relative import spelling. The
  // physical-close helper also imports sharedFileSystemRuntime via './...';
  // loading the real filesystem here would create the application probe pool
  // and add its lifetime listener to this isolated admission fixture.
  const mocks = {
    [path.join(root, 'src/main/app/shutdownCoordinatorRuntime.ts')]: shutdown,
    [path.join(root, 'src/main/path/startupPathAvailabilityRuntime.ts')]: availability,
    [path.join(root, 'src/main/path/sharedFileSystemRuntime.ts')]: shared,
  }
  const load = loader(mocks, globals)
  const admissionModule = load(base + 'optionalMaintenanceAdmissionRuntime.ts')
  assert.equal(listeners.size, 0, 'loading the admission fixture registered an unrelated application listener')
  assert.equal(timers.size, 0, 'loading the admission fixture started unrelated background work')
  return { load, mocks, globals, logs, states, scopes, timers, listeners, admissionModule,
    setBusy(value, quietAfter = Infinity) { busy = value; idleAfter = quietAfter; waits = 0 },
    get waits() { return waits }, isForegroundBusy: () => busy,
    close() { closing = true; epoch++; for (const fn of listeners) fn() },
    session(caller = 'test') { return admissionModule.createOptionalMaintenanceAdmission({ caller, isForegroundBusy: () => busy, appendStartupLog: line => logs.push(line) }) },
  }
}
async function admissionCases() {
  const h = harness(), { OptionalMaintenanceDeferred } = h.admissionModule
  h.states.set('private-root', { rootId: 'private-root', state: 'offline', generation: 1 })
  await assert.rejects(h.session().run(() => h.session().checkpoint('snapshot', 'private-root')), error => error instanceof OptionalMaintenanceDeferred && error.detail.blocker === 'unavailable')
  assert(h.logs.every(line => !line.includes('private-root')), 'evidence leaked a raw root')
  h.setBusy(true, 3)
  const s = h.session(); let admitted = 0
  await s.run(async () => { await s.checkpoint('batch'); admitted++ })
  assert.equal(admitted, 1); assert.equal(h.waits, 3, 'quiet transition did not resume the same phase')
  h.setBusy(true)
  const bounded = h.session()
  await assert.rejects(bounded.run(() => bounded.checkpoint('batch')), error => error.detail.blocker === 'foreground')
  assert.equal(h.waits, 20, 'foreground retries are not bounded to the 2s wait budget')
  assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0)
  h.setBusy(false)
  const generation = h.session()
  await generation.checkpoint('snapshot', 'online')
  h.states.set('online', { rootId: 'online', state: 'online', generation: 2 })
  assert.throws(() => generation.assertCurrent('commit', 'online'), error => error.detail.blocker === 'generation-changed')
  let closePhysical, settled = false
  const physical = new Promise(resolve => { closePhysical = resolve })
  const uncertain = Object.assign(Error('write outcome unknown'), { sharedIo: true, closed: physical, outcome: 'unknown' })
  const running = h.session().run(async () => { throw uncertain }).then(() => { settled = true }, error => { settled = true; assert.equal(error, uncertain) })
  await tick(); h.close(); await tick()
  assert.equal(settled, false, 'logical cancellation released physical-write lifetime')
  assert(h.scopes.at(-1).aborted)
  closePhysical(); await running
  assert.equal(h.listeners.size, 0); assert.equal(h.timers.size, 0)
  await h.load('src/main/path/ioDeadlineRuntime.ts').awaitPhysicalIoClose({ sharedIo: true, closed: Promise.reject(Error('close notification failed')) })
  await assert.rejects(h.session().run(async () => { throw Error('new work admitted on shutdown') }), error => error.detail.blocker === 'closing')
}
async function diagnosticsCases() {
  const h = harness(), opened = [], committed = [], closed = []
  h.states.set('offline', { rootId: 'offline', state: 'offline', generation: 1 })
  let late = false
  const deps = { isForegroundBusy: h.isForegroundBusy, appWatchedFolders: async () => ['offline', 'online', 'broken'], uniqueResolvedFolders: value => value,
    sharedMetadataDbPathForRoot: root => root + '/shared.sqlite', appendStartupLog: line => h.logs.push(line),
    openIsolatedSnapshot: async root => { opened.push(root); if (root === 'broken') throw Error('SQLITE_CORRUPT genuine failure'); if (late) h.states.set(root, { rootId: root, state: 'offline', generation: 2 }); return { exists: true, db: {}, commit: async () => committed.push(root), close: () => closed.push(root) } },
    ensureSharedTagOpsBackfilledInOpenDb() {}, ensureSharedTagOpsReplayedInOpenDb: () => ({}), readSharedMetadataMigrationDiagnosticsInOpenDb: () => ({ severity: 'ok', suggestedActions: [] }),
    readSharedTagOpsDiagnosticsInOpenDb: () => ({}), readSharedTagOpsConflictReportInOpenDb: () => ({ severity: 'ok', suggestedActions: [] }), repairSharedMetadataInOpenDb: () => ({ ok: true, suggestedActions: [] }),
  }
  const runtime = h.load('src/main/indexing/shared-metadata/sharedMetadataFrontendDiagnosticsRuntime.ts').createSharedMetadataFrontendDiagnosticsRuntime(deps)
  const result = await runtime.readSharedMetadataFrontendDiagnostics({ automatic: true })
  assert.deepEqual(opened, ['online', 'broken']); assert.deepEqual(committed, ['online']); assert.equal(result.complete, false); assert.equal(result.ok, false)
  assert.equal(result.deferredRoots, 1); assert.equal(result.reports[0].severity, 'info'); assert.equal(result.reports[2].severity, 'critical'); assert.match(result.reports[2].error, /SQLITE_CORRUPT/)
  late = true; opened.length = committed.length = closed.length = 0
  const changed = await runtime.readSharedMetadataFrontendDiagnostics({ automatic: true, roots: ['online'] })
  assert.equal(changed.complete, false); assert.equal(committed.length, 0); assert.deepEqual(closed, ['online'])
  late = false; h.states.set('online', { rootId: 'online', state: 'online', generation: 3 })
  const recovered = await runtime.readSharedMetadataFrontendDiagnostics({ automatic: true, roots: ['online'] })
  assert.equal(recovered.complete, true); assert.equal(recovered.ok, true); assert.deepEqual(committed, ['online'])
  await runtime.readSharedMetadataFrontendDiagnostics({ roots: ['offline'] })
  assert(opened.includes('offline'), 'explicit diagnostics were silently disabled by background policy')
}
async function previewCases() {
  const h = harness(), calls = [], directories = []
  const rows = [{ preview_key: '000', output_path: '/local/one.png' }, { preview_key: '001', output_path: '/offline/two.png' }, { preview_key: '002', output_path: String.raw`\\nas\share\alias.png` }]
  h.states.set('/offline', { rootId: '/offline', state: 'offline', generation: 1 })
  const db = { prepare: sql => ({ all: cursor => sql.includes('preview_key >') ? rows.filter(row => row.preview_key > cursor) : rows, get: () => { throw Error('unexpected fallback') } }) }
  const mocks = { ...h.mocks, '../rust-core/rustSharedIoCommandRuntime': { sharedIoResourceKeysSnapshot: paths => paths[0].includes('nas') ? ['shared-root'] : [], sharedIoAvailabilityRoot: () => '/offline' }, '../path/sharedDirectoryMetadataRuntime': { readSharedDirectoryMetadata: async dir => { directories.push(dir); return { entries: [] } } } }
  const load = loader(mocks, h.globals)
  const deps = { isForegroundBusy: h.isForegroundBusy, appendStartupLog: line => h.logs.push(line), previewOkRetentionMs: 1, openPreviewDb: async () => db,
    previewSqlitePath: () => '/local/cache.sqlite', previewSqliteSchemaVersion: 1, normalizePathForCacheCompare: value => value,
    collectPreviewMaintenanceDirs: async () => [{ dirPath: '/local/images', referenceDbPath: '/local/cache.sqlite' }, { dirPath: '/offline/images', referenceDbPath: '/offline/cache.sqlite', rootPath: '/offline' }],
    runRustPreviewCacheMaintenance: async input => { calls.push(plain(input.batch)); return { checkedRows: input.batch.rows.length, staleRows: 0, removedFiles: 0, removedOrphanFiles: 0, errors: [] } },
  }
  const runtime = load(base + 'previewCacheMaintenanceRuntime.ts').createPreviewCacheMaintenanceRuntime(deps)
  const result = await runtime.runPreviewCacheMaintenance()
  assert.equal(result.complete, false); assert.equal(result.errors.length, 0); assert.equal(result.checkedRows, 1)
  assert.deepEqual(calls.flatMap(batch => batch.rows.map(row => row.previewKey)), ['000']); assert.deepEqual(directories, ['/local/images'])
  assert(result.deferred.length > 0, 'offline preview roots were reported as complete')
  h.states.set('/offline', { rootId: '/offline', state: 'online', generation: 2 }); calls.length = directories.length = 0
  const recovered = await runtime.runPreviewCacheMaintenance()
  assert.equal(recovered.complete, true); assert.equal(recovered.checkedRows, 3); assert.equal(directories.length, 2)
  let release, settled = false
  const physical = new Promise(resolve => { release = resolve })
  const unknown = load(base + 'previewCacheMaintenanceRuntime.ts').createPreviewCacheMaintenanceRuntime({ ...deps, runRustPreviewCacheMaintenance: async () => { throw Object.assign(Error('uncertain write'), { sharedIo: true, closed: physical, outcome: 'unknown' }) } })
  const running = unknown.runPreviewCacheMaintenance().then(result => { settled = true; return result })
  await tick(); assert.equal(settled, false); release(); const failed = await running
  assert(failed.errors.some(error => error.includes('uncertain write'))); assert.equal(failed.staleRows, 0)
}
async function startupMaintenanceCases() {
  const h = harness(); h.setBusy(true)
  let touches = 0
  const runtime = h.load(base + 'databaseMaintenance.ts').createDatabaseMaintenanceRuntime({ isForegroundBusy: h.isForegroundBusy, appendStartupLog: line => h.logs.push(line),
    dbFileSpecs: () => { touches++; throw Error('busy startup touched a database') },
  })
  const result = await runtime.runStartupDatabaseMaintenance()
  assert.equal(touches, 0); assert.equal(result.complete, false); assert.equal(result.ok, false)
  assert.equal(result.deferred[0].blocker, 'foreground'); assert.equal(h.waits, 20)
  assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0)
}
function panelStatusCases() {
  const ts = require('typescript'), vm = require('node:vm')
  const file = path.join(root, 'src/renderer/src/components/app/SharedMetadataMaintenancePanel.tsx')
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const module = { exports: {} }
  const jsx = (type, props) => ({ type, props })
  const mocks = { 'react/jsx-runtime': { jsx, jsxs: jsx }, react: { useState: value => [value, () => {}] }, '../../confirmationDialogRuntime': { confirmUserAction: async () => true }, '../../appRuntime': { stringifyDeveloperValue: JSON.stringify } }
  vm.runInNewContext(code, { module, exports: module.exports, require: id => { assert(Object.hasOwn(mocks, id)); return mocks[id] } }, { filename: file })
  const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(text).join('|') : value && typeof value === 'object' ? text(value.props?.children) : ''
  const render = diagnostics => text(module.exports.SharedMetadataMaintenancePanel({ diagnostics, refreshDeveloperStatusDetails: async () => {}, onDiagnosticsUpdated() {} }))
  const deferred = render({ ok: false, complete: false, deferredRoots: 1, severity: 'info', summary: {}, reports: [{ rootPath: 'offline', deferred: { blocker: 'unavailable' }, severity: 'info' }] })
  assert(deferred.includes('诊断未完成')); assert(deferred.includes('已延后')); assert(!deferred.includes('正常'), 'deferred diagnostics rendered healthy')
  const failed = render({ ok: false, complete: false, deferredRoots: 0, severity: 'critical', summary: {}, reports: [{ rootPath: 'broken', error: 'SQLITE_CORRUPT', severity: 'critical' }] })
  assert(failed.includes('需要处理')); assert(!failed.includes('正常'), 'failed diagnostics rendered healthy')
  assert(render({ ok: true, complete: true, severity: 'ok', summary: {} }).includes('正常'))
}
async function snapshotMaintenanceCases() {
  const h = harness(), offline = path.resolve('offline'), online = path.resolve('online'), inspected = [], cleaned = []
  h.states.set(offline, { rootId: offline, state: 'offline', generation: 1 })
  const deps = { isForegroundBusy: h.isForegroundBusy, appendStartupLog: line => h.logs.push(line), loadLibraryShell: async () => ({ folders: [offline, online] }),
    rootCacheDir: value => value, rootIndexDbPath: value => value + '/index.sqlite',
    inspectRootIndexSnapshotMaintenance: async value => { inspected.push(value); return { ok: true, staleSnapshotCount: 1, orphanSidecarCount: 0, tmpFileCount: 0, deletedFiles: [] } },
    cleanupRootIndexSnapshotMaintenance: async value => { cleaned.push(value); return { ok: true, staleSnapshotCount: 0, orphanSidecarCount: 0, tmpFileCount: 0, deletedFiles: ['old'] } },
  }
  const runtime = h.load(base + 'sharedIndexSnapshotAutoMaintenanceRuntime.ts').createSharedIndexSnapshotAutoMaintenanceRuntime(deps)
  const report = await runtime.runSharedIndexSnapshotAutoMaintenance()
  assert.equal(report.complete, false); assert.equal(report.ok, false); assert.equal(report.checkedRoots, 1)
  assert.deepEqual(inspected, [online]); assert.deepEqual(cleaned, [online]); assert.equal(report.deletedFiles, 1)
}
async function main() {
  await admissionCases(); await diagnosticsCases(); await previewCases(); await snapshotMaintenanceCases(); await startupMaintenanceCases(); panelStatusCases()
  assert(fs.readFileSync(path.join(root, 'src/renderer/src/rendererDeveloperStatusRuntime.ts'), 'utf8').includes('automatic: true'))
  const panel = fs.readFileSync(path.join(root, 'src/renderer/src/components/app/SharedMetadataMaintenancePanel.tsx'), 'utf8')
  assert(panel.includes('诊断未完成') && panel.includes("root?.deferred ? '已延后'"), 'deferred diagnostics still look healthy')
  const snapshotClient = fs.readFileSync(path.join(root, 'src/main/rust-core/clients/rustMetadataClientRuntime.ts'), 'utf8')
  assert(snapshotClient.includes('sharedDatabaseTarget(input.dbPath, true, [input.rootPath])'), 'maintenance snapshot lost writable admission')
  console.log('PASS optional maintenance: offline/late-offline, recovery, same-phase quiet resume, bounded busy deferral, corruption preservation, independent local progress and physical-close lifetime')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
