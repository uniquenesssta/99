import { AdaptiveIoQueue,type IoTaskPriority } from './ioQueue'
import type { StorageProfile,StorageProfileType } from './storageProfile'

export type IoStorageLane = StorageProfileType | 'global' | 'sqlite'

export interface GlobalIoOptions {
  priority?: IoTaskPriority | number
  signal?: AbortSignal
  storagePath?: string
  lane?: IoStorageLane | 'auto'
}

export type IoQueueSnapshot = {
  active: number
  pending: number
  concurrency: number
  lanes: Record<string, { active: number; pending: number; concurrency: number }>
}

export interface IoSchedulerOptions {
  idleConcurrency: number
  indexingConcurrency: number
  networkConcurrency: number
  hddConcurrency: number
  ssdConcurrency: number
  nvmeConcurrency: number
  removableConcurrency: number
  sqliteWriteConcurrency: number
  localScanWorkers: number
  isIndexingActive: () => boolean
  storageProfileForPath: (filePath: string) => StorageProfile
  isUserActive?: () => boolean
}

export interface IoScheduler {
  withGlobalIo<T>(label: string, fn: () => Promise<T>, options?: GlobalIoOptions): Promise<T>
  snapshot(): IoQueueSnapshot
  recheck(): void
}

const laneNames: IoStorageLane[] = ['global', 'network', 'hdd', 'ssd', 'nvme', 'removable', 'sqlite']

export function createIoScheduler(options: IoSchedulerOptions): IoScheduler {
  const queues = new Map<IoStorageLane, AdaptiveIoQueue>()

  const isUserActive = (): boolean => !!options.isUserActive?.()

  const currentGlobalConcurrency = (): number => {
    if (isUserActive()) return 1
    return options.isIndexingActive() ? options.indexingConcurrency : options.idleConcurrency
  }

  const currentStorageConcurrency = (lane: IoStorageLane): number => {
    if (lane === 'sqlite') return options.sqliteWriteConcurrency

    // 前端活跃时，所有后台 IO 自动降档。这样扫描、预览、维护仍可继续，
    // 但不会和滚动、筛选、右键、拖选争抢磁盘/NAS。
    if (isUserActive()) {
      if (lane === 'network' || lane === 'hdd' || lane === 'removable') return 1
      if (lane === 'ssd' || lane === 'nvme') return 2
      return 1
    }

    if (lane === 'network') return options.networkConcurrency
    if (lane === 'hdd') return options.isIndexingActive() ? Math.max(1, Math.min(2, options.hddConcurrency)) : options.hddConcurrency
    if (lane === 'removable') return options.removableConcurrency
    if (lane === 'ssd') return options.isIndexingActive() ? Math.max(1, Math.min(options.ssdConcurrency, options.localScanWorkers)) : options.ssdConcurrency
    if (lane === 'nvme') return options.isIndexingActive() ? Math.max(1, Math.min(options.nvmeConcurrency, options.localScanWorkers + 1)) : options.nvmeConcurrency
    return currentGlobalConcurrency()
  }

  const queueForLane = (lane: IoStorageLane): AdaptiveIoQueue => {
    const existing = queues.get(lane)
    if (existing) return existing
    const queue = new AdaptiveIoQueue(() => currentStorageConcurrency(lane))
    queues.set(lane, queue)
    return queue
  }

  const laneForProfile = (type: StorageProfileType | undefined): IoStorageLane => {
    if (type === 'network' || type === 'hdd' || type === 'ssd' || type === 'nvme' || type === 'removable') return type
    return 'global'
  }

  const resolveLane = (label: string, taskOptions: GlobalIoOptions): IoStorageLane => {
    if (taskOptions.lane && taskOptions.lane !== 'auto') return taskOptions.lane
    if (taskOptions.storagePath) return laneForProfile(options.storageProfileForPath(taskOptions.storagePath).type)
    const normalizedLabel = String(label || '').toLowerCase()
    if (normalizedLabel.includes('sqlite') || normalizedLabel.includes('db-write') || normalizedLabel.includes('root-cache-write')) return 'sqlite'
    return 'global'
  }

  return {
    withGlobalIo<T>(label: string, fn: () => Promise<T>, taskOptions: GlobalIoOptions = {}): Promise<T> {
      const lane = resolveLane(label, taskOptions)
      return queueForLane(lane).add(`${lane}:${label}`, fn, taskOptions)
    },
    snapshot(): IoQueueSnapshot {
      const lanes: IoQueueSnapshot['lanes'] = {}
      let active = 0
      let pending = 0
      let concurrency = 0
      for (const lane of laneNames) {
        const laneSnapshot = queueForLane(lane).snapshot()
        lanes[lane] = laneSnapshot
        active += laneSnapshot.active
        pending += laneSnapshot.pending
        concurrency += laneSnapshot.concurrency
      }
      return { active, pending, concurrency, lanes }
    },
    recheck(): void {
      for (const queue of queues.values()) queue.recheck()
    }
  }
}
