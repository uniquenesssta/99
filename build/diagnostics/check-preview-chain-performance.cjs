#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..')
async function run() {
  assert.equal(process.platform, 'win32', 'actual preview chain requires Windows')
  if (process.argv.includes('--recovery-chain')) return runRecoveryChain()
  if (process.argv.includes('--work-comparison')) return require('./lib/operation-work-performance-runner.cjs').run()
  const directory = path.join(root, 'artifacts/list-preview/chain'), html = path.join(directory, 'index.html'), preload = path.join(directory, 'preload.cjs')
  fs.mkdirSync(directory, { recursive: true })
  await require('esbuild').build({ entryPoints: [path.join(__dirname, 'lib/preview-chain-performance-dom.ts')], bundle: true,
    outfile: path.join(directory, 'renderer.js'), platform: 'browser', format: 'iife', define: { 'import.meta.env': '{}' }, tsconfig: path.join(root, 'tsconfig.json') })
  fs.writeFileSync(html, '<!doctype html><html><meta charset="utf-8"><body><script src="renderer.js"></script></body></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = cp.spawnSync(require('electron'), [path.join(__dirname, 'lib/preview-chain-performance-electron.cjs'), directory, html, preload], { cwd: root, env, stdio: 'inherit', timeout: 150000 })
  assert.equal(result.status, 0, String(result.error || 'preview chain failed'))
}
async function runRecoveryChain() {
  const directory=path.join(root,'artifacts/list-preview/recovery-chain'),html=path.join(directory,'index.html'),preload=path.join(directory,'preload.cjs')
  fs.mkdirSync(directory,{recursive:true})
  const {selectFonts,hash}=require('./lib/operation-work-performance.cjs')
  const workerPath=path.join(root,'native-src/hfm-core-worker/target/release/hfm-core-worker.exe')
  const config={mode:'recovery-chain',sourceRoot:root,sourceSha:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),fixtureDirectory:path.join(directory,'fixture'),manifest:selectFonts(directory),workerPath,workerSha256:hash(fs.readFileSync(workerPath))}
  const configPath=path.join(directory,'config.json');fs.writeFileSync(configPath,JSON.stringify(config))
  await require('esbuild').build({entryPoints:[path.join(__dirname,'lib/recovery-chain-dom.tsx')],bundle:true,outfile:path.join(directory,'renderer.js'),platform:'browser',format:'iife',define:{'import.meta.env':'{}'},tsconfig:path.join(root,'tsconfig.json')})
  const css=require('./lib/font-view-layout-harness.cjs').css()
  fs.writeFileSync(html,'<!doctype html><html data-theme="light"><meta charset="utf-8"><style>'+css+' body{display:block;overflow:auto;padding:16px}main{width:100%;display:block}.f14-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.f14-list{display:block}.context-menu{position:fixed;z-index:9999}dialog{background:white}</style><body><script src="renderer.js"></script></body></html>')
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const result=cp.spawnSync(require('electron'),[path.join(__dirname,'lib/preview-chain-performance-electron.cjs'),directory,html,preload,configPath],{cwd:root,env,stdio:'inherit',timeout:210000})
  assert.equal(result.status,0,String(result.error||'recovery chain failed'))
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'report.json'),'utf8')).passed,true)
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { run }
