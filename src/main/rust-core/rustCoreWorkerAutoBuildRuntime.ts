import { app } from 'electron'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { dirname,join } from 'node:path'
import { RUST_CORE_WORKER_FILE_NAME } from './rustCoreWorkerPathRuntime'

export type RustCoreWorkerAutoBuildResult = {
  attempted: boolean
  built: boolean
  message: string
  targetPath?: string
}

function autoBuildEnabled(): boolean {
  const mode = String(process.env.HFM_RUST_CORE_AUTOBUILD || '1').trim().toLowerCase()
  return mode !== '0' && mode !== 'false' && mode !== 'off'
}

function candidateProjectRoots(): string[] {
  const appPath = app.getAppPath?.() || ''
  return Array.from(new Set([
    process.cwd(),
    appPath,
    dirname(appPath || ''),
  ].filter(Boolean)))
}

function findRustWorkerManifest(): { root: string; manifest: string } | null {
  for (const projectRoot of candidateProjectRoots()) {
    const manifest = join(projectRoot, 'native-src', 'hfm-core-worker', 'Cargo.toml')
    try {
      if (fs.existsSync(manifest) && fs.statSync(manifest).isFile()) return { root: projectRoot, manifest }
    } catch {
      // ignore bad candidate
    }
  }
  return null
}

function cargoAvailable(): boolean {
  const result = spawnSync('cargo', ['--version'], {
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 5000,
  })
  return !result.error && result.status === 0
}

export function tryBuildRustCoreWorkerForDevelopment(): RustCoreWorkerAutoBuildResult {
  if (app.isPackaged) return { attempted: false, built: false, message: 'packaged app does not auto-build rust worker' }
  if (!autoBuildEnabled()) return { attempted: false, built: false, message: 'disabled by HFM_RUST_CORE_AUTOBUILD=0' }

  const manifestInfo = findRustWorkerManifest()
  if (!manifestInfo) return { attempted: false, built: false, message: 'Cargo.toml not found in project roots' }
  if (!cargoAvailable()) return { attempted: false, built: false, message: 'cargo not available in PATH' }

  const startedAt = Date.now()
  const build = spawnSync('cargo', ['build', '--release', '--manifest-path', manifestInfo.manifest], {
    cwd: manifestInfo.root,
    encoding: 'utf-8',
    windowsHide: true,
    timeout: Math.max(30000, Number(process.env.HFM_RUST_CORE_AUTOBUILD_TIMEOUT_MS || 180000) || 180000),
  })
  if (build.error || build.status !== 0) {
    const stderr = String(build.stderr || build.error?.message || '').trim().split(/\r?\n/).slice(-5).join(' | ')
    return { attempted: true, built: false, message: `cargo build failed status=${build.status ?? 'error'} ${stderr}`.trim() }
  }

  const builtPath = join(manifestInfo.root, 'native-src', 'hfm-core-worker', 'target', 'release', RUST_CORE_WORKER_FILE_NAME)
  const targetPath = join(manifestInfo.root, 'build', 'native', RUST_CORE_WORKER_FILE_NAME)
  try {
    if (!fs.existsSync(builtPath)) return { attempted: true, built: false, message: `built binary missing: ${builtPath}` }
    fs.mkdirSync(dirname(targetPath), { recursive: true })
    fs.copyFileSync(builtPath, targetPath)
    return { attempted: true, built: true, targetPath, message: `built in ${Date.now() - startedAt}ms` }
  } catch (error) {
    return { attempted: true, built: false, message: error instanceof Error ? error.message : String(error) }
  }
}
