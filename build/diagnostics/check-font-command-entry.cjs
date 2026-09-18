#!/usr/bin/env node
// U-02: production TSX + commands + state/actions + preload; native/DOM ports are controlled.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {harness,treeNodes,button,plain,noop,tick,renderer,root}=require('./check-activation-entry.cjs')
function setup(config={}) {
  const h=harness(config), calls=[], confirmations=[], favorites=[], tags=[], edited=[]
  let confirm=true, refreshes=0
  h.window.confirm=text=>{confirmations.push(text);return confirm}
  const options=()=>({hfm:h.window.hfm,library:h.library,getCurrentLibrary:()=>h.library,setLibrary:h.setLibrary,setStatus:x=>h.status.push(x),setContextMenu:noop,activeOperationFontIds:{current:h.busy},refreshDatabaseDerivedState:()=>refreshes++,setSelectedFontIds:h.select().setSelectedFontIds,getCurrentSelectedFontId:()=>'',setSelectedFontId:noop,setDetailVisible:noop,setDatabaseFontMetrics:noop,queueFavoriteWrites:async(fonts,v)=>{for(const f of fonts){favorites.push([f.id,v]);h.load(renderer+'fontUserIntentRuntime.ts').settleFavoriteIntent(f)}},scheduleDatabaseDerivedStateRefresh:()=>refreshes++})
  const state=h.load(renderer+'runtime/system/actions/fontSystemStateRuntime.ts').createFontSystemStateRuntime(options())
  const install=h.load(renderer+'runtime/system/actions/fontInstallActionRuntime.ts').createFontInstallActionRuntime(options(),state,h.actions())
  const deletion=h.load(renderer+'runtime/system/actions/fontDeleteActionRuntime.ts').createFontDeleteActionRuntime(options())
  const favorite=h.load(renderer+'runtime/system/actions/fontFavoriteActionRuntime.ts').createFontFavoriteActionRuntime(options(),state)
  const protect=async(ids,value)=>{calls.push(['protect',plain(ids),value])}
  h.setCommandActions({...install,...deletion,...favorite,toggleFontDeleteProtection:protect,editFontTags:(fonts,scope)=>edited.push([fonts.map(f=>f.id),scope])})
  for(const name of ['installSystem','uninstallSystem'])h.handlers.set('fonts:'+name,(_,f)=>{calls.push([name,f.id]);return {ok:true,message:'native'}})
  h.handlers.set('fonts:compareInstalled',()=>({installed:true,by:'system',matches:[]}))
  h.handlers.set('fonts:deleteFiles',(_,fonts)=>{calls.push(['delete',fonts.map(f=>f.id)]);return {ok:true,deletedIds:fonts.map(f=>f.id),skippedInstalled:0,skippedProtected:0,skippedUnsafe:0,failed:[],message:'deleted'}})
  function overlay(id='a') {h.context().openFontMenu(h.event(),h.all.find(f=>f.id===id));const c=h.context();return h.load(renderer+'components/app/AppOverlays.tsx').AppOverlays({contextMenu:h.menu,contextSelectedFonts:c.contextFontTargets(),contextTargetCount:c.contextTargetCount,runFontContextAction:c.runFontContextAction,selectionLabel:c.selectionLabel})}
  function tagRuntime() {return h.load(renderer+'fontDialogTagActionsRuntime.ts').createFontDialogTagActions({library:h.library,selectedFont:h.all[0],selectedFontIds:h.select().selectedFontIds,getVisibleFonts:()=>h.all,commitLibraryUpdate:update=>{h.setLibrary(update);return h.library},setLibrary:h.setLibrary,setStatus:x=>h.status.push(x),setAssignTagName:noop,setAssignSharedTagName:noop,queueLocalTagsWrite:(f,t)=>tags.push(['local',f.id,plain(t)]),queueSharedTagsWrite:(f,t)=>tags.push(['shared',f.id,plain(t),f.__sharedTagWriteMode,f.__sharedTagWriteTag])},()=>refreshes++)}
  function detail() {const t=tagRuntime(),runtime=h.load(renderer+'fontDetailPanelRuntime.ts').createFontDetailPanelRuntime({selectedFont:h.all[0],previewFamilies:{},assignTagName:'new',assignSharedTagName:'new-shared',localTagSuggestions:[],sharedTagSuggestions:[],setAssignTagName:noop,setAssignSharedTagName:noop,...t});return h.load(renderer+'components/app/FontDetailPanel.tsx').FontDetailPanel({visible:true,selectedFont:h.all[0],selectedFontIds:h.select().selectedFontIds,library:h.library,visibleFonts:h.all,runFontCommand:h.command(),assignTagName:'new',assignSharedTagName:'new-shared',localTagSuggestions:[],sharedTagSuggestions:[],...t,...runtime})}
  return {...h,base:h,calls,confirmations,favorites,tags,edited,overlay,detail,tagRuntime,setConfirm:v=>{confirm=v},get refreshes(){return refreshes}}
}
const labels=tree=>treeNodes(tree).filter(n=>n.type==='button').map(n=>n.props.children).filter(x=>typeof x==='string')
async function run(){let cases=0
  for(const preload of [false,true])for(const entry of ['context','detail'])for(const count of [1,3]){
    const s=setup({runtimePreload:preload,cache:[]}),h=s.base;h.select().setSelectedFontIds(h.all.slice(0,count).map(f=>f.id))
    const tree=entry==='context'?s.overlay():s.detail(), names=labels(tree)
    for(const label of ['安装','删除字体文件','激活','加入保护','收藏'])assert.equal(names.filter(x=>x===label).length,1,label)
    assert(!names.some(x=>x.startsWith('批量')))
    for(const label of ['卸载字体','取消激活','取消保护','取消收藏'])assert(!names.includes(label))
    assert.equal(!!button(tree,'收藏').props.disabled,false)
    button(tree,'安装').props.onClick();await tick();assert.deepEqual(s.calls,h.all.slice(0,count).map(f=>['installSystem',f.id]));assert.match(h.status.at(-1),new RegExp('成功 '+count+' 个'));assert.equal(h.busy.size,0);cases++
  }
  for(const entry of ['context','detail']){
    const s=setup(),h=s.base;h.select().setSelectedFontIds(['a','b','c']);h.library.fonts.a.systemInstalled=true;h.library.fonts.b.systemInstalled=true;h.library.fonts.b.deleteProtected=true
    const tree=entry==='context'?s.overlay():s.detail();assert(labels(tree).includes('安装'));await h.command()('remove');await tick()
    assert.deepEqual(s.calls,[['uninstallSystem','a']]);assert.equal(s.confirmations.length,1);assert.match(s.confirmations[0],/所选 3 个/);assert.match(h.status.at(-1),/保护 1 个，未安装 1 个/);assert.equal(h.library.fonts.a.systemInstalled,false);assert.equal(h.library.fonts.b.systemInstalled,true);cases++
  }
  for(const entry of ['context','detail'])for(const count of [1,3])for(const enabled of [false,true]) {
    const s=setup(),h=s.base;h.select().setSelectedFontIds(h.all.slice(0,count).map(f=>f.id))
    for(const f of Object.values(h.library.fonts))Object.assign(f,{active:enabled,favorite:enabled,deleteProtected:enabled,systemInstalled:enabled})
    const tree=entry==='context'?s.overlay():s.detail(),names=labels(tree)
    for(const [yes,no] of [['卸载字体','安装'],['取消激活','激活'],['取消保护','加入保护'],['取消收藏','收藏']]){assert(names.includes(enabled?yes:no));assert(!names.includes(enabled?no:yes))}
    assert.equal(names.filter(n=>['卸载字体','安装','取消激活','激活','取消保护','加入保护','取消收藏','收藏','删除字体文件'].includes(n)).length,5)
    cases++
  }
  {
    const s=setup(),h=s.base;h.select().setSelectedFontIds(['a','b','c']);Object.assign(h.library.fonts.a,{active:true,favorite:true,deleteProtected:true,systemInstalled:true});
    for(const tree of [s.overlay(),s.detail()])for(const label of ['安装','激活','加入保护','收藏'])assert(button(tree,label))
    cases++
  }
  {
    const s=setup(),h=s.base;h.select().setSelectedFontIds(['a','b','c']);h.library.fonts.a.active=true;h.library.fonts.b.systemInstalled=true;h.library.fonts.c.path='C:/Windows/Fonts/c.ttf';
    for(const tree of [s.overlay(),s.detail()]){assert(button(tree,'取消激活'));assert(!labels(tree).includes('激活'))}
    h.handlers.set('fonts:deactivateFonts',(_,fonts)=>{h.requests.push(fonts.map(f=>f.id));return {ok:true,results:{a:{ok:true}},message:'deactivated'}})
    button(s.detail(),'取消激活').props.onClick();await tick();assert.deepEqual(plain(h.requests),[['a']]);assert(h.library.fonts.b.systemInstalled);cases++
  }
  {
    const file=renderer+'components/app/FontCommandButtons.tsx',source=require('node:child_process').execFileSync('git',['show','0ea2635:'+file],{cwd:root,encoding:'utf8'}),s=setup({transforms:{[path.join(root,file)]:()=>source}});s.select().setSelectedFontIds(['a']);
    const names=labels(s.detail());assert(names.includes('激活')&&names.includes('取消激活'));assert.throws(()=>assert.equal(names.filter(n=>['安装','卸载字体','激活','取消激活','加入保护','取消保护','收藏','取消收藏','删除字体文件'].includes(n)).length,5),assert.AssertionError);cases++
  }
  const outside=setup();outside.select().setSelectedFontIds(['a','b']);button(outside.overlay('c'),'安装').props.onClick();await tick();assert.deepEqual(outside.calls,[['installSystem','c']]);assert.deepEqual(plain(outside.select().selectedFontIds),['c']);cases++
  for(const label of ['卸载字体','删除字体文件']){const s=setup(),h=s.base;h.select().setSelectedFontIds(['a','b']);h.library.fonts.a.systemInstalled=true;s.setConfirm(false);await h.command()(label==='卸载字体'?'remove':'deleteFile');await tick();assert.equal(s.calls.length,0);assert.match(h.status.at(-1),/已取消/);cases++}
  const deletion=setup();deletion.select().setSelectedFontIds(['a','b']);button(deletion.overlay(),'删除字体文件').props.onClick();await tick();assert.deepEqual(plain(deletion.calls),[['delete',['a','b']]]);assert.match(deletion.confirmations[0],/回收站/);assert.deepEqual(plain(deletion.select().selectedFontIds),[]);cases++
  const busyDelete=setup(),bd=busyDelete.base;bd.select().setSelectedFontIds(['a','b']);bd.busy.add('a');button(bd.detail(),'删除字体文件').props.onClick();await tick();assert.deepEqual(plain(busyDelete.calls),[['delete',['b']]]);assert(bd.busy.has('a'));assert(!bd.busy.has('b'));assert(bd.library.fonts.a);assert.match(bd.status.at(-1),/跳过处理中 1 个/);cases++
  const pendingDelete=setup(),pd=pendingDelete.base;let finishDelete;pd.select().setSelectedFontIds(['a']);pd.handlers.set('fonts:deleteFiles',()=>new Promise(r=>{finishDelete=()=>r({deletedIds:[],skippedUnsafe:0,failed:[{id:'a'}],message:'failed'})}));button(pd.detail(),'删除字体文件').props.onClick();await tick();await pd.command()('install');assert.equal(pendingDelete.calls.length,0);finishDelete();await tick();assert.equal(pd.busy.size,0);assert(pd.library.fonts.a);assert.match(pd.status.at(-1),/失败 1 个/);cases++
  const stopped=setup();stopped.select().setSelectedFontIds(['a']);stopped.base.library.fonts.a.active=true;await stopped.command()('remove');await tick();assert.equal(stopped.calls.length,0);assert.equal(stopped.requests.length,0);assert.match(stopped.status.at(-1),/没有可卸载/);cases++
  const partial=setup(),p=partial.base;p.select().setSelectedFontIds(['a','b','c']);p.handlers.set('fonts:installSystem',(_,f)=>{partial.calls.push(['installSystem',f.id]);return {ok:f.id!=='b'}});button(p.detail(),'安装').props.onClick();await tick();assert.match(p.status.at(-1),/成功 2 个，失败或未确认 1 个/);assert.equal(p.library.fonts.b.systemInstalled,false);assert.equal(p.busy.size,0);cases++
  const inflight=setup(),i=inflight.base;let release;i.select().setSelectedFontIds(['a','b']);i.handlers.set('fonts:installSystem',(_,f)=>{inflight.calls.push(['installSystem',f.id]);return f.id==='a'?new Promise(r=>{release=()=>r({ok:true})}):{ok:true}});button(i.detail(),'安装').props.onClick();await tick();i.select().setSelectedFontIds(['c']);await i.command()('install',['a','b']);assert.equal(inflight.calls.length,1);release();await tick();assert.deepEqual(inflight.calls,[['installSystem','a'],['installSystem','b']]);assert.equal(i.library.fonts.c.systemInstalled,false);assert.equal(i.busy.size,0);cases++
  for(const entry of ['context','detail']){const s=setup({cache:['a']}),h=s.base;h.select().setSelectedFontIds(['a','absent']);const tree=entry==='context'?s.overlay():s.detail();button(tree,'安装').props.onClick();await tick();assert.equal(s.calls.length,0);assert.match(h.status.at(-1),/本次操作未执行/);cases++}
  const favorite=setup({cache:[]}),f=favorite.base;f.select().setSelectedFontIds(['a']);button(favorite.overlay(),'收藏').props.onClick();await tick();assert.equal(f.library.fonts.a.favorite,true);await f.command()('favorite');assert.equal(favorite.favorites.length,1);await f.command()('unfavorite');assert.equal(f.library.fonts.a.favorite,false);f.select().setSelectedFontIds(['a','b']);await f.command()('favorite');assert.equal(favorite.favorites.length,4);assert.match(f.status.at(-1),/成功 2 个/);cases++
  const protection=setup();protection.select().setSelectedFontIds(['a','b']);button(protection.overlay(),'加入保护').props.onClick();await tick();assert.deepEqual(protection.calls,[['protect',['a','b'],true]]);cases++
  for(const keyboard of [false,true])for(const shared of [false,true]){const s=setup(),h=s.base;h.select().setSelectedFontIds(['a','b']);h.library.fonts.a.localTagNames=['a'];h.library.fonts.b.localTagNames=['b'];h.library.fonts.a.tagNames=['sa'];h.library.fonts.b.tagNames=['sb'];const tree=s.detail();if(keyboard){const input=treeNodes(tree).find(n=>n.props?.id===(shared?'font-shared-tag-input':'font-local-tag-input'));input.props.onKeyDown({key:'Enter',nativeEvent:{isComposing:true},preventDefault:noop});assert.equal(s.tags.length,0);input.props.onKeyDown({key:'Enter',nativeEvent:{},preventDefault:noop})}else button(tree,shared?'添加共享标签':'添加标签').props.onClick();const key=shared?'tagNames':'localTagNames',tag=shared?'new-shared':'new';assert.deepEqual(plain(h.library.fonts.a[key]),[shared?'sa':'a',tag].sort());assert.deepEqual(plain(h.library.fonts.b[key]),[shared?'sb':'b',tag].sort());assert.equal(s.tags.length,2);s.tagRuntime()[shared?'removeSharedTagFromSelected':'removeTagFromSelected'](tag);assert.deepEqual(plain(h.library.fonts.a[key]),[shared?'sa':'a']);assert.deepEqual(plain(h.library.fonts.b[key]),[shared?'sb':'b']);assert.deepEqual(plain(h.library.fonts.b[shared?'localTagNames':'tagNames']),[shared?'b':'sb']);cases++}
  const missingTag=setup();missingTag.select().setSelectedFontIds(['a','missing']);missingTag.tagRuntime().addTagToSelectedByName('new');assert.equal(missingTag.tags.length,0);assert.match(missingTag.status.at(-1),/本次操作未执行/);cases++
  const edit=setup();edit.select().setSelectedFontIds(['a','b']);button(edit.overlay(),'设置共享标签').props.onClick();await tick();assert.deepEqual(plain(edit.edited),[[['a','b'],'shared']]);cases++
  // Mutate the actual common dispatcher to use only the first item; the UI regression must fail.
  const file=path.join(root,renderer+'fontCommandRuntime.ts'),broken=setup({transforms:{[file]:s=>s.replace('options.installFontsBatch(fonts, label)','options.installFontsBatch(fonts.slice(0, 1), label)')}});broken.select().setSelectedFontIds(['a','b']);button(broken.base.detail(),'安装').props.onClick();await tick();assert.throws(()=>assert.equal(broken.calls.length,2),assert.AssertionError);cases++
  console.log(`[diagnostics:font-command-entry] ${cases} controlled cases: shared TSX context/detail, two preloads, complete targets, one confirmation, mixed state/busy/partial failure, local-only collection favorite, tag mouse/Enter/IME/delta isolation; first-item mutation rejected. Native Windows and browser focus/layout remain unverified.`)
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1})

module.exports={setup}
