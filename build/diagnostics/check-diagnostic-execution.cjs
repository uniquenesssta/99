#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { runDiagnosticProcess } = require('./diagnosticProcessRuntime.cjs')
const root = path.resolve(__dirname, '../..')
const observer = path.join(__dirname, 'check-index-io-activation-shutdown-baseline.cjs')

function observe(args, transform) {
  const bootstrap = `const fs=require('node:fs'),Module=require('node:module'),path=require('node:path');
    const file=${JSON.stringify(observer)};let source=fs.readFileSync(file,'utf8');
    const transform=${JSON.stringify(transform || null)};
    if(transform){if(source.split(transform[0]).length!==2)throw Error('mutation anchor missing or ambiguous');source=source.replace(...transform)}
    process.argv.push(...${JSON.stringify(args)});const mod=new Module(file);mod.filename=file;
    mod.paths=Module._nodeModulePaths(path.dirname(file));mod._compile(source,file);`
  const result = spawnSync(process.execPath, ['-e', bootstrap], { cwd: root, encoding: 'utf8', timeout: 12000 })
  assert.ifError(result.error)
  return result
}

function observerModesAndFailureCleanup() {
  for (const newline of [[], ['--crlf']]) {
    const historic = observe(newline)
    assert.equal(historic.status, 0, historic.stderr)
    const evidence = JSON.parse(historic.stdout)
    assert.equal(evidence.knownDefects, 5)
    assert.equal(evidence.controls, 3)
    const negative = observe([...newline, '--strict'])
    assert.equal(negative.status, 1, negative.stderr)
    assert.equal(JSON.parse(negative.stdout).knownDefects, 5)
    const current = observe([...newline, '--current', '--strict'])
    assert.equal(current.status, 0, current.stderr)
    assert.equal(JSON.parse(current.stdout).knownDefects, 0)
  }
  for (const mode of [[], ['--current', '--strict']]) {
    // Fail while the actual historical/current foreground interval is still active.
    const failed = observe(mode, [
      "assert(calls.length >= 4, 'normal developer diagnostics must remain active before close')",
      "throw new Error('controlled renderer observation failure')",
    ])
    assert.equal(failed.status, 1, failed.stderr)
    assert.match(failed.stderr, /controlled renderer observation failure/)
  }
  const strictFailure = observe(['--current', '--strict'], [
    "const defect = rootState.state === 'offline'", 'const defect = true',
  ])
  assert.equal(strictFailure.status, 1, 'current observations must reject reported defects')
  assert.equal(JSON.parse(strictFailure.stdout).knownDefects, 1)
}

function isRunning(pid) {
  try {
    process.kill(pid, 0)
    // A killed orphan can briefly remain a zombie until the container init reaps it.
    if (process.platform === 'linux' && /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false
    return true
  } catch (error) { if (['ESRCH', 'ENOENT'].includes(error.code)) return false; throw error }
}

async function processDeadlines() {
  const run = (args, extra = {}) => runDiagnosticProcess(process.execPath, args, { cwd: root, stdio: 'ignore', timeoutMs: 3000, ...extra })
  const success = await run(['-e', 'process.exit(0)'])
  assert.equal(success.code, 0); assert.equal(success.timedOut, false)
  assert.equal((await run(['-e', 'process.exit(7)'])).code, 7)
  const missing = await runDiagnosticProcess(path.join(os.tmpdir(), 'hfm-nonexistent-executable'), [], { timeoutMs: 1000, stdio: 'ignore' })
  assert.equal(missing.error?.code, 'ENOENT')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-diagnostic-tree-'))
  const marker = path.join(dir, 'child.json')
  let descendant
  try {
    const script = `const cp=require('node:child_process'),fs=require('node:fs');
      const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:child.pid}));setInterval(()=>{},1000)`
    const result = await run(['-e', script])
    assert.equal(result.timedOut, true)
    assert.ifError(result.terminationError)
    assert(fs.existsSync(marker), 'test child never started')
    descendant = JSON.parse(fs.readFileSync(marker, 'utf8')).pid
    for (let i = 0; i < 20 && isRunning(descendant); i++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(isRunning(descendant), false, 'timed-out diagnostic left its descendant running')
  } finally {
    if (descendant && isRunning(descendant)) process.kill(descendant, 'SIGKILL')
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  observerModesAndFailureCleanup()
  await processDeadlines()
  console.log('[diagnostics:execution-lifecycle] pinned/current LF/CRLF, strict defects, assertion cleanup, exit codes and real process-tree deadline passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
