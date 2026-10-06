#!/usr/bin/env node
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),h=require('./helpers/rustWorkerTransportHarness.cjs')
async function main(){
 const input={fontPath:'C:/font.ttf',text:'sample',fontSize:32,width:500,height:80,outputPath:'C:/preview.png'}
 const legacy=h.createHarness(),legacyResult=await legacy.runtime.runRustPreviewRenderImage(input)
 assert.equal(legacyResult.engine,'rust-directwrite');assert.equal(legacyResult.nativeBackend,undefined)
 const observed=h.createHarness({previewPayload:{engine:'rust-private-gdi',provenance:{route:'private-file',selection:'first-private-family',familyName:'Selected family',familyNameStatus:'observed',requestedStyleBits:0,selectedStyleBits:0,faceStatus:'not-exposed',glyphFallbackStatus:'not-observed',faceIndex:7,arbitrary:'untrusted'}}})
 const result=await observed.runtime.runRustPreviewRenderImage(input)
 assert.equal(result.engine,'rust-directwrite');assert.equal(result.nativeBackend,'rust-private-gdi');assert.equal(result.provenance.familyName,'Selected family');assert.equal(result.provenance.faceStatus,'not-exposed');assert.equal(result.provenance.faceIndex,undefined);assert.equal(result.provenance.arbitrary,undefined)
 assert.equal(observed.trace.filter(row=>row[0]==='exec').length,legacy.trace.filter(row=>row[0]==='exec').length,'provenance added native requests')
 const invalid=h.createHarness({previewPayload:{engine:{invalid:true},provenance:{route:'invented',selectedStyleBits:500,familyNameStatus:13}}})
 const accepted=await invalid.runtime.runRustPreviewRenderImage(input);assert.equal(accepted.ok,true);assert.equal(accepted.nativeBackend,undefined);assert.equal(accepted.provenance,undefined)
 const source=fs.readFileSync(path.join(__dirname,'../../src/main/rust-core/clients/rustPreviewClientRuntime.ts'),'utf8')
 assert(source.includes('fallback decision deferred to preview dispatcher'));assert(!source.includes('helper fallback remains active'))
 console.log('[diagnostics:preview-provenance] legacy engine, observed native receipt, bounded best-effort fields and unchanged work passed')
}
let completed=false;process.once('beforeExit',()=>{if(!completed){console.error('Preview provenance diagnostic did not complete');process.exitCode=1}})
main().then(()=>{completed=true}).catch(error=>{console.error(error);process.exitCode=1})
