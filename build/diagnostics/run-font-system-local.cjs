'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')

assert.equal(process.platform, 'win32', 'Real font acceptance requires local Windows')
assert(!process.env.CI && !process.env.GITHUB_ACTIONS, 'Real font acceptance must not run in CI')

const root = path.resolve(__dirname, '../..')
const output = path.join(root, 'artifacts/font-identity-f06')
fs.mkdirSync(output, { recursive: true })
const log = path.join(output, 'local-acceptance.log')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
fs.writeFileSync(log, `F06 local Windows acceptance\ncommit=${commit}\ntime=${new Date().toISOString()}\n`)
function record(text) { process.stdout.write(text); fs.appendFileSync(log, text) }
function run(command, args) {
  record(`\n> ${command} ${args.join(' ')}\n`)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true })
    child.stdout.on('data', data => { process.stdout.write(data); fs.appendFileSync(log, data) })
    child.stderr.on('data', data => { process.stderr.write(data); fs.appendFileSync(log, data) })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} failed: exit=${code}, signal=${signal || 'none'}`))
    })
  })
}
async function main() {
  record('Run from a normal user terminal. Only uniquely named test copies and HKCU test entries are mutated.\n')
  await run(process.execPath, ['build/rust/build-core-worker.cjs', '--required'])
  await run('cargo', ['test', '--locked', '--manifest-path', 'native-src/hfm-core-worker/Cargo.toml', 'font_registry::'])
  await run('cargo', ['test', '--locked', '--manifest-path', 'native-src/hfm-core-worker/Cargo.toml', 'font_mutation::', '--', '--include-ignored'])
  await run('cargo', ['test', '--locked', '--manifest-path', 'native-src/hfm-core-worker/Cargo.toml', 'preview_render::windows::local_font_tests', '--', '--include-ignored'])
  await run(process.execPath, ['build/diagnostics/check-local-user-state.cjs', '--case=uninstall-native', '--local'])
  record('\nPASS: local handle and HKCU fixture checks. Interactive app/UAC/HKLM/network acceptance is still separate.\n')
}
main().catch(error => {
  record(`\nFAIL: ${error.stack || error}\n`)
  process.exitCode = 1
}).finally(() => { process.stdout.write(`\nLog: ${log}\n`) })
