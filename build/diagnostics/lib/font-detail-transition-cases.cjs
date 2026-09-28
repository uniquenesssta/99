const assert = require('node:assert/strict')
const { loader, prefix, fonts, read } = require('./font-view-layout-harness.cjs')
module.exports = function detailTransitionCases(overrides = {}) {
  let slots = [], cursor = 0, effects = []
  const hooks = { useRef(v) { const i = cursor++; return slots[i] ||= { current: v } }, useLayoutEffect(fn, deps) { const i = cursor++, prev = slots[i]; if (!prev || deps.some((v,j) => v !== prev[j])) { slots[i] = deps; effects.push(fn) } } }
  const load = loader({ hooks, overrides }), build = load(prefix+'runtime/app/fontViewLayoutRuntime.ts').buildFontViewLayout
  const hook = load(prefix+'runtime/app/useFontScrollRestoreRuntime.ts').useFontLayoutScrollAnchor
  const render = args => { cursor=0; const capture=hook(args); const list=effects; effects=[]; list.forEach(fn=>fn()); return capture }
  for (const mode of ['grid','list']) for (const offset of [0,300]) for (const initial of [0,7000,17000]) {
    slots=[]
    const wide=build(mode,'comfortable',1300,52,2), narrow=build(mode,'comfortable',840,52,2)
    const preview={scrollLeft:173}, cards=[{dataset:{fontId:'f300'},querySelector:()=>preview}]
    const node={scrollTop:initial,clientWidth:1300,clientHeight:520,scrollHeight:1e6,querySelectorAll:()=>cards}
    let viewport={scrollTop:initial,width:1300,height:520}
    const base={fonts:offset?fonts.slice(offset,offset+100):fonts,layout:wide,fontOffset:offset,scopeKey:'all',detailVisible:false,enabled:true,preferredFontId:'',fontScrollerRef:{current:node},setVirtualViewport:v=>{viewport=typeof v==='function'?v(viewport):v}}
    const enter=render({...base,viewport}); enter(true)
    node.clientWidth=840
    render({...base,viewport,detailVisible:true})
    assert.equal(node.scrollTop,initial,'stale geometry must not scroll')
    viewport={...viewport,width:840}
    let close=render({...base,layout:narrow,viewport,detailVisible:true})
    close=render({...base,layout:narrow,viewport,detailVisible:true})
    node.scrollTop+=600; preview.scrollLeft=400 // browsing in detail must not overwrite entry
    viewport={...viewport,scrollTop:node.scrollTop}
    close=render({...base,layout:narrow,viewport,detailVisible:true})
    close(false); node.clientWidth=1300; node.scrollTop=100 // browser clamping must not destroy saved entry
    render({...base,layout:narrow,viewport,detailVisible:false})
    viewport={...viewport,width:1300}
    render({...base,viewport})
    render({...base,viewport})
    assert.equal(node.scrollTop,initial,`${mode}/${offset}: detail cancel lost original position`)
    assert.equal(preview.scrollLeft,173,'detail cancel lost preview horizontal position')
    const again=render({...base,viewport}); again(true)
    node.clientWidth=840; viewport={...viewport,width:840,scrollTop:0}; node.scrollTop=0
    render({...base,scopeKey:'other-filter',layout:narrow,viewport,detailVisible:true})
    assert.equal(node.scrollTop,0,'old detail snapshot leaked into another filter')
  }
}
if(require.main===module) {
  module.exports()
  const file=prefix+'runtime/app/useFontScrollRestoreRuntime.ts'
  assert.throws(()=>module.exports({[file]:read(file).replace('if (visible) entry.current = position','if (visible) entry.current = null')}),/lost original position/)
  console.log('[font-detail-transition] grid/list return, pre-layout wait, horizontal restore, page offsets, scope reset and missing-entry mutant passed')
}
