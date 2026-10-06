import { parse } from 'node:path'
import type { FontItem, InstallCompareResult, SystemInstalledFont } from '../../shared/types'
import { readFontContentIdentity } from '../fonts/fontContentIdentityRuntime'
import { normalizePathForCacheCompare as key } from '../path/cachePath'
import { sharedFileSystem as fs } from '../path/sharedFileSystemRuntime'
import type { TemporaryActiveFontRecord } from '../windows/fontRuntime'

export type InstallSourceIdentity = Awaited<ReturnType<typeof readFontContentIdentity>> & { historical?: boolean }
export type ReadHistoricalFont = (path: string) => Promise<FontItem | undefined>

function numericFileIdentity(identity: InstallSourceIdentity): InstallSourceIdentity {
  // Shared-file IPC uses decimal strings for Win32 file IDs; local fs.Stats
  // uses numbers. Compare both in the same representation, conservatively.
  return { ...identity, dev: Number(identity.dev), ino: Number(identity.ino) }
}

// The callback reads main-owned snapshots. Never accept the renderer's recovery
// hash as authority, including when a card says that its source is missing.
export async function readInstallSourceIdentity(item: FontItem, readHistorical?: ReadHistoricalFont): Promise<InstallSourceIdentity> {
  try { return numericFileIdentity(await readFontContentIdentity(item.path)) }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' || !readHistorical) throw error
    const root = await fs.stat(parse(item.path).root)
    if (!root.isDirectory()) throw new Error('源字体所在盘当前不可访问，无法确认历史身份。')
    const saved = await readHistorical(item.path)
    let stamp: unknown[] = []
    try { stamp = JSON.parse(saved?.recoveryFileStamp || '') } catch { /* No trusted physical identity. */ }
    const values = Array.isArray(stamp) ? stamp.map(value => typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN) : []
    if (!saved || saved.id !== item.id || key(saved.path) !== key(item.path)
      || !/^[a-f0-9]{64}$/.test(saved.recoveryContentHash || '') || values.length !== 5
      || !values.every(Number.isFinite) || values[2] !== saved.fileSize || values[3] !== saved.modifiedAt) {
      throw new Error('原文件已丢失，主进程没有可核实的历史完整内容指纹，未按名称关联安装。')
    }
    return { path: saved.path, sha256: saved.recoveryContentHash!, size: values[2], modified: values[3], dev: values[0], ino: values[1], stamp: saved.recoveryFileStamp!, historical: true }
  }
}

export function independentInstallCopy(source: InstallSourceIdentity, target: InstallSourceIdentity): boolean {
  return key(source.path) !== key(target.path) && Number.isFinite(Number(source.dev)) && Number.isFinite(Number(target.dev))
    && Number(source.ino) > 0 && Number(target.ino) > 0 && (Number(source.dev) !== Number(target.dev) || Number(source.ino) !== Number(target.ino))
}

// One explicit refresh/operation owns this cache. Queries only read the confirmed
// index; they never read every font again. A later operation gets fresh evidence.
export function createFontInstallEvidenceSession(options: {
  readHistorical?: ReadHistoricalFont
  temporary?: (record: SystemInstalledFont) => boolean
  temporaryRecords?: TemporaryActiveFontRecord[]
  installed?: SystemInstalledFont[]
} = {}) {
  const reads = new Map<string, Promise<InstallSourceIdentity>>()
  const failedPaths = new Set<string>()
  const ownedBySource = new Map<string, SystemInstalledFont[]>()
  const ownedTemporary = new Set<SystemInstalledFont>()
  const registered = new Map<string, SystemInstalledFont[]>()
  for (const record of options.installed || []) {
    if (record.source !== 'HKCU' || !record.path) continue
    const identity = `${record.registryName.toLowerCase()}|${key(record.path)}`
    registered.set(identity, [...(registered.get(identity) || []), record])
  }
  for (const claim of options.temporaryRecords || []) {
    const records = registered.get(`${claim.registryName.toLowerCase()}|${key(claim.installPath)}`) || []
    const source = key(claim.sourcePath)
    ownedBySource.set(source, [...(ownedBySource.get(source) || []), ...records])
    for (const record of records) ownedTemporary.add(record)
  }
  const read = (path: string) => {
    const normalized = key(path)
    let pending = reads.get(normalized)
    if (!pending) { pending = readFontContentIdentity(path).then(numericFileIdentity); reads.set(normalized, pending) }
    return pending
  }
  async function confirm(item: FontItem, candidates: InstallCompareResult, source?: InstallSourceIdentity): Promise<InstallCompareResult> {
    candidates = { ...candidates, matches: [...new Set([...candidates.matches, ...(ownedBySource.get(key(item.path)) || [])])] }
    if (!candidates.matches.length) {
      if (item.fileAvailability === 'missing' || item.fileAvailability === 'unavailable') {
        try { await readInstallSourceIdentity(item, options.readHistorical) }
        catch (error) { return { installed: false, by: 'none', matches: [], known: false, reason: `no-candidate; source-unavailable: ${error instanceof Error ? error.message : String(error)}` } }
      }
      return { installed: false, by: 'none', matches: [], known: true, reason: 'no-candidate' }
    }
    try {
      if (!source) {
        try { source = await read(item.path) }
        catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' || !options.readHistorical) throw error
          source = await readInstallSourceIdentity(item, options.readHistorical)
        }
      }
    }
    catch (error) { return { installed: false, by: 'none', matches: [], known: false, reason: `source-unavailable: ${error instanceof Error ? error.message : String(error)}` } }
    const matches: SystemInstalledFont[] = []
    const accessFailures: Array<{ path?: string; reason: string }> = []
    let unavailable = 0, different = 0
    for (const record of candidates.matches) {
      if (!record.path) { unavailable++; failedPaths.add(''); accessFailures.push({ reason: 'record-path-missing' }); continue }
      try {
        const target = await read(record.path)
        if (target.sha256 === source.sha256) matches.push(record)
        else different++
      } catch (error) { unavailable++; failedPaths.add(key(record.path)); accessFailures.push({ path: record.path, reason: error instanceof Error ? error.message : String(error) }) }
    }
    const isTemporary = (record: SystemInstalledFont) => ownedTemporary.has(record) || options.temporary?.(record)
    const temporary = matches.some(isTemporary)
    const permanent = matches.filter(record => !isTemporary(record))
    const system = permanent.some(record => record.source === 'HKLM' || record.source === 'WindowsFontsFolder' || key(record.path || '').includes('\\windows\\fonts\\'))
    return {
      installed: matches.length > 0, known: matches.length > 0 || unavailable === 0,
      by: temporary ? (permanent.length ? 'both' : 'managed') : system ? 'system' : permanent.length ? 'user' : 'none', matches,
      reason: `content-confirmed=${matches.length}; content-mismatch=${different}; target-unavailable=${unavailable}; source=${source.historical ? 'main-history' : 'current-file'}${accessFailures.length ? `; access=${JSON.stringify(accessFailures)}` : ''}`,
    }
  }
  return { confirm, read, unavailablePaths: () => [...failedPaths] }
}
