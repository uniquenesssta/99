#!/usr/bin/env node
const assert = require('node:assert/strict')
const path = require('node:path')
const { loader } = require('./check-operation-chain.cjs')
const queueFile = 'src/renderer/src/runtime/preview/gridPreviewPostprocessRuntime.ts'
const trimFile = 'src/renderer/src/runtime/preview/gridNativePreviewImageTrimRuntime.ts'
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function png(id, width = 100, height = 50) {
 const header = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(header)
 header.writeUInt32BE(13,8); header.write('IHDR',12); header.writeUInt32BE(width,16); header.writeUInt32BE(height,20)
 return 'data:image/png;base64,' + header.toString('base64') + id
}
function clock() {
 let next = 0; const timers = new Map()
 return { timers, setTimeout:fn => { timers.set(++next,fn); return next }, clearTimeout:id => timers.delete(id),
  pump() { const entries = [...timers]; timers.clear(); entries.forEach(([,fn])=>fn()) } }
}
function queueHarness(transform) {
 const time = clock(), work = []
 const load = loader({}, {atob, setTimeout:time.setTimeout, clearTimeout:time.clearTimeout}, transform ? {[path.resolve(queueFile)]:transform} : {})
 const {createGridPreviewPostprocessRuntime,GRID_POSTPROCESS_LIMITS:limits} = load(queueFile)
 const runtime = createGridPreviewPostprocessRuntime((source,wanted) => new Promise(resolve=>work.push({source,wanted,resolve})))
 return {time,work,runtime,limits}
}
async function resourceCases(transform) {
 const {time,work,runtime:r,limits} = queueHarness(transform), values=[]
 const releaseA=r.request(png('A'),v=>values.push(['A',v])), releaseB=r.request(png('A'),v=>values.push(['B',v]))
 const queued=r.request(png('queued'),()=>assert.fail('released queue published'));queued()
 r.request(png('other'),()=>{});r.request(png('third'),()=>{})
 assert.equal(work.length,0,'decode started before cancellable admission')
 time.pump();assert.equal(work.length,2,'physical postprocess concurrency limit');assert.equal(r.getStats().pending,1)
 releaseA();assert(work[0].wanted(),'one consumer cancelled another consumer')
 work[0].resolve({image:'cropped',clipped:false,width:76,height:50});await flush()
 assert.deepEqual(values.map(v=>v[0]),['B']);releaseB()
 time.pump();assert.equal(work.length,3)
 work.slice(1).forEach(w=>w.resolve(undefined));await flush()
 assert.equal(r.getStats().active,0);assert.equal(r.getStats().workingBytes,0)
 r.request(png('A'),()=>{});assert.equal(work.length,3,'completed same-source crop not reused')
 const cancelled=r.request(png('active-cancel'),()=>assert.fail('abandoned task published'));time.pump();cancelled()
 assert.equal(r.getStats().active,1,'cancellation released physical slot early');assert.equal(work.at(-1).wanted(),false)
 work.at(-1).resolve({image:'stale',clipped:false,width:10,height:10});await flush();assert.equal(r.getStats().cacheEntries,1,'abandoned result entered cache')
 // Close while both slots are occupied, then request the same source after resume.
 r.request(png('old'),()=>assert.fail('old epoch published'));r.request(png('old2'),()=>{});time.pump()
 const old=work.slice(-2);r.request(png('never-start'),()=>assert.fail('closing queue published'))
 r.setPaused(true,false);assert.equal(r.getStats().cacheEntries,1,'scroll pause purged reusable cache')
 r.setPaused(true);assert.equal(r.getStats().cacheEntries,0,'close while scrolling retained cache')
 assert.equal(r.getStats().pending,0);assert.equal(r.getStats().active,2)
 r.setPaused(false);r.request(png('old'),v=>values.push(['fresh',v]));time.pump();assert.equal(work.at(-1),old[1],'resume exceeded occupied slots')
 old.forEach(w=>w.resolve({image:'old',clipped:false,width:1,height:1}));await flush();time.pump()
 assert.equal(work.at(-1).source,png('old'));assert.notEqual(work.at(-1),old[0],'old completion deleted/reused new same-source request')
 work.at(-1).resolve({image:'fresh',clipped:false,width:1,height:1});await flush();assert.equal(values.at(-1)[1].image,'fresh')
 assert.equal(r.getStats().active,0)
 // Count and byte admission are both bounded; over-budget cards get a disclosed fallback.
 const full=queueHarness(), releases=[], fallbacks=[]
 for(let i=0;i<=limits.pending;i++)releases.push(full.runtime.request(png('q'+i),v=>fallbacks.push(v)))
 assert.equal(full.runtime.getStats().pending,limits.pending);assert.equal(fallbacks.length,1);assert.equal(fallbacks[0].clipped,true)
 releases.forEach(f=>f());assert.equal(full.runtime.getStats().pendingBytes,0);assert.equal(full.time.timers.size,0)
 const big=queueHarness(), large=png('large',4096,128)+'A'.repeat(4_000_000)
 big.runtime.request(large,()=>{});big.runtime.request(large+'B',()=>{});big.runtime.request(large+'C',v=>assert(v.clipped))
 assert.equal(big.runtime.getStats().pending,2,'pending byte budget failed');big.time.pump()
 assert.equal(big.work.length,1,'working byte budget ignored dimensions/source strings')
 assert(big.runtime.getStats().workingBytes<=limits.workingBytes)
 big.runtime.setPaused(true);big.work[0].resolve(undefined);await flush()
 const invalid=queueHarness();invalid.runtime.request(png('oversize',4096,129),v=>assert(v.clipped));invalid.runtime.request('data:image/png;bad',v=>assert(v.clipped));invalid.time.pump();assert.equal(invalid.work.length,0)
 // Cache accounts for decoded output plus both source/result strings, not just entry count.
 const lru=queueHarness(transform);let cursor=0
 async function finish(source,width=4096,height=128){lru.runtime.request(source,()=>{});lru.time.pump();if(lru.work.length>cursor){lru.work[cursor++].resolve({image:source,clipped:false,width,height});await flush()}}
 for(let i=0;i<16;i++)await finish(png('cache'+i))
 await finish(png('cache1'));const before=lru.work.length;await finish(png('cache16'));await finish(png('cache1'))
 assert.equal(lru.work.length,before+1,'cache hit did not refresh LRU recency')
 await finish(png('cache0'));assert.equal(lru.work.length,before+2,'byte budget failed to evict oldest image')
 assert(lru.runtime.getStats().cacheBytes<=limits.cacheBytes,'cache byte budget exceeded')
 lru.runtime.setPaused(true);assert.equal(lru.runtime.getStats().cacheBytes,0)
 lru.runtime.setPaused(false)
 for(let i=0;i<241;i++)await finish(png('tiny'+i),1,1)
 assert.equal(lru.runtime.getStats().cacheEntries,240)
}
async function cropCases() {
 const time=clock(),images=[],canvases=[];let scans=0,throwScan=false,cropSize
 const pixels=new Uint8ClampedArray(100*50*4)
 for(let y=15;y<35;y++)for(let x=30;x<70;x++)pixels[(y*100+x)*4+3]=255
 class ImageFixture { naturalWidth=100;naturalHeight=50;set src(value){images.push(this)} removeAttribute(){this.released=true} }
 const load=loader({react:require('react')},{atob,Image:ImageFixture,setTimeout:time.setTimeout,clearTimeout:time.clearTimeout,document:{createElement(){const c={width:0,height:0,getContext:()=>({drawImage(){},getImageData(){scans++;if(throwScan)throw Error('canvas failure');return {data:pixels}}}),toDataURL(){cropSize=[c.width,c.height];return 'data:image/png;cropped'}};canvases.push(c);return c}}})
 const r=load(trimFile).gridPreviewPostprocess
 async function process(id){let result; r.request(png(id),v=>result=v);time.pump();images.at(-1).onload();await flush();return result}
 const a=await process('first');assert.deepEqual(cropSize,[76,50]);assert.equal(a.clipped,false)
 assert(images.every(i=>i.released&&i.onload===null&&i.onerror===null));assert(canvases.every(c=>c.width===0&&c.height===0),'canvas backing store retained')
 pixels[3]=255;assert.equal((await process('edge')).clipped,true)
 pixels.fill(0);assert.equal((await process('blank')).clipped,false);assert.deepEqual(cropSize,[36,50])
 let released=r.request(png('abandon'),()=>assert.fail('abandoned image applied'));time.pump();released();const scansBefore=scans;images.at(-1).onload();await flush();assert.equal(scans,scansBefore,'abandoned decode still scanned pixels')
 throwScan=true;const before=r.getStats().cacheEntries;assert.equal((await process('failure')).clipped,true);assert.equal(r.getStats().cacheEntries,before,'failed crop cached');assert(canvases.every(c=>c.width===0&&c.height===0))
 throwScan=false;await process('failure');assert.equal(r.getStats().cacheEntries,before+1,'failure could not retry')
 let error;r.request(png('decode-error'),v=>error=v);time.pump();images.at(-1).naturalWidth=0;images.at(-1).onerror();await flush();assert(error.clipped);assert(images.at(-1).released)
}
(async()=>{
 await resourceCases();await cropCases()
 await assert.rejects(()=>resourceCases(s=>s.replace('active: 2','active: 3')),/physical postprocess concurrency limit/)
 await assert.rejects(()=>resourceCases(s=>s.replace(' || cacheBytes > GRID_POSTPROCESS_LIMITS.cacheBytes','')),/byte budget failed to evict/)
 console.log('[grid-preview-clip-safe] crop/blank-line/edge correctness; shared consumers; queued/active cancellation; close/resume ownership; count/byte budgets and LRU; image/canvas cleanup; failure retry; 2 resource mutants passed')
})().catch(e=>{console.error(e);process.exitCode=1})
