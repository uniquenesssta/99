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
async function nativeReservationCases() {
  const removed=[],file='src/main/rust-core/nativeOwnedPreviewStageRuntime.ts',source='Z:\\fonts\\a.ttf',worker='C:\\worker.exe'
  const load=loader({'node:os':{tmpdir:()=> 'C:\\Temp'},'node:fs':{promises:{rm:async p=>removed.push(p),rmdir:async p=>removed.push(p)}}},{process:{...process,platform:'win32',env:{SystemDrive:'C:'}}})
  const owner=load(file).createNativeOwnedPreviewStageRuntime(async paths=>paths.includes(source)?['shared']:[],()=>['C:\\configured-fonts'])
  const stage=await owner.reserve(source,worker),input={fontPath:source,outputPath:stage.logicalPath,ownedStage:stage.request}
  assert.equal(owner.forInput(input,worker),stage)
  assert.equal(owner.forInput(input,'C:\\other.exe'),undefined)
  assert.equal(owner.forInput({...input,fontPath:'Z:\\other.ttf'},worker),undefined)
  assert.equal(owner.forInput({...input,ownedStage:{...stage.request,excludedRoots:[]}},worker),undefined)
  const proof={version:1,token:stage.request.token,basePath:'C:\\Temp',directoryPath:path.win32.dirname(stage.logicalPath),outputPath:stage.logicalPath}
  assert.throws(()=>stage.acceptFinal(proof,stage.logicalPath),/receipt invalid/,'missing ready accepted')
  assert.equal(stage.acceptLine('other bounded diagnostic'),false)
  for(const patch of [{token:'forged'},{basePath:'\\\\nas\\share'},{basePath:'D:\\Temp'},{directoryPath:'C:\\outside'},{outputPath:'C:\\outside.png'}])assert.throws(()=>stage.acceptLine('hfm-owned-preview-ready: '+JSON.stringify({...proof,...patch})))
  assert.equal(stage.acceptLine('hfm-owned-preview-ready: '+JSON.stringify(proof)),true)
  assert.throws(()=>stage.acceptLine('hfm-owned-preview-ready: '+JSON.stringify(proof)),/receipt invalid/)
  assert.throws(()=>stage.acceptFinal({...proof,outputPath:'C:\\changed.png'},proof.outputPath),/receipt invalid/)
  stage.acceptFinal(proof,proof.outputPath);await stage.dispose()
  assert.deepEqual(removed,[proof.outputPath,proof.directoryPath]);assert.equal(owner.forInput(input,worker),undefined)
  const unknown=await owner.reserve(source,worker);await unknown.dispose();assert.equal(removed.length,2,'unconfirmed predicted path was deleted')
}
async function nativeInitialPhaseCases() {
  const pool=loader()('src/main/path/sharedIoProcessRuntime.ts').createSharedIoProcessRuntime(()=>{})
  const submit=code=>pool.run({file:process.execPath,args:['-e',code],roots:['configured-root:owned-preview-stage'],write:true,
    label:'preview-render-owned-stage',lane:'preview-read',sharedReadOnlyPreview:true,timeoutMs:3000,maxBuffer:32768,
    initialPhase:{timeoutMs:500,acceptLine:line=>{if(!line.startsWith('ready:'))return false;if(line!=='ready:owned')throw Error('wrong nonce');return true}}})
  try {
    const split=await submit("process.stderr.write('rea');setTimeout(()=>{process.stderr.write('dy:owned\\n');process.stdout.write('{\"ok\":true}')},50)")
    assert.equal(JSON.parse(split.stdout).ok,true)
    for(const [code,reason] of [
      ["process.stderr.write('ready:owned\\nready:owned\\n');process.stdout.write('{\"ok\":true}')",'invalid-stage-receipt'],
      ["process.stderr.write('ready:wrong\\n');process.stdout.write('{\"ok\":true}')",'invalid-stage-receipt'],
      ["process.stdout.write('{\"ok\":true}')",'invalid-stage-receipt'],
      ["process.stderr.write('x'.repeat(8193)+'\\n');process.stdout.write('{\"ok\":true}')",'invalid-stage-receipt'],
      ["process.stderr.write('ready:owned');setInterval(()=>{},1000)",'timeout'],
    ]) {
      const error=await submit(code).catch(e=>e);assert.equal(error.reason,reason);assert.equal(error.outcome,'unknown');assert(error.closed);await error.closed
    }
    await pool.whenIdle();assert.equal(pool.status().metrics.started,pool.status().metrics.closed)
  } finally {pool.stop();await pool.whenIdle()}
}
async function proofLifetimeCases() {
  let base='C:\\Temp',serial=0,calls=0,rejectProof,closeProof,successful=false
  const env={SystemDrive:'C:'},closed=new Promise(resolve=>{closeProof=resolve})
  const load=loader({
    'node:os':{tmpdir:()=>base},'node:fs':{promises:{realpath:async value=>value,mkdtemp:async prefix=>prefix+(++serial),rm:async()=>{}}},
    [abs('src/main/path/sharedPathProbeRuntime.ts')]:{probeStartupDirectory:async path=>{calls++;if(successful)return{directory:true,physicalPath:path};return new Promise((_resolve,reject)=>{rejectProof=reject})}},
  },{process:{...process,platform:'win32',env}})
  const owner=load('src/main/rust-core/ownedPreviewStageRuntime.ts').createOwnedPreviewStageRuntime(async paths=>paths.includes('Z:\\font.ttf')?['source']:[])
  const first=Array.from({length:10},()=>owner.allocate('Z:\\font.ttf').catch(e=>e));for(let i=0;i<30;i++)await Promise.resolve()
  assert.equal(calls,1)
  const ErrorType=load('src/main/path/sharedIoProcessRuntime.ts').SharedIoProcessError
  const error=new ErrorType('probe timeout','unknown','timeout');error.closed=closed;rejectProof(error)
  for(let i=0;i<30;i++)await Promise.resolve()
  const late=owner.allocate('Z:\\font.ttf').catch(e=>e);for(let i=0;i<30;i++)await Promise.resolve()
  assert.equal(calls,1,'failed proof evicted before physical close')
  closeProof();assert((await Promise.all([...first,late])).every(value=>value.reason==='timeout'))
  successful=true;const retry=await owner.allocate('Z:\\font.ttf');assert.equal(calls,2,'later batch reused settled proof');await retry.dispose()
  base='D:\\Temp';env.SystemDrive='D:';const changed=await owner.allocate('Z:\\font.ttf');assert.equal(calls,3,'changed base/drive reused proof');await changed.dispose()
}
async function composition(native = false) {
  assert.equal(process.platform, 'win32', 'Owned preview staging integration requires Windows')
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'hfm-stage-test-'))
  const jobs = [], children = new Set(), requests = [], logs = [], failedCleanups = new Set()
  let generation = 1, changeBeforeCopy = false, badCopy = false, daemonCalls = 0, cleanupFailure = false, shortenDeadline = false
  let missingReady = false
  let fireDeadline, holdProof = false, allocationStarts = 0, proofStarts = 0
  const proofRelease = path.join(directory, 'proof-release')
  const source = 'Z:\\unverified-fonts\\a.ttf', other = 'Y:\\unverified-fonts\\b.ttf'
  const spawn = (_file, args, options) => {
    if (args[0] === '-e') {
      proofStarts++
      const probeArgs = holdProof ? ['-e', `const gate=require('node:fs');const wait=setInterval(()=>{if(gate.existsSync(${JSON.stringify(proofRelease)})){clearInterval(wait);${args[1]}}},5)`, ...args.slice(2)] : args
      const child = cp.spawn(process.execPath, probeArgs, options); children.add(child); child.once('close', () => children.delete(child)); return child
    }
    const input = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8'))
    const job = { args, input, release: path.join(directory, `release-${jobs.length}`), closed: false }
    jobs.push(job)
    const isOwned = args[0] === '--preview-render-owned-stage'
    const isRender = isOwned || args[0] === '--preview-render-image', isCopy = input.operation === 'copyFile'
    const proof = isOwned ? { version: 1, token: input.ownedStage.token, basePath: input.ownedStage.basePath, directoryPath: path.dirname(input.outputPath), outputPath: input.outputPath } : undefined
    const receipt = isRender ? { ok: true, outputPath: input.outputPath, ...(proof ? { ownedStage: proof } : {}) } : { ok: !(isCopy && badCopy), operation: input.operation, value: {}, message: 'controlled copy failure' }
    const mutation = isRender ? `fs.writeFileSync(${JSON.stringify(input.outputPath)},'png-stage');` : isCopy ? `fs.copyFileSync(${JSON.stringify(input.path)},${JSON.stringify(input.dest)});` : ''
    const prepare = isOwned ? `fs.mkdirSync(${JSON.stringify(proof.directoryPath)});${missingReady ? '' : `process.stderr.write(${JSON.stringify('hfm-owned-preview-ready: ' + JSON.stringify(proof) + '\n')});`}` : ''
    const script = `const fs=require('node:fs');${prepare}const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(job.release)})){clearInterval(timer);${mutation}process.stdout.write(${JSON.stringify(JSON.stringify(receipt))})}},5)`
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
  const execFile = (...args) => {
    const callback = args.at(-1), command = args[1][0]
    const protocol = load('src/main/rust-core/rustCoreProtocolRuntime.ts')
    const payload = command === '--handshake' ? { ok: true, version: '0.42.0', protocolVersion: 42, capabilities: [...protocol.REQUIRED_RUST_CORE_CAPABILITIES, 'preview-owned-stage-v1'] } : { ok: true, profiles: [] }
    callback(null, JSON.stringify(payload), ''); return {}
  }
  execFile[require('node:util').promisify.custom] = (...args) => new Promise((resolve, reject) => execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })))
  const load = loader({ electron: { app: {} }, 'node:child_process': { ...cp, spawn, ...(native ? { execFile } : {}) },
    [abs('src/main/rust-core/rustCoreWorkerPathRuntime.ts')]: { resolveRustCoreWorkerPathWithDiagnostics: () => ({ path: process.execPath, candidates: [process.execPath] }) }, 'node:fs': { ...fs, promises: files },
    [abs('src/main/path/startupPathAvailabilityRuntime.ts')]: { getStartupPathRootState: () => ({ state: 'online', generation }) },
    [abs('src/main/rust-core/rustCoreDaemonRuntime.ts')]: { createRustCoreDaemonRuntime: () => ({ tryRun: async () => { daemonCalls++; throw Error('shared preview entered daemon') }, stopImmediately() {}, status() {}, pollStatus() {} }), isRustCoreDaemonSubmittedError: () => false },
  }, { setTimeout: (fn, ms) => { if (shortenDeadline && ms > 7000) { fireDeadline = fn; return setTimeout(fn, 10000) } return setTimeout(fn, ms) } })
  const routing = load('src/main/rust-core/rustSharedIoCommandRuntime.ts')
  routing.registerIsolatedRoot('Z:\\unverified-fonts'); routing.registerIsolatedRoot('Y:\\unverified-fonts')
  const stageModule = load('src/main/rust-core/ownedPreviewStageRuntime.ts'), createStage = stageModule.createOwnedPreviewStageRuntime
  stageModule.createOwnedPreviewStageRuntime = (...args) => { const owner = createStage(...args), allocate = owner.allocate; owner.allocate = (...input) => { allocationStarts++; return allocate(...input) }; return owner }
  const transport = load('src/main/rust-core/rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({ enabled: native, required: false, appendStartupLog: value => logs.push(value) })
  if (native) assert.equal((await transport.diagnoseRustCoreWorker()).available, true)
  const pool = load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime(), run = pool.run
  pool.run = request => {
    requests.push(request)
    return run({ ...request, initialPhase: request.initialPhase ? { ...request.initialPhase, acceptLine: line => {
      const accepted = request.initialPhase.acceptLine(line)
      if (accepted) { const inputPath = request.args[request.args.indexOf('--input') + 1]; const job = jobs.find(job => job.args[job.args.indexOf('--input') + 1] === inputPath); assert(job); job.ready = true }
      return accepted
    } } : undefined })
  }
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
    const denied=await submit('--preview-render-owned-stage',{fontPath:source,outputPath:'C:\\Temp\\forged.png',ownedStage:{token:'forged'}},{paths:[source],write:true}).catch(e=>e)
    assert.equal(denied.reason,'invalid-stage-reservation');assert.equal(denied.outcome,'not-started');assert.equal(jobs.length,0)
    const first = render(output); await until(() => jobs.length === 1)
    const admittedRender = requests.find(row => row.label === (native ? 'preview-render-owned-stage' : 'preview-render-image'))
    if (native) {
      assert(admittedRender.roots.includes('configured-root:owned-preview-stage')); assert.equal(admittedRender.accesses, undefined)
      assert.equal(proofStarts, 0, 'folded native proof started a separate process'); assert.equal(allocationStarts, 0)
    }
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
      if (native) await until(() => jobs[start].ready)
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
    if (native) {
      start = jobs.length; missingReady = true
      const unconfirmed = render(output).catch(e => e); await until(() => jobs.length === start + 1)
      const unknownStage = jobs[start].input.outputPath, unknownDirectory = path.dirname(unknownStage)
      const unknown = await unconfirmed; assert.equal(unknown.reason, 'timeout'); assert.equal(unknown.outcome, 'unknown')
      assert(jobs[start].closed); assert(fs.existsSync(unknownDirectory), 'unconfirmed path deleted'); assert.equal(jobs.length, start + 1)
      await fsp.rmdir(unknownDirectory); missingReady = false
      const wrongInput = transport.createTemporaryJsonFile('hfm-stage-wrong-worker'); await wrongInput.writeJson(jobs[0].input)
      try {
        const wrong = await transport.runRustCoreScheduledCommand(process.execPath + '.wrong', ['--preview-render-owned-stage', '--input', wrongInput.path], { sharedIo: { paths: [source, jobs[0].input.outputPath], write: true, preview: true } }).catch(e => e)
        assert.equal(wrong.reason, 'invalid-stage-reservation'); assert.equal(wrong.outcome, 'not-started'); assert.equal(jobs.length, start + 1)
      } finally { await wrongInput.dispose() }
      assert.equal(proofStarts, 0, 'native path launched a separate proof'); assert.equal(allocationStarts, 0)
    } else {
    // Ten callers share only the still-running proof, then retain the existing render capacity ten.
    start = jobs.length; let beforeAllocations = allocationStarts, beforeProofs = proofStarts; holdProof = true
    await fsp.rm(proofRelease, { force: true })
    const ten = Array.from({length:10}, (_,i) => render(path.join(directory, `ten-${i}.png`)))
    await until(() => allocationStarts === beforeAllocations + 10 && proofStarts === beforeProofs + 1)
    for(let i=0;i<30;i++)await Promise.resolve()
    assert.equal(proofStarts,beforeProofs+1,'ten callers filled the probe queue with duplicate work')
    await fsp.writeFile(proofRelease,'go'); await until(() => jobs.length === start + 10)
    assert.equal(pool.status().activePreviewRead,10)
    assert.equal(new Set(jobs.slice(start).map(job=>job.input.outputPath)).size,10,'render stages collided')
    const phase = requests.filter(request=>request.label==='preview-render-image').slice(-10)
    assert.equal(new Set(phase.map(request=>request.previewStageProof.id)).size,1)
    await Promise.all(jobs.slice(start,start+10).map(release))
    for(let count=1;count<=10;count++) {
      await until(()=>jobs.length>=start+10+count)
      assert.equal(jobs[start+9+count].input.operation,'copyFile');await release(jobs[start+9+count])
    }
    await Promise.all(ten);holdProof=false
    // Cancelling the initiating waiter does not cancel a different preview's shared proof.
    start=jobs.length;beforeAllocations=allocationStarts;beforeProofs=proofStarts;holdProof=true
    await fsp.rm(proofRelease,{force:true})
    const cancelFirst=new AbortController(),one=render(output,cancelFirst.signal).catch(e=>e)
    await until(()=>proofStarts===beforeProofs+1)
    const two=render(output)
    await until(()=>allocationStarts===beforeAllocations+2&&proofStarts===beforeProofs+1)
    for(let i=0;i<30;i++)await Promise.resolve()
    cancelFirst.abort();assert.equal((await one).reason,'cancelled');assert.equal(jobs.length,start)
    await fsp.writeFile(proofRelease,'go');await until(()=>jobs.length===start+1);await release(jobs[start])
    await until(()=>jobs.length===start+2);await release(jobs[start+1]);await two
    assert.equal(proofStarts,beforeProofs+1);holdProof=false
    start=jobs.length;beforeProofs=proofStarts;holdProof=true
    await fsp.rm(proofRelease,{force:true})
    const changedDuringProof=render(output).catch(e=>e);await until(()=>proofStarts===beforeProofs+1)
    generation++;await fsp.writeFile(proofRelease,'go')
    assert.equal((await changedDuringProof).reason,'stale-generation');assert.equal(jobs.length,start);holdProof=false
    // All consumers can cancel promptly without disposing the bounded owner probe.
    start=jobs.length;beforeAllocations=allocationStarts;beforeProofs=proofStarts;holdProof=true
    await fsp.rm(proofRelease,{force:true})
    const cancellations=[new AbortController(),new AbortController()]
    const allCancelled=cancellations.map(controller=>render(output,controller.signal).catch(e=>e))
    await until(()=>allocationStarts===beforeAllocations+2&&proofStarts===beforeProofs+1)
    cancellations.forEach(controller=>controller.abort())
    assert((await Promise.all(allCancelled)).every(error=>error.reason==='cancelled'))
    assert.equal(jobs.length,start);assert.equal(pool.status().activeRootProbe,1)
    await fsp.writeFile(proofRelease,'go');await pool.whenIdle();assert.equal(jobs.length,start);holdProof=false
    }
    const contradictory = await pool.run({ file: process.execPath, args: [], roots: ['r'], accesses: [{ root: 'r', path: 'x', mode: 'write', scope: 'file' }], timeoutMs: 100, write: false }).catch(e => e)
    assert.equal(contradictory.reason, 'invalid-access')
    const forged = await pool.run({ file: process.execPath, args: [], roots: ['r'], timeoutMs: 100, write: true, sharedReadOnlyPreview: true }).catch(e => e)
    assert.equal(forged.reason, 'invalid-preview-stage'); assert.equal(daemonCalls, 0); assert.equal(pool.status().metrics.started, pool.status().metrics.closed)
  } finally {
    transport.stopRustCoreDaemon(); for (const child of children) child.kill('SIGKILL'); await pool.whenIdle()
    for (const file of failedCleanups) await fsp.rm(file, { force: true })
    // Only the directories this fixture's controlled children created are test-owned.
    for (const job of jobs.filter(job => job.input.ownedStage)) await fsp.rm(path.dirname(job.input.outputPath), { recursive: true, force: true })
    await fsp.rm(directory, { recursive: true, force: true })
  }
}
async function main() { await proofCases(); await nativeReservationCases(); await nativeInitialPhaseCases(); await proofLifetimeCases(); await composition(); await composition(true); console.log('owned preview stage: locality/live proof; unverified-alias read overlap; write fairness; same-output serialization; render/copy cancel-close; stale generation; unknown copy no replay passed') }
main().catch(error => { console.error(error); process.exitCode = 1 })
