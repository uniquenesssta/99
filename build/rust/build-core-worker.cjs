const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = process.cwd()
const required = process.argv.includes('--required')
const manifest = path.join(root, 'native-src', 'hfm-core-worker', 'Cargo.toml')
const outDir = path.join(root, 'build', 'native')
const exeName = process.platform === 'win32' ? 'hfm-core-worker.exe' : 'hfm-core-worker'
const builtBinary = path.join(root, 'native-src', 'hfm-core-worker', 'target', 'release', exeName)
const targetBinary = path.join(outDir, exeName)

function fail(message) {
  if (required) throw new Error(message)
  console.warn(`[hfm] rust core worker skipped: ${message}`)
}

if (!fs.existsSync(manifest)) {
  fail(`missing ${manifest}`)
  process.exit(0)
}

const cargoVersion = spawnSync('cargo', ['--version'], { encoding: 'utf-8' })
if (cargoVersion.error || cargoVersion.status !== 0) {
  fail('cargo is not installed or not in PATH')
  process.exit(0)
}

console.log(`[hfm] building Rust core worker with ${cargoVersion.stdout.trim()}`)
const build = spawnSync('cargo', ['build', '--release', '--manifest-path', manifest], {
  cwd: root,
  stdio: 'inherit',
})

if (build.error || build.status !== 0) {
  fail(`cargo build failed with status ${build.status}`)
  process.exit(required ? 1 : 0)
}

if (!fs.existsSync(builtBinary)) {
  fail(`built binary not found: ${builtBinary}`)
  process.exit(required ? 1 : 0)
}

fs.mkdirSync(outDir, { recursive: true })
fs.copyFileSync(builtBinary, targetBinary)
console.log(`[hfm] Rust core worker copied: ${path.relative(root, targetBinary)}`)
