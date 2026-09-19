#!/usr/bin/env node
const assert = require('node:assert/strict'), path = require('node:path'), cp = require('node:child_process')
const {loader} = require('./check-operation-chain.cjs')
const crlf = process.argv.includes('--crlf'), mutant = process.argv.includes('--skip-confirmation')
const file = 'src/main/indexing/shared-metadata/sharedMetadataPreflightRuntime.ts'
const load = loader({}, {}, {[path.resolve(__dirname,'../..',file)]: text => {
 if(mutant) text=text.replace("if (committed?.preflight?.version !== 1 || committed.preflight.phase !== 'commit')",'if (false)')
 return crlf ? text.replace(/\r?\n/g,'\r\n') : text
}})
const plain = value => JSON.parse(JSON.stringify(value))
async function main() {
 const plan = load('src/main/indexing/shared-metadata/sharedTagOpsReplayRuntime.ts').planSharedTagOpsReplay
 const rows=[{font_id:'f',relative_path:'f.ttf',tag_names_json:'["标签"]',favorite:1,revision:2}]
 const base={font_id:'f',tag_name:'标签',next_revision:3,created_at:'now',tombstone:0}
 const ops=[{...base,rowid:1,op_id:'1',machine_id:'A',action:'addTag'},{...base,rowid:2,op_id:'2',machine_id:'a',action:'removeTag'}]
 const result=plan(rows,ops,{},'today','test')
 const winner=ops.slice().sort((a,b)=>a.machine_id.localeCompare(b.machine_id)).at(-1)
 const expected=winner.action==='removeTag'?[]:['标签']
 assert.deepEqual(plain(result.changes.length ? result.changes[0].tagNames : ['标签']),expected)
 assert.equal(result.meta.sharedTagOpsConflictCount,'1')
 assert.equal(plan(rows,ops,{sharedTagOpsReplayMaxRowId:'2',sharedTagOpsConflictPolicy:'1'},'today','test').changes.length,0,'policy refresh replayed old history')
 const prepare=load(file).prepareSharedMetadataInWorker
 const cache={entries:{'f.ttf':{path:'f.ttf',font:{id:'f',path:'//nas/share/f.ttf',tagNames:['标签'],favorite:true}}}}
 const calls=[]
 const run=async input=>{calls.push(plain(input));return {preflight:input.preflight.phase==='snapshot'?{version:1,phase:'snapshot',snapshot:{token:'token',rows,ops,meta:{}}}:{version:1,phase:'commit'}}}
 await prepare(run,'//nas/share',(root,p)=>root+'/'+p,cache)
 assert.equal(calls.length,2);assert.equal(calls[0].preflight.legacy[0].fontId,'f');assert.equal(calls[1].preflight.token,'token');assert.equal(calls[1].preflight.legacy,undefined)
 let count=0
 await assert.rejects(prepare(async()=>{count++;return null},'//nas/share',(_,p)=>p,cache));assert.equal(count,1)
 await assert.rejects(prepare(async input=>input.preflight.phase==='snapshot'?run(input):null,'//nas/share',(_,p)=>p,cache),'missing commit was accepted')
 const overlay=load('src/main/indexing/shared-metadata/sharedMetadataOverlayRuntime.ts').createSharedMetadataOverlayRuntime({
  exists:async()=>{throw Error('main network exists')},openSharedMetadataDb:async()=>{throw Error('main SQLite')},closeSqliteDb(){throw Error('main close')},migrateLegacyMetadataFromCacheInOpenDb(){throw Error('main migration')},appendStartupLog(){},cacheEntryRuntimePath:(_,p)=>p,
  runRustSharedMetadataOverlayRead:async input=>input.preflight?run(input):{matched:[{key:'f.ttf',tagNames:['新'],favorite:true,deleteProtected:false}]}
 })
 assert.deepEqual(plain((await overlay.applySharedMetadataOverlay('//nas/share',cache)).entries['f.ttf'].font.tagNames),['新'])
 const {DatabaseSync}=require('node:sqlite')
 const db=()=>new DatabaseSync(':memory:')
 const database=load('src/main/indexing/shared-metadata/sharedMetadataDbRuntime.ts').createSharedMetadataDbRuntime({appendStartupLog(){},openStableSqliteDb(){throw Error('main file database')}})
 const remote=db();database.initializeSharedMetadataDb(remote)
 remote.prepare("INSERT INTO font_metadata (font_id,tag_names_json,revision,updated_at) VALUES ('bad','not-json',4,'old')").run()
 const tables=['font_metadata','shared_tag_ops','shared_tag_ops_archive','metadata_events','meta']
 const capture=()=>Object.fromEntries(tables.map(table=>[table,remote.prepare(`SELECT rowid AS __rowid,* FROM ${table} ORDER BY rowid`).all()]))
 let committedTables, maintenanceCalls=0
 const maintenance=load('src/main/indexing/shared-metadata/sharedMetadataMaintenanceSnapshotRuntime.ts').createSharedMetadataMaintenanceSnapshotRuntime(async input=>{
   maintenanceCalls++
   if(input.preflight.phase==='maintenance-snapshot')return {preflight:{version:1,phase:'maintenance-snapshot',maintenance:{exists:true,token:'snapshot-token',tables:capture()}}}
   assert.equal(input.preflight.token,'snapshot-token');committedTables=input.preflight.maintenance.tables
   return {preflight:{version:1,phase:'maintenance-commit'}}
 },db)
 const owner=await maintenance.openIsolatedSnapshot('//nas/share')
 try {
   const repair=load('src/main/indexing/shared-metadata/sharedMetadataRepairRuntime.ts').createSharedMetadataRepairRuntime({writeMeta:database.writeMeta,appendStartupLog(){}})
   const report=repair.repairSharedMetadataInOpenDb(owner.db,'//nas/share',{dryRun:false})
   assert.equal(report.repairedInvalidTagJsonRows,1)
   assert.equal(remote.prepare('SELECT revision FROM font_metadata').get().revision,4,'planning touched remote database')
   await owner.commit();assert.equal(committedTables.font_metadata[0].revision,5);assert.equal(committedTables.font_metadata[0].tag_names_json,'[]')
   assert.equal(committedTables.metadata_events.length,1);assert.equal(committedTables.metadata_events[0].event_type,'repair_invalid_tag_json')
   await assert.rejects(owner.commit(),/重复/);assert.equal(maintenanceCalls,2)
 } finally {owner.close();remote.close()}
 console.log(JSON.stringify({passed:6,crlf,cases:['locale conflict winner and policy-only refresh preserved','legacy snapshot then compare-token commit','unavailable snapshot stops without writes','unconfirmed commit rejects','actual overlay forbids main network/SQLite preflight','actual in-memory maintenance preserves row identity and audit events; one conditional commit only']}))
 if(!crlf&&!mutant){const child=cp.spawnSync(process.execPath,[__filename,'--crlf'],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);const negative=cp.spawnSync(process.execPath,[__filename,'--skip-confirmation'],{encoding:'utf8'});assert.notEqual(negative.status,0);assert.match(negative.stderr,/missing commit was accepted/);console.log('CRLF and missing-commit mutant passed')}
}
main().catch(error=>{console.error(error);process.exitCode=1})
