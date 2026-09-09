#!/usr/bin/env node
// Run the real compiler gate with each separator spelling, on every host OS.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { spawnSync } = require('node:child_process')

const filename = path.join(__dirname, 'check-main-composition-contracts.cjs')
const source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n')
const targets = ['main-composition.virtual.ts', 'mainRuntimeRegistrationPayload.ts', 'mainCompositionContracts.ts']
const mutations = [
  ['raw overlay keys', 'const fileKey = file => host.getCanonicalFileName', 'const fileKey = file => file; // host.getCanonicalFileName', /not found/],
  ['raw diagnostic location', 'fileKey(error.file.fileName), fileKey(virtualPath)', 'error.file.fileName, virtualPath', /AssertionError/],
  ['missing legacy overlay', 'new Map([...overrides].map(([file, text]) => [fileKey(file), text]))', 'new Map()', /moveFontFilesToFolder/],
]

function run(style, eol, mutation) {
  let text = source
  if (mutation) {
    const [name, before, after] = mutation
    assert.equal(text.split(before).length, 2, `${name}: mutation anchor drifted`)
    text = text.replace(before, after)
  }
  const localRequire = createRequire(filename)
  const logs = [], errors = [], translated = new Set()
  const diagnosticProcess = { exitCode: 0 }
  const spelledPaths = { ...path, join(...parts) {
    const file = path.join(...parts)
    const target = targets.find(name => file.endsWith(name))
    if (!target) return file
    translated.add(target)
    let separator = 0
    return file.replace(/[\\/]/g, () => style === 'forward' ? '/' : style === 'backslash' ? '\\' : separator++ % 2 ? '/' : '\\')
  } }
  const compatibleFs = { ...fs, readFileSync(file, ...args) {
    // Windows accepts both spellings; give Linux the same real-file reads.
    const result = fs.readFileSync(typeof file === 'string' ? file.replace(/\\/g, '/') : file, ...args)
    return typeof result === 'string' ? result.replace(/\r\n/g, '\n').replace(/\n/g, eol) : result
  } }
  // Keep Array/Object identities in the compiler's realm so the gate retains
  // strict deep equality, including prototype checks.
  vm.compileFunction(text.replace(/\n/g, eol), ['require', '__dirname', '__filename', 'process', 'console'], { filename })(
    id => id === 'node:path' ? spelledPaths : id === 'node:fs' ? compatibleFs : localRequire(id),
    __dirname, filename, diagnosticProcess,
    { log: (...args) => logs.push(args.join(' ')), error: (...args) => errors.push(args.join(' ')) },
  )
  assert.equal(translated.size, targets.length, 'not all virtual/override/contract paths exercised')
  const output = [...logs, ...errors].join('\n')
  if (mutation) {
    assert.equal(diagnosticProcess.exitCode, 1, `${mutation[0]} was accepted`)
    assert.match(output, mutation[3], `${mutation[0]} failed for an unrelated reason`)
  } else {
    assert.equal(diagnosticProcess.exitCode, 0, output)
    assert(output.includes('125 compiler rejections; legacy omission reproduced; runtime unchanged'), output)
  }
}

// Isolate compiler programs so the compatibility matrix does not retain them
// across cases on machines with limited memory.
const caseIndex = process.argv.indexOf('--case')
if (caseIndex !== -1) {
  const index = Number(process.argv[caseIndex + 1])
  assert(Number.isInteger(index) && index >= 0 && index < 9, 'invalid compiler path case')
  if (index < 6) run(['forward', 'backslash', 'mixed'][Math.floor(index / 2)], index % 2 ? '\r\n' : '\n')
  else run('backslash', '\n', mutations[index - 6])
} else {
  for (let index = 0; index < 9; index += 1) {
    const result = spawnSync(process.execPath, [__filename, '--case', String(index)], { encoding: 'utf8' })
    assert.ifError(result.error)
    assert.equal(result.status, 0, `compiler path case ${index}: ${result.stderr || result.stdout}`)
  }
  console.log('[diagnostics:main-composition-compiler-paths] forward/backslash/mixed paths with LF/CRLF passed; 125 compiler rejections retained; 3 regressions rejected')
}
