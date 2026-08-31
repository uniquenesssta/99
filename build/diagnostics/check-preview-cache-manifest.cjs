#!/usr/bin/env node
/**
 * Regression checks for shared preview cache machine manifest append path.
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertIncludes(relativePath, needle) {
  const text = readText(relativePath)
  assert(text.includes(needle), `${relativePath} missing ${needle}`)
}

function testManifestRuntimeWritesPerMachineJsonl() {
  assertIncludes('src/main/preview/runtime/previewCacheManifestRuntime.ts', 'createPreviewCacheManifestRuntime')
  assertIncludes('src/main/preview/runtime/previewCacheManifestRuntime.ts', "join(sharedCacheDir(storage), 'manifests'")
  assertIncludes('src/main/preview/runtime/previewCacheManifestRuntime.ts', '.jsonl')
  assertIncludes('src/main/preview/runtime/previewCacheManifestRuntime.ts', 'appendFile')
  assertIncludes('src/main/preview/runtime/previewCacheManifestRuntime.ts', 'HFM_PREVIEW_MANIFEST_WRITE_TIMEOUT_MS')
}

function testPublishAppendsManifestAfterAtomicPublish() {
  const text = readText('src/main/preview/runtime/previewCachePublishRuntime.ts')
  assert(text.includes('appendSharedPreviewCacheManifest'), 'publish runtime missing manifest hook')
  assert(text.includes('manifestWritten'), 'publish summary missing manifest counter')
  assert(text.includes("manifestEvent: PreviewCacheManifestEvent = 'existing'"), 'publish runtime missing existing manifest event')
  assert(text.includes("manifestEvent = 'published'"), 'publish runtime missing published manifest event')
  assert(text.includes("manifestEvent = 'meta-mismatch'"), 'publish runtime missing meta mismatch manifest event')
}

function testPreviewRuntimeWiresManifestRuntime() {
  const text = readText('src/main/preview/previewRuntime.ts')
  assert(text.includes('createPreviewCacheManifestRuntime'), 'preview runtime missing manifest runtime')
  assert(text.includes('readSharedPreviewCacheMeta: previewCacheMetaRuntime.readPreviewCacheMeta'), 'manifest runtime does not reuse shared meta reader')
  assert(text.includes('appendSharedPreviewCacheManifest: previewCacheManifestRuntime.appendPreviewCacheManifestEntry'), 'publish runtime is not wired to manifest append')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:preview-cache-manifest'] === 'node build/diagnostics/check-preview-cache-manifest.cjs', 'missing diagnostics:preview-cache-manifest script')
}

const tests = [
  testManifestRuntimeWritesPerMachineJsonl,
  testPublishAppendsManifestAfterAtomicPublish,
  testPreviewRuntimeWiresManifestRuntime,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`preview cache manifest checks passed (${tests.length})`)
