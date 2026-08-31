#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8') }
function assert(condition, message) {
  if (!condition) {
    console.error(`[diagnostics:scan-root-path-boundary] ${message}`)
    process.exit(1)
  }
}

const listing = read('src/main/indexing/scan-orchestrator/scanListingRuntime.ts')
assert(listing.includes("import { findBestWatchedRootForFile } from '../../path/fontPathPolicy'"), 'scan listing must reuse the canonical watched-root boundary helper')
assert(listing.includes('return findBestWatchedRootForFile(dirPath, folders)'), 'Rust directory results must resolve through the canonical watched-root matcher')
assert(!listing.includes('startsWith(`${normalizedRoot}/`)'), 'scan listing must not compare Windows-normalized paths with a forward-slash boundary')

const earlyVisible = read('src/main/indexing/scan-orchestrator/fontScanEarlyVisibleRuntime.ts')
assert(earlyVisible.includes('cacheKey: string) => FontItem'), 'early-visible cache adapter must require the cache key promised by the scan orchestrator')
assert(!earlyVisible.includes('cacheKey?: string) => FontItem'), 'early-visible cache adapter must not weaken the cache-key contract')

console.log('[diagnostics:scan-root-path-boundary] ok')
