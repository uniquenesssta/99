#!/usr/bin/env node
// Run the real source-text gates with LF/CRLF and deliberate contract violations.
// Only reads inside these trusted diagnostics are substituted; no files are edited.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const root = path.resolve(__dirname, '..', '..')
const fixtures = [
  {
    script: 'check-io-deadline-policy.cjs',
    source: 'src/main/preview/runtime/previewCacheStorageRuntime.ts',
    before: 'if (!batchResult.ok) {\n          for (const row of group.rows) result[row.id] = false',
    after: 'if (!batchResult.ok) {\n          for (const row of group.rows) result[row.id] = true',
    error: 'status batch timeout does not return deterministic misses'
  },
  {
    script: 'check-preview-cache-unavailable-root.cjs',
    source: 'src/main/preview/runtime/previewCacheStorageRuntime.ts',
    before: 'rootAvailability.ensureRootPreviewCacheAvailable(\n        storage.rootPath',
    after: 'Promise.resolve(\n        storage.rootPath',
    error: 'root read/write paths missing availability short-circuit'
  },
  {
    script: 'check-scan-lifecycle-durability.cjs',
    source: 'src/main/indexing/scanOrchestrator.ts',
    before: 'signal,\n      sendFontIndexChanged',
    after: 'sendFontIndexChanged',
    error: 'scan stream must receive the active scan AbortSignal'
  },
  {
    script: 'check-shared-tag-conflicts.cjs',
    source: 'src/main/library/sharedFontMetadataMutations.ts',
    before: 'if (updatedIds.length) {\n      await deps.syncSharedMetadataRootsToMergedIndex',
    after: 'if (true) {\n      await deps.syncSharedMetadataRootsToMergedIndex',
    error: 'shared tag delete should not resync all roots when no rows changed'
  },
  {
    script: 'check-folder-cache-availability.cjs',
    source: 'src/main/folders/folderCacheRuntime.ts',
    before: 'filterFolderCacheAvailableRoots(\n      normalizedFolders',
    after: 'Promise.resolve(\n      normalizedFolders',
    error: 'loadFolderCache missing availability filter'
  },
  {
    script: 'check-destructive-batch-lease-lock.cjs',
    source: 'src/renderer/src/fontFolderTreeRuntime.ts',
    before: 'const result = await options.hfm.moveFontFilesToFolder(fontsToMove, targetPhysicalPath)',
    after: 'for (const id of uniqueIds) {\n        const font = options.library.fonts[id]\n        await options.hfm.moveFontFileToFolder(font, targetPhysicalPath)\n      }\n      const result = await options.hfm.moveFontFilesToFolder(fontsToMove, targetPhysicalPath)',
    error: 'renderer should not batch move by looping single IPC calls'
  }
]

async function runFixture(fixture, eol, broken) {
  const filename = path.join(__dirname, fixture.script)
  const localRequire = createRequire(filename)
  const sourcePath = path.join(root, fixture.source)
  let sourceRead = false
  const errors = []
  const injectedFs = {
    ...fs,
    readFileSync(file, ...args) {
      const raw = fs.readFileSync(file, ...args)
      if (typeof raw !== 'string') return raw
      let text = raw.replace(/\r\n/g, '\n')
      if (path.resolve(String(file)) === sourcePath) {
        sourceRead = true
        assert(text.includes(fixture.before), `${fixture.script}: mutation anchor missing`)
        if (broken) text = text.replaceAll(fixture.before, fixture.after)
      }
      return text.replace(/\n/g, eol)
    }
  }
  let failure
  try {
    await vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      require: (id) => id === 'node:fs' ? injectedFs : localRequire(id),
      __dirname, __filename: filename,
      console: { log() {}, error(...args) { errors.push(args.join(' ')) } },
      process: { ...process, exit(code) { throw new Error(`diagnostic exit ${code}: ${errors.join('; ')}`) } },
      setImmediate, setTimeout, clearTimeout, AbortController
    }, { filename })
  } catch (error) { failure = error }
  assert(sourceRead, `${fixture.script}: target source was not read`)
  if (broken) {
    assert(failure, `${fixture.script}: broken contract was accepted`)
    assert(String(failure.message).includes(fixture.error), `${fixture.script}: wrong failure: ${failure.message}`)
  } else if (failure) { throw failure }
}

async function main() {
  let passed = 0
  const failures = []
  for (const fixture of fixtures) {
    for (const eol of ['\n', '\r\n']) {
      for (const broken of [false, true]) {
        const label = `${fixture.script}/${eol === '\n' ? 'LF' : 'CRLF'}/${broken ? 'broken' : 'valid'}`
        try { await runFixture(fixture, eol, broken); passed++ }
        catch (error) { failures.push(`${label}: ${error.message}`) }
      }
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'))
  console.log(`diagnostic line ending checks passed (${passed} cases): valid LF/CRLF sources pass; broken contracts fail`)
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
