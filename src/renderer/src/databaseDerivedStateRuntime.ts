import type { FontQueryPageResult,FontQueryResult } from '@shared/types'
import type { FontMetrics } from './appTypes'

interface TimerRef {
  current: number | null
}

interface RequestSeqRef {
  current: number
}

export function refreshDatabaseDerivedStateRuntime(options: {
  timerRef: TimerRef
  clearTimeout: (handle: number) => void
  setDatabasePageResult: (value: FontQueryPageResult | null) => void
  setDatabaseQueryResult: (value: FontQueryResult | null) => void
  setDatabaseFontMetrics: (value: FontMetrics | null) => void
  setDatabaseRefreshToken: (updater: (value: number) => number) => void
  databasePageRequestSeqRef: RequestSeqRef
  fontMetricsRequestSeqRef: RequestSeqRef
}): void {
  options.databasePageRequestSeqRef.current += 1
  options.fontMetricsRequestSeqRef.current += 1
  if (options.timerRef.current !== null) {
    options.clearTimeout(options.timerRef.current)
    options.timerRef.current = null
  }
  options.setDatabasePageResult(null)
  options.setDatabaseQueryResult(null)
  options.setDatabaseFontMetrics(null)
  options.setDatabaseRefreshToken((value) => value + 1)
}

export function scheduleDatabaseDerivedStateRefreshRuntime(options: {
  timerRef: TimerRef
  delay: number
  clearTimeout: (handle: number) => void
  setTimeout: (callback: () => void, delay?: number) => number
  requestIdleWindow: (callback: () => void, timeout?: number) => number
  rendererUserActive: () => boolean
  scheduleAgain: (delay: number) => void
  setDatabaseRefreshToken: (updater: (value: number) => number) => void
}): void {
  if (options.timerRef.current !== null) options.clearTimeout(options.timerRef.current)
  options.timerRef.current = options.setTimeout(() => {
    options.timerRef.current = null
    options.requestIdleWindow(() => {
      if (options.rendererUserActive()) {
        options.scheduleAgain(Math.max(options.delay, 360))
        return
      }
      options.setDatabaseRefreshToken((value) => value + 1)
    }, Math.max(500, options.delay))
  }, options.delay)
}
