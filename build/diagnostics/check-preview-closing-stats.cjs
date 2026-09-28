#!/usr/bin/env node
const assert = require('node:assert/strict')
const { loader } = require('./check-operation-chain.cjs')
const load = loader({ react: {}, './deferredInstallStatusRefreshRuntime': {} })
const lifecycle = load('src/renderer/src/runtime/app/rendererClosingLifecycleRuntime.ts').createRendererClosingLifecycleRuntime()
let calls = 0, release, fail
const applied = [], listeners = new Set(), originalSubscribe = lifecycle.subscribe
lifecycle.subscribe = fn => { listeners.add(fn); const off = originalSubscribe(fn); return () => { listeners.delete(fn); off() } }
const runtime = load('src/renderer/src/runtime/library/actions/fontLibraryIndexSharedRuntime.ts').createFontLibraryIndexSharedRuntime({ closingLifecycle: lifecycle,
  hfm: { getCacheStats: () => { calls++; return new Promise((resolve, reject) => { release = resolve; fail = reject }) } }, setCacheStats: value => applied.push(value) })
async function main() {
  lifecycle.beginClosing(); await runtime.loadCacheStats(); assert.equal(calls, 0)
  lifecycle.resume(); const old = runtime.loadCacheStats(); assert.equal(calls, 1); assert.equal(listeners.size, 1)
  lifecycle.beginClosing(); lifecycle.resume(); release({ old: true }); await old; assert.deepEqual(applied, []); assert.equal(listeners.size, 0)
  const rejected = runtime.loadCacheStats(); lifecycle.beginClosing(); lifecycle.resume(); fail(Error('old rejection')); await rejected; assert.deepEqual(applied, [])
  const fresh = runtime.loadCacheStats(); release({ fresh: true }); await fresh; assert.deepEqual(applied, [{ fresh: true }])
  const error = runtime.loadCacheStats(); fail(Error('real failure')); await error; assert.equal(applied.at(-1), null); assert.equal(listeners.size, 0)
  console.log('PASS cache stats: no post-close IPC, close/resume rejects stale success and error, fresh retry and cleanup')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
