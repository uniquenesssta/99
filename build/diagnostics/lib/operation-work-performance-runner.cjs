const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict')
const {selectFonts,hash}=require('./operation-work-performance.cjs')
const root=path.resolve(__dirname,'../../..'),baseline='e4eec49133ac01e60b7ef481f6106590a7018056'
const git=(...args)=>cp.execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim()
async function run(){
 assert.equal(process.platform,'win32','F13 measured comparison requires Windows')
 const directory=path.join(root,'artifacts/list-preview/work'),sourceRoot=path.join(directory,'baseline'),fixtureDirectory=path.join(directory,'fixture'),workerPath=path.join(root,'native-src/hfm-core-worker/target/release/hfm-core-worker.exe')
 fs.mkdirSync(directory,{recursive:true})
 const candidate=git('rev-parse','HEAD'),nativeTree=git('rev-parse',`${candidate}:native-src`)
 const baselineNativeTree=git('rev-parse',`${baseline}:native-src`)
 assert.equal(git('rev-parse',`${baseline}:build/rust`),git('rev-parse',`${candidate}:build/rust`),'native build configuration changed')
 assert.equal(git('rev-parse',`${baseline}:package-lock.json`),git('rev-parse',`${candidate}:package-lock.json`),'comparison dependencies differ')
 fs.mkdirSync(sourceRoot,{recursive:true});const archive=path.join(directory,'baseline.tar')
 fs.writeFileSync(archive,cp.execFileSync('git',['archive','--format=tar',baseline],{cwd:root,maxBuffer:128*1024*1024}));cp.execFileSync('tar',['-xf',archive,'-C',sourceRoot]);fs.unlinkSync(archive)
 let baselineWorkerPath=workerPath
 if(baselineNativeTree!==nativeTree){
  const build=cp.spawnSync(process.execPath,[path.join(sourceRoot,'build/rust/build-core-worker.cjs'),'--required'],{cwd:sourceRoot,stdio:'inherit',timeout:600000})
  assert.equal(build.status,0,'changed native source requires successful separate immutable-baseline binary build: '+String(build.error||''))
  baselineWorkerPath=path.join(sourceRoot,'native-src/hfm-core-worker/target/release/hfm-core-worker.exe')
 }
 const baselineWorkerSha256=hash(fs.readFileSync(baselineWorkerPath))
 const manifest=selectFonts(directory),workerSha256=hash(fs.readFileSync(workerPath)),reports=[],configurations=[]
 // Date.now timestamps in both existing scheduler versions resolve to integer ms.
 let t=Date.now(),minimum=Infinity;for(let i=0;i<8;i++){let next;while((next=Date.now())===t){}minimum=Math.min(minimum,next-t);t=next}
 const timingResolutionMs=minimum
 const result={baseline,candidate,nativeTree,baselineNativeTree,workerSha256,baselineWorkerSha256,lockHash:git('rev-parse',`${candidate}:package-lock.json`),manifest,timingResolutionMs,order:['A1','B1','B2','A2'],reports,limitations:['logical returned source/cache/transfer bytes; no OS physical disk counters','DirectWrite font reads and SQLite engine pages uninstrumented','fixture DOM, not full application','controlled picker/registry/mutation effects, no actual system mutations','isolated route uses runner-local storage, not NAS'],passed:false}
 try{
  for(const variant of result.order){
   const selected=variant[0]==='A'?sourceRoot:root,runDir=path.join(directory,variant);fs.mkdirSync(runDir,{recursive:true})
   const outfile=path.join(runDir,'renderer.js'),entry=path.join(__dirname,'preview-chain-performance-dom.ts')
   const bundle=await require('esbuild').build({entryPoints:[entry],bundle:true,outfile,platform:'browser',format:'iife',define:{'import.meta.env':'{}'},tsconfig:path.join(selected,'tsconfig.json'),metafile:true,plugins:[{name:'selected-source-root',setup(build){build.onResolve({filter:/^(?:\.\.?\/|@shared\/)/},args=>{
    const target=args.path.startsWith('@shared/')?path.join(selected,'src/shared',args.path.slice(8)):path.resolve(path.dirname(args.importer),args.path)
    if(target.startsWith(path.join(root,'src')+path.sep)){const mapped=path.join(selected,path.relative(root,target));for(const ext of ['', '.ts','.tsx'])if(fs.existsSync(mapped+ext))return {path:mapped+ext}}
    if(args.path.startsWith('@shared/'))for(const ext of ['', '.ts','.tsx'])if(fs.existsSync(target+ext))return {path:target+ext}
   })}}]})
   for(const file of Object.keys(bundle.metafile.inputs)){const absolute=path.resolve(root,file);if(/[\\/]src[\\/]/.test(absolute)&&!absolute.includes('node_modules'))assert(absolute.startsWith(path.join(selected,'src')+path.sep),'renderer imported wrong source tree: '+absolute)}
   const html=path.join(runDir,'index.html'),preload=path.join(runDir,'preload.cjs'),configPath=path.join(runDir,'config.json')
   fs.writeFileSync(html,'<!doctype html><meta charset="utf-8"><body><script src="renderer.js"></script></body>')
   const config={variant,sourceRoot:selected,sourceSha:variant[0]==='A'?baseline:candidate,fixtureDirectory,manifest,workerPath:variant[0]==='A'?baselineWorkerPath:workerPath,workerSha256:variant[0]==='A'?baselineWorkerSha256:workerSha256,nativeTree:variant[0]==='A'?baselineNativeTree:nativeTree}
   configurations.push(config);fs.writeFileSync(configPath,JSON.stringify(config))
   const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
   const child=cp.spawnSync(require('electron'),[path.join(__dirname,'preview-chain-performance-electron.cjs'),runDir,html,preload,configPath],{cwd:root,env,stdio:'inherit',timeout:210000})
   if(fs.existsSync(path.join(runDir,'report.json')))reports.push(JSON.parse(fs.readFileSync(path.join(runDir,'report.json'),'utf8')))
   assert.equal(child.status,0,String(child.error||'F13 workload failed'));assert.equal(reports.at(-1).passed,true)
  }
  const a=reports.filter(r=>r.variant[0]==='A'),b=reports.filter(r=>r.variant[0]==='B')
  for(const candidate of b){
   assert.equal(candidate.operations.pagination.counts.bindingCollections,1);assert.equal(candidate.operations.pagination.counts.bindingRows,1001)
   assert.equal(candidate.operations.recovery.counts.contentHashes,16,'8 candidate and 8 fresh link hashes required; transaction reads are separate')
   assert.equal(candidate.operations.uninstall.counts.planningSnapshots,1);assert.equal(candidate.operations.uninstall.counts.projections,5);assert.equal(candidate.operations.uninstall.counts.brokerSessions,1)
   assert.equal(candidate.contention.counts.timeouts,0);assert.equal(candidate.remainingChildren,0)
   assert(candidate.operations.recovery.logicalReadBytes.source<Math.min(...a.map(r=>r.operations.recovery.logicalReadBytes.source)),'actual source reads did not decrease')
   assert(candidate.operations.pagination.counts.bindingCollections<Math.min(...a.map(r=>r.operations.pagination.counts.bindingCollections)))
   assert(candidate.operations.uninstall.counts.planningSnapshots<Math.min(...a.map(r=>r.operations.uninstall.counts.planningSnapshots)))
  }
  result.waitComparison={}
  for(const metric of ['p95Ms','maxMs']){const values=a.map(r=>r.contention.foreground[metric]),allowance=Math.max(...values)+Math.abs(values[0]-values[1])+timingResolutionMs;result.waitComparison[metric]={baseline:values,allowance,candidate:b.map(r=>r.contention.foreground[metric])};assert(b.every(r=>r.contention.foreground[metric]<=allowance),'foreground contention wait regressed: '+JSON.stringify(result.waitComparison[metric]))}
  result.passed=true;console.log('[F13 comparison]',JSON.stringify({baseline,candidate,waitComparison:result.waitComparison,passed:true}))
 }catch(error){result.error=error?.stack||String(error);throw error}
 finally{fs.writeFileSync(path.join(directory,'comparison.json'),JSON.stringify(result,null,2));fs.rmSync(sourceRoot,{recursive:true,force:true})}
}
module.exports={run}
