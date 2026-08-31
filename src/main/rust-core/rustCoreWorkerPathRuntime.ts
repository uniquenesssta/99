import { app } from 'electron'
import fs from 'node:fs'
import { dirname,join } from 'node:path'

export const RUST_CORE_WORKER_FILE_NAME = process.platform === 'win32'
  ? 'hfm-core-worker.exe'
  : 'hfm-core-worker'

export function rustCoreWorkerCandidates(): string[] {
  const configured = process.env.HFM_RUST_CORE_WORKER
  const appPath = app.getAppPath?.() || ''
  const projectRoots = Array.from(new Set([
    process.cwd(),
    appPath,
    dirname(appPath || ''),
  ].filter(Boolean)))
  const candidates = [
    configured || '',
    join(process.resourcesPath || '', 'native', RUST_CORE_WORKER_FILE_NAME),
    join(dirname(process.execPath || ''), 'resources', 'native', RUST_CORE_WORKER_FILE_NAME),
  ]
  for (const root of projectRoots) {
    candidates.push(join(root, 'build', 'native', RUST_CORE_WORKER_FILE_NAME))
    candidates.push(join(root, 'native', RUST_CORE_WORKER_FILE_NAME))
    candidates.push(join(root, 'native-src', 'hfm-core-worker', 'target', 'release', RUST_CORE_WORKER_FILE_NAME))
  }
  return Array.from(new Set(candidates.filter(Boolean)))
}

export type RustCoreWorkerPathResolution = {
  path: string | null
  candidates: string[]
}

export function resolveRustCoreWorkerPathWithDiagnostics(): RustCoreWorkerPathResolution {
  const candidates = rustCoreWorkerCandidates()
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { path: candidate, candidates }
    } catch {
      // ignore bad candidate
    }
  }
  return { path: null, candidates }
}

export function resolveRustCoreWorkerPath(): string | null {
  return resolveRustCoreWorkerPathWithDiagnostics().path
}
