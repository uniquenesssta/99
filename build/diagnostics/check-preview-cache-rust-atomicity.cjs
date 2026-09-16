'use strict'
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const {spawnSync,execFileSync}=require('node:child_process')
const {loader,validatePreviewNativeStages}=require('./check-operation-chain.cjs')
const root=path.resolve(__dirname,'../..'),file='native-src/hfm-core-worker/src/preview_cache/write.rs',clientFile='src/main/rust-core/clients/rustPreviewClientRuntime.ts'
function check(s){s=s.replace(/\r\n/g,'\n');const body=s.slice(s.indexOf('fn apply_on_connection'),s.indexOf('pub fn delete_preview_cache_rows'));let prev=-1;for(const t of ['conn.transaction()','upsert.execute','set_meta(&tx, "updatedAt"','tx.commit()','trace.committed()','trace.finish(']){const i=body.indexOf(t);assert(i>prev,t);prev=i}assert(!body.includes('set_meta(&conn'));assert.equal((body.match(/tx\.commit\(\)/g)||[]).length,1)}
async function clientCase(mode,kind,transform=x=>x,binary) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-preview-chain-')),dbPath=path.join(dir,'preview.db'),events=[];let runs=0,disposed=0,written
 const previous=process.env.HFM_LOG_DETAIL;process.env.HFM_LOG_DETAIL='debug'
 try{
 const load=loader({electron:{app:{}}}, {}, {[path.join(root,clientFile)]:transform}),context=load('src/main/logging/operationTraceContext.ts')
 const append=s=>{if(mode==='log-error')throw Error('log');if(s.startsWith('operation-chain: '))events.push(JSON.parse(s.slice(17)))}
 const inputPath=path.join(dir,'input.json')
 const runtime=load(clientFile).createRustPreviewClientRuntime({
 diagnoseRustCoreWorker:async()=>({available:mode!=='unavailable',path:'worker',capabilities:['preview-cache-index-apply','preview-cache-index-delete']}),
 createTemporaryJsonFile:()=>({path:inputPath,async writeJson(v){written=context.traceRustInput(v);fs.writeFileSync(inputPath,JSON.stringify(written))},async dispose(){disposed++;if(mode==='cleanup-error')throw Error('cleanup')}}),
 appendStartupLog:append,appendPreviewCacheFailureLog:()=>{if(mode==='log-error')throw Error('log')},
 async runRustCoreScheduledCommand(_,args){runs++;if(mode==='error')throw Error('outcome unknown');if(mode==='invalid')return {stdout:'{"ok":true}'};if(mode==='malformed')return {stdout:'broken'};if(mode==='rejected')return {stdout:'{"ok":false}'};
 if(binary){const o=spawnSync(binary,args,{encoding:'utf8'});if(o.error)throw o.error;for(const line of o.stderr.split(/\r?\n/))if(line.startsWith('operation-chain: '))events.push(JSON.parse(line.slice(17)));if(o.status!==0)throw Error(o.stderr);return {stdout:o.stdout}}
 return {stdout:JSON.stringify({ok:true,written:1,deleted:1})}
 }})
 const input={dbPath,schemaVersion:1,rows:[{preview_key:'a',output_path:'a.png',updated_at:'next'}],keys:['a']}
 const run=()=>kind==='apply'?runtime.runRustPreviewCacheApply(input):runtime.runRustPreviewCacheDelete(input)
 if(['error','invalid','malformed','rejected'].includes(mode))await assert.rejects(run(),'submitted mutation must not return null')
 else {const result=await run();assert.equal(result===null,mode==='unavailable')}
 assert.equal(runs,mode==='unavailable'?0:1);assert.equal(disposed,mode==='unavailable'?0:1)
 if(mode!=='unavailable')assert.equal(written.trace.domain,'previewCache')
 if(binary){validatePreviewNativeStages(events);const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(dbPath);try{assert.equal(db.prepare('SELECT COUNT(*) n FROM preview_cache').get().n,kind==='apply'?1:0)}finally{db.close()}}
 return events
 }finally{if(previous===undefined)delete process.env.HFM_LOG_DETAIL;else process.env.HFM_LOG_DETAIL=previous;fs.rmSync(dir,{recursive:true,force:true})}
}
async function main(){const s=fs.readFileSync(path.join(root,file),'utf8');check(s);check(s.replace(/\n/g,'\r\n'));for(const mutate of [s=>s.replace('set_meta(&tx,','set_meta(&conn,'),s=>s.replace('    tx.commit().map_err(|error| error.to_string())?;\n    trace.committed();','    trace.committed();\n    tx.commit().map_err(|error| error.to_string())?;')])assert.throws(()=>check(mutate(s)))
 for(const kind of ['apply','delete'])for(const mode of ['success','error','invalid','malformed','rejected','log-error','cleanup-error','unavailable'])await clientCase(mode,kind)
 await assert.rejects(()=>clientCase('error','apply',s=>s.replace('          throw error\n        }','          return null\n        }')),/submitted mutation/)
 await assert.rejects(()=>clientCase('success','apply',s=>s.replace('return tracePreviewCacheMutation(label, options.appendStartupLog, async () => {','return (async () => {').replace('    })\n  }','    })()\n  }')))
 // Synthetic validator unit cases; these do not count as native execution.
 const t={version:1,sessionId:'validator',operationId:'o',attemptId:'a',batchId:'b',domain:'previewCache',members:['o'],omitted:0,spanId:'s'}
 const chain=[{trace:t,stage:'dispatch'},{trace:t,stage:'backend-start',backend:'rust',backendSequence:1},{trace:{...t,commitSequence:2},stage:'commit',backend:'rust',backendSequence:2},{trace:t,stage:'backend-result',backend:'rust',backendSequence:3,outcome:'returned'},{trace:t,stage:'client-result',outcome:'returned'}]
 validatePreviewNativeStages(chain)
 for(const bad of [chain.filter(e=>e.stage!=='commit'),chain.map(e=>e.stage==='commit'?{...e,backendSequence:0}:e),chain.map(e=>e.stage==='backend-start'?{...e,trace:{...t,attemptId:'other'}}:e)])assert.throws(()=>validatePreviewNativeStages(bad))
 console.log('[diagnostics:preview-cache-rust-atomicity] 16 actual client cases, original replay regression, trace removal and transaction mutants passed; native requires --native')
}
async function native(){const origin=path.join(root,'native-src/hfm-core-worker'),manifest=path.join(origin,'Cargo.toml');const cargo=(args,env=process.env)=>{const r=spawnSync('cargo',args,{cwd:root,env,encoding:'utf8'});if(r.error)throw r.error;return r}
 const r=cargo(['test','--manifest-path',manifest,'preview_cache_atomicity']);process.stdout.write(r.stdout);process.stderr.write(r.stderr);assert.equal(r.status,0)
 const m=cargo(['metadata','--manifest-path',manifest,'--no-deps','--format-version','1']);assert.equal(m.status,0);const binary=path.join(JSON.parse(m.stdout).target_directory,'debug',process.platform==='win32'?'hfm-core-worker.exe':'hfm-core-worker')
 for(const kind of ['apply','delete']){const events=await clientCase('success',kind,x=>x,binary);assert.throws(()=>validatePreviewNativeStages(events.filter(e=>e.stage!=='commit')))}
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-r04-mutant-'));try{for(const name of ['src','tests','Cargo.toml','Cargo.lock'])fs.cpSync(path.join(origin,name),path.join(dir,name),{recursive:true});const source=fs.readFileSync(path.join(root,file),'utf8'),old=execFileSync('git',['show',`8b60ee798b8e5fd4c10fcecc5633dbbc08981c01:${file}`],{cwd:root,encoding:'utf8'});const block='    if let Some(first) = payload.rows.first() {\n        set_meta(&tx, "updatedAt", &first.updated_at).map_err(|error| error.to_string())?;\n    }';const mutant=source.replace(block,'').replace('    trace.committed();','    trace.committed();\n'+block.replace('&tx','&conn'));assert.notEqual(mutant,source)
 for(const [label,text] of [['old',old],['meta-after-commit',mutant]]){fs.writeFileSync(path.join(dir,'src/preview_cache/write.rs'),text);const result=cargo(['test','--manifest-path',path.join(dir,'Cargo.toml'),'--test','preview_cache_atomicity','preview_cache_atomicity_row_and_meta_failures','--','--nocapture'],{...process.env,CARGO_TARGET_DIR:path.join(origin,'target/r04-negative')});assert.notEqual(result.status,0);assert((result.stdout+result.stderr).includes('metadata leaked partial writes'),`${label}: must fail database assertion, not compilation`);console.log(`[native:preview-cache-atomicity] ${label} database assertion rejected`)}}
 finally{fs.rmSync(dir,{recursive:true,force:true})}}
if(require.main===module)main().then(()=>{if(process.argv.includes('--native'))return native()}).catch(e=>{console.error(e);process.exitCode=1})
