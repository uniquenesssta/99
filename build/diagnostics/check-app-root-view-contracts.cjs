#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const crypto = require('node:crypto')
const root = path.resolve(__dirname, '../..')
const appPath = 'src/renderer/src/App.tsx', viewPath = 'src/renderer/src/components/app/AppRootView.tsx'
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')
function jsx(text) {
  const file = ts.createSourceFile('App.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found
  function walk(n) { if(ts.isJsxSelfClosingElement(n) && n.tagName.getText(file)==='AppRootView') found=n; ts.forEachChild(n,walk) }
  walk(file); assert(found); return { file, found }
}
function viewDeclarations(app) {
  const { file, found } = jsx(app)
  const declarations = []
  for (const attribute of found.attributes.properties) {
    const group = attribute.name.text
    const name = attribute.initializer.expression.getText(file)
    assert.equal(name, `${group}ViewProps`, 'view must use its typed local group')
    let declaration
    function walk(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) {
        assert(!declaration, 'duplicate view binding'); declaration = node
      }
      ts.forEachChild(node, walk)
    }
    walk(file)
    assert(declaration && ts.isObjectLiteralExpression(declaration.initializer), 'explicit view object required')
    assert.equal(declaration.type?.getText(file), `AppRootViewProps['${group}']`, 'reuse existing group type')
    assert(declaration.initializer.properties.every(ts.isPropertyAssignment), 'no controller spread at view boundary')
    declarations.push(`const ${declaration.getText(file)};`)
  }
  return declarations.join('\n')
}
function checkLifecycle(app, view) {
  const fixture = require('./fixtures/app-view-composition.fixture.json')
  const normalizedApp = app.replace(/\r\n/g, '\n')
  const closingImport = "import { useRendererClosingLifecycleRuntime } from './runtime/app/rendererClosingLifecycleRuntime'\n"
  const closingOwner = '  const rendererClosingLifecycle = useRendererClosingLifecycleRuntime()\n'
  const libraryClosing = '    rendererUserActive,\n    appendDeveloperStatus,\n    closingLifecycle: rendererClosingLifecycle\n  })'
  const operationsClosing = '    sidebarPage,\n    clearFontListScrollIdleTimer,\n    appendDeveloperStatus,\n    closingLifecycle: rendererClosingLifecycle\n  })'
  const developerClosing = '    enabled: IS_DEVELOPMENT,\n    hfm: window.hfm,\n    status,\n    closingLifecycle: rendererClosingLifecycle\n  })'
  assert.equal((normalizedApp.match(/useRendererClosingLifecycleRuntime\(\)/g) || []).length, 1, 'renderer closing lifecycle owner must be composed exactly once')
  assert.equal((normalizedApp.match(/closingLifecycle: rendererClosingLifecycle/g) || []).length, 4, 'renderer closing lifecycle must wire three controllers and preview cards')
  assert(normalizedApp.indexOf(closingOwner) < normalizedApp.indexOf('  useRendererReadyNotification()'), 'renderer closing lifecycle owner must exist before close-capable effects')
  assert(normalizedApp.includes(libraryClosing), 'library controller lost renderer closing lifecycle wiring')
  assert(normalizedApp.includes(operationsClosing), 'operations controller lost renderer closing lifecycle wiring')
  assert(normalizedApp.includes(developerClosing), 'developer controller lost renderer closing lifecycle wiring')
  assert(normalizedApp.includes('useFontCardRenderer({\n    closingLifecycle: rendererClosingLifecycle,'), 'preview cards lost renderer closing lifecycle wiring')
  const normalized = normalizedApp
    .replace('useFontCardRenderer({\n    closingLifecycle: rendererClosingLifecycle,', 'useFontCardRenderer({')
    .replace("import type { AppRootViewProps } from './components/app/AppRootView'\n", '')
    .replace(closingImport, '')
    .replace(closingOwner, '')
    .replace(libraryClosing, '    rendererUserActive,\n    appendDeveloperStatus\n  })')
    .replace(operationsClosing, '    sidebarPage,\n    clearFontListScrollIdleTimer,\n    appendDeveloperStatus\n  })')
    .replace(developerClosing, '    enabled: IS_DEVELOPMENT,\n    hfm: window.hfm,\n    status\n  })')
  const marker = normalized.indexOf('  const topbarViewProps:')
  assert(marker > 0)
  const { file } = jsx(app)
  const body = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'App').body
  const start = body.statements.findIndex(node => ts.isVariableStatement(node) && node.declarationList.declarations[0].name.getText(file) === 'topbarViewProps')
  assert(start >= 0)
  const tail = body.statements.slice(start)
  assert.equal(tail.length, 7, 'view composition must add no lifecycle work')
  for (const [index, group] of ['topbar', 'sidebar', 'content', 'detail', 'overlays', 'developer'].entries()) {
    assert(ts.isVariableStatement(tail[index]))
    assert.equal(tail[index].declarationList.declarations.length, 1)
    assert.equal(tail[index].declarationList.declarations[0].name.getText(file), `${group}ViewProps`)
  }
  assert(ts.isReturnStatement(tail[6]))
  const hash = text => crypto.createHash('sha256').update(text).digest('hex')
  assert.equal(hash(normalized.slice(0, marker)), fixture.lifecyclePrefixSha256, 'App hooks/effects/commands changed')
  assert.equal(hash(view.replace(/\r\n/g, '\n')), fixture.rootViewSha256, 'root view lifecycle/dev switch changed')
}
function snapshot(app, view, bindings, development, collapsed) {
  const runtime = { jsx: (type, props) => typeof type === 'function' ? type(props) : ({type, props}), jsxs: (type, props) => runtime.jsx(type, props) }
  function compile(text, imports) {
    const module = { exports: {} }
    const code = ts.transpileModule(text, {compilerOptions:{ module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, jsx:ts.JsxEmit.ReactJSX }}).outputText
    vm.runInNewContext('(function(require,exports){'+code+'\n})')((id) => id==='react/jsx-runtime' ? runtime : imports(id), module.exports)
    return module.exports
  }
  const actual = compile(view, id => { const name=path.posix.basename(id); return {[name]:name} }).AppRootView
  const {file,found} = jsx(app)
  // The extracted caller uses the actual AppRootView function, not an emulated prop mapping.
  const source='import { AppRootView } from "./root"; export function render({'+bindings.join(',')+'}: any) { '+viewDeclarations(app)+' return '+found.getText(file)+' }'
  const caller=compile(source,()=>({AppRootView:actual}))
  const values=Object.fromEntries(bindings.map(name=>[name,'binding:'+name]))
  values.IS_DEVELOPMENT=development; values.library={previewText:'binding:library.previewText'}
  const tree=caller.render(values)
  function normalize(value) {
    if(Array.isArray(value))return value.map(normalize)
    if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,normalize(key==='renderSidebar'?v(collapsed,'collapse-callback'):v)]))
    return value
  }
  return crypto.createHash('sha256').update(JSON.stringify(normalize(tree))).digest('hex')
}
function compilerGate() {
  const config=ts.readConfigFile(path.join(root,'tsconfig.json'),ts.sys.readFile)
  const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,root)
  const filename=path.join(root,'src/renderer/src/appRootViewContractDiagnostic.ts')
  const fields={topbar:'themeMode',sidebar:'sidebarPage',content:'search',detail:'visible',overlays:'renameValue',developer:'IS_DEVELOPMENT'}
  let source='import type { AppRootViewProps } from "./components/app/AppRootView"; declare const p: AppRootViewProps;\n'
  let count=0
  for(const [group,field] of Object.entries(fields)) {
    source+=`const { ${field}: omitted${count}, ...rest${count} } = p.${group};\n`
    source+=`// @ts-expect-error required property must not be omitted\nconst missing${count}: AppRootViewProps['${group}'] = rest${count};\n`
    source+=`// @ts-expect-error wrong property must not be accepted\nconst unknown${count}: AppRootViewProps['${group}'] = { ...p.${group}, wrongProperty: true };\n`
    source+=`// @ts-expect-error wrong value must not be accepted\nconst bad${count}: AppRootViewProps['${group}'] = { ...p.${group}, ${field}: 42 };\n`
    count++
  }
  const host=ts.createCompilerHost(parsed.options), originalRead=host.readFile, originalExists=host.fileExists
  const same = file => path.resolve(file).replace(/\\/g,'/')===filename.replace(/\\/g,'/')
  host.readFile=file=>same(file)?source:originalRead(file);host.fileExists=file=>same(file)||originalExists(file)
  const program=ts.createProgram([...parsed.fileNames,filename],parsed.options,host)
  const diagnostics=ts.getPreEmitDiagnostics(program)
  assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>root,getCanonicalFileName:f=>f,getNewLine:()=> '\n'}))
  for(const rel of [viewPath,'src/renderer/src/components/app/AppSidebarTypes.ts','src/renderer/src/components/app/FontListPanelTypes.ts','src/renderer/src/components/app/AppOverlays.tsx']) {
    const file=program.getSourceFile(path.join(root,rel));let any=0
    function walk(n){if(n.kind===ts.SyntaxKind.AnyKeyword)any++;ts.forEachChild(n,walk)}walk(file)
    assert.equal(any,0,rel+' reintroduced any')
  }
}
function main() {
  const fixture=require('./fixtures/app-root-view-wiring.fixture.json')
  const app=read(appPath),view=read(viewPath)
  checkLifecycle(app, view)
  checkLifecycle(app.replace(/\r?\n/g,'\r\n'), view.replace(/\r?\n/g,'\r\n'))
  const missingClosingOwner = app.replace(/  const rendererClosingLifecycle = useRendererClosingLifecycleRuntime\(\)\r?\n/, '')
  assert.notEqual(missingClosingOwner, app, 'closing lifecycle owner mutant did not match source')
  assert.throws(() => checkLifecycle(missingClosingOwner, view), /closing lifecycle owner/, 'closing lifecycle owner removal escaped the gate')
  const missingClosingWiring = app.replace(/    closingLifecycle: rendererClosingLifecycle\r?\n/, '')
  assert.notEqual(missingClosingWiring, app, 'closing lifecycle wiring mutant did not match source')
  assert.throws(() => checkLifecycle(missingClosingWiring, view), /closing lifecycle/, 'closing lifecycle controller wiring removal escaped the gate')
  assert.throws(() => checkLifecycle(app.replace('useRendererReadyNotification()', 'useRendererReadyNotification(); setTimeout(() => {}, 1)'), view), /hooks\/effects\/commands/, 'new lifecycle work escaped the gate')
  const lateLifecycleWork = app.replace(/  return \(\r?\n    <AppRootView/, match => `  setTimeout(() => {}, 1)\n${match}`)
  assert.notEqual(lateLifecycleWork, app, 'late lifecycle mutant did not match source')
  assert.throws(() => checkLifecycle(lateLifecycleWork, view), /no lifecycle work/, 'late lifecycle work escaped the gate')
  assert.throws(() => viewDeclarations(app.replace("AppRootViewProps['topbar']", 'any')), /group type/, 'untyped view input escaped the gate')
  assert.throws(() => viewDeclarations(app.replace('themeMode: themeMode,', '...operationsController,')), /controller spread/, 'controller forwarding escaped the gate')
  const groupNames=jsx(app).found.attributes.properties.map(p=>p.name?.text)
  assert.deepEqual(groupNames,['topbar','sidebar','content','detail','overlays','developer'])
  for(const entry of fixture.cases) {
    assert.equal(snapshot(app,view,fixture.bindings,entry.development,entry.collapsed),entry.hash,'UI wiring changed')
    assert.equal(snapshot(app.replace(/\r?\n/g,'\r\n'),view.replace(/\r?\n/g,'\r\n'),fixture.bindings,entry.development,entry.collapsed),entry.hash,'CRLF wiring changed')
  }
  const broken=app.replace('search: search,','search: status,')
  assert.notEqual(broken,app)
  assert.notEqual(snapshot(broken,view,fixture.bindings,false,false),fixture.cases.find(c=>!c.development&&!c.collapsed).hash,'wrong wiring was not detected')
  compilerGate()
  console.log('[diagnostics:app-root-view-contracts] six typed local groups; explicit renderer-closing owner/wiring plus frozen legacy lifecycle; 18 compiler negatives; frozen UI in four modes; wiring/type/spread/lifecycle mutations and CRLF passed')
}
module.exports={snapshot,jsx}
if(require.main===module)main()
