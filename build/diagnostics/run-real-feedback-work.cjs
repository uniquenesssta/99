#!/usr/bin/env node
// Windows-only orchestration. The user's checkout and branch are never switched.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const root=path.resolve(__dirname,'../..'),baseline='6620b3bafd5b3d894987585dd06c5d5eabc54933'
function run(command,args,options={}){const result=cp.spawnSync(command,args,{cwd:root,stdio:'inherit',windowsHide:true,...options});assert.equal(result.status,0,String(result.error||`${command} exited ${result.status}`))}
function git(...args){return cp.execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim()}
function hash(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}
function main(){
 assert.equal(process.platform,'win32','Real feedback work gate requires Windows')
 const output=path.join(root,'artifacts/real-feedback/full-refresh'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-baseline-work-')),source=path.join(temporary,'source')
 const report={candidate:git('rev-parse','HEAD'),baseline,startedAt:new Date().toISOString(),passed:false};let attached=false
 fs.mkdirSync(output,{recursive:true})
 try{
  run('git',['worktree','add','--detach',source,baseline]);attached=true
  assert.equal(git('rev-parse',`${baseline}:package-lock.json`),git('rev-parse','HEAD:package-lock.json'),'Baseline dependencies require an identical lockfile')
  const modules=path.join(source,'node_modules'),currentModules=path.join(root,'node_modules')
  assert(fs.statSync(currentModules).isDirectory());fs.symlinkSync(currentModules,modules,'junction')
  assert.equal(fs.realpathSync.native(modules),fs.realpathSync.native(currentModules))
  report.dependencyLock=git('rev-parse','HEAD:package-lock.json');report.dependencyReuse='explicit temporary junction; identical lockfile'

  run(process.execPath,[path.join(source,'build/rust/build-core-worker.cjs'),'--required'],{cwd:source,timeout:600000})
  const baselineWorker=path.join(source,'build/native/hfm-core-worker.exe'),worker=path.join(root,'build/native/hfm-core-worker.exe')
  report.baselineWorkerSha256=hash(baselineWorker);report.candidateWorkerSha256=hash(worker)
  assert.equal(git('-C',source,'rev-parse','HEAD'),baseline);assert.equal(git('-C',source,'status','--porcelain','--untracked-files=no'),'')
  run(process.execPath,[path.join(__dirname,'check-full-refresh-work.cjs'),'--current-root',root,'--baseline-root',source,'--worker',worker,'--baseline-worker',baselineWorker,'--host',path.join(__dirname,'lib/production-projection-host.cjs'),'--output',output],{timeout:35*60*1000})
  report.passed=true
 }catch(error){report.failure=error.stack||String(error);throw error}
 finally{
  report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'orchestration.json'),JSON.stringify(report,null,2))
  if(attached){const link=path.join(source,'node_modules');if(fs.existsSync(link)){assert(fs.lstatSync(link).isSymbolicLink());fs.rmSync(link,{recursive:true,force:true})}assert.equal(git('-C',source,'rev-parse','HEAD'),baseline);run('git',['worktree','remove','--force',source])}
  fs.rmSync(temporary,{recursive:true,force:true})
 }
}
try{main()}catch(error){console.error(error);process.exitCode=1}
