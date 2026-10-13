#!/usr/bin/env node
'use strict'
// Windows-only production restore/maintenance owners; real SQLite and real files.
// Faults are injected at the filesystem/SQLite close ports, never in preservation.
const assert = require('node:assert/strict')
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const { fork, spawnSync } = require('node:child_process')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..'), abs = file => path.join(root, file)
const family = file => [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]
const intentPath = file => `${file}.hfm-restore.json`
const exists = async file => { try { await fsp.lstat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
const ioError = code => Object.assign(Error(`injected ${code}`), { code })
const isArchive = file => String(file).includes(`${path.sep}manual-restores${path.sep}`)
async function bytes(file) { return await exists(file) ? (await fsp.readFile(file)).toString('hex') : null }
async function familyBytes(file) { return Promise.all(family(file).map(bytes)) }

async function fixture(directory, name, fault = async () => {}, extra = {}) {
  const folder = path.join(directory, name), target = path.join(folder, 'library.sqlite')
  const backups = path.join(folder, 'backups'), archive = path.join(folder, 'corrupt')
  const backup = path.join(backups, '2026-01-01_00-00-00', 'library.sqlite')
  if (!extra.reuse) {
    await fsp.mkdir(path.dirname(backup), { recursive: true })
    const db = new DatabaseSync(backup)
    db.exec("CREATE TABLE user_state(key TEXT PRIMARY KEY,value TEXT); INSERT INTO user_state VALUES('intent','old-backup')")
    db.close()
    for (const [index, file] of family(target).entries()) await fsp.writeFile(file, `latest-original-${index}`)
  }
  const events = [], logs = [], handles = new Set()
  const state = { target, backup, archive, folder, events, logs, closeFault: false, ...extra }
  const port = new Proxy(fsp, { get(fs, operation) {
    const fn = fs[operation]
    if (typeof fn !== 'function') return fn
    return async (...args) => {
      events.push({ operation, args })
      const override = await fault(operation, args, state)
      return override?.handled ? override.value : fn.apply(fs, args)
    }
  } })
  function Database(file, options) {
    const native = new DatabaseSync(file, { readOnly: options?.readonly === true })
    let open = true
    const wrapper = { get open() { return open }, exec: sql => native.exec(sql), prepare: sql => native.prepare(sql),
      close() {
        if (state.closeFault && file === target) throw ioError('SQLITE_BUSY')
        if (open) { native.close(); open = false; handles.delete(wrapper) }
      } }
    handles.add(wrapper)
    return wrapper
  }
  const load = loader({ [abs('src/main/path/sharedFileSystemRuntime.ts')]: { sharedFileSystem: port },
    'node:fs': { ...fs, lstatSync(file, ...args) {
      state.markerProbes = (state.markerProbes || 0) + 1
      if (state.markerStatFault && String(file).endsWith('.hfm-restore.json')) throw ioError(state.markerStatFault)
      return fs.lstatSync(file, ...args)
    } },
  })
  const runtime = load('src/main/db/sqliteRuntime.ts').createSqliteRuntime({ appName: 'HFM diagnostic',
    nodeRequire: () => Database, normalizePath: value => path.resolve(value).toLowerCase(),
    // Deliberately incomplete legacy helper: restoration must still include journal.
    sqliteSidecarPaths: file => [file, `${file}-wal`, `${file}-shm`],
    appendLog: message => { logs.push(message); if (state.logFault && (message.includes('cleanup deferred') || message.startsWith('sqlite restored from backup'))) throw Error('log unavailable') }, exists,
    backupsRootPath: () => backups, corruptDatabasesRootPath: () => archive,
    applicationDatabasePaths: () => [target],
    quickCheckIntervalMs: 0, fastOpenSharedCacheDbs: false, verboseSqliteLogs: false,
    busyTimeoutMs: 10, mmapSizeBytes: 0, corruptRetentionCount: 0 })
  return { ...state, state, runtime, handles, load,
    restore: options => runtime.restoreLatestDatabaseBackupForLabel('library', target, options),
    async close() { state.closeFault = false; for (const handle of handles) handle.close() } }
}

async function assertArchive(receiptPath, expected, target) {
  const manifest = JSON.parse(await fsp.readFile(path.join(receiptPath, 'recovery-manifest.json'), 'utf8'))
  assert.equal(manifest.complete, true)
  assert.equal(manifest.sourcePath, target)
  assert.equal(manifest.files.length, 4)
  const actual = await Promise.all(family(target).map(file => bytes(path.join(receiptPath, path.basename(file)))))
  assert.deepEqual(actual, expected, 'archive must preserve every original byte and absent family member')
}

async function waitForKill(stage) {
  process.send({ readyToKill: stage })
  await new Promise(() => { setInterval(() => {}, 1000) })
}

async function crashChild(directory, name, stage) {
  assert.equal(process.platform, 'win32', 'HFM verification is Windows-only')
  const item = await fixture(directory, name, async (op, args, state) => {
    if (op === 'rename' && args[0] === state.target) {
      if (stage === 'intent-durable') return await waitForKill(stage)
      if (stage === 'main-held') { await fsp.rename(...args); return await waitForKill(stage) }
    }
    if (op === 'link') {
      if (stage === 'family-held') return await waitForKill(stage)
      if (stage === 'candidate-published') { await fsp.link(...args); return await waitForKill(stage) }
      if (stage === 'rollback-main-restored') throw ioError('ENOSPC')
    }
    if (stage === 'rollback-main-restored' && op === 'rename' && args[1] === state.target) {
      await fsp.rename(...args); return await waitForKill(stage)
    }
  }, { reuse: true })
  const result = await item.restore()
  throw Error(`crash checkpoint was not reached: ${stage}: ${JSON.stringify(result)}`)
}

async function reopenChild(directory, name) {
  assert.equal(process.platform, 'win32', 'HFM verification is Windows-only')
  const item = await fixture(directory, name, undefined, { reuse: true })
  const before = await familyBytes(item.target)
  assert.throws(() => item.runtime.openStableSqliteDb(item.target, 'fresh-process-alias-reader'), /未完成的数据库恢复事务/)
  assert.equal(item.handles.size, 0, 'SQLite constructor ran despite the persistent restore intent')
  assert.deepEqual(await familyBytes(item.target), before, 'fresh open created or changed an interrupted database family')
  assert.equal((await item.restore()).ok, false, 'a fresh restore must not overwrite an unfinished transaction')
  console.log(JSON.stringify({ blocked: true, constructedHandles: 0 }))
}

async function killAt(directory, name, stage) {
  await new Promise((resolve, reject) => {
    const child = fork(__filename, ['--crash-child', directory, name, stage], {
      execArgv: ['--experimental-sqlite'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    })
    let ready = false, stderr = '', failure
    const timer = setTimeout(() => {
      failure = Error(`crash child timeout: ${stage}: ${stderr}`)
      child.kill('SIGKILL')
      // The promise remains owned until physical close, including timeout.
    }, 30000)
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192) })
    child.on('error', error => { failure = error })
    child.on('message', message => {
      if (message?.readyToKill === stage) { ready = true; child.kill('SIGKILL') }
    })
    child.on('close', () => {
      clearTimeout(timer)
      if (failure) reject(failure)
      else if (ready) resolve()
      else reject(Error(`crash child closed before ${stage}: ${stderr}`))
    })
  })
}

async function main() {
  assert.equal(process.platform, 'win32', 'HFM verification is Windows-only')
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'hfm-manual-restore-'))
  const cases = [], fixtures = []
  const make = async (...args) => { const value = await fixture(directory, ...args); fixtures.push(value); return value }
  try {
    for (const markerState of ['truncated', 'EACCES', 'EPERM']) {
      const item = await make(`marker-${markerState}`)
      const before = await familyBytes(item.target)
      if (markerState === 'truncated') await fsp.writeFile(intentPath(item.target), '{"version":')
      else item.state.markerStatFault = markerState
      assert.throws(() => item.runtime.openStableSqliteDb(item.target, 'unexpected-label'), /恢复标记|未完成的数据库恢复事务/)
      assert.equal(item.handles.size, 0); assert.deepEqual(await familyBytes(item.target), before)
      assert.equal((await item.restore()).ok, false)
      const unrelated = path.join(item.folder, 'derived.sqlite'); await fsp.copyFile(item.backup, unrelated)
      const beforeProbes = item.state.markerProbes
      const derived = item.runtime.openStableSqliteDb(unrelated, 'root-index')
      assert.equal(item.state.markerProbes, beforeProbes, 'derived paths must not perform synchronous restore-marker probes')
      derived.close()
      cases.push(`${markerState} marker state blocks local application opens; derived paths do not probe markers`)
    }
    for (const fault of ['intent-write', 'intent-sync', 'intent-remove', 'intent-remove-after']) {
      const item = await make(fault, async (op, args, state) => {
        if (fault.startsWith('intent-remove') && op === 'rm' && args[0] === intentPath(state.target)) {
          if (fault === 'intent-remove-after') await fsp.rm(...args)
          throw ioError('EPERM')
        }
        if (!fault.startsWith('intent-remove') && op === 'open' && args[0] === intentPath(state.target)) {
          const handle = await fsp.open(...args)
          return { handled: true, value: new Proxy(handle, { get(handle, name) {
            if (name === 'writeFile' && fault === 'intent-write') return async () => { await handle.writeFile('{'); throw ioError('ENOSPC') }
            if (name === 'sync' && fault === 'intent-sync') return async () => { throw ioError('EIO') }
            const value = handle[name]; return typeof value === 'function' ? value.bind(handle) : value
          } }) }
        }
      })
      const before = await familyBytes(item.target), result = await item.restore()
      assert.equal(result.ok, false)
      if (fault.startsWith('intent-remove')) {
        assert.equal(await bytes(item.target), await bytes(item.backup), 'cleanup failure must retain the already verified candidate')
        await assertArchive(result.preservationPath, before, item.target)
        assert.match(result.message, /已发布并验证.*清理未确认/)
        const marker = JSON.parse(await fsp.readFile(intentPath(item.target), 'utf8'))
        assert.equal(await bytes(path.join(marker.holdingDirectory, path.basename(item.target))), before[0])
      } else {
        assert.deepEqual(await familyBytes(item.target), before)
        assert.equal(item.events.some(event => event.operation === 'rename'), false)
      }
      if (fault !== 'intent-sync') {
        assert(await exists(intentPath(item.target)))
        const fresh = await fixture(directory, fault, undefined, { reuse: true })
        fixtures.push(fresh)
        assert.throws(() => fresh.runtime.openStableSqliteDb(fresh.target, 'new-runtime'), /未完成的数据库恢复事务/)
      }
      cases.push(`${fault} cannot confirm replacement or permit a fresh open while intent remains`)
    }
    for (const code of ['EACCES', 'EPERM', 'ENOSPC', 'EIO']) {
      const item = await make(`copy-${code}`, async (op, args) => {
        if (op === 'copyFile' && isArchive(args[1]) && String(args[0]).endsWith('-wal')) throw ioError(code)
      })
      const before = await familyBytes(item.target), result = await item.restore()
      assert.equal(result.ok, false); assert.match(result.message, new RegExp(code))
      assert.deepEqual(await familyBytes(item.target), before)
      assert.equal(item.events.some(event => event.operation === 'rename'), false)
      cases.push(`archive copy ${code} leaves main/WAL/SHM/journal untouched`)
    }
    for (const mode of ['manifest-write', 'manifest-read', 'manifest-corrupt', 'copy-corrupt', 'archive-sync', 'archive-close', 'source-stat']) {
      const item = await make(mode, async (op, args, state) => {
        const file = String(args[0])
        if (mode === 'manifest-write' && op === 'writeFile' && file.endsWith('recovery-manifest.json')) throw ioError('ENOSPC')
        if (mode === 'manifest-read' && op === 'readFile' && file.endsWith('recovery-manifest.json')) throw ioError('EACCES')
        if (mode === 'manifest-corrupt' && op === 'readFile' && file.endsWith('recovery-manifest.json')) return { handled: true, value: '{}' }
        if (mode === 'copy-corrupt' && op === 'copyFile' && isArchive(args[1])) {
          await fsp.writeFile(args[1], 'incomplete-copy'); return { handled: true }
        }
        if (mode === 'source-stat' && op === 'lstat' && file === `${state.target}-journal`) throw ioError('EACCES')
        if ((mode === 'archive-sync' || mode === 'archive-close') && op === 'open' && isArchive(file)) {
          const handle = await fsp.open(...args)
          return { handled: true, value: new Proxy(handle, { get(handle, name) {
            if (name === 'sync' && mode === 'archive-sync') return async () => { throw ioError('ENOSPC') }
            if (name === 'close' && mode === 'archive-close') return async () => { await handle.close(); throw ioError('EIO') }
            const value = handle[name]; return typeof value === 'function' ? value.bind(handle) : value
          } }) }
        }
      })
      const before = await familyBytes(item.target), result = await item.restore()
      assert.equal(result.ok, false, mode); assert.deepEqual(await familyBytes(item.target), before, mode)
      assert.equal(item.events.some(event => event.operation === 'rename'), false, mode)
      cases.push(`${mode} cannot produce a usable preservation receipt`)
    }
    for (const stage of ['rename-before', 'rename-after', 'publish-before', 'publish-after']) {
      let injected = false
      const item = await make(stage, async (op, args, state) => {
        if (injected) return
        if (stage.startsWith('rename') && op === 'rename' && args[0] === `${state.target}-wal`) {
          injected = true
          if (stage.endsWith('after')) await fsp.rename(...args)
          throw ioError('EPERM')
        }
        if (stage.startsWith('publish') && op === 'link') {
          injected = true
          if (stage.endsWith('after')) await fsp.link(...args)
          throw ioError('ENOSPC')
        }
      })
      const before = await familyBytes(item.target), result = await item.restore()
      assert.equal(result.ok, false); assert(injected)
      assert.deepEqual(await familyBytes(item.target), before, 'failed replacement must restore originals without copying')
      await assertArchive(result.preservationPath, before, item.target)
      assert.equal(item.events.some(event => event.operation === 'copyFile' && family(item.target).includes(event.args[1])), false)
      cases.push(`${stage} rolls back the full original family`)
    }
    {
      const item = await make('published-sync', async (op, args, state) => {
        if (op === 'open' && args[0] === state.target && args[1] === 'r+') {
          const handle = await fsp.open(...args)
          return { handled: true, value: new Proxy(handle, { get(handle, name) {
            if (name === 'sync') return async () => { throw ioError('EIO') }
            const value = handle[name]; return typeof value === 'function' ? value.bind(handle) : value
          } }) }
        }
      })
      const before = await familyBytes(item.target), result = await item.restore()
      assert.equal(result.ok, false); assert.match(result.message, /EIO/)
      assert.deepEqual(await familyBytes(item.target), before)
      await assertArchive(result.preservationPath, before, item.target)
      assert.equal(await exists(intentPath(item.target)), false, 'verified rollback must clear its intent')
      cases.push('published-target fsync failure rolls back before clearing the persistent intent')
    }
    {
      let injected = false
      const item = await make('rollback-blocked', async (op, args, state) => {
        if (op === 'link') { await fsp.link(...args); injected = true; throw ioError('ENOSPC') }
        if (injected && op === 'rm' && args[0] === state.target) throw ioError('EPERM')
      })
      const before = await familyBytes(item.target), result = await item.restore()
      assert.equal(result.ok, false); assert.match(result.message, /ENOSPC/); assert.match(result.message, /自动回滚未完成/)
      await assertArchive(result.preservationPath, before, item.target)
      assert.throws(() => item.runtime.openStableSqliteDb(item.target, 'library'), /等待人工恢复/)
      assert.equal((await item.restore()).ok, false)
      const held = (await fsp.readdir(item.folder)).find(name => name.startsWith('.hfm-restore-'))
      assert(held, 'failed rollback must retain held originals')
      cases.push('failed rollback reports original error, keeps originals/archive and blocks reopening')
    }
    for (const change of ['modify', 'appear']) {
      let injected = false
      const item = await make(`race-${change}`, async (op, args, state) => {
        if (!injected && op === 'copyFile' && isArchive(args[1])) {
          await fsp.copyFile(...args); injected = true
          await fsp.writeFile(change === 'modify' ? state.target : `${state.target}-journal`, 'new-concurrent-bytes')
          return { handled: true }
        }
      })
      if (change === 'appear') await fsp.rm(`${item.target}-journal`)
      const result = await item.restore()
      assert.equal(result.ok, false)
      assert.equal(await fsp.readFile(change === 'modify' ? item.target : `${item.target}-journal`, 'utf8'), 'new-concurrent-bytes')
      assert.equal(item.events.some(event => event.operation === 'rename'), false)
      cases.push(`${change} during preservation cancels before destructive changes`)
    }
    {
      let injected = false
      const item = await make('late-rename-race', async (op, args, state) => {
        if (!injected && op === 'rename' && args[0] === state.target) {
          injected = true
          await fsp.writeFile(state.target, 'new-after-final-source-check')
        }
      })
      const before = await familyBytes(item.target), result = await item.restore()
      assert.equal(result.ok, false); assert.equal(injected, true)
      assert.equal(await fsp.readFile(item.target, 'utf8'), 'new-after-final-source-check')
      await assertArchive(result.preservationPath, before, item.target)
      assert.throws(() => item.runtime.openStableSqliteDb(item.target, 'library'), /等待人工恢复/)
      cases.push('late rename race retains both archived original and newly changed bytes')
    }
    {
      const item = await make('publish-sidecar-race', async (op, args, state) => {
        if (op === 'link') {
          await fsp.link(...args); await fsp.writeFile(`${state.target}-wal`, 'new-external-WAL')
          return { handled: true }
        }
      })
      const before = await familyBytes(item.target), result = await item.restore()
      assert.equal(result.ok, false); assert.match(result.message, /新的旁路文件/)
      assert.equal(await fsp.readFile(`${item.target}-wal`, 'utf8'), 'new-external-WAL')
      await assertArchive(result.preservationPath, before, item.target)
      assert.throws(() => item.runtime.openStableSqliteDb(item.target, 'library'), /等待人工恢复/)
      cases.push('sidecar appearing at publication is retained and cannot yield a mixed-family success')
    }
    {
      const item = await make('closed-handle')
      for (const file of family(item.target)) await fsp.rm(file)
      await fsp.copyFile(item.backup, item.target)
      const handle = await item.runtime.openRecoverableApplicationSqliteDb(item.target, 'library')
      item.state.closeFault = true
      const before = await familyBytes(item.target)
      const result = await item.restore({ beforeReplace: async () => item.runtime.closeSqliteDb(handle) })
      assert.equal(result.ok, false); assert.match(result.message, /连接尚未关闭/)
      assert.deepEqual(await familyBytes(item.target), before)
      await item.close()
      cases.push('swallowed owning-store close failure still blocks preservation/replacement')
    }
    {
      const item = await make('alias-labelled-handle')
      for (const file of family(item.target)) await fsp.rm(file)
      await fsp.copyFile(item.backup, item.target)
      const aliasPath = path.join(path.dirname(item.target), path.basename(item.target).toUpperCase())
      const held = item.runtime.openStableSqliteDb(aliasPath, 'diagnostic-alias-reader')
      const unrelatedPath = path.join(item.folder, 'unrelated.sqlite')
      await fsp.copyFile(item.backup, unrelatedPath)
      const unrelated = item.runtime.openStableSqliteDb(unrelatedPath, 'diagnostic-alias-reader')
      const before = await familyBytes(item.target), blocked = await item.restore()
      assert.equal(blocked.ok, false); assert.match(blocked.message, /连接尚未关闭/)
      assert.deepEqual(await familyBytes(item.target), before)
      assert.equal(item.events.some(event => event.operation === 'rename'), false)
      held.close()
      // If direct close did not remove the strong registry entry, the following
      // restore would inspect this getter and fail. This also checks lifecycle cleanup.
      Object.defineProperty(held, 'open', { get() { throw Error('closed handle retained in restore registry') } })
      const restored = await item.restore()
      assert.equal(restored.ok, true, restored.message)
      assert.equal(await exists(intentPath(item.target)), false, 'verified success must clear its intent')
      assert.equal(unrelated.open, true, 'a different path must not block or be closed by this restore')
      cases.push('alias-labelled normalized-path handle blocks restore; direct close removes tracking without affecting another path')
    }
    {
      const item = await make('open-gate')
      const result = await item.restore({ beforeReplace: async () => {
        assert.throws(() => item.runtime.openStableSqliteDb(item.target, 'library'), /暂不能打开/)
        assert.equal((await item.restore()).ok, false)
      } })
      assert.equal(result.ok, true, result.message)
      cases.push('restore gate rejects concurrent application opens and duplicate restores')
    }
    {
      const item = await make('bad-backup')
      await fsp.writeFile(item.backup, 'not a database')
      let closed = false
      const before = await familyBytes(item.target)
      const result = await item.restore({ beforeReplace: async () => { closed = true } })
      assert.equal(result.ok, false); assert.equal(closed, false); assert.deepEqual(await familyBytes(item.target), before)
      cases.push('invalid backup leaves current handle and data untouched')
    }
    {
      const item = await make('missing-main')
      await fsp.rm(item.target)
      const before = await familyBytes(item.target), result = await item.restore()
      assert.equal(result.ok, true, result.message); await assertArchive(result.preservationPath, before, item.target)
      cases.push('missing main does not skip orphan WAL/SHM/journal preservation')
    }
    {
      const item = await make('cleanup-failure', async (op, args) => {
        if (op === 'rm' && String(args[0]).includes('.hfm-restore-') && args[1]?.recursive) throw ioError('EPERM')
      })
      const before = await familyBytes(item.target)
      item.state.logFault = true
      const restored = await item.restore()
      assert.equal(restored.ok, true, restored.message); await assertArchive(restored.preservationPath, before, item.target)
      assert(item.logs.some(log => log.includes('cleanup deferred')))
      cases.push('temporary cleanup and logging failure do not mask a verified successful replacement')
    }
    {
      const item = await make('maintenance-owner')
      for (const file of family(item.target)) await fsp.rm(file)
      await fsp.copyFile(item.backup, item.target)
      const handle = await item.runtime.openRecoverableApplicationSqliteDb(item.target, 'library')
      handle.exec("UPDATE user_state SET value='latest-maintenance-intent'")
      let closed = 0, afterClose
      const maintenance = item.load('src/main/maintenance/databaseMaintenance.ts').createDatabaseMaintenanceRuntime({
        appName: 'HFM diagnostic', maintenanceSqliteSchemaVersion: 1, databaseBackupRetentionCount: 1,
        autoDatabaseBackupIntervalMs: 1, previewOkRetentionMs: 1,
        backupsRootPath: () => path.dirname(path.dirname(item.backup)), maintenanceStatePath: () => path.join(item.folder, 'state.json'),
        dataRoot: () => item.folder, dbFileSpecs: () => [], databasePathForLabel: () => item.target,
        closeApplicationDatabaseHandle: () => { item.runtime.closeSqliteDb(handle); closed++; afterClose = familyBytes(item.target) },
        checkpointApplicationDatabases: async () => {}, restoreLatestDatabaseBackupForLabel: item.runtime.restoreLatestDatabaseBackupForLabel,
        quarantineSqliteFiles: async () => { throw Error('lossy quarantine must never be called') },
        recoveryMessage: String, exists: async () => { throw Error('boolean currentExists must not decide preservation') },
        appendStartupLog() {}, openPreviewDb: async () => ({}), previewSqlitePath: () => '', previewSqliteSchemaVersion: 1,
        collectPreviewMaintenanceDirs: async () => [], normalizePathForCacheCompare: value => value,
        runTaskMaintenance: async () => ({ resetRunning: 0, removedCompleted: 0, removedFailed: 0, removedErrors: 0 }),
      })
      const result = await maintenance.restoreLatestApplicationDatabase('library')
      assert.equal(result.ok, true, result.message); assert.equal(closed, 1)
      assert.equal(result.label, 'library'); assert.equal(result.targetPath, item.target)
      await assertArchive(result.preservationPath, await afterClose, item.target)
      cases.push('real maintenance-to-SQLite restore chain closes once and returns a verified preservation receipt')
    }
    {
      const item = await make('real-wal')
      for (const file of family(item.target)) await fsp.rm(file)
      const live = path.join(item.folder, 'live.sqlite'), db = new DatabaseSync(live)
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE user_state(key TEXT PRIMARY KEY,value TEXT); INSERT INTO user_state VALUES('intent','old-main'); PRAGMA wal_checkpoint(TRUNCATE)")
      db.exec("UPDATE user_state SET value='latest-committed-WAL'")
      assert(fs.statSync(`${live}-wal`).size > 0)
      for (let index = 0; index < 3; index++) await fsp.copyFile(family(live)[index], family(item.target)[index])
      db.close()
      const before = await familyBytes(item.target), first = await item.restore()
      assert.equal(first.ok, true, first.message); await assertArchive(first.preservationPath, before, item.target)
      const current = new DatabaseSync(item.target)
      assert.equal(current.prepare("SELECT value FROM user_state WHERE key='intent'").get().value, 'old-backup'); current.close()
      const inspect = path.join(item.folder, 'inspect.sqlite')
      for (let index = 0; index < 3; index++) await fsp.copyFile(path.join(first.preservationPath, path.basename(family(item.target)[index])), family(inspect)[index])
      const preserved = new DatabaseSync(inspect)
      assert.equal(preserved.prepare("SELECT value FROM user_state WHERE key='intent'").get().value, 'latest-committed-WAL'); preserved.close()
      const second = await item.restore()
      assert.equal(second.ok, true, second.message); assert.notEqual(second.preservationPath, first.preservationPath)
      await assertArchive(first.preservationPath, before, item.target)
      cases.push('real SQLite WAL-only committed intent survives as a reopenable archive; repeated restores use unique archives')
    }
    for (const stage of ['intent-durable', 'main-held', 'family-held', 'candidate-published', 'rollback-main-restored']) {
      const name = `kill-${stage}`, item = await make(name)
      for (const file of family(item.target)) await fsp.rm(file)
      const live = path.join(item.folder, 'live.sqlite'), db = new DatabaseSync(live)
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE user_state(key TEXT PRIMARY KEY,value TEXT); INSERT INTO user_state VALUES('intent','old-main'); PRAGMA wal_checkpoint(TRUNCATE)")
      db.exec("UPDATE user_state SET value='crash-survivor-WAL'")
      for (let index = 0; index < 3; index++) await fsp.copyFile(family(live)[index], family(item.target)[index])
      db.close()
      const before = await familyBytes(item.target)
      await killAt(directory, name, stage)
      const marker = JSON.parse(await fsp.readFile(intentPath(item.target), 'utf8'))
      assert.equal(marker.targetPath, item.target); assert.equal(marker.receipt.complete, true)
      await assertArchive(marker.receipt.directory, before, item.target)
      assert(await exists(marker.candidatePath)); assert(await exists(marker.holdingDirectory))
      if (stage === 'main-held' || stage === 'family-held') assert.equal(await exists(item.target), false)
      const interrupted = await familyBytes(item.target)
      const reopened = spawnSync(process.execPath, ['--experimental-sqlite', __filename, '--reopen-child', directory, name], {
        encoding: 'utf8', timeout: 30000, windowsHide: true,
      })
      assert.equal(reopened.status, 0, `fresh-process rejection failed: ${reopened.stderr}`)
      assert.match(reopened.stdout, /"blocked":true/)
      assert.deepEqual(await familyBytes(item.target), interrupted)
      const recovered = path.join(item.folder, 'recovered.sqlite')
      for (let index = 0; index < before.length; index++) {
        if (before[index] === null) continue
        const originalFile = family(item.target)[index]
        assert([await bytes(originalFile), await bytes(path.join(marker.holdingDirectory, path.basename(originalFile)))].includes(before[index]), 'neither original nor holding file retained the pre-restore bytes')
        await fsp.copyFile(path.join(marker.receipt.directory, path.basename(originalFile)), family(recovered)[index])
      }
      const recoveredDb = new DatabaseSync(recovered)
      assert.equal(recoveredDb.prepare("SELECT value FROM user_state WHERE key='intent'").get().value, 'crash-survivor-WAL')
      recoveredDb.close()
      cases.push(`real process kill at ${stage}: new process refuses to open/create; archived committed WAL data remains recoverable`)
    }
    console.log(JSON.stringify({ diagnostic: 'sqlite-manual-restore', ok: true, cases }, null, 2))
  } finally {
    for (const item of fixtures) await item.close()
    await fsp.rm(directory, { recursive: true, force: true })
  }
}

const mode = process.argv[2]
let completed = false
process.once('beforeExit', () => {
  if (!completed) { console.error('sqlite-manual-restore ended with an unsettled diagnostic'); process.exitCode = 1 }
})
const operation = mode === '--crash-child' ? crashChild(...process.argv.slice(3))
  : mode === '--reopen-child' ? reopenChild(...process.argv.slice(3)) : main()
operation.then(() => { completed = true }, error => { completed = true; console.error(error); process.exitCode = 1 })
