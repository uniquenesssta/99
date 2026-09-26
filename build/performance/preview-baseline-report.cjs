#!/usr/bin/env node
// DW-00 main-process measurements only; never infer screen-visible latency.
const fs = require('node:fs')
function summarize(text) {
  const requests = new Map()
  let malformed = 0, dropped = 0
  for (const line of text.split(/\r?\n/)) {
    const offset = line.indexOf('operation-chain: ')
    if (offset < 0) continue
    let event
    try { event = JSON.parse(line.slice(offset + 17)) } catch { malformed++; continue }
    if (!event || typeof event !== 'object') { malformed++; continue }
    if (event.dropped > 0) dropped++
    if (event.trace?.domain !== 'preview-baseline') continue
    const key = `${event.trace.sessionId}:${event.trace.operationId}`
    if (!requests.has(key)) requests.set(key, [])
    if (requests.size > 100000) throw Error('Too many requests; split the recording into rounds')
    requests.get(key).push(event)
  }
  const groups = new Map()
  let incomplete = 0
  const stats = values => {
    values = values.filter(v => Number.isFinite(v) && v >= 0).sort((a,b) => a-b)
    const at = q => values.length ? Math.round(values[Math.max(0, Math.ceil(q*values.length)-1)]*100)/100 : null
    return { n: values.length, p50Ms: at(.5), p95Ms: at(.95) }
  }
  for (const events of requests.values()) {
    const starts = events.filter(e => e.stage === 'preview-request-start')
    const ends = events.filter(e => e.stage === 'preview-request-result')
    if (starts.length !== 1 || ends.length !== 1 || !Number.isFinite(ends[0].elapsedMs) || ends[0].elapsedMs < 0) { incomplete++; continue }
    const native = events.filter(e => e.stage === 'preview-native-result')
    const signature = [...new Set(native.map(e => `${e.backend}/${e.transport}`))].sort().join('+') || 'not-observed'
    const cache = [...new Set(events.filter(e => e.stage === 'preview-cache').map(e => e.reason))].sort().join('+') || 'not-observed'
    const source = events.filter(e => e.stage === 'preview-file-source').map(e => e.reason).join('+') || 'not-observed'
    const key = JSON.stringify([starts[0].reason, cache, source, signature])
    if (!groups.has(key)) groups.set(key, { channel: starts[0].reason, cache, source, native: signature, requests: 0, rejected: 0, stages: {} })
    const group = groups.get(key)
    group.requests++
    if (ends[0].outcome === 'rejected') group.rejected++
    // Successful main returns can contain a placeholder; source is kept separate.
    for (const event of events) if (event.stage.startsWith('preview-') && event.elapsedMs !== undefined) {
      const metric = `${event.stage}:${event.outcome || 'observed'}`
      ;(group.stages[metric] ||= []).push(event.elapsedMs)
    }
  }
  return {
    schemaVersion: 1, scope: 'main-handler-only', requests: requests.size, incomplete, malformed, droppedRecords: dropped,
    usableMainRecording: requests.size > 0 && incomplete === 0 && malformed === 0 && dropped === 0,
    endToEndAccepted: false,
    limitations: ['No renderer queue/decode/visible timing', 'No inferred cold/hot font state or NAS classification', 'Stage timings can overlap; do not add or subtract percentiles', 'n counts stage observations, not always unique requests'],
    groups: [...groups.values()].map(g => ({ ...g, minimum100Requests: g.requests >= 100, stages: Object.fromEntries(Object.entries(g.stages).map(([k,v]) => [k,stats(v)])) }))
  }
}
if (require.main === module) {
  const file = process.argv[2]
  if (!file) { console.error('Usage: node build/performance/preview-baseline-report.cjs <startup.log>'); process.exitCode = 1 }
  else {
    try {
      if (fs.statSync(file).size > 32*1024*1024) throw Error('Recording exceeds 32 MiB; split into rounds')
      console.log(JSON.stringify(summarize(fs.readFileSync(file, 'utf8')), null, 2))
    } catch (error) { console.error(error.message); process.exitCode = 1 }
  }
}
module.exports = { summarize }
