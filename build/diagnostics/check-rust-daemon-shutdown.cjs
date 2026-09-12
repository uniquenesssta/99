#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const root = path.resolve(__dirname, '../..')
function harness(mode = 'normal') {
  const children = [], timers = new Map(), processStub = new EventEmitter()
  processStub.env = {}
  const real = mode === 'real' || mode === 'real-hung'
  let serial = 0
  const context = vm.createContext({ Error, JSON, Date, Map, Set, Buffer, process: processStub,
    setTimeout: (fn, ms) => { if (real) return setTimeout(fn, ms); const timer = { unref() {} }; timers.set(timer, { fn, ms }); return timer },
    clearTimeout: timer => { if (real) clearTimeout(timer); else timers.delete(timer) },
  })
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const localRequire = id => {
      if (id === 'node:child_process') return { spawn: () => {
        if (real) {
          const script = `const rl = require('readline').createInterface({input:process.stdin}); rl.on('line', line => { const r=JSON.parse(line); if(r.type==='submit') process.stdout.write(JSON.stringify({type:'job_finished',id:r.id,stdout:'ok'})+'\\n'); if(r.type==='shutdown'){ process.stdout.write('shutdown-received\\n'); ${mode === 'real-hung' ? '' : 'rl.close();process.stdin.destroy();'} } });`
          const child = require('node:child_process').spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
          child.output = ''; child.kills = 0
          child.stdout.on('data', chunk => { child.output += chunk.toString() })
          const kill = child.kill.bind(child)
          child.kill = (...args) => { child.kills++; return kill(...args) }
          children.push(child); return child
        }
        const child = new EventEmitter()
        Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, writes: [], kills: 0, exitCode: null, signalCode: null })
        child.stdin.write = (line, callback) => {
          child.writes.push(JSON.parse(line))
          if (child.writes.at(-1).type === 'shutdown') {
            if (mode === 'throw') throw new Error('write failed')
            if (mode === 'callback-error') callback(new Error('write failed'))
          }
          return true
        }
        child.kill = () => { child.killed = true; child.kills++; return true }
        children.push(child); return child
      } }
      if (id === 'node:crypto') return { randomUUID: () => 'job-' + ++serial }
      if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id + '.ts'))
      return require(id)
    }
    vm.runInContext('(function(require,module,exports){' + code + '\n})', context)(localRequire, module, module.exports)
    return module.exports
  }
  const api = load(path.join(root, 'src/main/rust-core/rustCoreDaemonRuntime.ts')).createRustCoreDaemonRuntime({ appendStartupLog() {} })
  const finish = child => { const id = child.writes.find(w => w.type === 'submit').id; child.stdout.emit('data', Buffer.from(JSON.stringify({ id, type: 'job_finished', stdout: 'ok' }) + '\n')) }
  return { api, children, timers, processStub, finish }
}
async function main() {
  const h = harness()
  const first = h.api.tryRun('worker', ['--local-tags-set'], { timeout: 5000 })
  const c = h.children[0]
  h.finish(c); await first
  h.api.stop()
  assert.equal(c.writes.filter(w => w.type === 'shutdown').length, 1, 'stop must actually send shutdown')
  assert.equal(c.kills, 0, 'shutdown must have a chance to exit')
  h.api.stop()
  assert.equal(c.writes.filter(w => w.type === 'shutdown').length, 1, 'repeated stop is idempotent')
  assert.equal(h.timers.size, 1)
  c.emit('exit', 0, null)
  assert.equal(h.timers.size, 0, 'graceful exit must cancel kill timer')
  assert.equal(c.kills, 0)

  for (const mode of ['normal', 'throw', 'callback-error']) {
    const h = harness(mode)
    const result = h.api.tryRun('worker', ['--local-tags-set'], { timeout: 5000 }).catch(e => e)
    const child = h.children[0]
    h.api.stop()
    const error = await result
    assert.equal(error.daemonSubmitted, true, 'stopped write must not fall back or hang')
    assert.equal(error.command, '--local-tags-set')
    assert.equal(h.api.status().pending, 0)
    if (mode === 'normal') {
      assert.equal(h.timers.size, 1, 'job timer must be cleared; only stop deadline remains')
      const deadline = [...h.timers.values()][0]
      assert(deadline.ms > 0 && deadline.ms <= 2000)
      deadline.fn()
    }
    assert.equal(child.kills, 1, mode + ' must kill once')
    assert.equal(h.timers.size, 0)
  }

  const r = harness()
  const oldResult = r.api.tryRun('old', ['--local-tags-set'], {}).catch(e => e)
  const old = r.children[0]
  const nextResult = r.api.tryRun('new', ['--local-tags-set'], {})
  const next = r.children[1]
  assert.equal((await oldResult).daemonSubmitted, true)
  old.emit('error', new Error('late old failure'))
  old.stdin.emit('error', new Error('late old stdin failure'))
  old.emit('exit', 0, null)
  assert.equal(r.api.status().pending, 1, 'old exit must not reject replacement job')
  assert.equal(r.api.status().running, true, 'old exit must not clear replacement child')
  r.finish(next); await nextResult
  r.api.stop()
  r.processStub.emit('exit', 0)
  assert.equal(next.kills, 1, 'parent exit must synchronously kill remaining child')
  assert.equal(r.timers.size, 0)
  const a = harness()
  const signal = new AbortController()
  const pending = a.api.tryRun('worker', ['--local-tags-set'], { signal: signal.signal, timeout: 1000 }).catch(e => e)
  assert.equal(require('node:events').getEventListeners(signal.signal, 'abort').length, 1)
  signal.abort('cancelled')
  assert.equal((await pending).name, 'AbortError')
  a.api.stop()
  assert.equal(require('node:events').getEventListeners(signal.signal, 'abort').length, 0)
  a.processStub.emit('exit', 0)
  assert.equal(a.timers.size, 0)

  for (const mode of ['real', 'real-hung']) {
    const actual = harness(mode)
    let child
    try {
      assert.equal((await actual.api.tryRun('worker', ['--local-tags-set'], { timeout: 2000 })).stdout, 'ok')
      child = actual.children[0]
      const exited = require('node:events').once(child, 'exit')
      actual.api.stop()
      await exited
      assert(child.output.includes('shutdown-received'), 'real process did not receive shutdown')
      assert.equal(child.kills, mode === 'real' ? 0 : 1)
    } finally {
      for (const process of actual.children) if (process.exitCode === null && process.signalCode === null) process.kill()
    }
  }
  console.log('[diagnostics:rust-daemon-shutdown] shutdown write, graceful exit, deadline, sync/async write failure, pending settlement, repeat stop, replacement isolation, abort cleanup, parent exit, real Node graceful/timeout exits passed')
}
// A hung promise is a failed gate, never a silent Node exit with status 0.
const deadline = setTimeout(() => { console.error('shutdown diagnostic timed out'); process.exit(1) }, 10000)
main().then(() => clearTimeout(deadline), error => { clearTimeout(deadline); console.error(error); process.exitCode = 1 })
