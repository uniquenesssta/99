#!/usr/bin/env node
const assert=require('node:assert/strict')
const {loader,renderCase,read}=require('./lib/font-view-layout-harness.cjs')
const load=loader()
// The geometry harness intentionally stubs browser hooks; load the pure fit from
// the real module through the general source loader for these behavioral cases.
const actual=require('./check-operation-chain.cjs').loader({react:require('react')})('src/renderer/src/runtime/preview/gridPreviewVisualFitRuntime.ts').gridPreviewVisualFit
assert.deepEqual(JSON.parse(JSON.stringify(actual(100,50,300,112,42))),{scale:1,overflow:false})
const fitResult=actual(400,100,300,112,42)
assert.equal(fitResult.scale,.75);assert.equal(fitResult.overflow,false)
const overflow=actual(2000,100,300,112,42)
assert.equal(overflow.scale,26/42);assert.equal(overflow.overflow,true)
assert.equal(actual(500,100,300,112,26).scale,1,'26px floor must not shrink further')
assert.equal(actual(300,200,300,150,42).scale,.75,'fit both axes as one block')
for(const text of JSON.parse(read('build/diagnostics/fixtures/grid-preview-visual-fit.fixture.json')).samples){
 const html=renderCase(load,{mode:'grid',density:'comfortable',width:420,total:1,previewText:text}).html
 const lines=[...html.matchAll(/class="font-sample-line">([^<]*)<\/span>/g)].map(m=>m[1])
 assert.equal(lines.join('\n'),text,'grid changed visible source text')
}
console.log('[grid-preview-visual-fit] complete text, no enlargement, bounded whole-sample scaling, overflow and both-axis cases passed')
