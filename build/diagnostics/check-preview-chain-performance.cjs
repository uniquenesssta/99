#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..')
async function run() {
  assert.equal(process.platform, 'win32', 'actual preview chain requires Windows')
  const directory = path.join(root, 'artifacts/list-preview/chain'), html = path.join(directory, 'index.html'), preload = path.join(directory, 'preload.cjs')
  fs.mkdirSync(directory, { recursive: true })
  await require('esbuild').build({ entryPoints: [path.join(__dirname, 'lib/preview-chain-performance-dom.ts')], bundle: true,
    outfile: path.join(directory, 'renderer.js'), platform: 'browser', format: 'iife', define: { 'import.meta.env': '{}' }, tsconfig: path.join(root, 'tsconfig.json') })
  fs.writeFileSync(html, '<!doctype html><html><meta charset="utf-8"><body><script src="renderer.js"></script></body></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = cp.spawnSync(require('electron'), [path.join(__dirname, 'lib/preview-chain-performance-electron.cjs'), directory, html, preload], { cwd: root, env, stdio: 'inherit', timeout: 150000 })
  assert.equal(result.status, 0, String(result.error || 'preview chain failed'))
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { run }
