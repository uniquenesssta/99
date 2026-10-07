#!/usr/bin/env node
// Production stage owner, transport, queue and physical child lifetime. No real font mutation.
process.env.HFM_LOG_DETAIL = 'debug'
const assert = require('node:assert/strict'), fs = require('node:fs'), fsp = fs.promises
const path = require('node:path'), os = require('node:os'), cp = require('node:child_process')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..'), abs = p => path.join(root, p)
const tick = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(test) { const end = Date.now() + 10000; while (!test()) { assert(Date.now() < end, 'stage condition timed out'); await tick(10) } }
async function proofCases() {
  const file = 'src/main/rust-core/ownedPreviewStageRuntime.ts'
  const make = ({ temporary = 'C:\\Temp', canonical = temporary, stageCanonical, shared = false, mappingError = false, probeError = false } = {}) => {
    let probes = 0, removed = 0
    const owner = loader({
      'node:os': { tmpdir: () => temporary },
      [abs('src/main/path/sharedPathProbeRuntime.ts')]: { probeStartupDirectory: async () => { probes++; if (probeError) throw Error('probe denied'); return { directory: true, physicalPath: canonical } } },
      'node:fs': { promises: { realpath: async value => { probes++; if (probeError) throw Error('probe denied'); return value === temporary ? canonical : stageCanonical || value }, mkdtemp: async prefix => prefix + 'owned', rm: async () => { removed++ } } },
    }, { process: { ...process, platform: 'win32', env: { SystemDrive: 'C:' } } })(file).createOwnedPreviewStageRuntime(async paths => {
      if (mappingError) throw Error('mapping unavailable')
      return paths.some(p => p === 'Z:\\font.ttf' || (shared && p.startsWith('C:'))) ? ['configured-root:source'] : []
    })
    return { owner, probes: () => probes, removed: () => removed }
  }
  const h = make(), stage = await h.owner.allocate('Z:\\font.ttf')
  assert(stage)
  const accesses = [{ path: 'Z:\\font.ttf', mode: 'read', scope: 'file' }, { path: stage.path, mode: 'write', scope: 'file' }]
  assert.equal(h.owner.provesReadOnly({ fontPath: 'Z:\\font.ttf', outputPath: stage.path }, accesses), true)
  assert.equal(h.owner.provesReadOnly({ fontPath: 'Z:\\font.ttf', outputPath: 'C:\\Temp\\forged.png' }, accesses), false)
  assert.equal(h.owner.provesReadOnly({ fontPath: 'Z:\\font.ttf', outputPath: stage.path }, [...accesses, { path: 'Z:\\other', mode: 'write', scope: 'file' }]), false)
  await stage.dispose(); assert.equal(h.owner.provesReadOnly({ fontPath: 'Z:\\font.ttf', outputPath: stage.path }, accesses), false)
  for (const options of [{ temporary: 'D:\\Temp' }, { shared: true }, { canonical: '\\\\nas\\temp' }]) {
    const unsafe = make(options); assert.equal(await unsafe.owner.allocate('Z:\\font.ttf'), null)
    if (options.temporary || options.shared) assert.equal(unsafe.probes(), 0, 'unproven temp was probed on main')
  }
  const moved = make({ stageCanonical: 'C:\\elsewhere\\not-owned' })
  await assert.rejects(moved.owner.allocate('Z:\\font.ttf'), /locality/); assert.equal(moved.removed(), 1)
  for (const options of [{ mappingError: true }, { probeError: true }]) await assert.rejects(make(options).owner.allocate('Z:\\font.ttf'))
}
async function composition() {
  assert.equal(process.platform, 'win32', 'Owned preview staging integration requires Windows')
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'hfm-stage-test-'))
  const jobs = [], children = new Set(), requests = [], logs = [], failedCleanups = new Set()
  let generation = 1, changeBeforeCopy = false, badCopy = false, daemonCalls = 0, cleanupFailure = false, shortenDeadline = false
  let fireDeadline
  const source = 'Z:\\unverified-fonts\\a.ttf', other = 'Y:\\unverified-fonts\\b.ttf'
  const spawn = (_file, args, options) => {
    if (args[0] === '-e') return cp.spawn(process.execPath, args, options)
    const input = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8'))
    const job = { args, input, release: path.join(directory, `release-${jobs.length}`), closed: false }
    jobs.push(job)
    const isRender = args[0] === '--preview-render-image', isCopy = input.operation === 'copyFile'
    const receipt = isRender ? { ok: true, outputPath: input.outputPath } : { ok: !(isCopy && badCopy), operation: input.operation, value: {}, message: 'controlled copy failure' }
    const mutation = isRender ? `fs.writeFileSync(${JSON.stringify(input.outputPath)},'png-stage');` : isCopy ? `fs.copyFileSync(${JSON.stringify(input.path)},${JSON.stringify(input.dest)});` : ''
    const script = `const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(job.release)})){clearInterval(timer);${mutation}process.stdout.write(${JSON.stringify(JSON.stringify(receipt))})}},5)`
    const child = cp.spawn(process.execPath, ['-e', script], options); children.add(child)
    child.once('close', () => { children.delete(child); job.closed = true })
    return child
  }
  const files = { ...fsp, rm: async (file, ...args) => {
    if (cleanupFailure && /hfm-preview-(stage|publish)-input/.test(String(file))) { failedCleanups.add(file); throw Object.assign(Error('cleanup denied'), { code: 'EACCES' }) }
    return fsp.rm(file, ...args)
  }, writeFile: async (file, content, ...args) => {
    await fsp.writeFile(file, content, ...args)
    if (changeBeforeCopy && String(file).includes('hfm-preview-publish-input')) { changeBeforeCopy = false; generation++ }
  } }
  const load = loader({ electron: { app: {} }, 'node:child_process': { ...cp, spawn }, 'node:fs': { ...fs, promises: files },
    [abs('src/main/path/startupPathAvailabilityRuntime.ts')]: { getStartupPathRootState: () => ({ state: 'online', generation }) },
    [abs('src/main/rust-core/rustCoreDaemonRuntime.ts')]: { createRustCoreDaemonRuntime: () => ({ tryRun: async () => { daemonCalls++; throw Error('shared preview entered daemon') }, stopImmediately() {}, status() {}, pollStatus() {} }), isRustCoreDaemonSubmittedError: () => false },
  }, { setTimeout: (fn, ms) => { if (shortenDeadline && ms > 7000) { fireDeadline = fn; return setTimeout(fn, 10000) } return setTimeout(fn, ms) } })
  const routing = load('src/main/rust-core/rustSharedIoCommandRuntime.ts')
  routing.registerIsolatedRoot('Z:\\unverified-fonts'); routing.registerIsolatedRoot('Y:\\unverified-fonts')
  const transport = load('src/main/rust-core/rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({ enabled: false, required: false, appendStartupLog: value => logs.push(value) })
  const pool = load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime(), run = pool.run
  pool.run = request => { requests.push(request); return run(request) }
  const release = job => fsp.writeFile(job.release, 'release')
  const submit = async (command, input, sharedIo, signal) => {
    const file = transport.createTemporaryJsonFile('hfm-stage-regression'); await file.writeJson(input)
    try { return await transport.runRustCoreScheduledCommand(process.execPath, [command, '--input', file.path], { timeout: 5000, sharedIo, signal }) }
    finally { await file.dispose() }
  }
  const render = (outputPath, signal, fontPath = source) => submit('--preview-render-image', { fontPath, outputPath }, {
    paths: [fontPath, outputPath], write: true, preview: true, accesses: [{ path: fontPath, mode: 'read', scope: 'file' }, { path: outputPath, mode: 'write', scope: 'file' }],
  }, signal)
  try {
    const output = path.join(directory, 'out.png'); await fsp.writeFile(output, 'last-good')
    const first = render(output); await until(() => jobs.length === 1)
    const admittedRender = requests.find(row => row.label === 'preview-render-image')
    assert.equal(admittedRender.write, true); assert.equal(admittedRender.sharedReadOnlyPreview, true); assert.equal(admittedRender.lane, 'preview-read')
    assert.notEqual(jobs[0].input.outputPath, output)
    const enumeration = submit('--shared-file-io', { operation: 'treeSnapshot', path: other }, { paths: [other], write: false })
    await until(() => jobs.length === 2); assert.equal(pool.status().active, 2, 'enumeration was blocked by local stage write')
    const writer = submit('--unknown-writer', { path: other }, { paths: [other], write: true })
    await until(() => pool.status().queued === 1)
    const cancelQueued = new AbortController(), newer = render(path.join(directory, 'newer.png'), cancelQueued.signal).catch(e => e)
    await until(() => pool.status().queued === 2); assert.equal(jobs.length, 2, 'new render bypassed unknown writer')
    cancelQueued.abort(); assert.equal((await newer).outcome, 'not-started')
    await release(jobs[1]); await enumeration; assert.equal(jobs.length, 2, 'writer did not hold behind live render')
    await release(jobs[0]); await until(() => jobs.length === 3); assert.equal(jobs[2].args[0], '--unknown-writer')
    assert.equal(await fsp.readFile(output, 'utf8'), 'last-good', 'render stage published without copy')
    await release(jobs[2]); await writer; await until(() => jobs.length === 4)
    assert.equal(jobs[3].input.operation, 'copyFile'); assert.equal(requests.at(-1).write, true); assert.equal(requests.at(-1).lane, 'default')
    await release(jobs[3]); assert.equal(JSON.parse((await first).stdout).outputPath, output); assert.equal(await fsp.readFile(output, 'utf8'), 'png-stage')
    assert.equal(fs.existsSync(jobs[0].input.outputPath), false, 'settled stage leaked')
    routing.registerIsolatedRoot('Z:\\unverified-fonts', '\\\\nas-a\\fonts'); routing.registerIsolatedRoot('Y:\\unverified-fonts', '\\\\nas-b\\fonts')
    let start = jobs.length
    const left = render(output), right = render(output, undefined, other)
    await until(() => jobs.length === start + 2); await Promise.all([release(jobs[start]), release(jobs[start + 1])])
    await until(() => jobs.length === start + 3); assert.equal(jobs[start + 2].input.operation, 'copyFile'); await tick(30)
    assert.equal(jobs.length, start + 3, 'same-output copies overlapped')
    await release(jobs[start + 2]); await until(() => jobs.length === start + 4); await release(jobs[start + 3]); await Promise.all([left, right])
    for (const phase of ['render', 'copy']) {
      start = jobs.length; const controller = new AbortController(), pending = render(output, controller.signal).catch(e => e)
      await until(() => jobs.length === start + 1); const stage = jobs[start].input.outputPath
      if (phase === 'copy') { await release(jobs[start]); await until(() => jobs.length === start + 2); assert(fs.existsSync(stage)) }
      controller.abort(); const error = await pending
      assert.equal(error.outcome, 'unknown'); assert.equal(error.reason, 'cancelled')
      assert(jobs.slice(start).every(job => job.closed), 'preview settled before physical close'); await error.closed; await pool.whenIdle()
      assert.equal(fs.existsSync(stage), false, 'stage disposed before close or leaked')
    }
    start = jobs.length; shortenDeadline = true
    const expired = render(output).catch(e => e); await until(() => jobs.length === start + 1)
    assert.equal(typeof fireDeadline, 'function'); fireDeadline()
    const deadlineError = await expired; assert.equal(deadlineError.reason, 'timeout'); assert.equal(deadlineError.outcome, 'unknown')
    assert(jobs[start].closed, 'deadline settled before physical close'); shortenDeadline = false
    start = jobs.length; changeBeforeCopy = true
    const stale = render(output).catch(e => e); await until(() => jobs.length === start + 1); await release(jobs[start])
    assert.equal((await stale).reason, 'stale-generation'); assert.equal(jobs.length, start + 1, 'old generation reached publication child')
    start = jobs.length; badCopy = true
    const failed = render(output).catch(e => e); await until(() => jobs.length === start + 1); await release(jobs[start]); await until(() => jobs.length === start + 2); await release(jobs[start + 1])
    assert.equal((await failed).outcome, 'unknown'); assert.equal(jobs.length, start + 2, 'unconfirmed copy was replayed'); badCopy = false
    start = jobs.length; cleanupFailure = true
    const committed = render(output); await until(() => jobs.length === start + 1); await release(jobs[start]); await until(() => jobs.length === start + 2); await release(jobs[start + 1])
    assert.equal(JSON.parse((await committed).stdout).outputPath, output, 'cleanup loss changed a committed result into retryable failure')
    assert.equal(jobs.length, start + 2); assert.equal(failedCleanups.size, 2); cleanupFailure = false
    const contradictory = await pool.run({ file: process.execPath, args: [], roots: ['r'], accesses: [{ root: 'r', path: 'x', mode: 'write', scope: 'file' }], timeoutMs: 100, write: false }).catch(e => e)
    assert.equal(contradictory.reason, 'invalid-access')
    const forged = await pool.run({ file: process.execPath, args: [], roots: ['r'], timeoutMs: 100, write: true, sharedReadOnlyPreview: true }).catch(e => e)
    assert.equal(forged.reason, 'invalid-preview-stage'); assert.equal(daemonCalls, 0); assert.equal(pool.status().metrics.started, pool.status().metrics.closed)
  } finally {
    transport.stopRustCoreDaemon(); for (const child of children) child.kill('SIGKILL'); await pool.whenIdle()
    for (const file of failedCleanups) await fsp.rm(file, { force: true })
    await fsp.rm(directory, { recursive: true, force: true })
  }
}
async function main() { await proofCases(); await composition(); console.log('owned preview stage: locality/live proof; unverified-alias read overlap; write fairness; same-output serialization; render/copy cancel-close; stale generation; unknown copy no replay passed') }
main().catch(error => { console.error(error); process.exitCode = 1 })
