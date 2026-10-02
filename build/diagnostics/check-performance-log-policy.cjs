#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8') }
function assert(condition, message) {
  if (!condition) {
    console.error(`[diagnostics:performance-log-policy] ${message}`)
    process.exit(1)
  }
}

const policy = read('src/main/logging/startupLogPolicy.ts')

for (const needle of [
  'function isRoutineFontRecordLog',
  'function isRoutineStateChurnLog',
  'function shouldKeepRoutinePerformanceLog',
  'HFM_LOG_DETAIL',
  'HFM_VERBOSE_LOGS',
  "text.startsWith('memory fallback page query:')",
  "text.startsWith('tag metadata barrier delayed indexed')",
  "text.startsWith('renderer perf event:')",
]) assert(policy.includes(needle), `startup log performance policy missing ${needle}`)

for (const needle of [
  'fontId=',
  'activation install status cache hit:',
  'temporary activation verify:',
  'rust core scheduler interactive activity noted:',
  'shared metadata mutation signal ignored:',
]) assert(policy.includes(needle), `startup log routine filter missing ${needle}`)


const globalIo = read('src/main/performance/globalIoRuntime.ts')
const globalIoPolicy = read('src/main/performance/globalIoLogPolicyRuntime.ts')
for (const needle of [
  'function detailedGlobalIoLogsEnabled',
  'function compactIoSnapshot',
  "if (label === 'scan:stat-font') return 2000",
  'detailedIoLogs && (before.pending > 0 || before.active >= before.concurrency)',
  'thresholdMs=',
  'queue=${compactIoSnapshot(after)}',
]) assert(globalIo.includes(needle), `global IO source log policy missing ${needle}`)

for (const needle of [
  'QUEUE_PRESSURE_LABELS',
  "'scan:stat-font'",
  'return false',
]) {
  if (needle === "'scan:stat-font'") {
    assert(!globalIoPolicy.includes(needle), 'high-volume scan:stat-font must not be queue-pressure logged below threshold')
  } else {
    assert(globalIoPolicy.includes(needle), `global IO successful log policy missing ${needle}`)
  }
}

const packageJson = JSON.parse(read('package.json'))
assert(packageJson.scripts['diagnostics:performance-log-policy'] === 'node build/diagnostics/check-performance-log-policy.cjs', 'package.json missing diagnostics:performance-log-policy script')

console.log('[diagnostics:performance-log-policy] ok')

// Fast query events must survive BOTH renderer aggregation and startup policy.
const strictAssert = require('node:assert/strict')
const { loader } = require('./check-operation-chain.cjs')
const load = loader()
const runtime = load('src/main/performance/rendererInteractionRuntime.ts')
const shouldAppend = load('src/main/logging/startupLogPolicy.ts').createStartupLogPolicy().shouldAppend
const events = []
const interaction = runtime.createRendererInteractionRuntime({ appendLog: line => { if (shouldAppend(line)) events.push(line) } })
for (const kind of ['db-query-start','db-query-end','db-query-rejected','font-query-view']) {
  interaction.reportPerformanceEvent({kind,label:'acceptance',severity:'info',durationMs:1,page:'tags',details:{keyword:'私有标签',visible:0}})
  strictAssert(events.some(line => line.includes('kind='+kind+',') && line.includes('私有标签')), 'fast evidence suppressed: '+kind)
}
strictAssert.equal(interaction.isRendererUserActive(), false, 'diagnostics must not postpone background idle work')
