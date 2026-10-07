const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), cp = require('node:child_process')
const { randomUUID } = require('node:crypto')
async function applyNativeRootIndex(root, directory, input) {
  const payload = path.join(directory, `native-${randomUUID()}.json`)
  await fs.writeFile(payload, JSON.stringify({ upserts: input.upserts.map(([relativePath, entry]) => ({ relativePath, entry })), deletes: input.deletes, directories: input.directories || [] }))
  try {
    const output = cp.spawnSync(path.join(root, 'build/native/hfm-core-worker.exe'), [input.mode === 'replace' ? '--root-index-replace' : '--root-index-apply-changes', '--db', input.dbPath, '--root', input.rootPath, '--storage', input.storage, '--input', payload, '--schema-version', String(input.schemaVersion), '--cache-version', String(input.cacheVersion), '--script-detection-version', String(input.scriptDetectionVersion)], { encoding: 'utf8', timeout: 30000 })
    assert.equal(output.status, 0, output.stdout + output.stderr)
    const receipt = JSON.parse(output.stdout.split(/\r?\n/).find(line => line.startsWith('{')))
    assert(receipt.ok && receipt.applied, output.stdout)
    return { ...receipt, applied: true, durationMs: 1 }
  } finally { await fs.rm(payload, { force: true }) }
}
module.exports = { applyNativeRootIndex }
