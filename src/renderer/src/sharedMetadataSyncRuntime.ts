import type { MutableRefObject } from 'react'
import type { HfmApi } from '../../preload'

export type SharedMetadataSyncCheckResult = {
  changed?: boolean
  rebuilt?: boolean
  roots?: number
  elapsedMs?: number
  reason?: string
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
}

export function runSharedMetadataSyncCheckRuntime(options: SharedMetadataSyncRuntimeOptions): Promise<void> | null {
  if (typeof options.hfm.checkSharedMetadataUpdates !== 'function') return null
  if (!options.libraryLoadedRef.current || options.foldersLength <= 0 || options.indexingActive) return null

  const now = Date.now()
  const minIntervalMs = Math.max(2000, options.minIntervalMs ?? 5000)
  if (now - options.lastCheckedAtRef.current < minIntervalMs) return null
  if (options.inFlightRef.current) return options.inFlightRef.current

  options.lastCheckedAtRef.current = now
  const task = (async () => {
    const result = await options.hfm.checkSharedMetadataUpdates(options.reason) as SharedMetadataSyncCheckResult
    if (!result?.changed) return

    options.refreshDatabaseDerivedState()
    const roots = Number(result.roots || 0)
    const elapsedMs = Number(result.elapsedMs || 0)
    const message = `检测到共享标签 / 收藏 / 保护变化，已同步 ${roots} 个共享索引。`
    options.setStatus(message)
    options.appendDeveloperStatus?.('shared-metadata-sync', message, { ...result, elapsedMs })
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    options.appendDeveloperStatus?.('shared-metadata-sync', `共享元数据同步检查失败：${message}`, { reason: options.reason })
  }).finally(() => {
    if (options.inFlightRef.current === task) options.inFlightRef.current = null
  })

  options.inFlightRef.current = task
  return task
}
