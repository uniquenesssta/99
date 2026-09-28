#!/usr/bin/env node
const assert=require('node:assert/strict')
const {loader}=require('./check-operation-chain.cjs')
const {previewBridge}=require('./lib/preview-preload-harness.cjs')
async function main(){
 const load=loader(),api=load('src/shared/preview-layout/previewTextFitRuntime.ts'),validate=load('src/shared/preview-layout/nativePreviewLayout.ts').validateNativePreviewLayout
 for(const text of ['安盛aaaa','  Ag  \nSecond','\nAg','Wide '.repeat(100)+'\nSecond']){
  const d=api.getCardPreviewLayout('grid',text,18),other=api.getCardPreviewLayout('grid',text,72)
  assert.equal(d.token,other.token,'hidden list size changed grid')
  assert.equal(d.text,text);assert.equal(d.nativeLayout.version,'grid-v1');assert.equal(d.nativeLayout.textAlign,'center')
  assert(d.fontSize>=26&&d.fontSize<=42);assert.equal(d.width,4096)
  assert.equal(validate(d.nativeLayout,d.text,d.fontSize,d.width,d.height).version,'grid-v1')
  for(const field of Object.keys(d.nativeLayout))assert.throws(()=>validate({...d.nativeLayout,[field]:'invalid'},d.text,d.fontSize,d.width,d.height),/PREVIEW_INPUT_INVALID/)
  for(const source of ['runtime','typed']){
   let delivered
   const apiBridge=previewBridge({renderFontPreviewImage:async(...args)=>{delivered=args;return 'image'},appendLog(){}},{kind:source}).api
   await apiBridge.renderPreviewImage({id:'f',path:'font'},d.text,d.fontSize,d.width,d.height,undefined,d.nativeLayout)
   assert.equal(delivered[1],text);assert.equal(delivered[5].version,'grid-v1')
  }
 }
 const d=api.getCardPreviewLayout('list','Ag',44)
 assert.equal(d.nativeLayout.version,'list-v1');assert.equal(d.nativeLayout.paddingLeft,36)
 console.log('[grid-preview-size] full sample, hidden-control independence, dual runtime bridge, strict versioned contract and list compatibility passed')
}
main().catch(e=>{console.error(e);process.exitCode=1})
