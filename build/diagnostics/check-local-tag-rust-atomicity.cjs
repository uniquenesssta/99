'use strict'
// Structural guard only. Native SQLite behavior requires the separate cargo tests.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { adaptLegacyTagSignal, assertNativeDatabaseFailure } = require('./helpers/nativeTagMutationFixture.cjs')
const root = path.resolve(__dirname, '../..')
const file = 'native-src/hfm-core-worker/src/local_tags/state_machine.rs'
function check(source) {
  for (const [name, end, read] of [['set_on_connection', 'fn apply_set_rows', 'read_bound_tags(&tx)'], ['delete_on_connection', 'fn read_tag_target_ids', 'read_tag_target_ids(&tx,']]) {
    const begin = source.indexOf(`fn ${name}(`)
    assert(begin >= 0, name)
    const body = source.slice(begin, source.indexOf(end, begin))
    const ordered = ['transaction_with_behavior(TransactionBehavior::Immediate)', 'read_known_tags(&tx)', read, 'save_known_tags(&tx, &known_tags)', 'set_meta(&tx, "localTagsUpdatedAt"', 'tx.commit()', 'trace.committed()', 'local_tag_signal(', 'trace.finish(']
    let previous = -1
    for (const token of ordered) { const index = body.indexOf(token); assert(index > previous, `${name}: ${token} outside required transaction order`); previous = index }
    assert.equal((body.match(/tx\.commit\(\)/g) || []).length, 1)
    assert(!/read_(?:known_tags|bound_tags|tag_target_ids)\(&conn/.test(body))
  }
}
function main() {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  check(source); check(source.replace(/\r?\n/g, '\r\n'))
  for (const mutate of [
    s => s.replace('save_known_tags(&tx, &known_tags)', 'save_known_tags(&conn, &known_tags)'),
    s => s.replace('set_meta(&tx, "localTagsUpdatedAt"', 'set_meta(&conn, "localTagsUpdatedAt"'),
    s => s.replace('TransactionBehavior::Immediate', 'TransactionBehavior::Deferred'),
    s => s.replace('read_known_tags(&tx)', 'read_known_tags(&conn)'),
    s => s.replace('    tx.commit().map_err(|error| error.to_string())?;\n    trace.committed();', '    trace.committed();\n    tx.commit().map_err(|error| error.to_string())?;')
  ]) assert.throws(() => check(mutate(source)))
  console.log('[diagnostics:local-tag-rust-atomicity] transaction structure/LF/CRLF and 5 mutants passed; native behavior NOT executed: cargo test --manifest-path native-src/hfm-core-worker/Cargo.toml local_tags_atomicity')
}
function native() {
  const { spawnSync } = require('node:child_process')
  const os = require('node:os')
  const manifest = path.join(root, 'native-src/hfm-core-worker/Cargo.toml')
  function cargo(args, env = process.env) {
    const result = spawnSync('cargo', args, { cwd:root, encoding:'utf8', env })
    if (result.error) throw result.error
    return result
  }
  const current = cargo(['test', '--manifest-path', manifest, 'local_tags_atomicity'])
  process.stdout.write(current.stdout); process.stderr.write(current.stderr)
  assert.equal(current.status, 0, 'native corrected implementation must pass')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-r02-mutant-'))
  try {
    // Feed an actual native receipt through the production signal runtime and R-01 validator.
    const metadata = cargo(['metadata','--manifest-path',manifest,'--no-deps','--format-version','1'])
    assert.equal(metadata.status,0)
    const binary = path.join(JSON.parse(metadata.stdout).target_directory, 'debug', process.platform === 'win32' ? 'hfm-core-worker.exe' : 'hfm-core-worker')
    const input = path.join(dir,'trace-input.json'), dbPath = path.join(dir,'trace.sqlite')
    fs.writeFileSync(input, JSON.stringify({dbPath,updatedAt:'r02-native',rows:[{itemId:'a',aliases:['a'],fontPath:'a.ttf',tagNames:['new']}],trace:{version:1,sessionId:'r02',operationId:'intent',attemptId:'attempt',batchId:'batch',domain:'localTags',members:['intent'],omitted:0,spanId:'native-span'}}))
    const receipt = spawnSync(binary,['--local-tags-set','--input',input],{encoding:'utf8'})
    if(receipt.error) throw receipt.error
    assert.equal(receipt.status,0,receipt.stderr)
    const events = receipt.stderr.split(/\r?\n/).filter(s=>s.startsWith('operation-chain: ')).map(s=>JSON.parse(s.slice(17)))
    const {loader,validateNativeStages} = require('./check-operation-chain.cjs')
    const appendStartupLog = s=>{if(s.startsWith('operation-chain: '))events.push(JSON.parse(s.slice(17)))}
    const load=loader({electron:{BrowserWindow:{getAllWindows:()=>[]}}})
    const oldDetail=process.env.HFM_LOG_DETAIL
    try {
      process.env.HFM_LOG_DETAIL='debug'
      const tagMetadataRevisionBarrier=load('src/main/library/tagMetadataRevisionBarrierRuntime.ts').createTagMetadataRevisionBarrierRuntime({appendStartupLog})
      const signals=load('src/main/library/tagMutationStateSignalRuntime.ts').createTagMutationStateSignalRuntime({tagMetadataRevisionBarrier,appendStartupLog,clearFontQueryCaches(){}})
      signals.handleLocalTagsMutationStateSignal(JSON.parse(receipt.stdout).stateSignal)
      validateNativeStages(events)
      console.log('[native:local-tag-rust-atomicity] actual worker receipt -> production signal -> R-01 causal validator passed')
    } finally { if(oldDetail===undefined)delete process.env.HFM_LOG_DETAIL;else process.env.HFM_LOG_DETAIL=oldDetail }
    const origin = path.dirname(manifest)
    for (const name of ['src', 'tests', 'Cargo.toml', 'Cargo.lock']) fs.cpSync(path.join(origin,name), path.join(dir,name), {recursive:true})
    const target = path.join(dir,'src/local_tags/state_machine.rs')
    const source = fs.readFileSync(path.join(root,file),'utf8')
    const old = execFileSync('git', ['show', `934139b238ad0967068fecde8766ea38de51c37e:${file}`], {cwd:root,encoding:'utf8'})
    const line = '    save_known_tags(&tx, &known_tags).map_err(|error| error.to_string())?;'
    const mutant = source.replace(line, '').replace('    trace.committed();', '    trace.committed();\n' + line.replace('&tx', '&conn'))
    assert.notEqual(mutant, source)
    for (const [label,text] of [['pre-fix',adaptLegacyTagSignal(old,'local_tags')],['catalog-after-commit',mutant]]) {
      fs.writeFileSync(target,text)
      const result = cargo(['test','--manifest-path',path.join(dir,'Cargo.toml'),'--test','local_tags_atomicity','local_tags_atomicity_nth_row_catalog_and_metadata_failures','--','--nocapture'], {...process.env,CARGO_TARGET_DIR:path.join(origin,'target/r02-negative')})
      assertNativeDatabaseFailure(result, label, 'catalog leaked partial writes')
      console.log(`[native:local-tag-rust-atomicity] ${label}: actual catalog rollback assertion rejected`)
    }
  } finally { fs.rmSync(dir,{recursive:true,force:true}) }
}
if (require.main === module) { main(); if (process.argv.includes('--native')) native() }
module.exports = { check }
