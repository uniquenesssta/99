const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process')
const { loader } = require('./check-operation-chain.cjs')
const file = 'src/main/path/pathCanonicalizer.ts', root = path.resolve(__dirname, '../..')
const encode = rows => Buffer.from(JSON.stringify(rows), 'utf8').toString('base64')
function harness(transform = s => s) {
  let now = 10000
  const calls = []
  class Clock extends Date { static now() { return now } }
  const load = loader({
    'node:path': path.win32,
    'node:fs': { statSync() { assert.fail('synchronous source probe') }, realpathSync: { native() { assert.fail('synchronous source realpath') } } },
    'node:child_process': { execFileSync() { assert.fail('synchronous mapping lookup') }, execFile(command, args, options, done) { calls.push({command,args,options,done}) } },
  }, { Date: Clock, process: {...process, platform:'win32'} }, {[path.join(root,file)]:transform})
  return {load, runtime:load(file), calls, advance(ms) { now += ms } }
}
async function unicode(transform) {
  const h = harness(transform), r = h.runtime
  const remote = '\\\\nas\\14t中文共享  盘_日本어😀'
  const task = r.mappedDriveTableAsync(), duplicate = r.mappedDriveTableAsync()
  assert.equal(h.calls.length,1)
  const call = h.calls[0]
  assert.equal(call.command,'powershell.exe')
  assert.deepEqual(Array.from(call.args.slice(0,4)),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand'])
  const script = Buffer.from(call.args[4],'base64').toString('utf16le')
  assert(script.includes("Get-CimInstance -Query 'SELECT DeviceID, ProviderName FROM Win32_LogicalDisk"))
  assert(script.includes("WHERE DriveType = 4'"))
  assert(script.includes('ToBase64String([Text.Encoding]::UTF8.GetBytes($json))'))
  assert(!script.includes('-ComputerName')); assert(!script.includes(remote))
  assert.equal(call.options.timeout,1500); assert.equal(call.options.shell,false); assert.equal(call.options.killSignal,'SIGKILL')
  call.done(null,encode([{drive:'z:',remote},{drive:'O:',remote:'\\\\nas\\other'}]))
  assert.equal((await task).get('Z:'),remote); assert.equal((await duplicate).get('O:'),'\\\\nas\\other')
  const chosen = 'Z:\\字体\\字体-小薇'
  const expected = remote+'\\字体\\字体-小薇'
  for (const input of [chosen,'z:/字体/字体-小薇','\\\\?\\Z:\\字体\\字体-小薇']) assert.equal(r.canonicalizeWatchedFolderPathText(input),expected)
  const watched = h.load('src/main/path/watchedFolderCanonicalRuntime.ts')
  assert.equal(watched.canonicalWatchedFolderPath(chosen),expected)
  assert.equal(watched.dedupeWatchedFolderRoots([chosen,expected]).length,1)
  assert.equal(r.canonicalizeWatchedFolderPathText('C:\\本机\\字体'),'C:\\本机\\字体')
  assert.equal(r.canonicalizeWatchedFolderPathText('\\\\other\\共享\\字体'),'\\\\other\\共享\\字体')
  ;(await r.mappedDriveTableAsync()).set('Z:','poison')
  assert.equal(r.canonicalizeWatchedFolderPathText(chosen),expected)
  assert.equal(h.calls.length,1)
  h.advance(30001)
  const fresh=r.mappedDriveTableAsync();h.calls[1].done(null,encode([{drive:'Z:',remote:'\\\\nas\\新共享'}]));await fresh
  assert.equal(r.canonicalizeWatchedFolderPathText(chosen),'\\\\nas\\新共享\\字体\\字体-小薇')
}
async function failures() {
  for (const output of ['', 'broken',encode(null),encode({drive:'Z:',remote:'\\\\nas\\share'}),encode([{drive:'Z:',remote:'\\\\nas\\bad�'}]),encode([{drive:'Z:',remote:'local'}]),encode([{drive:'Z:',remote:'\\\\nas\\a'},{drive:'z:',remote:'\\\\nas\\b'}])]) {
    const h=harness(),task=h.runtime.mappedDriveTableAsync();h.calls[0].done(null,output)
    assert.equal(await task,null);assert.equal(h.runtime.canonicalizeWatchedFolderPathText('Z:\\字体'),'Z:\\字体')
    assert.equal(await h.runtime.mappedDriveTableAsync(),null);assert.equal(h.calls.length,1)
    h.advance(5001);const retry=h.runtime.mappedDriveTableAsync();h.calls[1].done(null,encode([]));assert.equal((await retry).size,0)
  }
  const h=harness(),task=h.runtime.mappedDriveTableAsync();h.calls[0].done(Error('timeout'))
  assert.equal(await task,null);h.advance(5001);const retry=h.runtime.mappedDriveTableAsync();h.calls[1].done(null,encode([{drive:'Z:',remote:'\\\\nas\\中文'}]));await retry
  h.advance(30001);const stale=h.runtime.mappedDriveTableAsync();h.calls[2].done(Error('timeout'));await stale
  assert.equal(h.runtime.canonicalizeWatchedFolderPathText('Z:\\字体'),'Z:\\字体','failed refresh must discard previous mapping')
}
async function baseline() {
  const old=cp.execFileSync('git',['show','848764d:'+file],{cwd:root,encoding:'utf8'})
  const h=harness(()=>old), task=h.runtime.mappedDriveTableAsync()
  // CP936 bytes for 中文 decoded as UTF-8 reproduce the user's replacement characters.
  const remote='\\\\nas\\14t'+Buffer.from('d6d0cec4','hex').toString('utf8')
  h.calls[0].done(null,'OK Z: '+remote+'       Microsoft Windows Network\r\n');await task
  assert(h.runtime.canonicalizeWatchedFolderPathText('Z:\\字体').includes('�'))
}
async function main() {
  await baseline();await unicode(s=>s);await failures();await unicode(s=>s.replace(/\r?\n/g,'\r\n'))
  await assert.rejects(()=>unicode(s=>s.replace("normalizeNativePathText(`${remoteRoot}${suffix}`)","normalizeNativePathText(`${remoteRoot}`)")),undefined,'lost suffix mutant escaped')
  if(process.platform==='win32') {
    let observation
    const actual = loader({'node:child_process': {...cp, execFile(command, args, options, done) {
      const started = Date.now()
      return cp.execFile(command, args, options, (error, stdout, stderr) => {
        observation = { elapsedMs: Date.now() - started, timeoutMs: options.timeout,
          code: error?.code, signal: error?.signal, killed: error?.killed,
          stdoutBytes: Buffer.byteLength(stdout || ''), stderr: String(stderr || '').slice(0, 2000) }
        done(error, stdout, stderr)
      })
    }}})(file)
    assert(await actual.mappedDriveTableAsync() instanceof Map, 'real local CIM query failed: ' + JSON.stringify(observation))
    console.log('[diagnostics:mapped-drive-unicode] actual CIM execution: ' + JSON.stringify(observation))
  }
  console.log('[diagnostics:mapped-drive-unicode] old OEM corruption reproduced; Unicode/space/device aliases, actual watched-root dedupe, no sync IO, coalescing/cache/retry/invalid receipts, CRLF and suffix regression passed; Windows CIM/NAS '+(process.platform==='win32'?'local CIM executed; NAS acceptance separate':'not executed'))
}
main().catch(error=>{console.error(error);process.exitCode=1})
