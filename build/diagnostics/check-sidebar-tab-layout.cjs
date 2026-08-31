#!/usr/bin/env node
/** Regression checks for adaptive sidebar page icon spacing. */
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..', '..')
function read(relativePath) { return fs.readFileSync(path.join(root, relativePath), 'utf8') }
function json(relativePath) { return JSON.parse(read(relativePath)) }
function assert(condition, message) { if (!condition) throw new Error(message) }
function includes(relativePath, needle) { assert(read(relativePath).includes(needle), `${relativePath} missing ${needle}`) }

function testAdaptiveExpandedTabs() {
  const css = read('src/renderer/src/styles/studio-interface/studio-interface-13.css')
  for (const needle of [
    'Sidebar page icons: keep four columns but distribute the tracks across the available sidebar width.',
    '@media (min-width: 1081px)',
    '--hfm-sidebar-tab-size: 38px',
    '--hfm-sidebar-tab-gap: clamp(6px, 4%, 10px)',
    'grid-template-columns: repeat(4, minmax(var(--hfm-sidebar-tab-size), 1fr)) !important',
    'justify-content: stretch !important',
    'justify-items: center !important',
    'justify-self: center !important',
  ]) assert(css.includes(needle), `adaptive sidebar tab css missing ${needle}`)
}

function testCompactModeGuard() {
  const css = read('src/renderer/src/styles/studio-interface/studio-interface-13.css')
  for (const needle of [
    '@media (max-width: 1080px)',
    'grid-template-columns: 1fr !important',
    'justify-items: stretch !important',
    'max-width: none !important',
  ]) assert(css.includes(needle), `compact sidebar guard missing ${needle}`)
}

function testPackageScriptAndVersion() {
  const pkg = json('package.json')
  assert(pkg.version === '3.0.0', 'package version changed')
  assert(pkg.scripts['diagnostics:sidebar-tab-layout'] === 'node build/diagnostics/check-sidebar-tab-layout.cjs', 'missing diagnostics:sidebar-tab-layout script')
}

includes('src/renderer/src/styles.css', '@import "./styles/13-studio-interface.css"')
const tests = [testAdaptiveExpandedTabs, testCompactModeGuard, testPackageScriptAndVersion]
for (const test of tests) test()
console.log(`sidebar tab layout checks passed (${tests.length})`)
