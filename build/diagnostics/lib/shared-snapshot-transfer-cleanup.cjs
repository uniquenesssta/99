const assert = require('node:assert/strict')
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os')
const cp = require('node:child_process')
const suffixes = ['', '-journal', '-wal', '-shm']
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

// Windows regression for the real filesystem facade -> transport -> process
// owner. Only handshake and native worker execution are external fixture ports;
// allocation, registration, deadlines, leases and deletion are production code.
module.exports = async function verifySnapshotTransferCleanup({ loader, root, dir }) {
  const fixture = await fsp.mkdtemp(path.join(dir, 'snapshot-owner-'))
  const temporaryRoot = path.join(fixture, 'temp'), sourceRoot = path.join(fixture, 'sources')
  await fsp.mkdir(temporaryRoot); await fsp.mkdir(sourceRoot)
  const unrelated = path.join(temporaryRoot, 'unrelated.keep')
  await fsp.writeFile(unrelated, 'unrelated temporary file')
  const plans = new Map(), children = new Set(), submissions = [], snapshots = [], logs = []
  let daemonCalls = 0
  const core = 'src/main/rust-core/'
  const script = String.raw`
    const fs = require('node:fs')
    const inputPath = process.argv[1], mode = process.argv[2]
    const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
    let createError
    try {
      for (const suffix of ['', '-journal', '-wal', '-shm'])
        fs.writeFileSync(input.transferPath + suffix, fs.readFileSync(input.path + suffix), { flag: 'wx' })
    } catch (error) { createError = error }
    const failed = mode.startsWith('native-failure')
    const result = createError
      ? { ok: false, operation: 'sqliteSnapshot', code: createError.code, message: 'controlled create_new target already exists' }
      : failed
      ? { ok: false, operation: 'sqliteSnapshot', code: 'EIO', message: 'controlled native snapshot failure' }
      : { ok: true, operation: 'sqliteSnapshot', value: null }
    process.on('message', message => {
      if (message === 'close') process.exit(mode === 'native-failure-exit' ? 2 : 0)
    })
    process.stdout.write(JSON.stringify(result) + '\n', () => {
      process.send({ ready: true, pid: process.pid, inputPath, transferPath: input.transferPath })
    })
  `
  const spawn = (file, args, options) => {
    assert.equal(file, process.execPath)
    assert.equal(args[0], '--shared-file-io')
    assert.equal(args.length, 5)
    const inputPath = args[args.indexOf('--input') + 1]
    const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
    const plan = plans.get(input.path)
    assert(plan, 'unplanned native snapshot invocation')
    assert.equal(input.operation, 'sqliteSnapshot')
    assert.equal(args[args.indexOf('--transfer') + 1], input.transferPath)
    assert.equal(options.shell, false)
    plan.inputPath = inputPath; plan.transferPath = input.transferPath
    plan.directory = path.dirname(input.transferPath)
    assert.equal(path.dirname(plan.directory), temporaryRoot, 'snapshot is not in its own temporary directory')
    assert.match(path.basename(plan.directory), /^hfm-shared-snapshot-.+/)
    assert.equal(path.basename(input.transferPath), 'snapshot.sqlite')
    assert(!submissions.some(other => other.directory === plan.directory), 'snapshot directory was reused')
    submissions.push(plan)
    // Keep a real Windows child alive after logical cancellation. The adapter
    // observes production kill requests, then releases real close over IPC.
    // There are no synthetic deadline callbacks or sleeps in this test.
    const child = cp.spawn(file, ['-e', script, inputPath, plan.mode], {
      ...options, stdio: [...options.stdio, 'ipc'],
    })
    plan.child = child; plan.forceKill = child.kill.bind(child)
    child.kill = signal => { plan.killSignals.push(signal); return true }
    children.add(plan)
    child.once('error', error => { plan.spawnError = error })
    child.on('message', message => {
      if (message?.ready) { plan.readyReceived = true; plan.ready.resolve(message) }
    })
    child.once('close', () => {
      plan.closed = true; children.delete(plan); plan.closedGate.resolve()
      if (!plan.readyReceived) plan.ready.resolve({ error: plan.spawnError || new Error('snapshot child closed before ready') })
    })
    return child
  }
  const execFile = (...args) => {
    const callback = args.at(-1), protocol = load(core + 'rustCoreProtocolRuntime.ts')
    const value = args[1][0] === '--handshake'
      ? { ok: true, version: protocol.EXPECTED_RUST_CORE_WORKER_VERSION, protocolVersion: protocol.EXPECTED_RUST_CORE_PROTOCOL_VERSION, capabilities: [...protocol.REQUIRED_RUST_CORE_CAPABILITIES] }
      : { ok: true, profiles: [] }
    callback(null, JSON.stringify(value), '')
    return {}
  }
  execFile[require('node:util').promisify.custom] = (...args) => new Promise((resolve, reject) => {
    execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))
  })
  const load = loader({
    electron: { app: {} },
    'node:os': { ...os, tmpdir: () => temporaryRoot },
    'node:child_process': { ...cp, spawn, execFile },
    [path.join(root, core + 'rustCoreWorkerPathRuntime.ts')]: { resolveRustCoreWorkerPathWithDiagnostics: () => ({ path: process.execPath, candidates: [process.execPath] }) },
    [path.join(root, core + 'rustCoreWorkerAutoBuildRuntime.ts')]: { tryBuildRustCoreWorkerForDevelopment: () => { throw new Error('snapshot fixture must not build a worker') } },
    [path.join(root, core + 'rustCoreDaemonRuntime.ts')]: {
      createRustCoreDaemonRuntime: () => ({
        hasSubmittedWork: () => false, tryRun: async () => { daemonCalls++; throw new Error('snapshot bypassed isolated process owner') },
        stop() {}, stopImmediately() {}, status: () => ({}), pollStatus() {},
      }),
      isRustCoreDaemonSubmittedError: () => false,
    },
  }, { AbortController, setInterval, clearInterval })
  load(core + 'rustSharedIoCommandRuntime.ts').registerIsolatedRoot(sourceRoot, '\\\\hfm-snapshot-fixture\\sources')
  const shared = load('src/main/path/sharedFileSystemRuntime.ts')
  const transport = load(core + 'rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({ appendStartupLog: line => logs.push(line), enabled: true, required: true })
  const pool = load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime()
  const originalRun = pool.run
  pool.run = request => {
    const inputPath = request.args[request.args.indexOf('--input') + 1]
    const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
    const plan = plans.get(input.path)
    assert(plan, 'snapshot was submitted outside its fixture plan')
    assert.equal(request.timeoutMs, 2000, 'ordinary snapshot execution deadline changed')
    assert.equal(request.queueTimeoutMs, 3000, 'snapshot queue allowance changed')
    assert.equal(request.write, false)
    plan.inputPath = inputPath; plan.transferPath = input.transferPath; plan.directory = path.dirname(input.transferPath)
    const pending = originalRun(request)
    plan.submitted.resolve()
    // Observe logical failure without replacing the real scheduler, timer,
    // cancellation, closed promise, or the transport's physical-close wait.
    void pending.then(value => plan.logical.resolve({ ok: true, value }), error => plan.logical.resolve({ ok: false, error }))
    return pending
  }
  const waitReady = async plan => {
    const ready = await plan.ready.promise
    if (ready.error) throw ready.error
    assert.equal(ready.pid, plan.child.pid)
    assert.equal(ready.transferPath, plan.transferPath)
    assert.equal(ready.inputPath, plan.inputPath)
  }
  const start = async (name, mode = 'success', signal, waitForReady = true) => {
    const source = path.join(sourceRoot, name + '.sqlite')
    const plan = { source, mode, ready: deferred(), submitted: deferred(), logical: deferred(), closedGate: deferred(), killSignals: [], sourceBytes: new Map(), closed: false, settled: false }
    for (const suffix of suffixes) {
      const bytes = Buffer.from(name + ':source' + suffix)
      plan.sourceBytes.set(suffix, bytes); await fsp.writeFile(source + suffix, bytes)
    }
    plans.set(source, plan)
    const pending = signal
      ? shared.withSharedIoSignal(signal, () => shared.sharedSqliteReadSnapshot(source))
      : shared.sharedSqliteReadSnapshot(source)
    plan.result = pending.then(value => { plan.settled = true; snapshots.push(value); return { ok: true, value } }, error => { plan.settled = true; return { ok: false, error } })
    if (waitForReady) await waitReady(plan)
    return plan
  }
  const assertOwnedFiles = plan => {
    for (const suffix of suffixes) assert.deepEqual(fs.readFileSync(plan.transferPath + suffix), plan.sourceBytes.get(suffix), 'live snapshot file changed: ' + suffix)
  }
  const assertSourcesAndSentinel = () => {
    for (const plan of plans.values()) for (const suffix of suffixes)
      assert.deepEqual(fs.readFileSync(plan.source + suffix), plan.sourceBytes.get(suffix), 'snapshot cleanup touched source: ' + suffix)
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'unrelated temporary file')
  }
  const assertCleaned = (plan, directoryRemoved = true) => {
    assert.equal(plan.closed, true, 'cleanup result arrived before child close')
    for (const suffix of suffixes) assert.equal(fs.existsSync(plan.transferPath + suffix), false, 'snapshot file leaked: ' + suffix)
    assert.equal(fs.existsSync(plan.inputPath), false, 'snapshot input lease leaked')
    assert.equal(fs.existsSync(plan.directory), !directoryRemoved, 'snapshot directory ownership cleanup mismatch')
    assertSourcesAndSentinel()
  }
  const close = async plan => {
    assert.equal(plan.closed, false)
    plan.child.send('close')
    await plan.closedGate.promise
  }
  let watchdog
  try {
    // Failure-only watchdog prevents a missing callback/close from silently
    // passing. The production 2000ms timer runs unchanged below.
    await Promise.race([new Promise((_, reject) => {
      watchdog = setTimeout(() => { for (const plan of children) plan.forceKill('SIGKILL'); reject(new Error('snapshot transport cleanup did not complete')) }, 20000)
    }), (async () => {
      const peer = await start('concurrent-owner')
      const success = await start('successful-owner')
      assert.equal(pool.status().active, 2, 'snapshots did not overlap in the real process pool')
      assertOwnedFiles(peer); assertOwnedFiles(success)
      const unexpected = success.transferPath + '.keep'
      await fsp.writeFile(unexpected, 'unexpected file in owned directory')
      await close(success)
      const completed = await success.result
      assert.equal(completed.ok, true); assert.equal(completed.value.path, success.transferPath)
      assertOwnedFiles(success)
      await completed.value.dispose()
      assertCleaned(success, false)
      assert.equal(fs.readFileSync(unexpected, 'utf8'), 'unexpected file in owned directory', 'snapshot cleanup recursed into unrelated contents')
      assertOwnedFiles(peer); assert.equal(peer.closed, false); assert.equal(pool.status().active, 1)
      await fsp.unlink(unexpected); await fsp.rmdir(success.directory)
      await close(peer)
      const peerResult = await peer.result
      assert.equal(peerResult.ok, true)
      for (const mode of ['native-failure-receipt', 'native-failure-exit', 'cancelled', 'timeout']) {
        const controller = new AbortController()
        const plan = await start(mode, mode, controller.signal)
        assertOwnedFiles(plan); assertOwnedFiles(peer)
        assert.equal(plan.settled, false, 'snapshot settled while child remained open')
        if (mode === 'cancelled' || mode === 'timeout') {
          if (mode === 'cancelled') controller.abort()
          const logical = await plan.logical.promise
          assert.equal(logical.ok, false); assert.equal(logical.error.reason, mode)
          assert.equal(logical.error.outcome, 'unknown'); assert.equal(logical.error.phase, 'executing')
          assert(logical.error.closed && typeof logical.error.closed.then === 'function')
          assert.deepEqual(plan.killSignals, ['SIGTERM'])
          assert.equal(plan.child.exitCode, null); assert.equal(plan.closed, false)
          assert.equal(plan.settled, false, 'snapshot caller escaped the physical-close owner')
          assert.equal(pool.status().active, 1, 'logical failure released the physical process slot')
          assert(fs.existsSync(plan.inputPath), 'logical failure deleted the leased input')
          assertOwnedFiles(plan); assertOwnedFiles(peer); assertSourcesAndSentinel()
        }
        await close(plan)
        const failed = await plan.result
        assert.equal(failed.ok, false)
        assert.equal(failed.error.reason, mode === 'native-failure-receipt' ? 'EIO' : mode === 'native-failure-exit' ? 'process-exit' : mode)
        if (mode.startsWith('native-failure')) assert.match(failed.error.message, /controlled native snapshot failure/)
        assertCleaned(plan); assertOwnedFiles(peer)
      }
      await peerResult.value.dispose()
      assertCleaned(peer)
      for (const replacement of ['directory', 'junction']) {
        const plan = await start('replaced-' + replacement)
        await close(plan)
        const completed = await plan.result
        assert.equal(completed.ok, true)
        const saved = plan.directory + '.original'
        const replacementTarget = replacement === 'junction' ? path.join(fixture, 'junction-target') : plan.directory
        await fsp.rename(plan.directory, saved)
        await fsp.mkdir(replacementTarget)
        const replacementBytes = Buffer.from('unowned replacement ' + replacement)
        for (const suffix of suffixes) await fsp.writeFile(path.join(replacementTarget, 'snapshot.sqlite' + suffix), replacementBytes)
        if (replacement === 'junction') {
          await fsp.symlink(replacementTarget, plan.directory, 'junction')
          assert(fs.lstatSync(plan.directory).isSymbolicLink(), 'Windows junction fixture was not created')
        }
        const beforeLogs = logs.length
        await completed.value.dispose()
        assert(logs.slice(beforeLogs).some(line => line.includes('shared snapshot disposal incomplete:')), 'directory substitution did not report incomplete cleanup')
        assert.equal(fs.existsSync(plan.inputPath), false)
        for (const suffix of suffixes) {
          assert.deepEqual(fs.readFileSync(plan.transferPath + suffix), replacementBytes, 'cleanup touched a substituted directory: ' + replacement + suffix)
          assert.deepEqual(fs.readFileSync(path.join(saved, 'snapshot.sqlite' + suffix)), plan.sourceBytes.get(suffix), 'cleanup followed the renamed original directory')
        }
        if (replacement === 'junction') assert(fs.lstatSync(plan.directory).isSymbolicLink(), 'cleanup removed the replacement junction')
        assertSourcesAndSentinel()
        // Fixture-owned teardown only, after proving production left both
        // directories intact. This is not product cleanup or a retry.
        if (replacement === 'junction') await fsp.unlink(plan.directory)
        await fsp.rm(replacementTarget, { recursive: true, force: true })
        await fsp.rm(saved, { recursive: true, force: true })
      }
      for (const targetExists of [true, false]) {
        const name = targetExists ? 'queued-existing-target' : 'queued-absent-target'
        const blockers = [await start(name + '-blocker-a'), await start(name + '-blocker-b')]
        const queued = await start(name, 'success', undefined, false)
        // Observe the already-written transport input without adding any
        // production hook or bypassing the actual queue admission owner.
        await queued.submitted.promise
        assert.equal(pool.status().active, 2); assert.equal(pool.status().queued, 1)
        assert.equal(queued.child, undefined, 'substitution fixture missed the queue boundary')
        assert.deepEqual(fs.readdirSync(queued.directory), [])
        const saved = queued.directory + '.original'
        await fsp.rename(queued.directory, saved); await fsp.mkdir(queued.directory)
        const sentinel = path.join(queued.directory, 'unrelated.keep')
        const replacementBytes = Buffer.from('queued replacement must survive')
        await fsp.writeFile(sentinel, replacementBytes)
        if (targetExists) for (const suffix of suffixes) await fsp.writeFile(queued.transferPath + suffix, replacementBytes)
        for (const blocker of blockers) await close(blocker)
        for (const blocker of blockers) {
          const completed = await blocker.result
          assert.equal(completed.ok, true); await completed.value.dispose(); assertCleaned(blocker)
        }
        await waitReady(queued)
        const beforeLogs = logs.length
        await close(queued)
        const rejected = await queued.result
        assert.equal(rejected.ok, false, 'queued directory substitution published a snapshot')
        if (targetExists) assert.equal(rejected.error.code, 'EEXIST', 'existing target was not protected by exclusive create')
        else assert.match(rejected.error.message, /snapshot directory ownership changed/, 'replacement success escaped the post-close ownership guard')
        assert(logs.slice(beforeLogs).some(line => line.includes('shared snapshot disposal incomplete:')), 'queued substitution cleanup was not reported')
        assert.deepEqual(fs.readFileSync(sentinel), replacementBytes)
        for (const suffix of suffixes) assert.deepEqual(fs.readFileSync(queued.transferPath + suffix), targetExists ? replacementBytes : queued.sourceBytes.get(suffix))
        assert.deepEqual(fs.readdirSync(saved), [], 'cleanup changed the original queued directory')
        assert.equal(fs.existsSync(queued.inputPath), false)
        assertSourcesAndSentinel()
        // An absent name can receive a new exclusive temporary file after a
        // queue-time replacement. This accepted limitation is observable here;
        // no snapshot is published and neither directory is guessed away.
        await fsp.rm(queued.directory, { recursive: true, force: true })
        await fsp.rmdir(saved)
      }
      await pool.whenIdle()
      assert.equal(pool.status().active, 0); assert.equal(pool.status().queued, 0)
      assert.equal(pool.status().metrics.started, plans.size)
      assert.equal(pool.status().metrics.closed, plans.size)
      assert.equal(submissions.length, plans.size); assert.equal(daemonCalls, 0)
      assert.deepEqual(fs.readdirSync(temporaryRoot), ['unrelated.keep'], 'snapshot ownership left unexpected temporary files')
    })()])
  } finally {
    clearTimeout(watchdog)
    pool.run = originalRun
    transport.stopRustCoreDaemon()
    for (const plan of children) plan.forceKill('SIGKILL')
    await Promise.all([...plans.values()].filter(plan => plan.child).map(plan => plan.closedGate.promise))
    await Promise.all([...plans.values()].map(plan => plan.result))
    await pool.whenIdle()
    for (const snapshot of snapshots) await snapshot?.dispose()
    await fsp.rm(fixture, { recursive: true, force: true })
  }
}
