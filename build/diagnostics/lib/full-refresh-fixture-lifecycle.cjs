'use strict'

// Diagnostic-only, sequential fixture ownership. Production/native cache paths
// remain root/.hfm-cache. Never delete, reset, retry, or overwrite a namespace.
// Node lstat + realpath rejects observable links/junctions/path aliases; it does
// not prove every Windows reparse tag absent or pin a race-proof rename handle.
// The caller must own newly created fixtures and positively close every owner.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const NAMESPACE = '.hfm-cache'
const ARCHIVE = 'generated-shared-root-cache'
const VERSION = 1
const clone = value => JSON.parse(JSON.stringify(value))
const key = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value)
function fail(code, message) { throw Object.assign(new Error(message), { code }) }
function demand(condition, code, message) { if (!condition) fail(code, message) }
function errorField(error, name) { try { return error?.[name] } catch { return undefined } }
function errorMessage(error) {
  try { return String(errorField(error, 'message') || error) }
  catch { return 'Unprintable fixture lifecycle failure' }
}
function absolute(value, label) {
  demand(typeof value === 'string' && value.length > 0 && path.isAbsolute(value), 'ERR_FIXTURE_PATH', `${label} must be an absolute path`)
  return path.resolve(value)
}
function inside(parent, child) {
  const relative = path.relative(parent, child)
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}
function lstatIfPresent(file) {
  try { return fs.lstatSync(file, { bigint: true }) }
  catch (error) { if (errorField(error, 'code') === 'ENOENT') return null; throw error }
}
function ordinary(stat, file, directoryOnly = false) {
  demand(!stat.isSymbolicLink(), 'ERR_FIXTURE_LINK', `Link/junction refused: ${file}`)
  demand(stat.isDirectory() || (!directoryOnly && stat.isFile()), 'ERR_FIXTURE_TYPE', `Unknown or unexpected entry type: ${file}`)
  demand(typeof stat.dev === 'bigint' && typeof stat.ino === 'bigint' && stat.ino > 0n &&
    typeof stat.birthtimeNs === 'bigint', 'ERR_FIXTURE_IDENTITY', `Physical identity unavailable: ${file}`)
  if (stat.isFile()) demand(stat.nlink === 1n, 'ERR_FIXTURE_LINK', `Nonowned hard-linked file refused: ${file}`)
}
function identity(file, stat) {
  return { path: file, physicalPath: fs.realpathSync(file), physical: `${stat.dev}:${stat.ino}`, birthtimeNs: String(stat.birthtimeNs) }
}
function assertIdentity(actual, expected) {
  demand(actual && expected && key(actual.path) === key(expected.path) &&
    key(actual.physicalPath) === key(expected.physicalPath) && actual.physical === expected.physical &&
    actual.birthtimeNs === expected.birthtimeNs, 'ERR_FIXTURE_IDENTITY', `Fixture identity changed: ${expected?.path || 'unknown'}`)
}
// Check components from the volume root down before resolving the full path.
// In particular, never lstat/read through a known parent junction.
function inspectDirectory(directory) {
  const full = absolute(directory, 'Directory'), root = path.parse(full).root
  const components = path.relative(root, full).split(path.sep).filter(Boolean)
  let current = root, stat = fs.lstatSync(root, { bigint: true })
  ordinary(stat, root, true)
  for (const component of components) {
    current = path.join(current, component)
    stat = fs.lstatSync(current, { bigint: true })
    ordinary(stat, current, true)
  }
  const result = identity(full, stat)
  demand(key(result.physicalPath) === key(full), 'ERR_FIXTURE_ALIAS', `Path-changing alias refused: ${full}`)
  return result
}
function requireAbsent(file) {
  demand(lstatIfPresent(file) === null, 'ERR_FIXTURE_OCCUPIED', `Expected absent diagnostic namespace/destination: ${file}`)
}
function validateOwnership(ownership) {
  demand(ownership?.version === VERSION && ownership.namespace === NAMESPACE &&
    Array.isArray(ownership.roots) && ownership.roots.length > 0, 'ERR_FIXTURE_OWNERSHIP', 'Missing manifest-owned fixture root identities')
  const fixture = absolute(ownership.fixture?.path, 'Fixture directory')
  demand(key(fixture) !== key(path.parse(fixture).root), 'ERR_FIXTURE_OWNERSHIP', 'A volume root cannot be a fixture')
  assertIdentity(inspectDirectory(fixture), ownership.fixture)
  const roots = []
  for (const captured of ownership.roots) {
    const root = absolute(captured?.path, 'Owned root')
    demand(key(root) !== key(fixture) && inside(fixture, root), 'ERR_FIXTURE_OWNERSHIP', `Root is not owned by this fixture: ${root}`)
    demand(!roots.some(previous => inside(previous, root) || inside(root, previous)), 'ERR_FIXTURE_OWNERSHIP', `Duplicate/overlapping fixture root: ${root}`)
    assertIdentity(inspectDirectory(root), captured)
    roots.push(root)
  }
  demand(new Set(ownership.roots.map(row => row.physical)).size === roots.length, 'ERR_FIXTURE_OWNERSHIP', 'Fixture roots must have distinct physical identities')
}

// Call immediately after makeFiles creates its private roots, before any host.
// Persist this JSON-safe object in the immutable fixture manifest.
function captureFixtureRoots({ fixtureDirectory, roots }) {
  demand(Array.isArray(roots) && roots.length > 0, 'ERR_FIXTURE_OWNERSHIP', 'No fixture roots to capture')
  const ownership = { version: VERSION, namespace: NAMESPACE, fixture: inspectDirectory(fixtureDirectory),
    roots: roots.map(root => inspectDirectory(root)) }
  validateOwnership(ownership)
  for (const root of ownership.roots) requireAbsent(path.join(root.path, NAMESPACE))
  return ownership
}

// Only cache metadata is traversed. Font paths and bytes are never opened or
// changed. A compact digest detects changes between the preflight and rename.
function inspectNamespace(namespace) {
  const stat = lstatIfPresent(namespace)
  if (!stat) return null
  ordinary(stat, namespace, true)
  const rows = [], pending = [{ file: namespace, relative: '' }]
  while (pending.length) {
    const { file, relative } = pending.pop()
    const entry = fs.lstatSync(file, { bigint: true })
    ordinary(entry, file)
    const actual = identity(file, entry)
    demand(key(actual.physicalPath) === key(file), 'ERR_FIXTURE_ALIAS', `Cache path-changing alias refused: ${file}`)
    rows.push({ relative, type: entry.isDirectory() ? 'directory' : 'file', physical: actual.physical,
      birthtimeNs: actual.birthtimeNs, mtimeNs: String(entry.mtimeNs), bytes: String(entry.size) })
    if (entry.isDirectory()) {
      // lstat this directory before readdir; never recursively follow a link.
      for (const name of fs.readdirSync(file).sort().reverse()) {
        demand(name !== '.' && name !== '..' && path.basename(name) === name, 'ERR_FIXTURE_PATH', 'Invalid cache directory entry')
        pending.push({ file: path.join(file, name), relative: relative ? path.join(relative, name) : name })
      }
    }
  }
  rows.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0)
  return { physical: `${stat.dev}:${stat.ino}`, birthtimeNs: String(stat.birthtimeNs),
    entries: rows.length, files: rows.filter(row => row.type === 'file').length,
    treeSha256: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex') }
}

function requireCloseProof(proof) {
  demand(proof?.hostClosed === true && proof.databaseOwnersClosed === true && proof.childrenReaped === true &&
    proof.remainingDatabaseOwners === 0 && proof.remainingChildren === 0,
  'ERR_FIXTURE_CLOSE_PROOF', 'Archive requires successful host close, all database owners closed, and every child reaped')
  // Explicit cleanup failures cannot be hidden behind otherwise positive flags.
  demand(!proof.cleanupFailure && !proof.failure && !proof.error, 'ERR_FIXTURE_CLOSE_PROOF', 'Cleanup failed; cache metadata must remain in place')
  return { hostClosed: true, databaseOwnersClosed: true, childrenReaped: true, remainingDatabaseOwners: 0, remainingChildren: 0 }
}

function createFixtureCacheLifecycle({ ownership, evidenceDirectory }) {
  demand(ownership && typeof ownership === 'object', 'ERR_FIXTURE_OWNERSHIP', 'Missing fixture root ownership')
  const owned = clone(ownership)
  validateOwnership(owned)
  const evidence = inspectDirectory(evidenceDirectory)
  demand(!inside(owned.fixture.path, evidence.path), 'ERR_FIXTURE_OWNERSHIP', 'Evidence directory cannot be inside the immutable fixture')
  const cases = [], caseIds = new Set(), caseDirectories = new Set()
  let active = null, activeDirectory = null, failure = null
  function snapshot() {
    return clone({ version: VERSION, mode: 'manifest-owned-sequential-cache-archive', namespace: NAMESPACE,
      blocked: failure !== null, failure, activeCaseId: active?.caseId || null, cases,
      guard: 'Component lstat, canonical path and physical identity; observable links/junctions refused. No all-reparse-tag or pinned-rename claim.' })
  }
  function guarded(phase, caseId, action) {
    if (failure) fail('ERR_FIXTURE_BLOCKED', `Fixture lifecycle is blocked by ${failure.phase}: ${failure.message}`)
    try { return action() }
    catch (error) {
      const code = errorField(error, 'code')
      failure = { phase, caseId: typeof caseId === 'string' ? caseId : null,
        code: typeof code === 'string' && code ? code : 'ERR_FIXTURE_LIFECYCLE', message: errorMessage(error) }
      if (active) active.status = 'blocked'
      // Snapshot is independently available even when a port throws a frozen
      // Error, null, or another primitive. Never mask the original failure.
      try { if (error && (typeof error === 'object' || typeof error === 'function')) error.fixtureCacheLifecycle = snapshot() } catch {}
      throw error
    }
  }
  function verifyBoundary() {
    validateOwnership(owned)
    assertIdentity(inspectDirectory(evidence.path), evidence)
  }
  function beginCase(options = {}) {
    const { caseId, caseDirectory } = options || {}
    return guarded('begin', caseId, () => {
      demand(active === null, 'ERR_FIXTURE_ACTIVE', 'Previous fixture case was not positively finalized')
      demand(typeof caseId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(caseId) && !caseIds.has(caseId),
        'ERR_FIXTURE_CASE', 'Case ID must be unique and bounded')
      verifyBoundary()
      const directory = absolute(caseDirectory, 'Case evidence directory')
      demand(key(directory) !== key(evidence.path) && inside(evidence.path, directory) &&
        !inside(owned.fixture.path, directory) && !inside(directory, owned.fixture.path) &&
        ![...caseDirectories].some(previous => inside(previous, directory) || inside(directory, previous)),
      'ERR_FIXTURE_OWNERSHIP', 'Case evidence directory must be distinct, private, and outside the fixture')
      const directoryIdentity = inspectDirectory(directory)
      const archiveDirectory = path.join(directory, ARCHIVE)
      requireAbsent(archiveDirectory)
      const roots = owned.roots.map((root, index) => ({ rootPath: root.path, rootPhysical: root.physical,
        sourcePath: path.join(root.path, NAMESPACE), destinationPath: path.join(archiveDirectory, `root-${index}`),
        before: 'unchecked', status: 'pending' }))
      active = { caseId, caseDirectory: directory, archiveDirectory, status: 'active', roots }
      cases.push(active)
      for (const root of roots) { requireAbsent(root.sourcePath); root.before = 'absent' }
      // Keep the private directory identity outside the JSON provenance record.
      activeDirectory = directoryIdentity
      caseIds.add(caseId)
      caseDirectories.add(key(directory))
      return clone(active)
    })
  }
  function finalizeCase(options = {}) {
    const { caseId, closeProof } = options || {}
    return guarded('finalize', caseId, () => {
      demand(active && active.caseId === caseId, 'ERR_FIXTURE_CASE', 'Only the active fixture case can be finalized')
      active.closeProof = requireCloseProof(closeProof)
      verifyBoundary()
      assertIdentity(inspectDirectory(active.caseDirectory), activeDirectory)
      requireAbsent(active.archiveDirectory)
      // Inspect every root before any move. Any later failure retains both the
      // already moved evidence and all namespaces that have not been moved.
      const namespaces = active.roots.map(root => inspectNamespace(root.sourcePath))
      fs.mkdirSync(active.archiveDirectory) // Exclusive, nonrecursive reservation.
      const archiveIdentity = inspectDirectory(active.archiveDirectory)
      for (let index = 0; index < active.roots.length; index++) {
        const root = active.roots[index], expected = namespaces[index]
        verifyBoundary()
        assertIdentity(inspectDirectory(active.caseDirectory), activeDirectory)
        assertIdentity(inspectDirectory(active.archiveDirectory), archiveIdentity)
        requireAbsent(root.destinationPath)
        const current = inspectNamespace(root.sourcePath)
        demand(JSON.stringify(current) === JSON.stringify(expected), 'ERR_FIXTURE_IDENTITY', `Generated cache changed after archive preflight: ${root.sourcePath}`)
        if (!expected) { root.status = 'absent'; continue }
        root.namespace = expected
        // Recheck the destination after the potentially longer tree inspection.
        assertIdentity(inspectDirectory(active.archiveDirectory), archiveIdentity)
        requireAbsent(root.destinationPath)
        fs.renameSync(root.sourcePath, root.destinationPath)
        // Record the move before any postcheck: a later failure must not conceal
        // or roll back evidence already moved into this case's archive.
        root.status = 'archived'
        requireAbsent(root.sourcePath)
        const archived = inspectNamespace(root.destinationPath)
        demand(JSON.stringify(archived) === JSON.stringify(expected), 'ERR_FIXTURE_IDENTITY', `Archived cache identity/content metadata changed: ${root.destinationPath}`)
      }
      verifyBoundary()
      for (const root of active.roots) requireAbsent(root.sourcePath)
      active.status = 'archived'
      const result = clone(active)
      active = null
      activeDirectory = null
      return result
    })
  }
  return { beginCase, finalizeCase, snapshot }
}

module.exports = { captureFixtureRoots, createFixtureCacheLifecycle }
