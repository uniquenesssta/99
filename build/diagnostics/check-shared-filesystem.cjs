#!/usr/bin/env node
const assert = require('node:assert/strict'), fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os')
const { loader } = require('./check-operation-chain.cjs')
async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hfm-shared-fs-'))
  const load = loader(), { sharedFileSystem: io, configureSharedFileExecutor, executeSharedFile, sharedSqliteReadSnapshot } = load('src/main/path/sharedFileSystemRuntime.ts')
  const requests = []; let remote = '\\\\nas\\fonts\\sample.ttf'
  let failure, receiptMismatch = false, closed = 0, bytes = Buffer.from([0,255,1,128]), writes = [], identity = {device:'1',inode:'2',sha1:'a'.repeat(40),size:0}
  let hold
  const executor = async (request, input) => {
    if (hold) await hold
    requests.push(request)
    if(failure) return {result:{ok:false,operation:request.operation,code:failure,message:'controlled failure'}}
    const result={ok:true,operation:receiptMismatch?'unexpected':request.operation,value:null}
    if(request.operation==='readFile') return {result,bytes:Buffer.from(bytes)}
    if(['writeFile','writeOwnedFile'].includes(request.operation)){writes.push(Buffer.from(input));if(request.operation==='writeOwnedFile')assert.deepEqual(request.identity,identity)}
    if(request.operation==='stat')result.value={isFile:true,size:bytes.length,mtimeMs:100,atimeMs:100,birthtimeMs:100}
    if(request.operation==='readdir')result.value=[{name:'font.ttf',isFile:true,isDirectory:false,isSymbolicLink:false}]
    if(request.operation==='openFile'||request.operation==='writeOwnedFile')result.value=identity
    if(request.operation==='sqliteSnapshot')return {result,snapshotPath:path.join(dir,'snapshot.sqlite'),dispose:async()=>{closed++}}
    return {result}
  }
  configureSharedFileExecutor(executor)
  try {
    const local=path.join(dir,'local');await io.writeFile(local,'local');assert.equal(await io.readFile(local,'utf8'),'local');assert.equal(requests.length,0)
    assert.deepEqual(await io.readFile(remote),bytes);assert.equal(requests.at(-1).availabilityRoot,'\\\\nas\\fonts')
    await io.writeFile(remote,bytes);assert.deepEqual(writes.pop(),bytes)
    const stat=await io.stat(remote);assert(stat.isFile());assert.equal(stat.mtime.getTime(),100)
    assert.equal((await io.readdir(remote,{withFileTypes:true}))[0].isFile(),true)
    const handle=await io.open(remote,'wx');await handle.writeFile('owned');assert.equal(writes.pop().toString(),'owned');await handle.close();await assert.rejects(handle.writeFile('late'),/关闭/)
    let release;hold=new Promise(resolve=>release=resolve)
    const before=requests.length
    const first=io.readFile(remote),second=io.readFile(remote)
    await new Promise(resolve=>setImmediate(resolve));release();hold=undefined
    const pair=await Promise.all([first,second]);assert.equal(requests.length,before+1,'same-key read was not coalesced');pair[0][0]=77;assert.equal(pair[1][0],0,'coalesced readers share mutable bytes')
    hold=new Promise(resolve=>release=resolve)
    const stale=io.readFile(remote).catch(error=>error)
    await new Promise(resolve=>setImmediate(resolve))
    load('src/main/path/startupPathAvailabilityRuntime.ts').markStartupPathRootUnavailable('\\\\nas\\fonts',new Error('disconnect'))
    release();hold=undefined;assert.equal((await stale).reason,'stale-generation')
    await assert.rejects(io.readFile(remote),error=>error.reason==='root-offline')
    // Continue shape/error tests against an independent healthy root.
    remote='\\\\nas\\healthy\\sample.ttf'
    configureSharedFileExecutor(executor)
    failure='ENOENT';await assert.rejects(io.readFile(remote),e=>e.code==='ENOENT');failure='EIO';await assert.rejects(io.readFile(remote),e=>e.sharedIo&&e.outcome==='unknown');failure=undefined
    receiptMismatch=true;await assert.rejects(executeSharedFile({operation:'readFile',path:remote}),e=>e.sharedIo&&e.reason==='invalid-receipt');receiptMismatch=false
    await assert.rejects(io.open(remote,'r'),e=>e.reason==='unsupported-file-handle')
    await assert.rejects(io.symlink(remote,remote+'link'),e=>e.reason==='unsupported-file-operation')
    const snapshot=await sharedSqliteReadSnapshot(remote);assert.equal(closed,0);await snapshot.dispose();assert.equal(closed,1)
    assert.equal(await sharedSqliteReadSnapshot(local),undefined)
    const root=path.resolve(__dirname,'../..');const routing=loader({[path.join(root,'src/main/path/pathCanonicalizer.ts')]:{normalizeNativePathText:x=>x,mappedDriveTableAsync:async()=>new Map()}},{process:{...process,platform:'win32',env:{SystemDrive:'C:'}}})('src/main/rust-core/rustSharedIoCommandRuntime.ts')
    routing.registerIsolatedRoot('C:\\fonts');assert.deepEqual(Array.from(await routing.sharedIoResourceKeys(['C:\\fonts\\a.ttf'])),['configured-root:c:\\fonts'])
    routing.registerIsolatedRoot('C:\\fonts','\\\\nas\\fonts');assert.deepEqual(Array.from(await routing.sharedIoResourceKeys(['C:\\fonts\\a.ttf','\\\\nas\\fonts\\b.ttf'])),['\\\\nas\\fonts'])
    assert.throws(()=>routing.registerIsolatedRoot('C:\\fonts','\\\\nas\\replacement'),e=>e.reason==='identity-changed')
    const cp=require('node:child_process')
    const waitUntil=async test=>{const end=Date.now()+5000;while(!test()){assert(Date.now()<end,'process proof timed out');await new Promise(resolve=>setTimeout(resolve,15))}}
    const pool=load('src/main/path/sharedIoProcessRuntime.ts').createSharedIoProcessRuntime(()=>{})
    let admitted=true
    const firstJob=pool.run({file:process.execPath,args:['-e',"setTimeout(()=>{},200)"],roots:['controlled-root'],timeoutMs:2000,write:false})
    const marker=path.join(dir,'forbidden-write')
    const staleWrite=pool.run({file:process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`],roots:['controlled-root'],timeoutMs:2000,write:true,admit:()=>admitted}).catch(error=>error)
    admitted=false;await firstJob;assert.equal((await staleWrite).outcome,'not-started');assert.equal(fs.existsSync(marker),false);pool.stop()
    const probeText=fs.readFileSync(path.join(root,'src/main/path/sharedPathProbeRuntime.ts'),'utf8')
    let source=probeText.match(/const probeSource = `([\s\S]*?)`/)[1]
    source=source.replace('const stat = fs.statSync(path);',"fs.writeFileSync(process.argv[2],'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); const stat = fs.statSync(path);")
    const ready=path.join(dir,'blocked-probe'),pidFile=path.join(dir,'probe-pid')
    const script=`const cp=require('node:child_process'),fs=require('node:fs');const child=cp.spawn(process.execPath,['-e',${JSON.stringify(source)},${JSON.stringify(dir)},${JSON.stringify(ready)}],{stdio:['ignore','ignore','ignore','pipe']});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`
    const parent=cp.spawn(process.execPath,['-e',script],{stdio:'ignore'});let childPid
    const running=()=>{try{if(process.platform==='linux')return fs.readFileSync('/proc/'+childPid+'/stat','utf8').split(') ')[1][0]!=='Z';process.kill(childPid,0);return true}catch{return false}}
    try {
      await waitUntil(()=>fs.existsSync(pidFile));childPid=Number(fs.readFileSync(pidFile,'utf8'))
      await waitUntil(()=>fs.existsSync(ready));assert(running())
      parent.kill('SIGKILL');await new Promise(resolve=>parent.once('close',resolve));await waitUntil(()=>!running())
    } finally {parent.kill('SIGKILL');if(childPid&&running())process.kill(childPid,'SIGKILL')}
    console.log('shared filesystem: local real files, binary transfer, owned handles, unknown reads, unsupported operations, snapshot lifetime, junction identity, stale queued write and blocked child after parent crash passed')
  } finally {await fsp.rm(dir,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1})
