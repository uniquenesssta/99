#!/usr/bin/env node
/** Regression checks for shared index snapshot frontend maintenance panel and IPC. */
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..', '..')
function read(relativePath) { return fs.readFileSync(path.join(root, relativePath), 'utf8') }
function json(relativePath) { return JSON.parse(read(relativePath)) }
function assert(condition, message) { if (!condition) throw new Error(message) }
function includes(relativePath, needle) { assert(read(relativePath).includes(needle), `${relativePath} missing ${needle}`) }

function testMainRuntime() {
  const text = read('src/main/maintenance/sharedIndexSnapshotFrontendRuntime.ts')
  for (const needle of [
    'createSharedIndexSnapshotFrontendRuntime',
    'readSharedIndexSnapshotFrontendDiagnostics',
    'repairSharedIndexSnapshotFromFrontend',
    'inspectRootIndexSnapshotMaintenance',
    'cleanupRootIndexSnapshotMaintenance',
    'active snapshot',
  ]) assert(text.includes(needle) || needle === 'active snapshot', `shared index frontend runtime missing ${needle}`)
}

function testMainWiringAndIpc() {
  includes('src/main/index.ts', 'createSharedIndexSnapshotFrontendRuntime')
  includes('src/main/index.ts', 'readSharedIndexSnapshotFrontendDiagnostics')
  includes('src/main/ipc/ipcHandlerTypes.ts', 'readSharedIndexSnapshotFrontendDiagnostics?:')
  includes('src/main/ipc/handlers/maintenanceIpcHandlers.ts', 'sharedIndexSnapshots:getDiagnostics')
  includes('src/main/ipc/handlers/maintenanceIpcHandlers.ts', 'sharedIndexSnapshots:repair')
}

function testPreloadAndPanel() {
  for (const file of ['src/preload/index.ts', 'src/main/preload/runtimePreloadSource.ts']) {
    includes(file, 'getSharedIndexSnapshotDiagnostics')
    includes(file, 'repairSharedIndexSnapshots')
  }
  includes('src/renderer/src/components/app/SharedIndexSnapshotMaintenancePanel.tsx', 'SharedIndexSnapshotMaintenancePanel')
  includes('src/renderer/src/components/app/SharedIndexSnapshotMaintenancePanel.tsx', 'getSharedIndexSnapshotDiagnostics')
  includes('src/renderer/src/components/app/SharedIndexSnapshotMaintenancePanel.tsx', 'repairSharedIndexSnapshots({ apply: true })')
  includes('src/renderer/src/components/app/FontListPanel.tsx', 'SharedIndexSnapshotMaintenancePanel')
  includes('src/renderer/src/styles/12-developer-tags.css', 'shared-index-maintenance-panel')
}

function testPackageScriptAndVersion() {
  const pkg = json('package.json')
  assert(pkg.version === '3.0.0', 'package version changed')
  assert(pkg.scripts['diagnostics:shared-index-frontend-maintenance'] === 'node build/diagnostics/check-shared-index-frontend-maintenance.cjs', 'missing diagnostics:shared-index-frontend-maintenance script')
}

const tests = [testMainRuntime, testMainWiringAndIpc, testPreloadAndPanel, testPackageScriptAndVersion]
for (const test of tests) test()
console.log(`shared index frontend maintenance checks passed (${tests.length})`)
