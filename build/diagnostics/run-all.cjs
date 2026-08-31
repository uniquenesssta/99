#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..', '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const scripts = Object.keys(packageJson.scripts || {})
  .filter((name) => name.startsWith('diagnostics:') && name !== 'diagnostics:all')
  .sort()

if (!scripts.length) {
  console.error('[diagnostics:all] no diagnostics scripts found')
  process.exit(1)
}

function resolveNpmInvocation() {
  const npmExecPath = String(process.env.npm_execpath || '').trim()
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    return {
      command: process.execPath,
      argsPrefix: [npmExecPath],
      shell: false
    }
  }

  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    argsPrefix: [],
    shell: process.platform === 'win32'
  }
}

const npmInvocation = resolveNpmInvocation()
for (const script of scripts) {
  console.log(`\n[diagnostics:all] running ${script}`)
  const result = spawnSync(
    npmInvocation.command,
    [...npmInvocation.argsPrefix, 'run', script],
    {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
      shell: npmInvocation.shell,
      windowsHide: true
    }
  )
  if (result.error) {
    console.error(`[diagnostics:all] failed to start ${script}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`[diagnostics:all] ${script} failed with exit code ${result.status}`)
    process.exit(result.status || 1)
  }
}

console.log(`\n[diagnostics:all] ok (${scripts.length} checks)`)
