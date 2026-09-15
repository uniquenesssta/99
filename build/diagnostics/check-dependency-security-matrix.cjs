#!/usr/bin/env node
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '../..')
const fixture = require('./fixtures/dependency-security-matrix.fixture.json')

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
}

function versionParts(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)/)
  assert(match, `invalid stable semver: ${value}`)
  return match.slice(1).map(Number)
}

function compareVersions(left, right) {
  const leftParts = versionParts(left)
  const rightParts = versionParts(right)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }
  return 0
}

function packageEntries(lock, packageName) {
  const suffix = `/node_modules/${packageName}`
  return Object.entries(lock.packages || {}).filter(([packagePath]) =>
    packagePath === `node_modules/${packageName}` || packagePath.endsWith(suffix)
  )
}

function toCrlf(source) {
  return source.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
}

function mutateLegacyWindowsPublisherConfig(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const signtoolIndex = lines.findIndex((line) => line === '  signtoolOptions:')
  assert(signtoolIndex >= 0, 'electron-builder publisher mutation target is missing')
  assert.deepEqual(
    lines.slice(signtoolIndex, signtoolIndex + 3),
    ['  signtoolOptions:', '    publisherName:', '      - Xie Ele'],
    'electron-builder publisher mutation target drifted'
  )
  lines.splice(signtoolIndex, 3, '  publisherName:', '    - Xie Ele')
  return lines.join(newline)
}

function validateWindowsBuilderConfig(builderConfigSource) {
  const lines = builderConfigSource.replace(/\r\n/g, '\n').split('\n')
  const winIndex = lines.findIndex((line) => /^win:\s*$/.test(line))
  assert(winIndex >= 0, 'electron-builder config lost the Windows section')
  const winEndOffset = lines.slice(winIndex + 1).findIndex((line) => /^\S/.test(line))
  const winEnd = winEndOffset < 0 ? lines.length : winIndex + 1 + winEndOffset
  const winLines = lines.slice(winIndex + 1, winEnd)
  const publisherIndexes = winLines
    .map((line, index) => (/^\s*publisherName:\s*$/.test(line) ? index : -1))
    .filter((index) => index >= 0)

  assert.equal(publisherIndexes.length, 1, 'Windows publisherName must have one canonical declaration')
  const publisherIndex = publisherIndexes[0]
  assert(/^ {4}publisherName:\s*$/.test(winLines[publisherIndex]), 'electron-builder v26 requires win.signtoolOptions.publisherName')
  const parentLine = [...winLines.slice(0, publisherIndex)].reverse().find((line) => /^ {2}\S/.test(line))
  assert(/^ {2}signtoolOptions:\s*$/.test(parentLine || ''), 'Windows publisherName escaped signtoolOptions')
}

function validateMatrix(packageJson, lock, configSource, builderConfigSource) {
  assert.equal(packageJson.engines?.node, fixture.nodeEngine, 'project Node engine does not match the compatible build floor')
  assert.equal(lock.packages?.['']?.engines?.node, fixture.nodeEngine, 'lock root lost the project Node engine')
  assert.deepEqual(
    Object.keys(packageJson.dependencies || {}).sort(),
    [...fixture.productionDependencies].sort(),
    'AT-7.2 must not add, remove, or replace production dependencies'
  )

  for (const [name, expected] of Object.entries(fixture.direct)) {
    assert.equal(packageJson.devDependencies?.[name], expected.range, `${name} declaration drifted from the approved compatibility group`)
    assert.equal(lock.packages?.['']?.devDependencies?.[name], expected.range, `${name} lock root declaration drifted`)
    const entry = lock.packages?.[`node_modules/${name}`]
    assert(entry, `${name} is missing from package-lock.json`)
    assert.equal(versionParts(entry.version)[0], expected.major, `${name} resolved to an unapproved major`)
    assert(compareVersions(entry.version, expected.minimum) >= 0, `${name} resolved below ${expected.minimum}`)
  }

  const electron = lock.packages?.['node_modules/electron']
  assert(electron?.dependencies?.['@electron-internal/extract-zip'], 'Electron must use its hardened internal archive extractor')
  assert(!electron?.dependencies?.['extract-zip'], 'Electron still depends on vulnerable extract-zip')
  assert.equal(packageEntries(lock, 'extract-zip').length, 0, 'vulnerable extract-zip remains in the lock graph')

  const electronVitePeers = lock.packages?.['node_modules/electron-vite']?.peerDependencies || {}
  const reactPluginPeers = lock.packages?.['node_modules/@vitejs/plugin-react']?.peerDependencies || {}
  assert(String(electronVitePeers.vite || '').includes('^7.0.0'), 'electron-vite does not declare Vite 7 compatibility')
  assert(String(reactPluginPeers.vite || '').includes('^7.0.0'), '@vitejs/plugin-react does not declare Vite 7 compatibility')
  assert(!configSource.includes('externalizeDepsPlugin'), 'electron-vite v5 deprecated externalizeDepsPlugin remains configured')
  validateWindowsBuilderConfig(builderConfigSource)

  for (const [name, minimum] of Object.entries(fixture.knownBuildChainMinimums)) {
    for (const [packagePath, entry] of packageEntries(lock, name)) {
      assert(compareVersions(entry.version, minimum) >= 0, `${packagePath} ${entry.version} remains below known-safe floor ${minimum}`)
    }
  }

  for (const [packagePath, entry] of packageEntries(lock, 'brace-expansion')) {
    const [major] = versionParts(entry.version)
    const safe = major === 1
      ? compareVersions(entry.version, '1.1.18') >= 0
      : major === 2
        ? compareVersions(entry.version, '2.1.4') >= 0
        : compareVersions(entry.version, '5.0.9') >= 0
    assert(safe, `${packagePath} ${entry.version} remains in a known vulnerable brace-expansion range`)
  }

  for (const script of Object.values(packageJson.scripts || {})) {
    assert(!String(script).includes('npm audit fix --force'), 'forced audit repair is forbidden')
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function main() {
  const baseline = childProcess.execFileSync('git', ['rev-parse', fixture.baseline], { cwd: root, encoding: 'utf8' }).trim()
  assert.equal(baseline, fixture.baseline, 'AT-7.2 baseline is unavailable')

  const packageJson = readJson('package.json')
  const lock = readJson('package-lock.json')
  const configSource = fs.readFileSync(path.join(root, 'electron.vite.config.ts'), 'utf8')
  const builderConfigSource = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')
  validateMatrix(packageJson, lock, configSource, builderConfigSource)
  const crlfConfigSource = toCrlf(configSource)
  const crlfBuilderConfigSource = toCrlf(builderConfigSource)
  validateMatrix(packageJson, lock, crlfConfigSource, crlfBuilderConfigSource)

  const oldElectron = clone(lock)
  oldElectron.packages['node_modules/electron'].version = '35.7.5'
  assert.throws(() => validateMatrix(packageJson, oldElectron, configSource, builderConfigSource), 'old Electron escaped the dependency gate')

  const oldBuilder = clone(lock)
  oldBuilder.packages['node_modules/builder-util-runtime'].version = '9.2.10'
  assert.throws(() => validateMatrix(packageJson, oldBuilder, configSource, builderConfigSource), 'old builder runtime escaped the dependency gate')

  const oldVite = clone(lock)
  oldVite.packages['node_modules/vite'].version = '6.4.3'
  assert.throws(() => validateMatrix(packageJson, oldVite, configSource, builderConfigSource), 'old Vite escaped the dependency gate')

  assert.throws(
    () => validateMatrix(packageJson, lock, `import { externalizeDepsPlugin } from 'electron-vite'\n${configSource}`, builderConfigSource),
    'deprecated electron-vite plugin configuration escaped the dependency gate'
  )

  const changedProductionDependencies = clone(packageJson)
  changedProductionDependencies.dependencies['new-runtime-package'] = '1.0.0'
  assert.throws(() => validateMatrix(changedProductionDependencies, lock, configSource, builderConfigSource), 'production dependency expansion escaped the gate')

  for (const [lineEnding, source] of [['LF', builderConfigSource], ['CRLF', crlfBuilderConfigSource]]) {
    const oldBuilderConfig = mutateLegacyWindowsPublisherConfig(source)
    assert.notEqual(oldBuilderConfig, source, `${lineEnding} electron-builder publisher mutation was not applied`)
    assert.throws(
      () => validateMatrix(packageJson, lock, configSource, oldBuilderConfig),
      `${lineEnding} electron-builder v25 publisherName nesting escaped the dependency gate`
    )
  }

  console.log('[diagnostics:dependency-security-matrix] compatible direct groups, lock graph floors, builder schema, production boundary, 6 mutants including LF/CRLF publisher rewrites passed')
}

main()
