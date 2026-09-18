#!/usr/bin/env node
/**
 * Regression checks for shared_tag_ops replay, diagnostics, and signature participation.
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function testReplayRuntimeExists() {
  const text = readText('src/main/indexing/shared-metadata/sharedTagOpsReplayRuntime.ts')
  for (const needle of [
    'createSharedTagOpsReplayRuntime',
    'ensureSharedTagOpsReplayedInOpenDb',
    'readSharedTagOpsDiagnosticsInOpenDb',
    'sharedTagOpsReplayMaxRowId',
    'SharedTagOpsReplayConflict',
    'revisionTies',
    'latestRemovals',
  ]) {
    assert(text.includes(needle), `shared tag ops replay runtime missing ${needle}`)
  }
}

function testOverlayRunsReplayBeforeRead() {
  const text = readText('src/main/indexing/shared-metadata/sharedMetadataOverlayRuntime.ts')
  for (const needle of [
    'ensureSharedTagOpsReplayedInOpenDb?.(legacyDb, rootPath, \'overlay-rust-preflight\')',
    'ensureSharedTagOpsReplayedInOpenDb?.(db, rootPath, \'overlay-read\')',
    'ensureSharedTagOpsReplayedInOpenDb?.(db, rootPath, \'merged-row-overlay\')',
  ]) {
    assert(text.includes(needle), `shared metadata overlay missing replay hook ${needle}`)
  }
}

function testRuntimeExportsReplay() {
  const text = readText('src/main/indexing/shared-metadata/sharedFontMetadataRuntime.ts')
  for (const needle of [
    'createSharedTagOpsReplayRuntime',
    'ensureSharedTagOpsReplayedInOpenDb',
    'readSharedTagOpsDiagnosticsInOpenDb',
  ]) {
    assert(text.includes(needle), `shared metadata runtime missing ${needle}`)
  }
}

function testSignatureIncludesOps() {
  const ts = readText('src/main/indexing/shared-metadata/sharedMetadataSignatureRuntime.ts')
  const rust = readText('native-src/hfm-core-worker/src/shared_metadata/signature.rs')
  for (const needle of ['metadata-v2', 'shared_tag_ops', 'max_op_rowid']) {
    assert(ts.includes(needle), `node shared metadata signature missing ${needle}`)
    assert(rust.includes(needle), `rust shared metadata signature missing ${needle}`)
  }
}

function testSchemaVersionAndPackageScript() {
  const nodeSchema = readText('src/main/indexing/shared-metadata/sharedMetadataDbRuntime.ts')
  const rustSchema = readText('native-src/hfm-core-worker/src/shared_metadata/schema.rs')
  const pkg = readJson('package.json')
  assert(nodeSchema.includes("schemaVersion', '3"), 'node shared metadata schema version not bumped to 3')
  assert(rustSchema.includes('schemaVersion", "3'), 'rust shared metadata schema version not bumped to 3')
  assert(pkg.version === '3.0.0', 'package version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:shared-tag-ops-replay'] === 'node build/diagnostics/check-shared-tag-ops-replay.cjs', 'missing diagnostics:shared-tag-ops-replay script')
}


function testReplayAndConflictBehavior() {
  const strict = require('node:assert/strict')
  const { DatabaseSync } = require('node:sqlite')
  const { loader } = require('./check-operation-chain.cjs')
  const { execFileSync } = require('node:child_process')
  const runtimeFile = 'src/main/indexing/shared-metadata/sharedTagOpsReplayRuntime.ts'
  const load = loader()
  const schema = load('src/main/indexing/shared-metadata/sharedMetadataDbRuntime.ts').createSharedMetadataDbRuntime({})
  function fixture(ops, tags = [], transform) {
    const db = new DatabaseSync(':memory:')
    schema.initializeSharedMetadataDb(db)
    db.prepare("INSERT INTO font_metadata(font_id,tag_names_json,revision,updated_at,favorite,delete_protected) VALUES ('a',?,10,'fixed',1,1)").run(JSON.stringify(tags))
    const insert = db.prepare("INSERT INTO shared_tag_ops(op_id,font_id,tag_name,action,base_revision,next_revision,created_at,machine_id) VALUES (?,'a','设计',?,?,?,?,?)")
    ops.forEach(([action,rev,machine='pc1'],i)=>insert.run(`op${i}`,action,rev-1,rev,`2026-09-18T00:00:0${i}Z`,machine))
    const loaded = transform ? loader({}, {}, {[path.join(root,runtimeFile)]:transform}) : load
    const runtime = loaded(runtimeFile).createSharedTagOpsReplayRuntime({...schema,appendStartupLog(){}})
    return {db,runtime,row:()=>db.prepare("SELECT * FROM font_metadata WHERE font_id='a'").get()}
  }
  for(const [ops,tags,count] of [
    [[['addTag',1],['removeTag',2]],[],0],
    [[['removeTag',1],['addTag',2]],['设计'],0],
    [[['addTag',1,'pc1'],['removeTag',2,'pc2']],[],0],
    [[['addTag',2,'pc1'],['removeTag',2,'pc2']],[],1],
    [[['addTag',2,'pc1'],['addTag',2,'pc2']],['设计'],1],
    [[['addTag',1,'pc1'],['removeTag',1,'pc2'],['addTag',3,'pc3']],['设计'],0],
    [[],[],0]
  ]) {
    const h=fixture(ops,tags)
    try {
      const before=h.row()
      // Simulate an existing DB whose replay watermark and false-positive sample were persisted.
      schema.writeMeta(h.db,'sharedTagOpsReplayMaxRowId',String(ops.length))
      schema.writeMeta(h.db,'sharedTagOpsConflictCount','9')
      schema.writeMeta(h.db,'sharedTagOpsConflictSamples','[{"stale":true}]')
      const result=h.runtime.ensureSharedTagOpsReplayedInOpenDb(h.db,'/fonts')
      strict.equal(result.skipped,false,'old diagnostic policy must be recomputed even without new ops')
      strict.equal(result.conflicts,count)
      strict.equal(result.changedRows,0)
      strict.deepEqual(h.row(),before,'diagnostic correction must not change tags, favorites, protection or revision')
      strict.equal(schema.readMeta(h.db,'sharedTagOpsConflictCount'),String(count))
      strict.equal(JSON.parse(schema.readMeta(h.db,'sharedTagOpsConflictSamples')).length,count)
      strict.equal(h.runtime.readSharedTagOpsDiagnosticsInOpenDb(h.db,'/fonts').conflicts,count)
      const report=h.runtime.readSharedTagOpsConflictReportInOpenDb(h.db,'/fonts')
      strict.equal(report.conflicts,count)
      if(count) {strict.equal(report.revisionTies,1);strict.equal(report.samples[0].opCount,2)}
      else strict.equal(report.severity,'ok')
      strict.equal(h.runtime.ensureSharedTagOpsReplayedInOpenDb(h.db,'/fonts').skipped,true)
    } finally {h.db.close()}
  }
  // Policy refresh never reapplies old ops over newer metadata, even when they differ.
  {
    const h=fixture([['addTag',1],['removeTag',2]],['后来确认的标签'])
    try {
      schema.writeMeta(h.db,'sharedTagOpsReplayMaxRowId','2')
      const before=h.row()
      strict.equal(h.runtime.ensureSharedTagOpsReplayedInOpenDb(h.db,'/fonts').changedRows,0)
      strict.deepEqual(h.row(),before)
    } finally {h.db.close()}
  }
  // A later resolution clears samples as well as the conflict count.
  {
    const h=fixture([['addTag',1],['removeTag',1,'pc2']],[])
    try {
      h.runtime.ensureSharedTagOpsReplayedInOpenDb(h.db,'/fonts')
      h.db.exec("INSERT INTO shared_tag_ops(op_id,font_id,tag_name,action,base_revision,next_revision,created_at,machine_id) VALUES ('new','a','设计','addTag',1,2,'later','pc3')")
      h.db.exec("CREATE TRIGGER reject_policy BEFORE INSERT ON meta WHEN NEW.key='sharedTagOpsConflictPolicy' BEGIN SELECT RAISE(ABORT,'injected failure'); END")
      strict.throws(()=>h.runtime.ensureSharedTagOpsReplayedInOpenDb(h.db,'/fonts'),/injected failure/)
      strict.equal(h.row().tag_names_json,'[]','replay and diagnostic state roll back together')
      strict.equal(schema.readMeta(h.db,'sharedTagOpsReplayMaxRowId'),'2')
      h.db.exec('DROP TRIGGER reject_policy')
      const result=h.runtime.ensureSharedTagOpsReplayedInOpenDb(h.db,'/fonts')
      strict.equal(result.conflicts,0);strict.equal(result.changedRows,1)
      strict.deepEqual(JSON.parse(h.row().tag_names_json),['设计'])
      strict.equal(schema.readMeta(h.db,'sharedTagOpsConflictSamples'),'[]')
    } finally {h.db.close()}
  }
  // The previous implementation reports a sequential add/remove as a conflict.
  const old = execFileSync('git',['show','aebc063b1bfefd5851a645852ab375490b5770be:'+runtimeFile],{cwd:root,encoding:'utf8'})
  const h=fixture([['addTag',1],['removeTag',2]],[],()=>old)
  try {strict.equal(h.runtime.readSharedTagOpsConflictReportInOpenDb(h.db,'/fonts').conflicts,1)} finally {h.db.close()}
}

const tests = [
  testReplayAndConflictBehavior,
  testReplayRuntimeExists,
  testOverlayRunsReplayBeforeRead,
  testRuntimeExportsReplay,
  testSignatureIncludesOps,
  testSchemaVersionAndPackageScript,
]

for (const test of tests) test()
console.log(`shared tag ops replay checks passed (${tests.length})`)
