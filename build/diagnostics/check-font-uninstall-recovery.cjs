#!/usr/bin/env node
// Windows controlled main/SQLite regression. Never installs real fonts or writes Windows registry.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {DatabaseSync}=require('node:sqlite'),{loader}=require('./check-operation-chain.cjs')
const root=path.resolve(__dirname,'../..'),plain=value=>JSON.parse(JSON.stringify(value))
const source='C:\\source\\face.ttf',target='C:\\user-fonts\\renamed.ttf',key=value=>String(value).toLowerCase()
const bytes=Buffer.from('0001000000000000','hex')
function harness() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hfm-uninstall-receipt-')),file=path.join(directory,'library.sqlite')
  const open=()=>{const db=new DatabaseSync(file);db.transaction=fn=>()=>{db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result}catch(error){db.exec('ROLLBACK');throw error}};return db}
  let db=open(),epoch=0,closing=false,runtime
  const h={files:new Map([[source,{id:'9007199254740992',bytes:Buffer.from(bytes),readonly:true,mtime:1.125,ctime:1}],[target,{id:'9007199254740993',bytes:Buffer.from(bytes),readonly:false,mtime:1.125,ctime:1}]]),aliases:new Map(),denied:new Set(),protected:new Set(),records:[{source:'HKCU',path:target,fileName:'renamed.ttf',registryName:'Face',value:target}],effects:[],calls:[],claims:[],claimsFail:false,mode:'success',persistFails:false,projectionCalls:0,projectionHook:null,projectionResult:{known:true,installed:false,by:'none',matches:[]},hook:null}
  const missing=()=>Object.assign(Error('missing'),{code:'ENOENT'})
  const physical=p=>h.aliases.get(p)||p
  const io={
    realpath:async p=>{if(h.denied.has(p))throw Object.assign(Error('access denied '+p),{code:'EACCES'});const actual=physical(p);if(!h.files.has(actual))throw missing();return actual},
    stat:async(p,options)=>{
      if(h.denied.has(p))throw Object.assign(Error('access denied '+p),{code:'EACCES'})
      if(/^[A-Z]:\\$/i.test(p))return {isDirectory:()=>true,isFile:()=>false}
      const entry=h.files.get(physical(p));if(!entry)throw missing()
      return {isDirectory:()=>false,isFile:()=>true,size:entry.bytes.length,mtimeMs:entry.mtime,ctimeMs:entry.ctime,dev:options?.bigint?1n:1,ino:options?.bigint?BigInt(entry.id):Number(entry.id)}
    },
    readFile:async p=>{const entry=h.files.get(physical(p));if(!entry)throw missing();return Buffer.from(entry.bytes)},
    unlink:async()=>{throw Error('source unlink port must not be reached')},copyFile:async()=>{throw Error('source copy port must not be reached')},chmod:async()=>{throw Error('source attributes port must not be reached')},
  }
  const snapshot=()=>plain(h.records)
  const mocks={
    'node:path':path.win32,
    [path.join(root,'src/main/path/sharedFileSystemRuntime.ts')]:{sharedFileSystem:io,withSharedIoPriority:(_priority,run)=>run()},
    [path.join(root,'src/main/install/fontMutationProcessRuntime.ts')]:{createFontMutationSession:async()=>{throw Error('real native launcher forbidden')}},
    [path.join(root,'src/main/app/shutdownCoordinatorRuntime.ts')]:{applicationWorkEpoch:()=>epoch,isApplicationClosing:()=>closing,assertApplicationOpen:ticket=>{if(closing||ticket!==epoch)throw Error('software closing')},noteRecoveryPersistenceFailure(){}},
  }
  const load=loader(mocks)
  load('src/main/library/runtime/librarySchemaRuntime.ts').initializeLibraryDb(db)
  const store=()=>load('src/main/install/fontUninstallReceiptRuntime.ts').openFontUninstallReceipts(db)
  const item={id:'source',path:source,fileName:'face.ttf',family:'Face',fullName:'Face',postscriptName:'Face',style:'Regular',format:'ttf',fileSize:8,modifiedAt:1.125,tagNames:['retain'],localTagNames:['private'],favorite:true,systemInstalled:true,systemInstallMatches:[],active:false}
  const initial=()=>plain([...h.files].map(([path,entry])=>({path,id:entry.id,bytes:entry.bytes.toString('hex'),readonly:entry.readonly,mtime:entry.mtime,ctime:entry.ctime})))
  const original=initial().find(entry=>entry.path===source)
  const deps={readUninstallActivationClaims:async()=>{if(h.claimsFail)throw Error('activation store unavailable');return h.claims},openUninstallReceipts:async()=>store(),ensureWindows(){},currentUserFontsDir:()=> 'C:\\user-fonts',windowsFontsDir:()=> 'C:\\Windows\\Fonts',normalizePathForCacheCompare:key,isTemporaryActiveInstalledRecord:record=>record.registryName.startsWith('TEMP'),
    withFontProtection:async(items,action)=>{const check=async()=>{if(items.some(item=>h.protected.has(item.path)))throw Error('protected')};await check();return action(check)},
    getSystemInstalledFonts:async()=>snapshot(),readUninstallRegistry:async()=>snapshot(),clearInstalledFontsMemoryCache(){},appendStartupLog(){},advancedFontRefresh:async()=>{},
    persistUninstallResult:async(_item,assertCurrent)=>{assertCurrent?.();h.projectionCalls++;await h.projectionHook?.();assertCurrent?.();if(h.persistFails)throw Error('projection disk failed');return h.projectionResult},
    createMutationSession:async()=>({close(){},execute:async(plan,check)=>{
      h.calls.push(plain(plan));let completedSteps=0,fileRemoved=false
      try {
        await check()
        if(h.mode==='cancel'){await check(snapshot(),'before-uac');return {ok:false,message:'UAC cancelled',completedSteps:0,fileRemoved:false,cancelled:true,code:1223}}
        let entry=h.files.get(plan.path)
        if(entry?.readonly&&(plan.preflight_file||plan.delete_file)&&plan.allow_readonly_copy){await h.hook?.('attributes');await check(snapshot(),'attributes');entry.readonly=false;entry.ctime++;h.effects.push(['attributes',plan.path])}
        for(const record of plan.records){
          await h.hook?.('registry');await check(snapshot(),'registry')
          if(h.mode==='lost-ack-live')return {ok:false,message:'elevated transport disconnected',completedSteps:0,fileRemoved:false,uncertain:true}
          const index=h.records.findIndex(row=>row.source===record.scope&&row.registryName.toLowerCase()===record.name.toLowerCase()&&row.value===record.value)
          assert(index>=0,'controlled native exact record must still exist');h.records.splice(index,1);h.effects.push(['registry',record.scope,record.name]);completedSteps++;await h.hook?.('after-registry')
          if(h.mode==='lost-ack-absent')return {ok:false,message:'elevated transport disconnected',completedSteps:0,fileRemoved:false,uncertain:true}
        }
        if(plan.delete_file){
          await h.hook?.('file');await check(snapshot(),'file')
          if(h.mode==='blocked')return {ok:false,message:'sharing violation',completedSteps,fileRemoved:false,code:32}
          h.files.delete(plan.path);h.effects.push(['file',plan.path]);completedSteps++;fileRemoved=true
          if(h.mode==='lost-file-ack')return {ok:false,message:'file receipt lost',completedSteps:0,fileRemoved:false,uncertain:true}
        }
        return {ok:true,message:'controlled',completedSteps,fileRemoved}
      }catch(error){return {ok:false,message:String(error),completedSteps,fileRemoved}}
    }}),
  }
  const make=()=>runtime=load('src/main/install/systemFontInstallRuntime.ts').createSystemFontInstallRuntime(deps)
  make()
  return Object.assign(h,{item,io,load,store,initial,run:(selected=item)=>runtime.uninstallFontSystemWide(selected),restart(){db.close();db=open();make()},db:()=>db,
    sourceUnchanged(){assert.deepEqual(initial().find(entry=>entry.path===source),original,'source content/path/attributes changed');assert.deepEqual(item.tagNames,['retain']);assert.deepEqual(item.localTagNames,['private'])},
    quitAndResume(){closing=true;epoch++;closing=false;epoch++},
    startClosing(){closing=true;epoch++},
    close(){db.close();fs.rmSync(directory,{recursive:true,force:true})},make,
  })
}
async function run() {
  let cases=0
  const scenario=async action=>{const h=harness();try{await action(h);cases++}finally{h.close()}}
  await scenario(async h=>{
    h.mode='blocked';let result=await h.run();assert.equal(result.ok,false);assert.equal(result.uninstall.pending,true);assert.equal(result.uninstall.completedSteps,1);assert.equal(h.records.length,0)
    const first=h.store().load(source);assert.equal(first.steps[0].state,'done');assert.equal(first.steps[1].state,'pending');assert.equal(h.store().hydrate([{...h.item,systemInstalled:false}])[0].systemInstalled,false)
    h.load('src/main/library/runtime/libraryPersistenceRuntime.ts').saveLibraryToSqlite(h.db(),h.load('src/main/library/libraryState.ts').defaultLibrary())
    h.restart();assert(h.store().hydrate([h.item])[0].pendingUninstall,'settings save/reopen lost retry hint');h.mode='success'
    result=await h.run();assert.equal(result.ok,true);assert.equal(h.store().load(source),undefined);assert.deepEqual(h.effects,[['registry','HKCU','Face'],['file',target]]);h.sourceUnchanged()
  })
  await scenario(async h=>{h.mode='blocked';await h.run();h.restart();h.files.get(target).id='9007199254740992';h.mode='success';h.effects.length=0;const result=await h.run();assert.equal(result.ok,false);assert.match(result.message,/身份已变化/);assert.deepEqual(h.effects,[]);assert(h.files.has(target));h.sourceUnchanged()})
  await scenario(async h=>{h.mode='cancel';const result=await h.run();assert.equal(result.uninstall.cancelled,true);assert.equal(h.store().load(source).steps[0].state,'pending');assert.deepEqual(h.effects,[]);h.restart();h.mode='success';assert.equal((await h.run()).ok,true);h.sourceUnchanged()})
  for(const mode of ['lost-ack-live','lost-ack-absent'])await scenario(async h=>{h.mode=mode;assert.equal((await h.run()).ok,false);assert.equal(h.store().load(source).steps[0].state,'attempted');h.restart();h.mode='success';h.effects.length=0;const result=await h.run();if(mode==='lost-ack-live'){assert.equal(result.ok,false);assert.match(result.message,/回执中断/);assert.deepEqual(h.effects,[])}else{assert.equal(result.ok,true);assert.deepEqual(h.effects,[['file',target]])}h.sourceUnchanged()})
  for(const change of ['same-record','changed-value','new-reference','alias-reference','temporary'])await scenario(async h=>{
    h.mode='blocked';await h.run();h.restart();h.mode='success';h.effects.length=0
    const record={source:'HKCU',path:target,registryName:change==='temporary'?'TEMP-session':change==='same-record'||change==='changed-value'?'Face':'Another',value:target}
    if(change==='changed-value'){record.path='C:\\other\\unrelated.ttf';record.value=record.path}
    if(change==='alias-reference'){record.path='C:\\alias\\copy.ttf';record.value=record.path;h.aliases.set(record.path,target)}
    h.records.push(record);assert.equal((await h.run()).ok,false,change);assert.deepEqual(h.effects,[]);assert(h.files.has(target));assert.equal(h.records.length,1);h.sourceUnchanged()
  })
  await scenario(async h=>{h.files.get(target).readonly=true;assert.equal((await h.run()).ok,true);assert.deepEqual(h.effects.map(effect=>effect[0]),['attributes','registry','file']);h.sourceUnchanged()})
  await scenario(async h=>{h.records=[{source:'HKCU',path:source,fileName:'face.ttf',registryName:'Face',value:source}];assert.equal((await h.run()).ok,true);assert.deepEqual(h.effects,[['registry','HKCU','Face']]);h.sourceUnchanged()})
  await scenario(async h=>{h.records.push({...h.records[0],source:'HKLM',registryName:'Face Other'});assert.equal((await h.run()).ok,true);assert.equal(h.effects.filter(effect=>effect[0]==='registry').length,2);assert.equal(h.effects.filter(effect=>effect[0]==='file').length,1);h.sourceUnchanged()})
  for(const protectedPath of [source,target])await scenario(async h=>{h.mode='blocked';await h.run();h.restart();h.protected.add(protectedPath);h.effects.length=0;assert.equal((await h.run()).ok,false);assert.deepEqual(h.effects,[]);h.sourceUnchanged()})
  await scenario(async h=>{h.store();h.db().exec("CREATE TRIGGER deny_receipt BEFORE INSERT ON font_uninstall_receipts BEGIN SELECT RAISE(ABORT,'journal disk failed'); END");const result=await h.run();assert.equal(result.ok,false);assert.equal(result.uninstall.pending,false);assert.deepEqual(h.effects,[]);h.sourceUnchanged()})
  await scenario(async h=>{h.mode='blocked';await h.run();h.db().exec("CREATE TRIGGER deny_progress BEFORE UPDATE ON font_uninstall_receipts BEGIN SELECT RAISE(ABORT,'journal update failed'); END");h.mode='success';h.effects.length=0;assert.equal((await h.run()).ok,false);assert.deepEqual(h.effects,[]);assert(h.store().load(source));h.sourceUnchanged()})
  await scenario(async h=>{h.persistFails=true;assert.equal((await h.run()).ok,false);assert(!h.files.has(target));h.restart();h.effects.length=0;const again=await h.run([h.item,{...h.item,id:'later',path:'C:\\source\\other.ttf'}]);assert.equal(again.results.source.ok,false);assert(again.results.later,'settlement failure aborted later batch members');assert.deepEqual(h.effects,[]);h.persistFails=false;assert.equal((await h.run()).ok,true);assert.deepEqual(h.effects,[]);assert.equal(h.store().load(source),undefined);h.sourceUnchanged()})
  await scenario(async h=>{h.mode='lost-file-ack';assert.equal((await h.run()).ok,false);h.restart();h.mode='success';h.denied.add(source);h.protected.add(source);h.effects.length=0;assert.equal((await h.run()).ok,true,'all-absent read-only settlement unnecessarily required source/protection');assert.deepEqual(h.effects,[]);h.sourceUnchanged()})
  await scenario(async h=>{h.mode='blocked';await h.run();h.files.delete(source);h.restart();h.mode='success';assert.equal((await h.run()).ok,true,'durable receipt did not supply untagged missing-source proof');assert.equal(h.files.has(source),false)})
  await scenario(async h=>{const alias='C:\\junction\\face.ttf';h.aliases.set(alias,source);h.mode='blocked';assert.equal((await h.run({...h.item,path:alias})).ok,false);h.files.delete(source);h.restart();h.mode='success';assert.equal((await h.run({...h.item,path:alias})).ok,true,'missing source alias did not use stored canonical proof');assert.equal(h.files.has(source),false)})
  await scenario(async h=>{h.hook=async stage=>{if(stage==='registry')h.quitAndResume()};const result=await h.run();assert.equal(result.ok,false);assert.equal(result.uninstall.cancelled,true);assert.deepEqual(h.effects,[]);h.hook=null;assert.equal((await h.run()).ok,true);h.sourceUnchanged()})
  await scenario(async h=>{h.records=[];const result=await h.run();assert.equal(result.ok,false);assert.equal(h.store().load(source),undefined);assert.deepEqual(h.effects,[]);assert.deepEqual(h.calls,[]);h.sourceUnchanged()})
  await scenario(async h=>{h.mode='blocked';await h.run();const first=h.store().load(source),stale=plain(first);h.store().save(first);assert.throws(()=>h.store().save(stale),/其他操作更新/);assert.throws(()=>h.store().remove(stale),/清理未确认/);h.sourceUnchanged()})
  await scenario(async h=>{let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);h.hook=async stage=>{if(stage==='registry'){entered();await gate}};const a=h.run();await started;const b=h.run();release();const results=await Promise.all([a,b]);assert.equal(results[0].ok,true);assert.equal(results[1].ok,false);assert.deepEqual(h.effects,[['registry','HKCU','Face'],['file',target]]);h.sourceUnchanged()})
  for(const inaccessible of [source,target])await scenario(async h=>{h.mode='blocked';await h.run();h.restart();h.denied.add(inaccessible);h.effects.length=0;assert.equal((await h.run()).ok,false);assert.deepEqual(h.effects,[]);h.sourceUnchanged()})
  await scenario(async h=>{h.mode='blocked';await h.run();h.files.get(source).id='9007199254740994';h.restart();h.mode='success';h.effects.length=0;assert.equal((await h.run()).ok,false);assert.deepEqual(h.effects,[]);assert(h.files.has(target))})
  await scenario(async h=>{h.store();h.db().exec("CREATE TRIGGER deny_clear BEFORE DELETE ON font_uninstall_receipts BEGIN SELECT RAISE(ABORT,'journal clear failed'); END");assert.equal((await h.run()).ok,false);h.restart();h.effects.length=0;assert.equal((await h.run()).ok,false);assert.deepEqual(h.effects,[]);h.db().exec('DROP TRIGGER deny_clear');assert.equal((await h.run()).ok,true);assert.deepEqual(h.effects,[]);h.sourceUnchanged()})
  await scenario(async h=>{h.hook=async stage=>{if(stage==='after-registry')h.db().exec("CREATE TRIGGER deny_ack BEFORE UPDATE ON font_uninstall_receipts BEGIN SELECT RAISE(ABORT,'ack disk failed'); END")};assert.equal((await h.run()).ok,false);assert.equal(h.store().load(source).steps[0].state,'attempted');assert.equal(h.records.length,0);h.db().exec('DROP TRIGGER deny_ack');h.restart();h.hook=null;h.effects.length=0;assert.equal((await h.run()).ok,true);assert.deepEqual(h.effects,[['file',target]]);h.sourceUnchanged()})
  await scenario(async h=>{h.files.get(target).readonly=true;const before=h.initial().find(entry=>entry.path===target);assert.equal((await h.run({...h.item,path:target})).ok,true);assert.deepEqual(h.effects,[['registry','HKCU','Face']]);assert.deepEqual(h.initial().find(entry=>entry.path===target),before);h.sourceUnchanged()})
  await scenario(async h=>{const results=await h.run([h.item,{...h.item,id:'collection-member'}]);assert.equal(results.results.source.ok,true);assert.equal(results.results['collection-member'].ok,true);assert.equal(h.effects.filter(effect=>effect[0]==='file').length,1);h.sourceUnchanged()})
  await scenario(async h=>{h.records[0].nameCandidates=['Face'];h.claims=[{registryName:'Face',installPath:target}];assert.equal((await h.run()).ok,false,'legacy exact claim was treated as permanent');assert.deepEqual(h.effects,[]);h.sourceUnchanged()})
  await scenario(async h=>{h.claims=[{registryName:'Face',installPath:target}];assert.equal((await h.run({...h.item,path:target})).ok,false,'installed-page selection removed a claimed activation');assert.deepEqual(h.effects,[]);h.sourceUnchanged()})
  for(const gate of ['registry','attributes'])await scenario(async h=>{if(gate==='attributes')h.files.get(target).readonly=true;h.hook=async stage=>{if(stage===gate)h.claims=[{registryName:'Face',installPath:target}]};assert.equal((await h.run()).ok,false,'late legacy activation claim crossed '+gate);assert.deepEqual(h.effects,[]);h.sourceUnchanged()})
  await scenario(async h=>{h.hook=async stage=>{if(stage==='file'){h.claims=[{registryName:'Legacy active',installPath:target}];h.records.push({source:'HKCU',path:target,registryName:'Legacy active',value:target})}};assert.equal((await h.run()).ok,false);assert.deepEqual(h.effects,[['registry','HKCU','Face']]);assert(h.files.has(target));h.sourceUnchanged()})
  for(const when of ['initial','gate'])await scenario(async h=>{if(when==='initial')h.claimsFail=true;else h.hook=async stage=>{if(stage==='registry')h.claimsFail=true};const result=await h.run();assert.equal(result.ok,false);assert.match(result.message,/activation store unavailable/);assert.deepEqual(h.effects,[]);h.sourceUnchanged()})
  await scenario(async h=>{h.claims=[{registryName:'Other',installPath:'C:\\another\\copy.ttf'},{registryName:'Face',installPath:'C:\\another\\face.ttf'}];assert.equal((await h.run()).ok,true,'inexact legacy claim broadened ownership');h.sourceUnchanged()})
  await scenario(async h=>{h.mode='blocked';await h.run();h.restart();h.claims=[{registryName:'Legacy file-pending',installPath:target}];h.mode='success';h.effects.length=0;assert.equal((await h.run()).ok,false,'registry-free activation remnant lost copy ownership');assert.deepEqual(h.effects,[]);assert(h.files.has(target));h.sourceUnchanged()})
  await scenario(async h=>{h.hook=async stage=>{if(stage==='file')h.claims=[{registryName:'Legacy pending intent',installPath:target}]};assert.equal((await h.run()).ok,false,'late pending activation copy crossed file gate');assert.deepEqual(h.effects,[['registry','HKCU','Face']]);assert(h.files.has(target));h.sourceUnchanged()})
  // F14: partial failure must expose the current authoritative comparison,
  // independently of the journal's pending retry ownership.
  await scenario(async h=>{h.mode='blocked';const result=await h.run();assert.equal(result.ok,false);assert.equal(result.installCompare.known,true);assert.equal(result.installCompare.installed,false);assert.equal(h.projectionCalls,1);assert(h.store().load(source));h.sourceUnchanged()})
  await scenario(async h=>{h.mode='blocked';h.projectionResult={known:true,installed:true,by:'user',matches:[{source:'HKCU',path:'C:\\other\\copy.ttf',value:'C:\\other\\copy.ttf',registryName:'another copy'}]};const result=await h.run();assert.equal(result.installCompare.installed,true);assert.equal(result.installCompare.matches[0].registryName,'another copy');assert(h.store().load(source));h.sourceUnchanged()})
  await scenario(async h=>{h.mode='blocked';h.projectionResult={known:false,installed:false,by:'none',matches:[],reason:'candidate-unavailable'};const result=await h.run();assert.equal(result.installCompare.known,false);assert.equal(result.installCompare.reason,'candidate-unavailable');assert(h.store().load(source));h.sourceUnchanged()})
  await scenario(async h=>{h.mode='blocked';h.persistFails=true;const result=await h.run();assert.equal(result.installCompare,undefined);assert.match(result.message,/状态回查未确认/);assert.equal(h.projectionCalls,1);assert(h.store().load(source));h.sourceUnchanged()})
  await scenario(async h=>{h.mode='blocked';h.projectionHook=async()=>h.startClosing();const result=await h.run();assert.equal(result.installCompare,undefined);assert.equal(result.uninstall.cancelled,true);assert.equal(h.projectionCalls,1);assert(h.store().load(source));assert.deepEqual(h.effects,[['registry','HKCU','Face']]);h.sourceUnchanged()})
  console.log(`[F11] ${cases} SQLite reopen/CAS, partial retry, exact 64-bit replacement, ref reuse/alias/temp, cancellation/exit, readonly/source invariants and no-target cases passed`)
}
module.exports={run}
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1})
