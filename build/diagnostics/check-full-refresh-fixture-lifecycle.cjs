#!/usr/bin/env node
'use strict'

// Isolated fixture counterexamples, called by full-refresh-acceptance on Windows.
// These create only private temporary fixtures, never a production font/cache.
// No native worker, shell, elevation, builds, or timing claims are involved.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const vm = require('node:vm')
const lifecycle = require('./lib/full-refresh-fixture-lifecycle.cjs')

const closeProof = () => ({ hostClosed: true, databaseOwnersClosed: true, childrenReaped: true,
  remainingDatabaseOwners: 0, remainingChildren: 0 })
const cachePath = (fixture, index = 0) => path.join(fixture.roots[index], '.hfm-cache')
const exists = file => { try { fs.lstatSync(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
const json = value => JSON.parse(JSON.stringify(value))
function immutableFile(file) {
  const stat = fs.lstatSync(file, { bigint: true })
  return { path: file, physical: `${stat.dev}:${stat.ino}`, size: String(stat.size), mtimeNs: String(stat.mtimeNs),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
}
function withFixture(run) {
  // Canonicalize the ambient temp directory before creating any owned fixture.
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hfm-fixture-lifecycle-'))
  const fixtureDirectory = path.join(directory, 'fonts'), roots = [path.join(fixtureDirectory, 'root-a'), path.join(fixtureDirectory, 'root-b')]
  fs.mkdirSync(fixtureDirectory)
  for (const root of roots) fs.mkdirSync(root)
  const font = path.join(roots[0], 'immutable-font.ttf'), sentinel = path.join(directory, 'unrelated.txt')
  fs.writeFileSync(font, 'Owned test font bytes; this file is never an actual system font.')
  fs.writeFileSync(sentinel, 'Untouched sibling evidence')
  const fixture = { directory, fixtureDirectory, roots, font, sentinel,
    ownership: lifecycle.captureFixtureRoots({ fixtureDirectory, roots }) }
  try { return run(fixture) }
  finally {
    // Test teardown is separate from the lifecycle under test. This is the sole
    // recursively removed path, freshly created by this invocation's mkdtemp.
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
function caseDirectory(fixture, caseId) {
  const directory = path.join(fixture.directory, `case-${caseId}`)
  fs.mkdirSync(directory)
  return directory
}
function create(fixture, module = lifecycle) {
  return module.createFixtureCacheLifecycle({ ownership: fixture.ownership, evidenceDirectory: fixture.directory })
}
function begin(fixture, owner, caseId = 'A1') {
  const directory = caseDirectory(fixture, caseId)
  owner.beginCase({ caseId, caseDirectory: directory })
  return directory
}
function generate(fixture, index = 0, value = 'case generated metadata') {
  const directory = cachePath(fixture, index)
  fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, 'tags.sqlite'), value)
  fs.mkdirSync(path.join(directory, 'metadata'))
  fs.writeFileSync(path.join(directory, 'metadata', 'index.json'), JSON.stringify({ value }))
  return directory
}
function reject(owner, action, pattern) {
  assert.throws(action, pattern)
  assert.equal(owner.snapshot().blocked, true, 'Lifecycle failure must be sticky')
  const original = json(owner.snapshot().failure)
  assert.throws(() => owner.beginCase({ caseId: 'following', caseDirectory: path.join(os.tmpdir(), 'must-not-be-opened') }),
    error => error.code === 'ERR_FIXTURE_BLOCKED', 'Failed lifecycle admitted a later case')
  assert.deepEqual(json(owner.snapshot().failure), original, 'Blocked retry replaced the original failure')
}
// Isolated module loading only for syscall counterexamples. Production has no
// test hook, mutable global fs replacement, or alternate cache-path override.
function loadWithFs(overrides) {
  const filename = path.join(__dirname, 'lib', 'full-refresh-fixture-lifecycle.cjs')
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process,
    require: name => name === 'node:fs' ? new Proxy(fs, { get(target, property) {
      return Object.prototype.hasOwnProperty.call(overrides, property) ? overrides[property] : Reflect.get(target, property)
    } }) : require(name) }, { filename })
  return module.exports
}

function runFixtureLifecycleRegressions() {
  const checked = []
  const test = (name, run) => { withFixture(run); checked.push(name) }

  test('two sequential archives retain bytes and physical font identity', fixture => {
    const font = immutableFile(fixture.font), sentinel = immutableFile(fixture.sentinel)
    const owner = create(fixture)
    for (const caseId of ['A1', 'B1']) {
      const directory = begin(fixture, owner, caseId)
      for (let index = 0; index < fixture.roots.length; index++) generate(fixture, index, `${caseId}-${index}`)
      const report = owner.finalizeCase({ caseId, closeProof: closeProof() })
      assert.equal(report.status, 'archived')
      assert.equal(report.roots.length, 2)
      for (let index = 0; index < fixture.roots.length; index++) {
        assert.equal(exists(cachePath(fixture, index)), false)
        assert.equal(fs.readFileSync(path.join(directory, 'generated-shared-root-cache', `root-${index}`, 'tags.sqlite'), 'utf8'), `${caseId}-${index}`)
        assert.equal(report.roots[index].before, 'absent')
        assert.equal(report.roots[index].namespace.files, 2)
      }
    }
    assert.equal(owner.snapshot().blocked, false)
    assert.equal(owner.snapshot().activeCaseId, null)
    assert.equal(owner.snapshot().cases.length, 2)
    assert.deepEqual(immutableFile(fixture.font), font)
    assert.deepEqual(immutableFile(fixture.sentinel), sentinel)
  })
  test('fully closed no-cache case is retained and permits next case', fixture => {
    const owner = create(fixture)
    begin(fixture, owner)
    const report = owner.finalizeCase({ caseId: 'A1', closeProof: closeProof() })
    assert(report.roots.every(row => row.status === 'absent'))
    begin(fixture, owner, 'B1')
    generate(fixture, 1)
    const next = owner.finalizeCase({ caseId: 'B1', closeProof: closeProof() })
    assert.deepEqual(next.roots.map(row => row.status), ['absent', 'archived'])
  })
  for (const kind of ['directory', 'file']) test(`preexisting ${kind} namespace is preserved`, fixture => {
    const owner = create(fixture), cache = cachePath(fixture)
    if (kind === 'directory') generate(fixture)
    else fs.writeFileSync(cache, 'preexisting metadata')
    const directory = caseDirectory(fixture, 'A1')
    reject(owner, () => owner.beginCase({ caseId: 'A1', caseDirectory: directory }), /Expected absent/)
    assert.equal(exists(cache), true)
    assert.equal(exists(path.join(directory, 'generated-shared-root-cache')), false)
  })
  test('capture refuses preexisting namespace', fixture => {
    generate(fixture)
    assert.throws(() => lifecycle.captureFixtureRoots(fixture), /Expected absent/)
    assert.equal(exists(cachePath(fixture)), true)
  })
  test('capture rejects nonowned, equal, duplicate and overlapping roots', fixture => {
    for (const roots of [[fixture.directory], [fixture.fixtureDirectory], [fixture.roots[0], fixture.roots[0]]]) {
      assert.throws(() => lifecycle.captureFixtureRoots({ fixtureDirectory: fixture.fixtureDirectory, roots }), /not owned|Duplicate\/overlapping/)
    }
    const nested = path.join(fixture.roots[0], 'nested')
    fs.mkdirSync(nested)
    assert.throws(() => lifecycle.captureFixtureRoots({ fixtureDirectory: fixture.fixtureDirectory, roots: [fixture.roots[0], nested] }), /Duplicate\/overlapping/)
    assert.throws(() => lifecycle.createFixtureCacheLifecycle({ ownership: {}, evidenceDirectory: fixture.directory }), /Missing manifest-owned/)
  })
  test('manifest ownership is copied and cannot be changed by caller', fixture => {
    const owner = create(fixture)
    fixture.ownership.roots[0].path = fixture.directory
    begin(fixture, owner)
    generate(fixture)
    owner.finalizeCase({ caseId: 'A1', closeProof: closeProof() })
    assert.equal(owner.snapshot().blocked, false)
  })
  for (const phase of ['begin', 'finalize']) test(`replaced root identity blocks ${phase} without moving cache`, fixture => {
    const owner = create(fixture)
    const directory = phase === 'begin' ? caseDirectory(fixture, 'A1') : begin(fixture, owner)
    const original = fixture.roots[0], retired = original + '-retained'
    if (phase === 'finalize') generate(fixture)
    fs.renameSync(original, retired)
    fs.mkdirSync(original)
    const action = phase === 'begin' ? () => owner.beginCase({ caseId: 'A1', caseDirectory: directory }) :
      () => owner.finalizeCase({ caseId: 'A1', closeProof: closeProof() })
    reject(owner, action, /Fixture identity changed/)
    assert.equal(exists(path.join(retired, 'immutable-font.ttf')), true)
    if (phase === 'finalize') assert.equal(exists(path.join(retired, '.hfm-cache', 'tags.sqlite')), true)
  })
  test('changed fixture directory identity blocks even if roots are retained', fixture => {
    const owner = create(fixture), directory = caseDirectory(fixture, 'A1')
    fs.renameSync(fixture.fixtureDirectory, fixture.fixtureDirectory + '-retained')
    fs.mkdirSync(fixture.fixtureDirectory)
    for (const root of fixture.roots) fs.renameSync(path.join(fixture.fixtureDirectory + '-retained', path.basename(root)), root)
    reject(owner, () => owner.beginCase({ caseId: 'A1', caseDirectory: directory }), /Fixture identity changed/)
  })
  test('overlapping live cases cannot reset the prior namespace', fixture => {
    const owner = create(fixture)
    begin(fixture, owner)
    generate(fixture)
    reject(owner, () => begin(fixture, owner, 'B1'), /Previous fixture case/)
    assert.equal(exists(cachePath(fixture)), true)
  })
  test('repeated case ID cannot reuse previous archive', fixture => {
    const owner = create(fixture), directory = begin(fixture, owner)
    generate(fixture)
    owner.finalizeCase({ caseId: 'A1', closeProof: closeProof() })
    reject(owner, () => owner.beginCase({ caseId: 'A1', caseDirectory: directory }), /Case ID must be unique/)
    assert.equal(exists(path.join(directory, 'generated-shared-root-cache', 'root-0', 'tags.sqlite')), true)
  })
  test('case directory must be outside immutable fixture', fixture => {
    const owner = create(fixture)
    reject(owner, () => owner.beginCase({ caseId: 'A1', caseDirectory: fixture.roots[0] }), /outside the fixture/)
  })
  test('new case cannot nest inside prior archived evidence', fixture => {
    const owner = create(fixture), directory = begin(fixture, owner)
    generate(fixture)
    owner.finalizeCase({ caseId: 'A1', closeProof: closeProof() })
    const prior = path.join(directory, 'generated-shared-root-cache', 'root-0')
    reject(owner, () => owner.beginCase({ caseId: 'B1', caseDirectory: prior }), /Case evidence directory/)
    assert.equal(fs.readFileSync(path.join(prior, 'tags.sqlite'), 'utf8'), 'case generated metadata')
  })
  test('missing active case and wrong finalization case are blocked', fixture => {
    const owner = create(fixture)
    reject(owner, () => owner.finalizeCase({ caseId: 'A1', closeProof: closeProof() }), /Only the active/)
    const other = create(fixture)
    begin(fixture, other)
    generate(fixture)
    reject(other, () => other.finalizeCase({ caseId: 'B1', closeProof: closeProof() }), /Only the active/)
    assert.equal(exists(cachePath(fixture)), true)
  })
  const badProofs = [undefined, {}, ...['hostClosed', 'databaseOwnersClosed', 'childrenReaped'].flatMap(field =>
    [false, 'true', undefined].map(value => ({ ...closeProof(), [field]: value }))),
  ...['remainingDatabaseOwners', 'remainingChildren'].flatMap(field => [1, '0', undefined].map(value => ({ ...closeProof(), [field]: value }))),
  ...['cleanupFailure', 'failure', 'error'].map(field => ({ ...closeProof(), [field]: 'close failed' }))]
  badProofs.forEach((proof, index) => test(`unproven or failed cleanup ${index} retains namespace`, fixture => {
    const owner = create(fixture), directory = begin(fixture, owner)
    generate(fixture)
    reject(owner, () => owner.finalizeCase({ caseId: 'A1', closeProof: proof }), /Archive requires|Cleanup failed/)
    assert.equal(exists(cachePath(fixture)), true)
    assert.equal(exists(path.join(directory, 'generated-shared-root-cache')), false)
  }))
  for (const phase of ['begin', 'finalize']) test(`occupied archive at ${phase} is never overwritten`, fixture => {
    const owner = create(fixture)
    const directory = phase === 'begin' ? caseDirectory(fixture, 'A1') : begin(fixture, owner)
    const archive = path.join(directory, 'generated-shared-root-cache')
    fs.mkdirSync(archive)
    fs.writeFileSync(path.join(archive, 'prior-evidence'), 'preserve')
    if (phase === 'finalize') generate(fixture)
    const action = phase === 'begin' ? () => owner.beginCase({ caseId: 'A1', caseDirectory: directory }) :
      () => owner.finalizeCase({ caseId: 'A1', closeProof: closeProof() })
    reject(owner, action, /Expected absent/)
    assert.equal(fs.readFileSync(path.join(archive, 'prior-evidence'), 'utf8'), 'preserve')
    if (phase === 'finalize') assert.equal(exists(cachePath(fixture)), true)
  })
  test('replaced case evidence directory is refused', fixture => {
    const owner = create(fixture), directory = begin(fixture, owner)
    generate(fixture)
    fs.renameSync(directory, directory + '-retained')
    fs.mkdirSync(directory)
    reject(owner, () => owner.finalizeCase({ caseId: 'A1', closeProof: closeProof() }), /Fixture identity changed/)
    assert.equal(exists(cachePath(fixture)), true)
  })
  test('unknown cache entry type fails before any archive', fixture => {
    let unknown = ''
    const module = loadWithFs({ lstatSync(file, options) {
      const stat = fs.lstatSync(file, options)
      if (file === unknown) return new Proxy(stat, { get(target, property) {
        return property === 'isFile' || property === 'isDirectory' ? () => false : Reflect.get(target, property)
      } })
      return stat
    } })
    const owner = create(fixture, module), directory = begin(fixture, owner)
    generate(fixture)
    generate(fixture, 1)
    unknown = path.join(cachePath(fixture, 1), 'tags.sqlite')
    reject(owner, () => owner.finalizeCase({ caseId: 'A1', closeProof: closeProof() }), /Unknown or unexpected/)
    assert.equal(exists(cachePath(fixture)), true)
    assert.equal(exists(path.join(directory, 'generated-shared-root-cache')), false)
  })
  test('hard-linked cache metadata is not treated as owned', fixture => {
    const owner = create(fixture), directory = begin(fixture, owner)
    const cache = generate(fixture)
    fs.linkSync(fixture.sentinel, path.join(cache, 'foreign-hardlink'))
    reject(owner, () => owner.finalizeCase({ caseId: 'A1', closeProof: closeProof() }), /hard-linked file/)
    assert.equal(fs.readFileSync(fixture.sentinel, 'utf8'), 'Untouched sibling evidence')
    assert.equal(exists(path.join(directory, 'generated-shared-root-cache')), false)
  })
  test('canonical path-changing alias fails closed', fixture => {
    const module = loadWithFs({ realpathSync(file, ...args) {
      return file === fixture.roots[0] ? fixture.roots[1] : fs.realpathSync(file, ...args)
    } })
    assert.throws(() => create(fixture, module), /Path-changing alias/)
  })
  test('archive reservation failure retains all namespaces', fixture => {
    const module = loadWithFs({ mkdirSync(file, ...args) {
      if (path.basename(file) === 'generated-shared-root-cache') throw Object.assign(Error('archive permission denied'), { code: 'EACCES' })
      return fs.mkdirSync(file, ...args)
    } })
    const owner = create(fixture, module)
    begin(fixture, owner)
    generate(fixture)
    reject(owner, () => owner.finalizeCase({ caseId: 'A1', closeProof: closeProof() }), /archive permission denied/)
    assert.equal(exists(cachePath(fixture)), true)
  })
  for (const thrown of [Object.freeze(new Error('frozen archive failure')), 'primitive archive failure', null, undefined]) {
    test(`original archive failure identity is retained: ${String(thrown)}`, fixture => {
      const module = loadWithFs({ renameSync() { throw thrown } })
      const owner = create(fixture, module)
      begin(fixture, owner)
      generate(fixture)
      let didThrow = false, actual
      try { owner.finalizeCase({ caseId: 'A1', closeProof: closeProof() }) }
      catch (error) { didThrow = true; actual = error }
      assert.equal(didThrow, true)
      assert.equal(actual, thrown, 'Lifecycle provenance must never mask the original failure')
      assert.equal(owner.snapshot().blocked, true)
      assert.equal(owner.snapshot().failure.phase, 'finalize')
      assert.equal(owner.snapshot().failure.message, thrown instanceof Error ? thrown.message : String(thrown))
      assert.equal(exists(cachePath(fixture)), true)
      assert.throws(() => owner.beginCase({ caseId: 'B1' }), error => error.code === 'ERR_FIXTURE_BLOCKED')
    })
  }
  test('null lstat failure stays original and poisons begin', fixture => {
    const module = loadWithFs({ lstatSync(file, ...args) {
      if (file === cachePath(fixture)) throw null
      return fs.lstatSync(file, ...args)
    } })
    const owner = create(fixture, module), directory = caseDirectory(fixture, 'A1')
    let didThrow = false, actual
    try { owner.beginCase({ caseId: 'A1', caseDirectory: directory }) }
    catch (error) { didThrow = true; actual = error }
    assert.equal(didThrow, true)
    assert.equal(actual, null)
    assert.equal(owner.snapshot().blocked, true)
    assert.equal(owner.snapshot().failure.message, 'null')
    assert.throws(() => owner.beginCase({ caseId: 'B1' }), error => error.code === 'ERR_FIXTURE_BLOCKED')
  })
  test('occupied per-root destination is never overwritten', fixture => {
    const module = loadWithFs({ mkdirSync(file, ...args) {
      const result = fs.mkdirSync(file, ...args)
      if (path.basename(file) === 'generated-shared-root-cache') {
        fs.mkdirSync(path.join(file, 'root-0'))
        fs.writeFileSync(path.join(file, 'root-0', 'prior'), 'retain competing destination')
      }
      return result
    } })
    const owner = create(fixture, module), directory = begin(fixture, owner)
    generate(fixture)
    reject(owner, () => owner.finalizeCase({ caseId: 'A1', closeProof: closeProof() }), /Expected absent/)
    assert.equal(exists(cachePath(fixture)), true)
    assert.equal(fs.readFileSync(path.join(directory, 'generated-shared-root-cache', 'root-0', 'prior'), 'utf8'), 'retain competing destination')
  })
  test('partial rename failure retains prior moved evidence and unmoved data', fixture => {
    let moves = 0
    const module = loadWithFs({ renameSync(source, destination) {
      moves++
      if (moves === 2) throw Object.assign(Error('second archive rename failed'), { code: 'EACCES' })
      return fs.renameSync(source, destination)
    } })
    const owner = create(fixture, module), directory = begin(fixture, owner)
    generate(fixture, 0, 'first moved data')
    generate(fixture, 1, 'second preserved data')
    reject(owner, () => owner.finalizeCase({ caseId: 'A1', closeProof: closeProof() }), /second archive rename failed/)
    assert.equal(moves, 2, 'Archive failure must not retry')
    assert.equal(exists(cachePath(fixture, 0)), false)
    assert.equal(fs.readFileSync(path.join(directory, 'generated-shared-root-cache', 'root-0', 'tags.sqlite'), 'utf8'), 'first moved data')
    assert.equal(fs.readFileSync(path.join(cachePath(fixture, 1), 'tags.sqlite'), 'utf8'), 'second preserved data')
    assert.deepEqual(json(owner.snapshot().cases[0].roots.map(row => row.status)), ['archived', 'pending'])
  })
  test('cache mutation during archive blocks remaining moves and retains evidence', fixture => {
    let moves = 0
    const module = loadWithFs({ renameSync(source, destination) {
      const result = fs.renameSync(source, destination)
      moves++
      fs.writeFileSync(path.join(cachePath(fixture, 1), 'new-external-entry'), 'must retain')
      return result
    } })
    const owner = create(fixture, module), directory = begin(fixture, owner)
    generate(fixture, 0)
    generate(fixture, 1)
    reject(owner, () => owner.finalizeCase({ caseId: 'A1', closeProof: closeProof() }), /changed after archive preflight/)
    assert.equal(moves, 1)
    assert.equal(exists(path.join(directory, 'generated-shared-root-cache', 'root-0', 'tags.sqlite')), true)
    assert.equal(exists(path.join(cachePath(fixture, 1), 'new-external-entry')), true)
  })
  test('post-rename validation failure retains moved data and records its location', fixture => {
    const module = loadWithFs({ renameSync(source, destination) {
      const result = fs.renameSync(source, destination)
      fs.writeFileSync(path.join(destination, 'unexpected-after-rename'), 'retain moved evidence')
      return result
    } })
    const owner = create(fixture, module), directory = begin(fixture, owner)
    generate(fixture, 0)
    generate(fixture, 1)
    reject(owner, () => owner.finalizeCase({ caseId: 'A1', closeProof: closeProof() }), /Archived cache identity\/content metadata changed/)
    assert.equal(exists(cachePath(fixture, 0)), false)
    assert.equal(exists(cachePath(fixture, 1)), true)
    assert.equal(exists(path.join(directory, 'generated-shared-root-cache', 'root-0', 'tags.sqlite')), true)
    assert.equal(owner.snapshot().cases[0].roots[0].status, 'archived')
  })
  // A real Windows junction needs no symlink privilege or administrator rights.
  // Other hosts are outside HFM validation scope; no platform CI is introduced.
  if (process.platform === 'win32') {
    test('real Windows preexisting namespace junction is preserved before case setup', fixture => {
      const owner = create(fixture), directory = caseDirectory(fixture, 'A1')
      const target = path.join(fixture.directory, 'preexisting-junction-target')
      fs.mkdirSync(target)
      fs.writeFileSync(path.join(target, 'untouched'), 'prior data')
      fs.symlinkSync(target, cachePath(fixture), 'junction')
      reject(owner, () => owner.beginCase({ caseId: 'A1', caseDirectory: directory }), /Expected absent/)
      assert.equal(fs.lstatSync(cachePath(fixture)).isSymbolicLink(), true)
      assert.equal(fs.readFileSync(path.join(target, 'untouched'), 'utf8'), 'prior data')
    })
    for (const placement of ['root', 'cache', 'cache-child', 'evidence', 'archive']) test(`real Windows ${placement} junction is refused without traversal`, fixture => {
      const target = path.join(fixture.directory, 'junction-target')
      fs.mkdirSync(target)
      fs.writeFileSync(path.join(target, 'untouched'), 'junction target remains untouched')
      const owner = create(fixture)
      let action, link
      if (placement === 'root') {
        const directory = caseDirectory(fixture, 'A1')
        fs.renameSync(fixture.roots[0], fixture.roots[0] + '-retained')
        link = fixture.roots[0]
        action = () => owner.beginCase({ caseId: 'A1', caseDirectory: directory })
      } else if (placement === 'evidence') {
        link = path.join(fixture.directory, 'junction-case')
        action = () => owner.beginCase({ caseId: 'A1', caseDirectory: link })
      } else {
        const directory = begin(fixture, owner)
        if (placement === 'cache-child') generate(fixture)
        link = placement === 'archive' ? path.join(directory, 'generated-shared-root-cache') :
          placement === 'cache' ? cachePath(fixture) : path.join(cachePath(fixture), 'linked-child')
        action = () => owner.finalizeCase({ caseId: 'A1', closeProof: closeProof() })
      }
      fs.symlinkSync(target, link, 'junction')
      reject(owner, action, placement === 'archive' ? /Expected absent/ : /Link\/junction refused/)
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'Junction must be preserved')
      assert.equal(fs.readFileSync(path.join(target, 'untouched'), 'utf8'), 'junction target remains untouched')
    })
  }
  return { passed: true, cases: checked.length, checked, windowsJunctionCases: process.platform === 'win32' ? 6 : 0 }
}

if (require.main === module) {
  assert.equal(process.platform, 'win32', 'HFM lifecycle diagnostics execute only on Windows; source review is not a run')
  const result = runFixtureLifecycleRegressions()
  console.log(`PASS full-refresh fixture lifecycle (${result.cases} counterexamples)`)
}
module.exports = { runFixtureLifecycleRegressions }
