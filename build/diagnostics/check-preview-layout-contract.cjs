#!/usr/bin/env node
const assert = require('node:assert/strict'), path = require('node:path')
const { loader } = require('./check-operation-chain.cjs')
const { rendererHarness, deferred, flush } = require('./check-preview-work-lifetime.cjs')
const { loader: cardLoader, fonts, prefix } = require('./lib/font-view-layout-harness.cjs')
const file = 'src/shared/preview-layout/previewTextFitRuntime.ts'
const shared = loader()(file), { getCardPreviewLayout: layout, getCardPreviewSample: sample } = shared
const cases = ['字体预览', 'Latin Aa 123', '安盛aaaa', '  A  B  \r\n中 文\r\nthird', '\nsecond\nthird', '\n\nthird', 'first\n', '', '  \r\n  ', 'a'.repeat(4095) + '😀z', 'a'.repeat(4096), 'a'.repeat(4097)]
function sampleCases(api) {
  assert.equal(api.getCardPreviewSample('  A  B  \r\n中 文\r\nthird').text, '  A  B  \n中 文')
  assert.equal(api.getCardPreviewSample('\n\nthird').text, '\n', 'explicit blank lines replaced by default')
  assert.equal(api.getCardPreviewSample('\nsecond\nthird').lines[0], '')
  assert.equal(api.getCardPreviewSample('  \r\n  ').text, '字体预览\nAaBb 123')
  assert.equal(api.getCardPreviewSample('a\rb').text, 'a\nb')
  assert.equal(api.getCardPreviewSample('first\n').lines.length, 2)
  const bounded = api.getCardPreviewSample('a'.repeat(4095) + '😀z')
  assert.equal(bounded.text.length, 4095); assert.equal(bounded.lengthLimited, true)
  assert.equal(api.getCardPreviewSample('a'.repeat(4096)).lengthLimited, false)
  assert.equal(api.getCardPreviewSample('a'.repeat(4097)).lengthLimited, true)
  assert.equal(api.getCardPreviewSample('a\nb\nc').hasHiddenLines, true)
  assert.equal(api.getCardPreviewLayout('grid', '中文\nlonger second line', 18).token, api.getCardPreviewLayout('grid', '中文\nlonger second line', 72).token, 'hidden list size altered grid')
  assert.equal(api.getCardPreviewLayout('list', 'a\nb\nold', 44).token, api.getCardPreviewLayout('list', 'a\nb\nnew', 44).token, 'hidden text invalidated identical pixels')
  assert.equal(api.getCardPreviewLayout('grid', 'A\n' + 'B'.repeat(60)).fontSize, 26, 'second visible line missing from grid fit')
  assert.notEqual(api.getCardPreviewLayout('list', 'text', 18).token, api.getCardPreviewLayout('list', 'text', 72).token)
  assert.notEqual(api.getCardPreviewLayout('grid', 'text', 44).token, api.getCardPreviewLayout('list', 'text', 44).token)
}
function domCases() {
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server'), load = cardLoader()
  const Card = load(prefix + 'components/FontCard.tsx').FontCard
  const Sidebar = load(prefix + 'components/app/AppSidebarLibraryPage.tsx').AppSidebarLibraryPage
  const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
  for (const text of cases) for (const compact of [true, false]) {
    const html = renderToStaticMarkup(React.createElement(Card, { font: fonts[0], compact, previewText: text, listPreviewFontSize: 44, onVisible() {}, onSelect() {} }))
    const lines = [...html.matchAll(/<span[^>]*class="font-sample-line[^>]*>(.*?)<\/span>/gs)].map(x => x[1])
    assert.deepEqual(lines, [...sample(text).lines].map(escape), 'DOM input differs from canonical sample')
  }
  for (const fileAvailability of ['missing', 'unavailable']) for (const compact of [true, false]) {
    const html = renderToStaticMarkup(React.createElement(Card, { font: { ...fonts[0], fileAvailability, previewDisabled: true }, compact,
      previewText: '字体预览', previewImage: 'data:image/png;base64,stale', listPreviewFontSize: 44, onVisible() {}, onSelect() {} }))
    assert(html.includes(fileAvailability === 'missing' ? '请右键重新链接文件' : '文件暂不可访问'))
    assert(!html.includes('原生预览生成中'), 'missing file must not show a perpetual loading placeholder')
    assert(!html.includes('data:image/png;base64,stale'), 'missing file must not show stale preview pixels')
  }
  const html = renderToStaticMarkup(React.createElement(Sidebar, { activeFilter: {kind:'all'}, categoryCounts:{}, allFonts:[], previewText:'a\nb\nthird', installStatusReady:true }))
  assert(html.includes('a\nb\nthird</textarea>'), 'full input was truncated')
  assert(html.includes('卡片仅展示前两行。')); assert(html.includes('aria-describedby="card-preview-sample-hint"'))
  const tooLong = renderToStaticMarkup(React.createElement(Sidebar, { activeFilter: {kind:'all'}, categoryCounts:{}, allFonts:[], previewText:'a'.repeat(4097), installStatusReady:true }))
  assert(tooLong.includes('显示上限')); assert(tooLong.includes('a'.repeat(4097)))
}
async function requests() {
  const h = rendererHarness(), font = {...fonts[0], systemInstalled:true}, calls = []
  const apply = (mode, text, size) => { Object.assign(h.opt, {previewLayoutMode:mode,previewText:text,listPreviewFontSize:size}); h.opt.previewRequestTokenRef.current=layout(mode,text,size).token; h.runtime.resetPreviewRuntimeState() }
  h.opt.hfm.getCachedPreviewImages = async (...args) => { calls.push(['batch',...args]); return {} }
  h.opt.hfm.getCachedPreviewImage = async (...args) => { calls.push(['single',...args]); return '' }
  h.opt.hfm.renderPreviewImage = async (...args) => { calls.push(['render',...args]); return 'data:image/png;base64,current' }
  const validate = loader()('src/main/preview/runtime/previewInputPolicy.ts').normalizePreviewInput
  for (const text of cases) for (const mode of ['list','grid']) for (const size of [18,72]) {
    apply(mode,text,size);calls.length=0
    const expected=layout(mode,text,size)
    await h.runtime.loadCachedNativeCardPreviews([font])
    await h.runtime.ensurePreviewFont(font)
    assert(calls.some(x=>x[0]==='batch'));assert(calls.some(x=>x[0]==='render'))
    for(const call of calls) {
      assert.deepEqual(call.slice(2,6), [expected.text,expected.fontSize,expected.width,expected.height], call[0]+' IPC arguments differ')
      assert.equal(validate({text:call[2],fontSize:call[3],width:call[4],height:call[5]}).text, expected.text)
    }
    // A standalone cache probe, without the batch-miss fast path.
    apply(mode,text,size);calls.length=0;await h.runtime.ensurePreviewFont(font)
    assert.equal(calls[0][0],'single');assert.deepEqual(calls[0].slice(2,6),[expected.text,expected.fontSize,expected.width,expected.height])
  }
  // Cache hit on old mode arrives after a new mode render. No old hit may apply.
  const gate=deferred(); apply('list','same',44)
  h.opt.hfm.getCachedPreviewImages=()=>gate.promise
  const old=h.runtime.loadCachedNativeCardPreviews([font]);await flush()
  apply('grid','same',44);await h.runtime.ensurePreviewFont(font,true)
  gate.resolve({[font.id]:'data:image/png;base64,old-list'});await old
  assert.equal(h.opt.nativePreviewImages[font.id],'data:image/png;base64,current')
  // Same visible sample may accept a late result after a hidden-line edit.
  apply('grid','a\nb\nold',18);const same=deferred();h.opt.hfm.renderPreviewImage=()=>same.promise
  const pending=h.runtime.ensurePreviewFont(font,true);await flush()
  Object.assign(h.opt,{previewText:'a\nb\nnew',listPreviewFontSize:72})
  h.opt.previewRequestTokenRef.current=layout('grid',h.opt.previewText,72).token
  same.resolve('data:image/png;base64,reused');await pending
  assert.equal(h.opt.nativePreviewImages[font.id],'data:image/png;base64,reused')
  h.runtime.disposePreviewQueue()
}
function cacheVersions() {
  const crypto=require('node:crypto'),sha=s=>crypto.createHash('sha1').update(s).digest('hex')
  for(const native of [true,false]) {
    const cache=loader({'../native-renderer/directwrite/directWritePreviewHelperPathRuntime':{hasDirectWritePreviewHelper:()=>native}})('src/main/preview/runtime/previewCacheKeyRuntime.ts')
    assert(cache.getPreviewRendererVersion().includes('card-preview-v2'))
    for(const kind of ['legacyPreviewCacheKey','strictPreviewCacheKey']) {
      const l=layout('list','a\nb\nthird',44),g=layout('grid','a\nb\nthird',44)
      const args=x=>[sha,'font.ttf',123,456,x.fontSize,x.width,x.height,x.text]
      assert.notEqual(cache[kind](...args(l)),cache[kind](...args(g)))
      assert.notEqual(cache[kind](...args(l)),cache[kind](...args(l),native?'native-preview-private-gdi-inkbox-v8':'native-preview-powershell-center-v7'))
    }
  }
}
async function mainIdentities() {
  const load = loader({
    '../native-renderer/directwrite/directWritePreviewHelperPathRuntime': {hasDirectWritePreviewHelper:()=>true},
    '../../path/sharedFileSystemRuntime': {sharedFileSystem:{}}
  })
  const list = layout('list',' a\nb\nold',44), grid = layout('grid',' a\nb\nold',18)
  const sameGrid = layout('grid',' a\nb\nnew',72)
  const args = x => [x.text,x.fontSize,x.width,x.height], font=fonts[0]
  const memory=load('src/main/preview/runtime/previewImageMemoryRuntime.ts').createPreviewImageMemoryRuntime()
  const listKey=memory.requestKey(font,...args(list)),gridKey=memory.requestKey(font,...args(grid))
  assert.notEqual(listKey,gridKey);assert.equal(gridKey,memory.requestKey(font,...args(sameGrid)))
  memory.remember(listKey,'data:image/png;base64,list');assert.equal(memory.get(gridKey),'')
  const coalescer=load('src/main/preview/runtime/cachedPreviewReadCoalescerRuntime.ts').createCachedPreviewReadCoalescerRuntime()
  let calls=0;const gate=deferred(),task=()=>{calls++;return gate.promise}
  const reads=[coalescer.readSingle(font,...args(list),task),coalescer.readSingle(font,...args(grid),task),coalescer.readSingle(font,...args(sameGrid),task)]
  assert.equal(calls,2);gate.resolve('image');await Promise.all(reads)
  calls=0;const batch=async()=>{calls++;return {[font.id]:'image'}}
  await Promise.all([coalescer.readBatch([font],...args(list),batch),coalescer.readBatch([font],...args(grid),batch),coalescer.readBatch([font],...args(sameGrid),batch)])
  assert.equal(calls,2,'main batch merged different layouts or duplicated same sample')
  const requests=[]
  const scheduler=load('src/main/preview/runtime/previewRequestSchedulerRuntime.ts').createPreviewRequestSchedulerRuntime({readCachedPreviewImages:async(_items,...parameters)=>{requests.push(parameters);return {[font.id]:'image'}}})
  await Promise.all([scheduler.readCachedPreviewImages([font],...args(list)),scheduler.readCachedPreviewImages([font],...args(grid)),scheduler.readCachedPreviewImages([font],...args(sameGrid))])
  assert.equal(requests.length,2);assert(requests.some(x=>JSON.stringify(x.slice(0,4))===JSON.stringify(args(list))));assert(requests.some(x=>JSON.stringify(x.slice(0,4))===JSON.stringify(args(grid))))
  scheduler.cancelPending()
}
function resetAndResize() {
  let slots=[],index=0,effects=[]
  const hooks={useRef:v=>slots[index++]??={current:v},useState:v=>{const i=index++;if(!(i in slots))slots[i]=v;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v]},useEffect:(f,deps)=>{const i=index++,old=slots[i];if(!old||deps.some((v,j)=>v!==old[j])){slots[i]=deps;effects.push(f)}}}
  const load=loader({react:hooks,'../app/windowResizePhaseRuntime':{isWindowResizeActive:()=>true,subscribeWindowResizeSettled:()=>()=>{}}})
  const reset=load(prefix+'runtime/app/effects/usePreviewTextResetRuntime.ts').usePreviewTextResetRuntime
  const render=(fn,...args)=>{index=0;return fn(...args)},commit=()=>{effects.splice(0).forEach(f=>f())}
  let count=0;const opts={previewToken:layout('list','a\nb\nc',44).token,resetPreviewRuntimeState:()=>count++}
  assert.equal(render(reset,opts),true);commit();assert.equal(count,0)
  opts.previewToken=layout('list','a\nb\nchanged',44).token;assert.equal(render(reset,opts),true);commit();assert.equal(count,0)
  opts.previewToken=layout('grid','a\nb\nchanged',44).token;assert.equal(render(reset,opts),false,'stale image exposed before reset effect');commit();assert.equal(count,1);assert.equal(render(reset,opts),true)
  slots=[];effects=[]
  const freeze=load(prefix+'runtime/preview/useResizeFrozenPreviewRuntime.ts').useResizeFrozenPreviewRuntime
  const old={previewText:'old',previewImage:'old image'},next={previewText:'new',previewImage:undefined}
  assert.equal(render(freeze,'font:list',old),old);commit()
  assert.equal(render(freeze,'font:grid',next),next,'resize retained old mode image');commit()
}
async function main() {
  sampleCases(shared);domCases();await requests();cacheVersions();await mainIdentities();resetAndResize()
  const fs=require('node:fs'),full=path.resolve(file),source=fs.readFileSync(full,'utf8')
  for(const [from,to] of [["sourceLines.slice(0, 2).join('\\n')","sourceLines.join('\\n')"],["const sample = visible.slice(0, end)","const sample = visible.slice(0, end).trim()"],["mode === 'list' ? clampListPreviewFontSize","true ? clampListPreviewFontSize"]]) {
    assert(source.includes(from));assert.throws(()=>sampleCases(loader({}, {}, {[full]:s=>s.replace(from,to)})(file)),assert.AssertionError)
  }
  console.log('[preview-layout-contract] sample bounds/whitespace, DOM source and input hints, 48 mode/size IPC paths, stale mode/reused sample, both cache keys/backends, reset/resize, three regression mutants passed')
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1})

function makeDomSamples() {
  const { renderCase } = require('./lib/font-view-layout-harness.cjs'), load = cardLoader(), result = []
  for (const mode of ['list', 'grid']) for (const text of ['  A  B  \r\n中 文\r\nthird', '\nsecond\nthird', '\n\nthird', 'first\n', '  \n  ']) {
    const spec = layout(mode, text, 44)
    result.push({...renderCase(load, {mode,density:'comfortable',width:900,total:1,lines:spec.lines.length,previewText:text}), lines:[...spec.lines]})
  }
  return result
}
module.exports = { makeDomSamples }
