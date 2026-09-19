const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..')
const file = 'src/renderer/src/runtime/preview/queue/fontPreviewLoadRuntime.ts'
const tick = () => new Promise(resolve => setImmediate(resolve))
async function check(transform = s => s) {
  let now = 1000, calls = 0, updates = 0, failure = true, pending
  class Clock extends Date { static now() { return now } }
  const load = loader({
    '../../../appRuntime': { PREVIEW_STATE_LRU_LIMIT: 800, pruneRecordByKeyLimit: x => x },
    '../../../rendererPerformance': { reportRendererTrace() {} },
    './fontPreviewQuickFallbackRuntime': {},
  }, { Date: Clock }, { [path.join(root,file)]: transform })
  const { SHARED_UNAVAILABLE_MESSAGE } = load('src/shared/sharedAvailability.ts')
  let font = { id:'a', path:'O:\\字体\\a.ttf', fileName:'a.ttf', systemInstalled:true, favorite:true, tagNames:['共享'], localTagNames:['本机'] }
  const original = JSON.stringify(font)
  const options = {
    previewText:'audit',listPreviewFontSize:39,previewRequestTokenRef:{current:'audit::39'},
    selectedFontId:'',selectedFontIds:[],previewFamilies:{},nativePreviewImages:{},failedPreviewFontIds:{},loadingFonts:{current:new Set()},isBadFontRecord:()=>false,
    setPreviewFamilies(){},setFailedPreviewFontIds(){},setNativePreviewImages(fn){options.nativePreviewImages=fn(options.nativePreviewImages)},
    updateFont(id,fn){ updates++;font=fn(font) },
    hfm:{getCachedPreviewImage:async()=>'',renderPreviewImage:async()=>{calls++;if(pending)await pending;if(failure)throw Error("Error invoking remote method: "+SHARED_UNAVAILABLE_MESSAGE);return 'data:image/png;base64,ok'}},
  }
  const runtime = load(file).createFontPreviewLoadRuntime(options)
  await runtime.ensurePreviewFont(font)
  for(let i=0;i<3000;i++) await runtime.ensurePreviewFont(font)
  assert.equal(calls,1,'offline rerenders must not produce repeated IPC')
  assert.equal(updates,0,'offline must not persist a broken-font flag')
  assert.equal(JSON.stringify(font),original)
  assert.equal(options.loadingFonts.current.size,0)
  now+=30001;failure=false;await runtime.ensurePreviewFont(font)
  assert.equal(calls,2);assert(options.nativePreviewImages.a,'recovery after cooldown did not render')
  failure=true;await runtime.ensurePreviewFont({...font,id:'b'})
  const before=calls;runtime.resetPreviewLoads();failure=false;await runtime.ensurePreviewFont({...font,id:'b'})
  assert.equal(calls,before+1,'explicit reset must release cooldown')
  let reject;pending=new Promise((_,r)=>reject=r)
  const stale=runtime.ensurePreviewFont({...font,id:'c'});await tick();runtime.resetPreviewLoads();options.loadingFonts.current.clear()
  reject(Error('late failure'));await stale;pending=undefined
  const after=calls;await runtime.ensurePreviewFont({...font,id:'c'});assert.equal(calls,after+1,'stale failure poisoned new generation')
}
async function main() {
  const protocol=loader()('src/main/rust-core/rustCoreProtocolRuntime.ts')
  const status={protocolVersion:protocol.EXPECTED_RUST_CORE_PROTOCOL_VERSION,capabilities:[...protocol.REQUIRED_RUST_CORE_CAPABILITIES]}
  assert(protocol.rustCoreWorkerIsCompatible(status).ok)
  assert(!protocol.rustCoreWorkerIsCompatible({...status,capabilities:status.capabilities.filter(c=>c!=='shared-file-io-v1')}).ok,'old worker admitted')
  // Decode the actual Rust handshake literal through its format placeholders.
  const source=fs.readFileSync(path.join(root,'native-src/hfm-core-worker/src/protocol.rs'),'utf8')
  const literal=source.match(/^\s*("\{\{.*")\s*,\s*$/m)[1]
  const handshake=JSON.parse(JSON.parse(literal).replaceAll('{{','{').replaceAll('}}','}').replace('"{}"','"worker"').replace('"{}"','"version"').replace('{}',String(status.protocolVersion)).replaceAll('"{}"','"platform"'))
  assert(protocol.rustCoreWorkerIsCompatible(handshake).ok,'actual handshake differs from Electron admission')
  await check();await check(s=>s.replace(/\r?\n/g,'\r\n'))
  await assert.rejects(()=>check(s=>s.replace("if ((failedPreviewUntil.get(failureKey) || 0) > Date.now()) return ''",'')),undefined,'cooldown removal mutant escaped')
  console.log('preview failure cooldown: 3000 requests bounded, no offline record mutation, expiry/reset recovery, stale failure, real handshake literal/old worker rejection and CRLF/mutation passed')
}
main().catch(error=>{console.error(error);process.exitCode=1})
