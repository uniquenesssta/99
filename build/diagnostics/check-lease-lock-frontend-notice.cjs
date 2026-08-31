#!/usr/bin/env node
/** Regression checks for NAS lease lock conflict frontend notice and logging. */
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..', '..')
function read(relativePath) { return fs.readFileSync(path.join(root, relativePath), 'utf8') }
function json(relativePath) { return JSON.parse(read(relativePath)) }
function assert(condition, message) { if (!condition) throw new Error(message) }
function includes(relativePath, needle) { assert(read(relativePath).includes(needle), `${relativePath} missing ${needle}`) }

function testParserRuntime() {
  const text = read('src/renderer/src/runtime/lease-lock/leaseLockConflictNoticeRuntime.ts')
  for (const needle of [
    'parseLeaseLockConflictNotice',
    'friendlyLeaseLockOperationName',
    "'move-font-batch': '批量移动字体'",
    "'delete-font': '删除字体到回收站'",
    'LOCK_CONFLICT_PATTERN',
  ]) assert(text.includes(needle), `lease lock parser missing ${needle}`)
}

function testNoticeComponentWiring() {
  includes('src/renderer/src/components/app/LeaseLockConflictNotice.tsx', '复制锁信息')
  includes('src/renderer/src/components/app/AppOverlays.tsx', 'LeaseLockConflictNotice')
  includes('src/renderer/src/App.tsx', 'parseLeaseLockConflictNotice(status)')
  includes('src/renderer/src/App.tsx', 'leaseLockConflictNotice')
  includes('src/renderer/src/styles/12-developer-tags.css', 'lease-lock-notice')
}

function testBackendConflictLogging() {
  const text = read('src/main/storage/runtime/sharedLeaseLockRuntime.ts')
  for (const needle of [
    'formatSharedLeaseLockConflictLog',
    'shared lease lock conflict:',
    'options.appendStartupLog?.(formatSharedLeaseLockConflictLog(details))',
    'SharedLeaseLockConflictError',
  ]) assert(text.includes(needle), `lease lock backend logging missing ${needle}`)
}

function testPackageScriptAndVersion() {
  const pkg = json('package.json')
  assert(pkg.version === '3.0.0', 'package version changed')
  assert(pkg.scripts['diagnostics:lease-lock-frontend-notice'] === 'node build/diagnostics/check-lease-lock-frontend-notice.cjs', 'missing diagnostics:lease-lock-frontend-notice script')
}

const tests = [testParserRuntime, testNoticeComponentWiring, testBackendConflictLogging, testPackageScriptAndVersion]
for (const test of tests) test()
console.log(`lease lock frontend notice checks passed (${tests.length})`)
