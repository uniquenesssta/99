#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
function assert(condition, message) {
  if (!condition) {
    console.error(`[diagnostics:release-build-gate] ${message}`)
    process.exit(1)
  }
}

const verify = String(packageJson.scripts?.verify || '')
assert(verify.includes('npm run typecheck'), 'verify must run TypeScript validation')
assert(verify.includes('npm run diagnostics:all'), 'verify must run the complete diagnostics suite')
assert(String(packageJson.scripts?.['diagnostics:all'] || '').includes('build/diagnostics/run-all.cjs'), 'diagnostics:all must use the shared diagnostics runner')

const diagnosticsRunner = fs.readFileSync(path.join(root, 'build', 'diagnostics', 'run-all.cjs'), 'utf8')
assert(diagnosticsRunner.includes('process.env.npm_execpath'), 'diagnostics runner must use npm_execpath for cross-platform nested npm execution')
assert(diagnosticsRunner.includes('command: process.execPath'), 'diagnostics runner must launch npm-cli.js through the active Node executable')
assert(diagnosticsRunner.includes("shell: process.platform === 'win32'"), 'diagnostics runner must keep a Windows shell fallback when npm_execpath is unavailable')

for (const name of ['build', 'build:win', 'pack:dir']) {
  const script = String(packageJson.scripts?.[name] || '')
  assert(script.startsWith('npm run verify && '), `${name} must run the complete verification gate before producing artifacts`)
  assert(script.includes('build/rust/build-core-worker.cjs --required'), `${name} must fail when the Rust core cannot be rebuilt`)
  assert(!script.includes('build/rust/build-core-worker.cjs --optional'), `${name} must not silently reuse a stale Rust core`)
}

console.log('[diagnostics:release-build-gate] ok')
