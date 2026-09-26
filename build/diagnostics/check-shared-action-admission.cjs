#!/usr/bin/env node
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs')
const {loadModules,treeNodes,button,font,plain,noop,tick,renderer,root} = require('./check-activation-entry.cjs')
const empty = { roots: [], tags: ['shared'], unattributedTags: [] }
const rootRow = (path,state,tags=[]) => ({path,rootId:path,state,tags,generation:1})
async function run() {
  let snapshot = {roots:[rootRow('//nas/a','online',['a','both']),rootRow('//nas/b','offline',['b','both'])],tags:['a','b','both','legacy'],unattributedTags:['legacy']}
  const audit=[],calls=[],handlers=new Map(), window={}, effects=[], timers=new Map();let timeId=0
  const react={createContext:value=>({value,Provider:({children})=>children}),useContext:()=>snapshot,useRef:current=>({current}),useState:value=>[value,v=>calls.push(['state',v])],useEffect:fn=>effects.push(fn)}
  const event={sender:{id:1,getURL:()=> 'http://localhost:39217/'}}
  const electron={app:{isPackaged:false,getAppPath:()=>root},ipcMain:{handle:(key,fn)=>{assert(!handlers.has(key));handlers.set(key,fn)}},ipcRenderer:{invoke:(key,...args)=>handlers.get(key)(event,...args),on:noop,removeListener:noop},contextBridge:{exposeInMainWorld:(_,value)=>window.hfm=value},shell:{showItemInFolder:()=>calls.push(['shell'])}}
  const globals={window,URL,URLSearchParams,__dirname:root,setTimeout:(fn)=>{const id=++timeId;timers.set(id,fn);return id},clearTimeout:id=>timers.delete(id)}
  const transforms = new Proxy({}, {get:(_,file)=>source=>{
    if(process.argv.includes('--mutant') && String(file).replace(/\\/g,'/').endsWith('/ipcHandlers.ts')) {
      assert(source.includes('await admit(channel, args);'),'admission mutation anchor missing')
      source=source.replace('await admit(channel, args);','/* deliberately bypass admission */')
    }
    return process.argv.includes('--crlf') ? source.replace(/\n/g,'\r\n') : source
  }})
  const load=loadModules(globals,{react,electron},transforms)
  const policy=load('src/shared/sharedAvailability.ts')
  assert(!policy.isSharedAvailability({roots:[{}]}));assert(policy.isSharedAvailability(snapshot))
  const runtime=new Proxy({getSharedAvailability:async()=>snapshot,appendLog:value=>audit.push(value),assertFeatureForChannel:noop,reportPerformanceEvent:noop},{get:(target,key)=>target[key] || ((...args)=>{calls.push([key,args]);return true})})
  load('src/main/ipc/ipcHandlers.ts').registerIpcHandlers(runtime)
  const invoke=(name,...args)=>handlers.get(name)(event,...args)
  const a={...font('a'),path:'//nas/a/a.ttf'}, b={...font('b'),path:'//nas/b/b.ttf'}, local=font('local')
  let cases=0
  for (const [channel,args] of [
    ['fonts:activateFonts',[[a,b]]],['fonts:installSystem',[b]],['fonts:deleteFiles',[[a,b],['//nas/a']]],
    ['fonts:moveFilesToFolder',[[a,b],'//nas/a']],['fonts:moveFilesToFolder',[[a],'//nas/b']],
    ['fonts:setSharedTags',[[a,b],['//nas/a'],['x']]],['fonts:setSharedTagsBatch',[[{item:b,tagNames:['x']}],[]]],
    ['fonts:renameSharedTag',['b','x',[]]],['fonts:deleteSharedTag',['b',[]]],
    ['folders:createPhysical',['//nas/b','new']],['folders:renamePhysical',['//nas/b/old','new']],
    ['folders:refreshWatched',['//nas/b']],['fonts:scanFolders',[['//nas/a','//nas/b']]],
    ['fonts:queryPage',[{selectedFolderId:'//nas/b/sub'}]],['fonts:query',[{activeFilter:{kind:'sharedTag',name:'both'}}]],
    ['library:save',[{tags:['new']}]],['shell:showItemInFolder',['//nas/b/f.ttf']],
    ['fonts:activateFont',[{...b,path:'//nas/a/../b/b.ttf'}]],['fonts:activateFont',[{...b,path:'//other/share/font.ttf'}]],
  ]) { const before=calls.length;await assert.rejects(invoke(channel,...args),/共享位置/);assert.equal(calls.length,before);cases++ }
  for (const [channel,args] of [['fonts:setLocalTags',[b,['local']]],['fonts:setFavorite',[[b],[],true]],['fonts:setDeleteProtection',[[b],[],true]],['fonts:deactivateFonts',[[a,b]]],['fonts:activateFont',[a]],['fonts:activateFont',[local]],['library:save',[{tags:snapshot.tags,localTags:['new']}]]]) {
    const before=calls.length; await invoke(channel,...args);assert.equal(calls.length,before+1);cases++
  }
  const temp=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'hfm-o03-new-root-'))
  try {const before=calls.length;await invoke('fonts:loadFolderCache',[temp]);assert.equal(calls.length,before+1);assert.equal(snapshot.roots.length,2);cases++}
  finally {fs.rmSync(temp,{recursive:true,force:true})}
  const before=calls.length
  await assert.rejects(handlers.get('fonts:deactivateFonts')({sender:{id:9,getURL:()=> 'https://untrusted.invalid'}},[b]),/untrusted/)
  assert.equal(calls.length,before)
  assert(audit.some(value=>value.includes('untrusted')));cases++
  const tagged=load(renderer+'components/app/AppSidebarTagPage.tsx')
  const props={shared:true,title:'共享标签',inputValue:'new',setInputValue:noop,createFromInput:()=>calls.push(['create']),tagList:snapshot.tags,selectedTagName:'b',setSelectedTagName:()=>calls.push(['select']),openTagMenu:()=>calls.push(['menu']),tagCounts:{b:9},emptyText:'empty',inputPlaceholder:'tag',navTitle:'nav'}
  const tree=tagged.AppSidebarTagPage(props),nodes=treeNodes(tree),tagNodes=nodes.filter(n=>n.props?.className?.includes('tag-nav'))
  assert.equal(tagNodes.length,4);assert.equal(tagNodes[0].props.disabled,false)
  for(const n of tagNodes.slice(1)){assert.equal(n.props.disabled,true);assert.equal(n.props['aria-disabled'],true);const count=calls.length;n.props.onClick();n.props.onContextMenu({preventDefault:noop});assert.equal(calls.length,count)}
  assert(tagNodes[1].props.className.includes('active'));assert.equal(tagNodes[1].props.children[2].props.children,9)
  assert.equal(button(tagged.AppSidebarTagPage({...props,shared:false}),'添加').props.disabled,false);cases++

  const folders=load(renderer+'components/app/AppSidebarFoldersPage.tsx')
  const library={folders:['//nas/a','//nas/b'],folderNodes:[],folderAliases:{},fonts:{},tags:[],collections:[]}
  const folderProps={library,categoryCounts:{all:3},selectedFolderId:'//nas/b',expandedFolderIds:{'//nas/b':true},flatFolderNodes:[{id:'//nas/b/child',rootPath:'//nas/b',name:'child',depth:1,hasChildren:true,expanded:true}],folderCounts:{'//nas/b':2},dropHoverFolderId:'',addFolder:noop,setDatabasePageResult:noop,setDatabaseQueryResult:noop,setSelectedFolderId:noop,setDropHoverFolderId:noop,selectFolderFilter:()=>calls.push(['folder-select']),openFolderMenu:()=>calls.push(['folder-menu']),fontIdsFromDropEvent:()=>['a'],assignFontsToFolder:()=>calls.push(['move']),toggleFolderExpanded:()=>calls.push(['expand'])}
  const folderTree=folders.AppSidebarFoldersPage(folderProps)
  for(const node of treeNodes(folderTree).filter(n=>n.type==='button' && n.props.disabled)) {
    assert.equal(node.props['aria-disabled'],true)
    const count=calls.length;node.props.onClick();node.props.onContextMenu({preventDefault:noop});node.props.onDrop({preventDefault:noop});node.props.children[0].props.onClick({preventDefault:noop,stopPropagation:noop});assert.equal(calls.length,count)
  }
  assert.equal(treeNodes(folderTree).filter(n=>n.type==='button' && n.props.disabled).length,2)
  assert.equal(library.folders.length,2);assert.equal(folderProps.selectedFolderId,'//nas/b');assert(folderProps.expandedFolderIds['//nas/b']);cases++
  const overlays=load(renderer+'components/app/AppOverlays.tsx')
  const overlayProps={contextMenu:{kind:'tag',scope:'shared',name:'b',x:0,y:0},runContextBatchActivate:()=>calls.push(['tag-activate']),runContextBatchDeactivate:noop,runContextRename:()=>calls.push(['rename']),runContextDelete:()=>calls.push(['delete']),setLeaseLockConflictNotice:noop}
  const overlay=overlays.AppOverlays(overlayProps)
  for(const name of ['激活','重命名','删除']) {const btn=button(overlay,name),count=calls.length;assert.equal(btn.props.disabled,true);btn.props.onClick();assert.equal(calls.length,count)}
  assert(!button(overlay,'取消激活').props.disabled);cases++
  const commands=load(renderer+'components/app/FontCommandButtons.tsx')
  const commandTree=commands.FontCommandButtons({fonts:[a,b],count:2,onCommand:()=>calls.push(['command'])})
  for(const name of ['安装','激活','删除字体文件','设置共享标签']){const btn=button(commandTree,name);assert.equal(btn.props.disabled,true);const count=calls.length;btn.props.onClick();assert.equal(calls.length,count)}
  for(const name of ['收藏','加入保护','设置本地标签'])assert.equal(button(commandTree,name).props.disabled,false)
  assert.equal(button(commands.FontCommandButtons({fonts:[{...b,active:true}],count:1,onCommand:noop}),'取消激活').props.disabled,false);cases++
  // Online UI dispatch through both actual preload routes into the actual guarded IPC registration.
  for(const runtimePreload of [false,true]) {
    if(runtimePreload){const src=load('src/main/preload/runtimePreloadSource.ts').runtimePreloadSource;require('node:vm').runInNewContext(src,{require:id=>{assert.equal(id,'electron');return electron},console,process,Buffer,URL,window})}
    else load('src/preload/index.ts')
    assert.equal((await window.hfm.getSharedAvailability()).roots.length,2)
    snapshot={...snapshot,roots:snapshot.roots.map(r=>({...r,state:'online',generation:r.generation+1}))}
    let dispatched
    const current=commands.FontCommandButtons({fonts:[a,b],count:2,onCommand:()=>{dispatched=window.hfm.activateFonts([a,b])}})
    assert.equal(button(current,'激活').props.disabled,false)
    snapshot={...snapshot,roots:snapshot.roots.map(r=>r.path.endsWith('/b')?{...r,state:'offline'}:r)}
    const count=calls.length;button(current,'激活').props.onClick();await assert.rejects(dispatched,/共享位置/);assert.equal(calls.length,count);cases++
  }
  assert(policy.sharedTagBlocked(snapshot,'legacy'));assert(!policy.sharedTagBlocked(snapshot,'a'))
  snapshot={...snapshot,roots:snapshot.roots.map(r=>({...r,state:'online'}))}
  assert.equal(button(tagged.AppSidebarTagPage(props),'添加').props.disabled,false);cases++
  snapshot=null
  assert.equal(button(commands.FontCommandButtons({fonts:[a],count:1,onCommand:noop}),'激活').props.disabled,true)
  assert.equal(button(commands.FontCommandButtons({fonts:[a],count:1,onCommand:noop}),'收藏').props.disabled,false)
  await assert.rejects(load('src/main/ipc/sharedActionAdmissionRuntime.ts').createSharedActionAdmission(undefined)('fonts:activateFont',[a]),/共享位置/);cases++
  // Poll cleanup: no replacement IPC while one is hung; deadline greys controls; late completion ignored.
  let resolve,reads=0;window.hfm={getSharedAvailability:()=>{reads++;return new Promise(r=>{resolve=r})}}
  const provider=load(renderer+'sharedAvailabilityRuntime.tsx');provider.SharedAvailabilityProvider({children:null});const firstCleanup=effects.at(-1)();firstCleanup();const cleanup=effects.at(-1)();assert.equal(timers.size,1)
  await tick();assert.equal(reads,1);const [deadlineId,deadline]=[...timers.entries()][0];timers.delete(deadlineId);deadline();assert.equal(calls.at(-1)[0],'state');assert.equal(calls.at(-1)[1],null)
  const count=calls.length;resolve(empty);await tick();assert.equal(calls.length,count);assert.equal(timers.size,1);cleanup();assert.equal(timers.size,0);cases++
  const unmount=effects.at(-1)();await tick();unmount();resolve(empty);await tick();assert.equal(calls.length,count);assert.equal(timers.size,0);cases++
  assert(fs.readFileSync(path.join(root,renderer+'runtime/database/useRendererDatabasePageRuntime.ts'),'utf8').includes('String(error).includes(SHARED_UNAVAILABLE_MESSAGE)'))
  if (!process.argv.includes('--mutant') && !process.argv.includes('--crlf')) {
    const spawn = require('node:child_process').spawnSync
    const crlf = spawn(process.execPath,[__filename,'--crlf'],{encoding:'utf8',timeout:30000})
    assert.equal(crlf.status,0,crlf.stdout+crlf.stderr)
    const mutant = spawn(process.execPath,[__filename,'--mutant'],{encoding:'utf8',timeout:30000})
    assert.equal(mutant.status,1,mutant.stdout+mutant.stderr)
    assert.match(mutant.stderr,/Missing expected rejection/)
    cases+=2
  }
  console.log(`[diagnostics:shared-action-admission] ${cases} groups: actual TSX and trusted IPC, zero mutation on mixed/offline roots, two preloads, late-menu rejection, local controls/deactivation retained, tag provenance/recovery and polling cleanup. Windows/NAS/O-02 isolation remain pending.`)
}
run().catch(error=>{console.error(error);process.exitCode=1})
