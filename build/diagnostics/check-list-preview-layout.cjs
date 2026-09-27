#!/usr/bin/env node
const assert = require('node:assert/strict'), path = require('node:path')
const { loader } = require('./check-operation-chain.cjs')
const { loader: cardLoader, fonts, prefix } = require('./lib/font-view-layout-harness.cjs')
const shared = loader()('src/shared/preview-layout/previewTextFitRuntime.ts')
const { nativePreviewLayoutKey } = loader()('src/shared/preview-layout/nativePreviewLayout.ts')
const { normalizePreviewInput: validate } = loader()('src/main/preview/runtime/previewInputPolicy.ts')
const plain = v => JSON.parse(JSON.stringify(v))
const descriptor = shared.getCardPreviewLayout('list', '  字体 Ag  \nsecond', 44)
const layout = descriptor.nativeLayout
const input = { text: descriptor.text, fontSize: descriptor.fontSize, width: descriptor.width, height: descriptor.height, layout }
function contracts() {
  for (const size of [18,44,72]) for (const text of ['Ag', '字体预览', 'Decorative fj', 'long '.repeat(1000), 'a\nb', '\nb', 'a\n']) {
    const d=shared.getCardPreviewLayout('list',text,size)
    assert.equal(d.fontSize,size); assert.equal(d.width,4096);assert.equal(d.textAlign,'left')
    assert.equal(validate({text:d.text,fontSize:size,width:d.width,height:d.height,layout:d.nativeLayout}).layout.fontSizeCssPx,size)
  }
  assert.equal(validate({...input,layout:undefined}).layout,undefined)
  for (const [field,value] of Object.entries(layout)) {
    assert.throws(()=>validate({...input,layout:{...layout,[field]: typeof value==='string'?'unknown':value+1}}),/PREVIEW_INPUT_INVALID/)
    const missing={...layout};delete missing[field];assert.throws(()=>validate({...input,layout:missing}),/PREVIEW_INPUT_INVALID/)
  }
  for (const bad of [null,[],{},'list-v1',{...layout,extra:1}]) assert.throws(()=>validate({...input,layout:bad}),/PREVIEW_INPUT_INVALID/)
  assert.throws(()=>validate({...input,width:760}),/PREVIEW_INPUT_INVALID/)
  assert.throws(()=>validate({...input,text:'a\nb\nc'}),/PREVIEW_INPUT_INVALID/)
  assert.equal(nativePreviewLayoutKey(layout),nativePreviewLayoutKey(Object.fromEntries(Object.entries(layout).reverse())))
}
async function identities() {
  const load=loader({'../native-renderer/directwrite/directWritePreviewHelperPathRuntime':{hasDirectWritePreviewHelper:()=>false}})
  const cache=load('src/main/preview/runtime/previewCacheKeyRuntime.ts'), sha=s=>s
  const args=[sha,'font',100,200,input.fontSize,input.width,input.height,input.text,'renderer']
  for(const key of ['legacyPreviewCacheKey','strictPreviewCacheKey']) {
    assert.notEqual(cache[key](...args),cache[key](...args,layout),'new pixels reused legacy cache')
    for(const [field,value] of Object.entries(layout)) assert.notEqual(cache[key](...args,layout),cache[key](...args,{...layout,[field]:typeof value==='string'?value+'x':value+1}),field+' missing from disk identity')
  }
  const params=[input.text,input.fontSize,input.width,input.height],font=fonts[0]
  for(const [file,factory,method] of [['previewImageMemoryRuntime','createPreviewImageMemoryRuntime','requestKey'],['cachedPreviewImageDataUriCacheRuntime','createCachedPreviewImageDataUriCacheRuntime','keyForItem']]) {
    const m=load('src/main/preview/runtime/'+file+'.ts')[factory]()
    assert.notEqual(m[method](font,...params),m[method](font,...params,layout))
  }
  const c=load('src/main/preview/runtime/cachedPreviewReadCoalescerRuntime.ts').createCachedPreviewReadCoalescerRuntime()
  let calls=0,done;const gate=new Promise(r=>done=r), task=()=>{calls++;return gate}
  const pending=[c.readSingle(font,...params,task),c.readSingle(font,...params,task,layout),c.readSingle(font,...params,task,layout)]
  assert.equal(calls,2);done('png');await Promise.all(pending)
  calls=0; const batch=async()=>{calls++;return {[font.id]:'png'}}
  await Promise.all([c.readBatch([font],...params,batch),c.readBatch([font],...params,batch,layout),c.readBatch([font],...params,batch,layout)])
  assert.equal(calls,2)
  const requests=[]
  const scheduler=load('src/main/preview/runtime/previewRequestSchedulerRuntime.ts').createPreviewRequestSchedulerRuntime({readCachedPreviewImages:async(...args)=>{requests.push(args);return {[font.id]:'png'}}})
  await Promise.all([scheduler.readCachedPreviewImages([font],...params),scheduler.readCachedPreviewImages([font],...params,undefined,layout)])
  assert.equal(requests.length,2);assert.deepEqual(plain(requests.find(r=>r[5])?.[5]),plain(layout));scheduler.cancelPending()
}
function interactions() {
  const load=cardLoader(), View=load(prefix+'components/ListPreviewViewport.tsx').ListPreviewViewport
  const tree=View({layout,children:null}),scroll=tree.props.children[1]
  assert.equal(scroll.props.role,'region');assert.equal(scroll.props.tabIndex,0)
  const node={scrollLeft:0,scrollWidth:4096};let stopped=0,prevented=0
  const event=key=>({key,currentTarget:node,stopPropagation(){stopped++},preventDefault(){prevented++}})
  scroll.props.onKeyDown(event('ArrowRight'));assert.equal(node.scrollLeft,80)
  scroll.props.onKeyDown(event('End'));assert.equal(node.scrollLeft,4096)
  scroll.props.onKeyDown(event('Home'));assert.equal(node.scrollLeft,0)
  for(const key of [' ','Enter'])scroll.props.onKeyDown(event(key))
  for(const name of ['onMouseDown','onPointerDown','onClick','onDoubleClick','onDragStart'])scroll.props[name](event())
  assert.equal(stopped,10);assert.equal(prevented,6)
  const React=require('react'),html=require('react-dom/server').renderToStaticMarkup(React.createElement(load(prefix+'components/FontCard.tsx').FontCard,{font:fonts[0],compact:true,previewText:'x',onVisible(){},onSelect(){}}))
  assert(!html.includes('<button'),'scroll surface nested in button');assert(html.includes('role="group"'));assert(html.includes('超出预览边界'))
}
async function capabilityGate() {
  const calls=[], status={available:true,path:'worker',capabilities:['preview-render-image']}
  const load=loader({
    '../rustSharedIoCommandRuntime':{sharedDatabaseTarget(){}},'../../path/sharedIoProcessRuntime':{rethrowSharedIoProcessError(){}},
    '../../logging/previewCacheMutationTrace':{tracePreviewCacheMutation(){}},
    '../rustCoreWorkerTransportRuntime':{parseJsonLine:JSON.parse,hasCapability:(s,c)=>s.capabilities.includes(c)},
    '../rustCoreDaemonWriteBoundaryRuntime':{rethrowRustCoreDaemonSubmittedJob(){},markRustCoreDaemonSubmittedError:e=>e},
  })
  const client=load('src/main/rust-core/clients/rustPreviewClientRuntime.ts').createRustPreviewClientRuntime({
    diagnoseRustCoreWorker:async()=>status,appendStartupLog(){},appendPreviewCacheFailureLog(){},
    createTemporaryJsonFile:()=>({path:'input',writeJson:async v=>calls.push(v),dispose:async()=>{}}),
    runRustCoreScheduledCommand:async()=>({stdout:JSON.stringify({ok:true,outputPath:'out',layoutVersion:'list-v1'})})
  })
  const request={...input,fontPath:'font',outputPath:'out'}
  assert.equal(await client.runRustPreviewRenderImage(request),null);assert.equal(calls.length,0,'old worker invoked new layout')
  status.capabilities.push('preview-layout-list-v1');assert.equal((await client.runRustPreviewRenderImage(request)).ok,true)
  assert.deepEqual(plain(calls[0].layout),plain(layout))
  const helper=loader({'./directWritePreviewHelperPathRuntime':{findDirectWritePreviewHelperPath:()=> 'helper'}})('src/main/preview/native-renderer/directwrite/directWritePreviewRequestRuntime.ts')
  assert.equal((await helper.renderWithDirectWritePreviewHelper(request,'input',async()=>({stdout:'{"ok":true}'}))).ok,false)
  assert.equal((await helper.renderWithDirectWritePreviewHelper(request,'input',async()=>({stdout:'{"ok":true,"layoutVersion":"list-v1"}'}))).ok,true)
}
async function main(){contracts();await identities();interactions();await capabilityGate();console.log('[list-preview-layout] pixel contract, invalid inputs, all cache identities, coalescing, event isolation and old backend gates passed')}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1})
