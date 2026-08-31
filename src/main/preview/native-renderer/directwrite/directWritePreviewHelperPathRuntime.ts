import fs from 'node:fs'
import { dirname,join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HELPER_EXE_NAME = 'hfm-preview-renderer.exe'
const HELPER_PATH_CACHE_TTL_MS = 5000

let cachedHelperPath: string | null = null
let cachedAt = 0

function isExistingFile(filePath?: string | null): filePath is string {
  if (!filePath) return false
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function runtimeDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return process.cwd()
  }
}

export function findDirectWritePreviewHelperPath(): string | null {
  const now = Date.now()
  if (now - cachedAt < HELPER_PATH_CACHE_TTL_MS) return cachedHelperPath
  cachedAt = now

  const envPath = process.env.HFM_PREVIEW_RENDERER_PATH
  if (isExistingFile(envPath)) {
    cachedHelperPath = envPath
    return cachedHelperPath
  }

  const candidates = [
    join(process.resourcesPath || '', 'native', HELPER_EXE_NAME),
    join(dirname(process.execPath || ''), 'resources', 'native', HELPER_EXE_NAME),
    join(process.cwd(), 'build', 'native', HELPER_EXE_NAME),
    join(process.cwd(), 'native', HELPER_EXE_NAME),
    join(runtimeDir(), '..', '..', '..', 'build', 'native', HELPER_EXE_NAME)
  ]

  for (const candidate of candidates) {
    if (isExistingFile(candidate)) {
      cachedHelperPath = candidate
      return cachedHelperPath
    }
  }

  cachedHelperPath = null
  return cachedHelperPath
}

export function hasDirectWritePreviewHelper(): boolean {
  return !!findDirectWritePreviewHelperPath()
}
