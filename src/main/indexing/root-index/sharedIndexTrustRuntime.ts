import { promises as fsp } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT_INDEX_DB_SCHEMA_VERSION } from '../../cache/constants'
import { normalizePathCompareText } from '../../path/pathCanonicalizer'
import { rootCacheManifestPath } from './rootIndexFileRuntime'
import { sharedRootIdentityPath } from './sharedRootIdentityRuntime'
import type { RootCacheManifestFile } from './rootIndexTypes'

export interface SharedIndexTrustResult {
  trusted: boolean
  reason: string
  cacheDir: string
  activeDbPath: string
  rootId?: string
  canonicalPath?: string
  expectedFileCount?: number
}

export interface SharedIndexTrustRuntimeDeps {
  fontScanCacheVersion: number
  exists: (filePath: string) => Promise<boolean>
  rootCacheDir: (rootPath: string) => string
  rootIndexDbPath: (rootPath: string) => string
  resolveActiveRootIndexDbPath: (rootDir: string, defaultDbPath: string) => Promise<string>
  appendStartupLog: (message: string) => void
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf-8')) as T
  } catch {
    return null
  }
}

function textValue(value: unknown): string {
  return String(value || '').trim()
}

function finiteNumber(value: unknown): number | null {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function samePathIdentity(left?: string, right?: string): boolean {
  const leftKey = normalizePathCompareText(textValue(left))
  const rightKey = normalizePathCompareText(textValue(right))
  return !!leftKey && !!rightKey && leftKey === rightKey
}

export function createSharedIndexTrustRuntime(deps: SharedIndexTrustRuntimeDeps) {
  async function inspectSharedIndexTrust(rootPath: string): Promise<SharedIndexTrustResult> {
    const resolvedRoot = resolve(rootPath)
    const cacheDir = deps.rootCacheDir(resolvedRoot)
    const defaultDbPath = deps.rootIndexDbPath(resolvedRoot)
    const activeDbPath = await deps.resolveActiveRootIndexDbPath(cacheDir, defaultDbPath).catch(() => defaultDbPath)

    if (!(await deps.exists(activeDbPath).catch(() => false))) {
      return { trusted: false, reason: 'active-database-missing', cacheDir, activeDbPath }
    }

    const identity = await readJsonFile<{ rootId?: string; canonicalPath?: string }>(sharedRootIdentityPath(cacheDir))
    const manifest = await readJsonFile<RootCacheManifestFile>(rootCacheManifestPath(cacheDir))
    const identityRootId = textValue(identity?.rootId)
    const manifestRootId = textValue(manifest?.rootId)
    const rootId = identityRootId || manifestRootId || undefined

    if (identityRootId && manifestRootId && identityRootId !== manifestRootId) {
      return { trusted: false, reason: 'root-id-mismatch', cacheDir, activeDbPath, rootId: identityRootId }
    }

    const manifestSchemaVersion = finiteNumber(manifest?.schemaVersion)
    if (manifestSchemaVersion !== null && manifestSchemaVersion !== ROOT_INDEX_DB_SCHEMA_VERSION) {
      return { trusted: false, reason: 'schema-version-mismatch', cacheDir, activeDbPath, rootId }
    }

    const manifestCacheVersion = finiteNumber(manifest?.indexCacheVersion)
    if (manifestCacheVersion !== null && manifestCacheVersion !== deps.fontScanCacheVersion) {
      return { trusted: false, reason: 'index-cache-version-mismatch', cacheDir, activeDbPath, rootId }
    }

    const cacheType = textValue(manifest?.cacheType)
    if (cacheType && cacheType !== 'font-index') {
      return { trusted: false, reason: 'cache-type-mismatch', cacheDir, activeDbPath, rootId }
    }

    const canonicalPath = textValue(identity?.canonicalPath || manifest?.canonicalPath)
    if (!rootId && canonicalPath && !samePathIdentity(canonicalPath, resolvedRoot)) {
      const aliases = Array.isArray(manifest?.aliases) ? manifest?.aliases || [] : []
      const matchedAlias = aliases.some((alias) => samePathIdentity(alias, resolvedRoot))
      if (!matchedAlias) {
        return { trusted: false, reason: 'canonical-path-mismatch', cacheDir, activeDbPath, rootId, canonicalPath }
      }
    }

    return {
      trusted: true,
      reason: rootId ? 'root-id-trusted' : manifest ? 'manifest-trusted' : 'legacy-index-compatible',
      cacheDir,
      activeDbPath,
      rootId,
      canonicalPath: canonicalPath || undefined,
      expectedFileCount: finiteNumber(manifest?.fileCount) ?? undefined,
    }
  }

  return {
    inspectSharedIndexTrust,
  }
}
