'use strict'
const assert = require('node:assert/strict')

// Only adapt the post-R-06 receipt type in historical, deliberately broken SQL fixtures.
function adaptLegacyTagSignal(source, domain) {
  const type = { local_tags: 'LocalTagsMutationStateSignal', shared_metadata: 'SharedMetadataMutationStateSignal' }[domain]
  assert(type, 'unsupported historical tag domain')
  assert(!source.includes('mutation_id:'), 'fixture already has a mutation identity field')
  const anchor = new RegExp(`(    ${type} \\{)(\\r?\\n)(        trace: None,)`, 'g')
  const matches = [...source.matchAll(anchor)]
  assert.equal(matches.length, 1, 'historical signal constructor must occur exactly once')
  return source.replace(anchor, (_, header, newline, trace) => `${header}${newline}        mutation_id: None,${newline}${trace}`)
}

function assertNativeDatabaseFailure(result, label, expected) {
  assert(!result.error, `${label}: native test process did not start`)
  assert(Number.isInteger(result.status) && result.status !== 0, `${label}: must fail with a test exit code`)
  const output = String(result.stdout || '') + String(result.stderr || '')
  assert(!/could not compile|error\[E\d+\]/.test(output), `${label}: compilation failure is not database evidence: ${output}`)
  assert(output.includes('test result: FAILED') && output.includes('panicked at') && output.includes(expected), `${label}: must fail on database assertion: ${output}`)
}

module.exports = { adaptLegacyTagSignal, assertNativeDatabaseFailure }
