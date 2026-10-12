#!/usr/bin/env node
'use strict'
// Actual Electron invoke serialization and both shipped preloads. Windows only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const { loader } = require('./check-operation-chain.cjs')

async function main() {
  assert.equal(process.platform, 'win32', 'Font query IPC acceptance requires Windows')
  const root = path.resolve(__dirname, '../..')
  const parent = path.join(root, 'artifacts', 'font-query-ipc')
  fs.mkdirSync(parent, { recursive: true })
  const directory = fs.mkdtempSync(path.join(parent, 'run-'))
  const runtimePreload = path.join(directory, 'runtime-preload.cjs')
  const indexPreload = path.join(directory, 'index-preload.cjs')
  fs.writeFileSync(runtimePreload, loader()('src/main/preload/runtimePreloadSource.ts').runtimePreloadSource)
  await require('esbuild').build({ entryPoints: [path.join(root, 'src/preload/index.ts')], outfile: indexPreload,
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  const html = path.join(directory, 'index.html')
  fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>Font query IPC acceptance</title><body></body>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = cp.spawnSync(require('electron'), [path.join(__dirname, 'lib/font-query-ipc-electron.cjs'), directory, html, indexPreload, runtimePreload],
    { cwd: root, env, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 })
  const childOutput = [child.error && String(child.error), child.signal && 'signal=' + child.signal, child.stderr, child.stdout]
    .filter(Boolean).join('\n').slice(-16000)
  const reportPath = path.join(directory, 'report.json')
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : undefined
  const details = [report?.error, childOutput].filter(Boolean).join('\n') || 'No child failure detail was recorded'
  assert.equal(child.status, 0, 'Electron font query IPC process failed: ' + details)
  assert(report, 'Electron font query IPC report missing: ' + details)
  assert.equal(report.passed, true, 'Electron font query IPC acceptance failed: ' + details)
  assert.equal(report.bridges.length, 2, 'Electron font query IPC did not complete both preloads: ' + details)
  console.log('[diagnostics:font-query-ipc] actual Electron, both preloads, admission/active/navigation cancellation, physical close and genuine errors passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
