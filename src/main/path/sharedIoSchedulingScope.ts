import { AsyncLocalStorage } from 'node:async_hooks'
import { CACHE_MAINTENANCE_PRIORITY, type IoTaskPriority } from '../performance/ioQueue'

const priorityScope = new AsyncLocalStorage<IoTaskPriority | number>()
export function withSharedIoPriority<T>(priority: IoTaskPriority | number, operation: () => Promise<T>): Promise<T> { return priorityScope.run(priorityScope.getStore() === CACHE_MAINTENANCE_PRIORITY ? CACHE_MAINTENANCE_PRIORITY : priority, operation) }
export function currentSharedIoPriority(): IoTaskPriority | number | undefined { return priorityScope.getStore() }

const queueTimeoutScope = new AsyncLocalStorage<number>()
export function withSharedIoQueueTimeout<T>(timeoutMs: number, operation: () => Promise<T>): Promise<T> { return queueTimeoutScope.run(timeoutMs, operation) }
export function currentSharedIoQueueTimeout(): number | undefined { return queueTimeoutScope.getStore() }

