'use strict'
// Fixture/validator contract only. Rust compilation and database behavior require --native gates.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { adaptLegacyTagSignal, assertNativeDatabaseFailure } = require('./helpers/nativeTagMutationFixture.cjs')
const root = path.resolve(__dirname, '../..')
for (const [domain, ref] of [['local_tags','934139b238ad0967068fecde8766ea38de51c37e'],['shared_metadata','cee79701ca72e63a4d829fdcccf93b099d449886']]) {
  const file = `native-src/hfm-core-worker/src/${domain}/state_machine.rs`
  const current = fs.readFileSync(path.join(root,file),'utf8')
  const identityLine = '        mutation_id: changed.then(crate::mutation_protocol::next_tag_mutation_id),'
  assert(current.includes(identityLine))
  // Default verify remains runnable without historical Git objects; the native scripts use real history.
  const fixture = process.argv.includes('--history')
    ? execFileSync('git',['show',`${ref}:${file}`],{cwd:root,encoding:'utf8'})
    : current.replace(new RegExp(identityLine.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\r?\\n'), '')
  for (const newline of ['\n','\r\n']) {
    const legacy = fixture.replace(/\r?\n/g,newline)
    assert(!legacy.includes('mutation_id:'), 'old fixture must demonstrate the missing field')
    const adapted = adaptLegacyTagSignal(legacy,domain)
    assert.equal((adapted.match(/mutation_id: None,/g)||[]).length,1)
    assert.equal(adapted.replace(`        mutation_id: None,${newline}`,''),legacy,'compatibility adapter changed historical SQL/trace behavior')
    assert.throws(()=>adaptLegacyTagSignal(adapted,domain),/already has/)
    assert.throws(()=>adaptLegacyTagSignal(legacy.replace('        trace: None,','        trace: changed_trace,'),domain),/exactly once/)
    assert.throws(()=>adaptLegacyTagSignal(legacy+legacy,domain),/exactly once/)
  }
}
assert.throws(()=>adaptLegacyTagSignal('','other'),/unsupported/)
const expected = 'catalog leaked partial writes'
// These are validator unit inputs, not reported as executed native tests.
const failure = { status:101,stdout:`thread 'test' panicked at tests/case.rs:1:\n${expected}\ntest result: FAILED`,stderr:'' }
assertNativeDatabaseFailure(failure,'database assertion',expected)
for (const invalid of [
  {...failure,status:0}, {...failure,status:null}, {...failure,error:Error('ENOENT')},
  {...failure,stdout:`error[E0063]: missing mutation_id; ${expected}`},
  {...failure,stderr:'error: could not compile hfm-core-worker'},
  {...failure,stdout:'test result: FAILED\npanicked at unrelated assertion'},
  {...failure,stdout:expected}, {...failure,stdout:`panicked at ${expected}`}
]) assert.throws(()=>assertNativeDatabaseFailure(invalid,'invalid evidence',expected))
console.log(`[diagnostics:native-tag-mutation-fixtures] two domains ${process.argv.includes('--history')?'actual historical sources':'constructor compatibility'}, LF/CRLF byte preservation, invalid fixtures rejected, 8 false native receipts rejected; Rust NOT executed`)
