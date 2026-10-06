#!/usr/bin/env node
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{DatabaseSync}=require('node:sqlite')
const {loader}=require('./check-operation-chain.cjs')
const tick=()=>new Promise(resolve=>setTimeout(resolve,0))
async function main(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-history-lifetime-')),filename=path.join(directory,'history.sqlite'),fontPath=path.join(directory,'font.ttf')
 let version=1,gate,release,started,enter;const reads=[]
 const content={readFontIdentityMetadata:async()=>{if(gate){enter();await gate}return {stamp:`stamp-${version}`}},readFontContentIdentity:async()=>{reads.push(version);return {sha256:String(version).repeat(64),size:version,modified:version,stamp:`stamp-${version}`}}}
 const load=loader({[path.resolve(__dirname,'../../src/main/fonts/fontContentIdentityRuntime.ts')]:content})
 const snapshots=load('src/main/library/tagFontSnapshotRuntime.ts')
 function open(){const raw=new DatabaseSync(filename);let open=true;return {get open(){return open},exec:s=>raw.exec(s),prepare:s=>raw.prepare(s),transaction:fn=>()=>{raw.exec('BEGIN');try{const v=fn();raw.exec('COMMIT');return v}catch(e){raw.exec('ROLLBACK');throw e}},close(){open=false;raw.close()}}}
 const item=v=>({id:`v${v}`,path:fontPath,fileName:'font.ttf',fileSize:v,modifiedAt:v,localTagNames:['keep'],tagNames:[]})
 let db=open(),owner=snapshots.openTagFontSnapshots(db)
 try{
  owner.schedule([item(1)]);version=2;await owner.capture([item(2)]);await owner.whenIdle()
  assert.equal(owner.read(fontPath).id,'v2');assert.equal(owner.read(fontPath).recoveryContentHash,'2'.repeat(64));assert.deepEqual(reads,[2],'queued older metadata overwrote newer durable capture')
  version=3;gate=new Promise(r=>release=r);started=new Promise(r=>enter=r);owner.schedule([item(3)]);await started
  gate=undefined;version=4;await owner.capture([item(4)]);release();await owner.whenIdle()
  assert.equal(owner.read(fontPath).id,'v4');assert.equal(owner.read(fontPath).recoveryContentHash,'4'.repeat(64))
  snapshots.disposeTagFontSnapshots(db);db.close();db=open();owner=snapshots.openTagFontSnapshots(db)
  assert.equal(owner.read(fontPath).recoveryContentHash,'4'.repeat(64),'trusted historical evidence did not survive reopen')
  version=5;gate=new Promise(r=>release=r);started=new Promise(r=>enter=r);owner.schedule([item(5)]);await started
  snapshots.disposeTagFontSnapshots(db);db.close();gate=undefined;release();await owner.whenIdle()
  db=open();owner=snapshots.openTagFontSnapshots(db);assert.equal(owner.read(fontPath).recoveryContentHash,undefined,'cancelled capture fabricated evidence')
  version=5;owner.schedule([item(5)]);await owner.whenIdle();assert.equal(owner.read(fontPath).recoveryContentHash,'5'.repeat(64),'legacy/unfinished evidence never completed after reopen')
  console.log('[diagnostics:recovery-snapshot-lifetime] stale queued and in-flight captures, close and durable reopen passed')
 }finally{snapshots.disposeTagFontSnapshots(db);db.close();fs.rmSync(directory,{recursive:true,force:true})}
}
let completed=false
process.once('beforeExit',()=>{if(!completed){console.error('Recovery snapshot diagnostic did not complete');process.exitCode=1}})
main().then(()=>{completed=true}).catch(error=>{console.error(error);process.exitCode=1})
