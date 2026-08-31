import crypto from 'node:crypto'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { CACHE_ARCHITECTURE_VERSION, ROOT_INDEX_DB_SCHEMA_VERSION } from '../../cache/constants'
import { canonicalizeWatchedFolderPathText, normalizePathCompareText, normalizeNativePathText } from '../../path/pathCanonicalizer'
import { rootCacheIdentityPath, rootCacheManifestPath, writeJsonAtomic } from './rootIndexFileRuntime'
import { sha1 } from './rootIndexSqliteRuntime'
import type { RootIndexStorage } from './rootIndexTypes'

export interface SharedRootIdentityFile {
  version: number
  rootId: string
  app?: string
  storage?: RootIndexStorage | string
  canonicalPath: string
  aliases: string[]
  architectureVersion?: number
  schemaVersion?: number
  ownerMachine?: string
  ownerPid?: number
  migratedFromCacheId?: string
  createdAt: string
  updatedAt: string
}

export interface SharedRootIdentityRuntimeDeps {
  appName: string
  exists: (filePath: string) => Promise<boolean>
  appendStartupLog: (message: string) => void
}

export function sharedRootIdentityPath(cacheDir: string): string {
  return join(cacheDir, 'root.json')
}

function stableAliasKey(value: string): string {
  return normalizePathCompareText(value)
}

function normalizeRootAlias(value: string): string {
  return canonicalizeWatchedFolderPathText(normalizeNativePathText(value))
}

function mergeAliases(values: string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of values || []) {
    const alias = normalizeRootAlias(String(raw || ''))
    if (!alias) continue
    const key = stableAliasKey(alias)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(alias)
  }
  return result
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf-8')) as T
  } catch {
    return null
  }
}


async function readManifestIdentity(cacheDir: string): Promise<Partial<SharedRootIdentityFile> | null> {
  const manifest = await readJsonFile<{
    rootId?: string
    canonicalPath?: string
    rootPath?: string
    aliases?: string[]
    storage?: RootIndexStorage | string
    updatedAt?: string
  }>(rootCacheManifestPath(cacheDir))
  const rootId = String(manifest?.rootId || '').trim()
  if (!manifest || !rootId) return null
  return {
    rootId,
    canonicalPath: normalizeRootAlias(String(manifest.canonicalPath || manifest.rootPath || '')),
    aliases: mergeAliases(manifest.aliases || []),
    storage: manifest.storage,
    updatedAt: String(manifest.updatedAt || ''),
  }
}

async function readLegacyCacheId(cacheDir: string): Promise<string | null> {
  const legacy = await readJsonFile<{ cacheId?: string }>(rootCacheIdentityPath(cacheDir))
  const cacheId = String(legacy?.cacheId || '').trim()
  return cacheId || null
}

function newRootId(rootPath: string, fallbackSeed?: string | null): string {
  if (fallbackSeed) return fallbackSeed
  return crypto.randomUUID
    ? crypto.randomUUID()
    : sha1(`${rootPath}|root|${Date.now()}|${process.pid}|${Math.random()}`)
}

function identityChanged(a: SharedRootIdentityFile | null, b: SharedRootIdentityFile): boolean {
  if (!a) return true
  if (a.rootId !== b.rootId) return true
  if (stableAliasKey(a.canonicalPath || '') !== stableAliasKey(b.canonicalPath || '')) return true
  const aAliases = mergeAliases(a.aliases || [])
  const bAliases = mergeAliases(b.aliases || [])
  if (aAliases.length !== bAliases.length) return true
  for (let index = 0; index < aAliases.length; index += 1) {
    if (stableAliasKey(aAliases[index]) !== stableAliasKey(bAliases[index])) return true
  }
  return false
}

export function createSharedRootIdentityRuntime(deps: SharedRootIdentityRuntimeDeps) {
  async function readSharedRootIdentity(cacheDir: string): Promise<SharedRootIdentityFile | null> {
    const identityPath = sharedRootIdentityPath(cacheDir)
    if (!(await deps.exists(identityPath).catch(() => false))) return null
    const parsed = await readJsonFile<Partial<SharedRootIdentityFile>>(identityPath)
    const rootId = String(parsed?.rootId || '').trim()
    if (!parsed || !rootId) return null
    return {
      version: Number(parsed.version || 1),
      rootId,
      app: parsed.app,
      storage: parsed.storage,
      canonicalPath: normalizeRootAlias(String(parsed.canonicalPath || '')),
      aliases: mergeAliases(parsed.aliases || []),
      architectureVersion: parsed.architectureVersion,
      schemaVersion: parsed.schemaVersion,
      ownerMachine: parsed.ownerMachine,
      ownerPid: parsed.ownerPid,
      migratedFromCacheId: parsed.migratedFromCacheId,
      createdAt: String(parsed.createdAt || new Date().toISOString()),
      updatedAt: String(parsed.updatedAt || parsed.createdAt || new Date().toISOString()),
    }
  }

  async function ensureSharedRootIdentity(cacheDir: string, rootPath: string, storage: RootIndexStorage): Promise<SharedRootIdentityFile> {
    const canonicalPath = normalizeRootAlias(rootPath)
    const existing = await readSharedRootIdentity(cacheDir)
    const manifestIdentity = existing ? null : await readManifestIdentity(cacheDir)
    const legacyCacheId = existing?.rootId || manifestIdentity?.rootId ? null : await readLegacyCacheId(cacheDir)
    const now = new Date().toISOString()
    const rootId = existing?.rootId || manifestIdentity?.rootId || newRootId(canonicalPath, legacyCacheId)
    const aliases = mergeAliases([
      existing?.canonicalPath || '',
      ...(existing?.aliases || []),
      manifestIdentity?.canonicalPath || '',
      ...(manifestIdentity?.aliases || []),
      rootPath,
      canonicalPath,
    ])
    const identity: SharedRootIdentityFile = {
      version: 1,
      rootId,
      app: deps.appName,
      storage: existing?.storage || manifestIdentity?.storage || storage,
      canonicalPath,
      aliases,
      architectureVersion: CACHE_ARCHITECTURE_VERSION,
      schemaVersion: ROOT_INDEX_DB_SCHEMA_VERSION,
      ownerMachine: existing?.ownerMachine || os.hostname(),
      ownerPid: existing?.ownerPid || process.pid,
      migratedFromCacheId: existing?.migratedFromCacheId || legacyCacheId || undefined,
      createdAt: existing?.createdAt || manifestIdentity?.updatedAt || now,
      updatedAt: now,
    }

    if (identityChanged(existing, identity)) {
      await writeJsonAtomic(sharedRootIdentityPath(cacheDir), identity)
      const action = existing ? 'updated' : manifestIdentity?.rootId ? 'recovered' : 'created'
      deps.appendStartupLog(
        `shared root identity ${action}: rootId=${rootId}, root=${canonicalPath}, aliases=${aliases.length}`,
      )
    }
    return identity
  }

  return {
    readSharedRootIdentity,
    ensureSharedRootIdentity,
  }
}
