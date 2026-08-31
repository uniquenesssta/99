#!/usr/bin/env node
/** Regression checks for shared metadata frontend diagnostics IPC/dev page entry. */
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..', '..')
function read(relativePath) { return fs.readFileSync(path.join(root, relativePath), 'utf8') }
function json(relativePath) { return JSON.parse(read(relativePath)) }
function assert(condition, message) { if (!condition) throw new Error(message) }
function testFrontendDiagnosticsRuntime() {
  const text = read('src/main/indexing/shared-metadata/sharedMetadataFrontendDiagnosticsRuntime.ts')
  for (const needle of [
    'createSharedMetadataFrontendDiagnosticsRuntime',
    'readSharedMetadataFrontendDiagnostics',
    'repairSharedMetadataFromFrontend',
    'includeRepairDryRun',
    'synchronize',
    'sharedMetadataDbPathForRoot',
    'severity',
    'suggestedActions',
  ]) assert(text.includes(needle), `frontend diagnostics runtime missing ${needle}`)
}
function testMainRuntimeWiring() {
  const text = read('src/main/index.ts')
  for (const needle of [
    'createSharedMetadataFrontendDiagnosticsRuntime',
    'readSharedMetadataFrontendDiagnostics',
    'repairSharedMetadataFromFrontend',
    'openSharedMetadataDb',
  ]) assert(text.includes(needle), `main runtime missing ${needle}`)
}
function testIpcAndPreload() {
  const ipc = read('src/main/ipc/handlers/maintenanceIpcHandlers.ts')
  assert(ipc.includes('sharedMetadata:getDiagnostics'), 'missing sharedMetadata:getDiagnostics IPC handler')
  assert(ipc.includes('sharedMetadata:repair'), 'missing sharedMetadata:repair IPC handler')
  const runtimePreload = read('src/main/preload/runtimePreloadSource.ts')
  const preload = read('src/preload/index.ts')
  for (const text of [runtimePreload, preload]) {
    assert(text.includes('getSharedMetadataDiagnostics'), 'preload missing getSharedMetadataDiagnostics')
    assert(text.includes('repairSharedMetadata'), 'preload missing repairSharedMetadata')
  }
}
function testDeveloperPageWiring() {
  for (const file of [
    'src/renderer/src/App.tsx',
    'src/renderer/src/components/app/AppRootView.tsx',
    'src/renderer/src/components/app/FontListPanel.tsx',
    'src/renderer/src/components/app/FontListPanelTypes.ts',
    'src/renderer/src/rendererDeveloperStatusRuntime.ts',
  ]) {
    const text = read(file)
    assert(text.includes('developerSharedMetadataDiagnostics') || text.includes('getSharedMetadataDiagnostics'), `${file} missing shared metadata diagnostics dev-page wiring`)
  }
}
function testSharedMetadataMaintenancePanel() {
  const panel = read('src/renderer/src/components/app/SharedMetadataMaintenancePanel.tsx')
  for (const needle of [
    'SharedMetadataMaintenancePanel',
    'getSharedMetadataDiagnostics({ synchronize: true, includeRepairDryRun: true })',
    'repairSharedMetadata({',
    'apply: false',
    'apply: true',
    'archiveOrphanTagOps: true',
    'purgeArchivedOrphanTagOps: true',
    'onDiagnosticsUpdated',
  ]) assert(panel.includes(needle), `shared metadata maintenance panel missing ${needle}`)
  const fontList = read('src/renderer/src/components/app/FontListPanel.tsx')
  assert(fontList.includes('SharedMetadataMaintenancePanel'), 'developer page missing shared metadata maintenance panel')
  const css = read('src/renderer/src/styles/12-developer-tags.css')
  assert(css.includes('shared-metadata-maintenance-panel'), 'developer stylesheet missing shared metadata maintenance panel styles')
}
function testPackageScriptAndVersion() {
  const pkg = json('package.json')
  assert(pkg.version === '3.0.0', 'package version changed')
  assert(pkg.scripts['diagnostics:shared-metadata-frontend'] === 'node build/diagnostics/check-shared-metadata-frontend-diagnostics.cjs', 'missing diagnostics:shared-metadata-frontend')
}
const tests = [testFrontendDiagnosticsRuntime, testMainRuntimeWiring, testIpcAndPreload, testDeveloperPageWiring, testSharedMetadataMaintenancePanel, testPackageScriptAndVersion]
for (const test of tests) test()
console.log(`shared metadata frontend diagnostics checks passed (${tests.length})`)
