#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { runDiagnosticProcess } = require('./diagnosticProcessRuntime.cjs')

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
async function main() {
  const failed = []
  let completed = 0
  for (const script of scripts) {
    console.log(`\n[diagnostics:all] running ${script}`)
    const result = await runDiagnosticProcess(
      npmInvocation.command,
      [...npmInvocation.argsPrefix, 'run', script],
      {
        cwd: root,
        stdio: 'inherit',
        env: process.env,
        shell: npmInvocation.shell,
        // This check compiles the existing native policy fixtures on a cold runner.
        timeoutMs: script === 'diagnostics:preview-input-boundary' ? 600000 : 300000,
        onTimeout: () => console.error(`[diagnostics:all] ${script} exceeded its deadline; terminating its process tree`)
      }
    )
    completed++
    if (result.error || result.timedOut || result.terminationError) {
      console.error(`[diagnostics:all] ${script} failed: ${result.terminationError?.message || result.error?.message || 'deadline exceeded'}`)
      failed.push(script)
      // Do not start another check if the previous process tree may still be alive.
      if (result.terminationError) break
      continue
    }
    if (result.code !== 0) {
      console.error(`[diagnostics:all] ${script} failed with exit code ${result.code}, signal=${result.signal || 'none'}`)
      failed.push(script)
    }
  }

  if (failed.length) {
    console.error(`\n[diagnostics:all] failed ${failed.length}/${completed} completed checks; ${scripts.length - completed} not run:\n${failed.join('\n')}`)
    process.exitCode = 1
    return
  }
  console.log(`\n[diagnostics:all] ok (${scripts.length} checks)`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
