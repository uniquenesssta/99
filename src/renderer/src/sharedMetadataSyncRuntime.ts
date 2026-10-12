import type { MutableRefObject } from 'react'
import type { HfmApi } from '../../preload'

export type SharedMetadataSyncCheckResult = {
  changed?: boolean
  rebuilt?: boolean
  roots?: number
  elapsedMs?: number
  reason?: string
  status?: 'complete' | 'partial'
  checkedRoots?: number
  syncedRoots?: number
  deferredRoots?: number
  failedRoots?: number
  reconciliationRequired?: boolean
  blockers?: Record<string, number>
}

export type SharedMetadataSyncRuntimeOptions = {
  hfm: HfmApi
  reason: string
  foldersLength: number
  indexingActive: boolean
  libraryLoadedRef: MutableRefObject<boolean>
  inFlightRef: MutableRefObject<Promise<void> | null>
  lastCheckedAtRef: MutableRefObject<number>
  minIntervalMs?: number
  refreshDatabaseDerivedState: () => void
  setStatus: (message: string) => void
  appendDeveloperStatus?: (source: string, message: string, payload?: unknown) => void
  isClosing?: () => boolean
}

export function runSharedMetadataSyncCheckRuntime(options: SharedMetadataSyncRuntimeOptions): Promise<void> | null {
  if (options.isClosing?.()) return null
  if (typeof options.hfm.checkSharedMetadataUpdates !== 'function') return null
  if (!options.libraryLoadedRef.current || options.foldersLength <= 0 || options.indexingActive) return null

  const now = Date.now()
  const minIntervalMs = Math.max(2000, options.minIntervalMs ?? 5000)
  if (now - options.lastCheckedAtRef.current < minIntervalMs) return null
  if (options.inFlightRef.current) return options.inFlightRef.current

  options.lastCheckedAtRef.current = now
  const task = (async () => {
    const result = await options.hfm.checkSharedMetadataUpdates(options.reason) as SharedMetadataSyncCheckResult
    if (options.isClosing?.()) return
    const partial = result?.status === 'partial' || Number(result?.deferredRoots || 0) > 0
      || Number(result?.failedRoots || 0) > 0 || result?.reconciliationRequired === true
    if (!result?.changed && !partial) return

    if (result?.changed) options.refreshDatabaseDerivedState()
    const roots = Number(result?.syncedRoots ?? result?.roots ?? 0)
    const elapsedMs = Number(result.elapsedMs || 0)
    const message = partial
      ? `共享元数据仅完成部分检查：已同步 ${roots} 个索引，暂缓 ${Number(result.deferredRoots || 0)} 个，失败 ${Number(result.failedRoots || 0)} 个${result.reconciliationRequired ? '，仍需完整校验' : ''}。`
      : `检测到共享标签 / 保护变化，已同步 ${roots} 个共享索引。`
    // A quiet background deferral belongs in diagnostics; it must not replace
    // the current user action's status, nor claim every configured root synced.
    if (result.changed || /(?:manual|repair|reconcile)/i.test(options.reason)) options.setStatus(message)
    options.appendDeveloperStatus?.('shared-metadata-sync', message, { ...result, elapsedMs })
  })().catch((error) => {
    if (options.isClosing?.()) return
    const message = error instanceof Error ? error.message : String(error)
    options.appendDeveloperStatus?.('shared-metadata-sync', `共享元数据同步检查失败：${message}`, { reason: options.reason })
  }).finally(() => {
    if (options.inFlightRef.current === task) options.inFlightRef.current = null
  })

  options.inFlightRef.current = task
  return task
}
