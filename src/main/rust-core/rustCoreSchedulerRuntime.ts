import { createHash } from 'node:crypto'
import { normalizePreviewRenderConcurrency, previewRenderConcurrency, previewRenderGlobalConcurrencyFloor } from './rustPreviewRenderConcurrencyRuntime'

export type RustCoreSchedulerLane = 'foreground' | 'preview' | 'scan' | 'io' | 'maintenance' | 'activation' | 'background'

export type RustCoreSchedulerProfile = {
  command: string
  lane: RustCoreSchedulerLane
  priority: number
  maxConcurrency: number
  coalesceMs: number
  cacheMs?: number
  interactive?: boolean
  backgroundThrottle?: boolean
  generationScope?: string
  cancelQueuedOnNewer?: boolean
  abortRunningOnNewer?: boolean
  discardStaleResults?: boolean
  slowMs?: number
  cooldownMs?: number
  adaptiveThrottle?: boolean
  nasSensitive?: boolean
  maxQueued?: number
  queuedTtlMs?: number
  dropQueuedOnOverflow?: boolean
}

export type RustCoreSchedulerQueuePolicy = {
  globalMaxConcurrency: number
  interactiveReserve: number
  blockBackgroundWhenInteractiveQueued: boolean
  blockMaintenanceWhenInteractiveActive: boolean
  schedulerYieldMs: number
  interactiveQuietMs: number
  adaptiveBackoffMaxMs: number
  queuedTaskPruneMs: number
}

type ScheduledTask<T> = {
  id: number
  command: string
  profile: RustCoreSchedulerProfile
  enqueuedAt: number
  key: string
  run: (signal: AbortSignal) => Promise<T>
  controller: AbortController
  generationScope?: string
  generation: number
  startedAt?: number
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

type SchedulerInFlightEntry = {
  command: string
  promise: Promise<unknown>
  globalCacheGeneration: number
  commandCacheGeneration: number
}

export type RustCoreSchedulerRuntimeOptions = {
  appendStartupLog: (message: string) => void
}

export class RustCoreSchedulerTaskCancelled extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RustCoreSchedulerTaskCancelled'
  }
}

function normalizeGenerationScope(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 80)
  return normalized || undefined
}

const DEFAULT_PROFILES: RustCoreSchedulerProfile[] = [
  { command: '--core-scheduler-profile', lane: 'foreground', priority: 110, maxConcurrency: 1, coalesceMs: 1000, cacheMs: 5000 },
  { command: '--merged-index-query-page', lane: 'foreground', priority: 100, maxConcurrency: 2, coalesceMs: 40, cacheMs: 180, generationScope: 'page-query', cancelQueuedOnNewer: true, abortRunningOnNewer: true, discardStaleResults: true },
  { command: '--merged-index-query-metrics', lane: 'foreground', priority: 96, maxConcurrency: 1, coalesceMs: 120, cacheMs: 900, generationScope: 'metrics', cancelQueuedOnNewer: true, abortRunningOnNewer: true, discardStaleResults: true },
  { command: '--merged-index-query-ids', lane: 'foreground', priority: 94, maxConcurrency: 1, coalesceMs: 80, cacheMs: 300, generationScope: 'ids-query', cancelQueuedOnNewer: true, abortRunningOnNewer: true, discardStaleResults: true },
  { command: '--preview-cache-batch', lane: 'preview', priority: 86, maxConcurrency: 1, coalesceMs: 80, cacheMs: 500 },
  { command: '--preview-cache-query', lane: 'preview', priority: 82, maxConcurrency: 1, coalesceMs: 80, cacheMs: 500 },
  { command: '--preview-cache-read-status', lane: 'preview', priority: 80, maxConcurrency: 1, coalesceMs: 60, cacheMs: 300 },
  { command: '--preview-cache-apply', lane: 'preview', priority: 66, maxConcurrency: 1, coalesceMs: 0 },
  { command: '--preview-cache-delete', lane: 'preview', priority: 68, maxConcurrency: 1, coalesceMs: 0 },
  { command: '--preview-cache-touch', lane: 'preview', priority: 45, maxConcurrency: 1, coalesceMs: 200 },
  { command: '--preview-render-image', lane: 'preview', priority: 84, maxConcurrency: previewRenderConcurrency(), coalesceMs: 20 },
  { command: '--list-font-files', lane: 'scan', priority: 28, maxConcurrency: 1, coalesceMs: 0 },
  { command: '--font-parse-batch', lane: 'scan', priority: 30, maxConcurrency: 1, coalesceMs: 0 },
  { command: '--root-index-apply-changes', lane: 'io', priority: 52, maxConcurrency: 1, coalesceMs: 0 },
  { command: '--merged-index-sync', lane: 'io', priority: 56, maxConcurrency: 1, coalesceMs: 80 },
  { command: '--merged-index-rebuild', lane: 'io', priority: 44, maxConcurrency: 1, coalesceMs: 0 },
  { command: '--shared-metadata-signature', lane: 'io', priority: 58, maxConcurrency: 1, coalesceMs: 200, cacheMs: 1000, generationScope: 'shared-metadata-signature', cancelQueuedOnNewer: true, abortRunningOnNewer: true, discardStaleResults: true },
  { command: '--shared-metadata-known-tags', lane: 'io', priority: 59, maxConcurrency: 1, coalesceMs: 200, cacheMs: 1000, generationScope: 'shared-metadata-known-tags', cancelQueuedOnNewer: true, abortRunningOnNewer: true, discardStaleResults: true },
  { command: '--shared-metadata-overlay-read', lane: 'io', priority: 61, maxConcurrency: 1, coalesceMs: 80, cacheMs: 500, generationScope: 'shared-metadata-overlay-read', cancelQueuedOnNewer: true, abortRunningOnNewer: true, discardStaleResults: true },
  { command: '--local-tags-read', lane: 'io', priority: 60, maxConcurrency: 1, coalesceMs: 80, cacheMs: 500, generationScope: 'local-tags-read', cancelQueuedOnNewer: true, abortRunningOnNewer: true, discardStaleResults: true },
  { command: '--local-tags-set', lane: 'io', priority: 72, maxConcurrency: 1, coalesceMs: 0 },
  { command: '--local-tags-delete-tag', lane: 'io', priority: 72, maxConcurrency: 1, coalesceMs: 0 },
  { command: '--shared-metadata-apply', lane: 'io', priority: 70, maxConcurrency: 1, coalesceMs: 0 },
  { command: '--shared-metadata-remove-tag', lane: 'io', priority: 70, maxConcurrency: 1, coalesceMs: 0 },
  { command: '--install-status-read', lane: 'io', priority: 54, maxConcurrency: 1, coalesceMs: 120, cacheMs: 600 },
  { command: '--install-status-save', lane: 'io', priority: 50, maxConcurrency: 1, coalesceMs: 0 },
  { command: '--install-status-compare', lane: 'background', priority: 34, maxConcurrency: 1, coalesceMs: 0 },
  { command: '--watcher-batch-preflight', lane: 'background', priority: 38, maxConcurrency: 1, coalesceMs: 100, cacheMs: 500, generationScope: 'watcher-preflight', cancelQueuedOnNewer: true, abortRunningOnNewer: true, discardStaleResults: true },
  { command: '--physical-folder-tree', lane: 'background', priority: 36, maxConcurrency: 1, coalesceMs: 300, cacheMs: 1000, generationScope: 'folder-tree', cancelQueuedOnNewer: true, abortRunningOnNewer: true, discardStaleResults: true },
  { command: '--system-installed-fonts', lane: 'background', priority: 32, maxConcurrency: 1, coalesceMs: 0 },
  { command: '--preview-cache-maintenance', lane: 'maintenance', priority: 12, maxConcurrency: 1, coalesceMs: 500 },
  { command: '--database-health-check', lane: 'maintenance', priority: 14, maxConcurrency: 1, coalesceMs: 500 },
  { command: '--database-backup', lane: 'maintenance', priority: 10, maxConcurrency: 1, coalesceMs: 0 },
  { command: '--font-resource-add', lane: 'activation', priority: 78, maxConcurrency: 1, coalesceMs: 0 },
  { command: '--font-resource-remove', lane: 'activation', priority: 78, maxConcurrency: 1, coalesceMs: 0 },
  { command: '--font-resource-notify', lane: 'activation', priority: 74, maxConcurrency: 1, coalesceMs: 80 },
  { command: '--font-registry-apply', lane: 'activation', priority: 76, maxConcurrency: 1, coalesceMs: 0 },
  { command: '--font-registry-delete', lane: 'activation', priority: 76, maxConcurrency: 1, coalesceMs: 0 },
  { command: '--font-activation-files', lane: 'activation', priority: 72, maxConcurrency: 1, coalesceMs: 0 },
]


const DURABLE_PREVIEW_COMMANDS = new Set([
  '--preview-cache-batch',
  '--preview-cache-query',
  '--preview-cache-read-status',
  '--preview-render-image',
])

function sanitizeDurablePreviewProfile(profile: RustCoreSchedulerProfile): RustCoreSchedulerProfile {
  if (!DURABLE_PREVIEW_COMMANDS.has(profile.command)) return profile
  return {
    ...profile,
    generationScope: undefined,
    cancelQueuedOnNewer: false,
    abortRunningOnNewer: false,
    discardStaleResults: false,
    dropQueuedOnOverflow: false,
  }
}

const FALLBACK_PROFILE: RustCoreSchedulerProfile = {
  command: '*',
  lane: 'background',
  priority: 20,
  maxConcurrency: 1,
  coalesceMs: 0,
  interactive: false,
  backgroundThrottle: true,
}

const DEFAULT_QUEUE_POLICY: RustCoreSchedulerQueuePolicy = {
  globalMaxConcurrency: previewRenderGlobalConcurrencyFloor(),
  interactiveReserve: 1,
  blockBackgroundWhenInteractiveQueued: true,
  blockMaintenanceWhenInteractiveActive: true,
  schedulerYieldMs: 16,
  interactiveQuietMs: 180,
  adaptiveBackoffMaxMs: 3000,
  queuedTaskPruneMs: 1000,
}

const VALID_LANES = new Set<RustCoreSchedulerLane>(['foreground', 'preview', 'scan', 'io', 'maintenance', 'activation', 'background'])

function schedulerEnabled(): boolean {
  const mode = String(process.env.HFM_RUST_CORE_SCHEDULER || '1').trim().toLowerCase()
  return mode !== '0' && mode !== 'false' && mode !== 'off'
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.round(numeric)))
}

function defaultMaxQueued(lane: RustCoreSchedulerLane): number {
  if (lane === 'foreground') return 8
  if (lane === 'preview') return 24
  if (lane === 'io') return 10
  if (lane === 'activation') return 12
  if (lane === 'maintenance') return 1
  if (lane === 'scan' || lane === 'background') return 3
  return 4
}

function defaultQueuedTtlMs(lane: RustCoreSchedulerLane): number {
  if (lane === 'foreground') return 2000
  if (lane === 'preview') return 3000
  if (lane === 'io') return 8000
  if (lane === 'activation') return 20_000
  if (lane === 'maintenance') return 30_000
  if (lane === 'scan' || lane === 'background') return 10_000
  return 5000
}

function defaultDropQueuedOnOverflow(lane: RustCoreSchedulerLane, replaceable: boolean): boolean {
  return replaceable || lane === 'scan' || lane === 'background' || lane === 'maintenance'
}

function normalizeProfile(input: unknown): RustCoreSchedulerProfile | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Partial<RustCoreSchedulerProfile>
  const command = typeof record.command === 'string' ? record.command.trim() : ''
  const lane = typeof record.lane === 'string' && VALID_LANES.has(record.lane as RustCoreSchedulerLane)
    ? record.lane as RustCoreSchedulerLane
    : null
  if (!command || !command.startsWith('--') || !lane) return null
  return {
    command,
    lane,
    priority: clampNumber(record.priority, 20, 0, 200),
    maxConcurrency: normalizePreviewRenderConcurrency(command, clampNumber(record.maxConcurrency, 1, 1, 8)),
    coalesceMs: clampNumber(record.coalesceMs, 0, 0, 5000),
    cacheMs: clampNumber(record.cacheMs, 0, 0, 10_000),
    interactive: typeof record.interactive === 'boolean' ? record.interactive : lane === 'foreground' || lane === 'preview' || lane === 'activation',
    backgroundThrottle: typeof record.backgroundThrottle === 'boolean' ? record.backgroundThrottle : lane === 'scan' || lane === 'maintenance' || lane === 'background',
    generationScope: normalizeGenerationScope(record.generationScope),
    cancelQueuedOnNewer: typeof record.cancelQueuedOnNewer === 'boolean' ? record.cancelQueuedOnNewer : false,
    abortRunningOnNewer: typeof record.abortRunningOnNewer === 'boolean' ? record.abortRunningOnNewer : false,
    discardStaleResults: typeof record.discardStaleResults === 'boolean' ? record.discardStaleResults : false,
    slowMs: clampNumber(record.slowMs, lane === 'foreground' || lane === 'preview' ? 1200 : lane === 'io' ? 2500 : 4000, 100, 60_000),
    cooldownMs: clampNumber(record.cooldownMs, lane === 'scan' || lane === 'maintenance' || lane === 'background' ? 1200 : lane === 'preview' || lane === 'io' ? 700 : 0, 0, 30_000),
    adaptiveThrottle: typeof record.adaptiveThrottle === 'boolean' ? record.adaptiveThrottle : lane === 'scan' || lane === 'maintenance' || lane === 'background' || lane === 'io',
    nasSensitive: typeof record.nasSensitive === 'boolean' ? record.nasSensitive : lane === 'scan' || lane === 'preview' || lane === 'io' || lane === 'maintenance',
    maxQueued: clampNumber(record.maxQueued, defaultMaxQueued(lane), 0, 200),
    queuedTtlMs: clampNumber(record.queuedTtlMs, defaultQueuedTtlMs(lane), 0, 120_000),
    dropQueuedOnOverflow: typeof record.dropQueuedOnOverflow === 'boolean' ? record.dropQueuedOnOverflow : defaultDropQueuedOnOverflow(lane, Boolean(record.cancelQueuedOnNewer || record.discardStaleResults)),
  }
}

function normalizeQueuePolicy(input: unknown, fallback: RustCoreSchedulerQueuePolicy = DEFAULT_QUEUE_POLICY): RustCoreSchedulerQueuePolicy {
  if (!input || typeof input !== 'object') return { ...fallback }
  const record = input as Partial<RustCoreSchedulerQueuePolicy>
  return {
    globalMaxConcurrency: Math.max(previewRenderGlobalConcurrencyFloor(), clampNumber(record.globalMaxConcurrency, fallback.globalMaxConcurrency, 1, 8)),
    interactiveReserve: clampNumber(record.interactiveReserve, fallback.interactiveReserve, 0, 4),
    blockBackgroundWhenInteractiveQueued: typeof record.blockBackgroundWhenInteractiveQueued === 'boolean' ? record.blockBackgroundWhenInteractiveQueued : fallback.blockBackgroundWhenInteractiveQueued,
    blockMaintenanceWhenInteractiveActive: typeof record.blockMaintenanceWhenInteractiveActive === 'boolean' ? record.blockMaintenanceWhenInteractiveActive : fallback.blockMaintenanceWhenInteractiveActive,
    schedulerYieldMs: clampNumber(record.schedulerYieldMs, fallback.schedulerYieldMs, 0, 250),
    interactiveQuietMs: clampNumber(record.interactiveQuietMs, fallback.interactiveQuietMs, 0, 2000),
    adaptiveBackoffMaxMs: clampNumber(record.adaptiveBackoffMaxMs, fallback.adaptiveBackoffMaxMs, 0, 30_000),
    queuedTaskPruneMs: clampNumber(record.queuedTaskPruneMs, fallback.queuedTaskPruneMs, 0, 10_000),
  }
}

function finalizeProfile(profile: RustCoreSchedulerProfile): RustCoreSchedulerProfile {
  return sanitizeDurablePreviewProfile({
    ...profile,
    interactive: typeof profile.interactive === 'boolean' ? profile.interactive : profile.lane === 'foreground' || profile.lane === 'preview' || profile.lane === 'activation',
    backgroundThrottle: typeof profile.backgroundThrottle === 'boolean' ? profile.backgroundThrottle : profile.lane === 'scan' || profile.lane === 'maintenance' || profile.lane === 'background',
    generationScope: normalizeGenerationScope(profile.generationScope),
    cancelQueuedOnNewer: Boolean(profile.cancelQueuedOnNewer),
    abortRunningOnNewer: Boolean(profile.abortRunningOnNewer),
    discardStaleResults: Boolean(profile.discardStaleResults),
    slowMs: clampNumber(profile.slowMs, profile.lane === 'foreground' || profile.lane === 'preview' ? 1200 : profile.lane === 'io' ? 2500 : 4000, 100, 60_000),
    cooldownMs: clampNumber(profile.cooldownMs, profile.lane === 'scan' || profile.lane === 'maintenance' || profile.lane === 'background' ? 1200 : profile.lane === 'preview' || profile.lane === 'io' ? 700 : 0, 0, 30_000),
    adaptiveThrottle: typeof profile.adaptiveThrottle === 'boolean' ? profile.adaptiveThrottle : profile.lane === 'scan' || profile.lane === 'maintenance' || profile.lane === 'background' || profile.lane === 'io',
    nasSensitive: typeof profile.nasSensitive === 'boolean' ? profile.nasSensitive : profile.lane === 'scan' || profile.lane === 'preview' || profile.lane === 'io' || profile.lane === 'maintenance',
    maxQueued: clampNumber(profile.maxQueued, defaultMaxQueued(profile.lane), 0, 200),
    queuedTtlMs: clampNumber(profile.queuedTtlMs, defaultQueuedTtlMs(profile.lane), 0, 120_000),
    dropQueuedOnOverflow: typeof profile.dropQueuedOnOverflow === 'boolean' ? profile.dropQueuedOnOverflow : defaultDropQueuedOnOverflow(profile.lane, Boolean(profile.cancelQueuedOnNewer || profile.discardStaleResults)),
  })
}

function buildProfiles(base: RustCoreSchedulerProfile[] = DEFAULT_PROFILES): Map<string, RustCoreSchedulerProfile> {
  const map = new Map<string, RustCoreSchedulerProfile>()
  for (const profile of base) map.set(profile.command, finalizeProfile(profile))
  return map
}

function commandFromArgs(args: string[]): string {
  return args.find((arg) => arg.startsWith('--')) || '*'
}

function stableTaskKey(command: string, args: string[]): string {
  const hash = createHash('sha1')
  hash.update(command)
  hash.update('\0')
  hash.update(args.join('\0'))
  return hash.digest('hex')
}

export function createRustCoreSchedulerRuntime(options: RustCoreSchedulerRuntimeOptions) {
  const enabled = schedulerEnabled()
  let profiles = buildProfiles()
  let queuePolicy = { ...DEFAULT_QUEUE_POLICY }
  let profileSource = 'node-default'
  const queues = new Map<RustCoreSchedulerLane, ScheduledTask<unknown>[]>()
  const activeByLane = new Map<RustCoreSchedulerLane, number>()
  const inFlightByKey = new Map<string, SchedulerInFlightEntry>()
  const resultCacheByKey = new Map<string, { command: string; expiresAt: number; value: unknown }>()
  const cacheGenerationByCommand = new Map<string, number>()
  const generationByScope = new Map<string, number>()
  let globalCacheGeneration = 0
  const activeTasks = new Set<ScheduledTask<unknown>>()
  let nextId = 1
  let loggedReady = false
  let lastInteractiveAt = 0
  let adaptiveBackoffUntil = 0
  let adaptiveBackoffReason = ''
  let adaptiveBackoffTimer: ReturnType<typeof setTimeout> | null = null
  let quietResumeTimer: ReturnType<typeof setTimeout> | null = null
  let queuedPruneTimer: ReturnType<typeof setTimeout> | null = null

  function profileFor(command: string): RustCoreSchedulerProfile {
    return profiles.get(command) || finalizeProfile({ ...FALLBACK_PROFILE, command })
  }

  function commandCacheGeneration(command: string): number {
    return cacheGenerationByCommand.get(command) || 0
  }

  function cacheGenerationIsCurrent(command: string, globalGeneration: number, commandGeneration: number): boolean {
    return globalGeneration === globalCacheGeneration && commandGeneration === commandCacheGeneration(command)
  }

  function logReadyOnce() {
    if (loggedReady) return
    loggedReady = true
    options.appendStartupLog(`rust core scheduler ready: enabled=${enabled}, profiles=${profiles.size}, source=${profileSource}, mode=${enabled ? 'rust-policy-thin-node-adapter' : 'disabled'}`)
  }

  function applyProfiles(nextProfiles: unknown, source = 'rust-worker', nextQueuePolicy?: unknown): number {
    if (!Array.isArray(nextProfiles)) return 0
    const merged = buildProfiles()
    let applied = 0
    for (const rawProfile of nextProfiles) {
      const normalized = normalizeProfile(rawProfile)
      if (!normalized) continue
      merged.set(normalized.command, finalizeProfile(normalized))
      applied += 1
    }
    if (!applied) return 0
    profiles = merged
    queuePolicy = normalizeQueuePolicy(nextQueuePolicy, queuePolicy)
    profileSource = source
    options.appendStartupLog(`rust core scheduler profile applied: source=${profileSource}, applied=${applied}, profiles=${profiles.size}, globalMax=${queuePolicy.globalMaxConcurrency}, interactiveReserve=${queuePolicy.interactiveReserve}, interactiveQuietMs=${queuePolicy.interactiveQuietMs}, queuedPruneMs=${queuePolicy.queuedTaskPruneMs}`)
    scheduleDrain()
    return applied
  }

  let drainScheduled = false

  function rejectQueuedTask(task: ScheduledTask<unknown>, reason: string): void {
    task.controller.abort()
    task.reject(new RustCoreSchedulerTaskCancelled(reason))
  }

  function pruneExpiredQueuedTasks(now = Date.now()): number {
    let removed = 0
    for (const [lane, queue] of queues.entries()) {
      if (!queue.length) continue
      const kept: ScheduledTask<unknown>[] = []
      for (const task of queue) {
        const ttlMs = Math.max(0, task.profile.queuedTtlMs || 0)
        if (task.profile.dropQueuedOnOverflow && ttlMs > 0 && now - task.enqueuedAt > ttlMs) {
          rejectQueuedTask(task, `rust scheduler queued task expired: command=${task.command}, lane=${lane}, queuedMs=${now - task.enqueuedAt}, ttlMs=${ttlMs}`)
          removed += 1
          continue
        }
        kept.push(task)
      }
      queues.set(lane, kept)
    }
    if (removed) options.appendStartupLog(`rust core scheduler queued tasks expired: removed=${removed}`)
    return removed
  }

  function enforceQueueBudget(lane: RustCoreSchedulerLane, command: string, profile: RustCoreSchedulerProfile): number {
    const maxQueued = Math.max(0, profile.maxQueued || 0)
    if (!profile.dropQueuedOnOverflow || maxQueued <= 0) return 0
    const queue = queues.get(lane)
    if (!queue?.length) return 0
    const matching = queue.filter((task) => task.command === command && task.profile.dropQueuedOnOverflow)
    if (matching.length <= maxQueued) return 0
    const toDrop = matching
      .sort((a, b) => a.profile.priority - b.profile.priority || a.enqueuedAt - b.enqueuedAt || a.id - b.id)
      .slice(0, matching.length - maxQueued)
    const dropIds = new Set(toDrop.map((task) => task.id))
    queues.set(lane, queue.filter((task) => {
      if (!dropIds.has(task.id)) return true
      rejectQueuedTask(task, `rust scheduler queued task dropped by budget: command=${task.command}, lane=${lane}, maxQueued=${maxQueued}`)
      return false
    }))
    options.appendStartupLog(`rust core scheduler queued budget applied: command=${command}, lane=${lane}, dropped=${toDrop.length}, maxQueued=${maxQueued}`)
    return toDrop.length
  }

  function scheduleQueuedPrune(): void {
    const delayMs = Math.max(0, queuePolicy.queuedTaskPruneMs || 0)
    if (!delayMs || queuedPruneTimer) return
    queuedPruneTimer = setTimeout(() => {
      queuedPruneTimer = null
      pruneExpiredQueuedTasks()
      scheduleDrain()
      if (queuedTaskCount() > 0) scheduleQueuedPrune()
    }, delayMs)
    queuedPruneTimer.unref?.()
  }

  function queuedTaskCount(): number {
    let total = 0
    for (const queue of queues.values()) total += queue.length
    return total
  }

  function scheduleDrain() {
    if (!enabled || drainScheduled) return
    drainScheduled = true
    const delayMs = Math.max(0, queuePolicy.schedulerYieldMs || 0)
    const run = () => {
      drainScheduled = false
      drain()
    }
    if (delayMs > 0) setTimeout(run, delayMs).unref?.()
    else queueMicrotask(run)
  }

  function drain() {
    if (!enabled) return
    pruneExpiredQueuedTasks()
    let startedAny = false
    let guard = 0
    do {
      startedAny = false
      guard += 1
      const lanes = Array.from(queues.keys()).sort((a, b) => laneTopPriority(b) - laneTopPriority(a))
      const interactiveQueued = hasInteractiveQueued()
      const interactiveActive = hasInteractiveActive()
      for (const lane of lanes) {
        if (totalActiveCount() >= queuePolicy.globalMaxConcurrency) break
        const queue = queues.get(lane)
        if (!queue?.length) continue
        queue.sort((a, b) => b.profile.priority - a.profile.priority || a.enqueuedAt - b.enqueuedAt || a.id - b.id)
        const task = queue[0]
        if (!task) continue
        if (shouldThrottleTask(task, interactiveQueued, interactiveActive)) continue
        const maxConcurrency = Math.max(1, task.profile.maxConcurrency || 1)
        const active = activeByLane.get(lane) || 0
        if (active >= maxConcurrency) continue
        if (!task.profile.interactive && totalActiveCount() >= Math.max(1, queuePolicy.globalMaxConcurrency - queuePolicy.interactiveReserve) && hasInteractiveQueued()) continue
        queue.shift()
        activeByLane.set(lane, active + 1)
        activeTasks.add(task)
        task.startedAt = Date.now()
        startedAny = true
        noteInteractiveActivity(task.profile)
        void task.run(task.controller.signal)
          .then((value) => {
            if (isTaskStale(task)) {
              task.reject(new RustCoreSchedulerTaskCancelled(`rust scheduler stale result discarded: command=${task.command}, scope=${task.generationScope || 'none'}, generation=${task.generation}`))
              return
            }
            task.resolve(value)
          }, task.reject)
          .finally(() => {
            observeTaskDuration(task)
            activeTasks.delete(task)
            activeByLane.set(lane, Math.max(0, (activeByLane.get(lane) || 1) - 1))
            scheduleDrain()
          })
      }
    } while (startedAny && totalActiveCount() < queuePolicy.globalMaxConcurrency && queuedTaskCount() > 0 && guard < queuePolicy.globalMaxConcurrency + 4)
  }

  function totalActiveCount(): number {
    let total = 0
    for (const active of activeByLane.values()) total += active
    return total
  }

  function hasInteractiveQueued(): boolean {
    for (const queue of queues.values()) {
      if (queue.some((task) => task.profile.interactive)) return true
    }
    return false
  }

  function hasInteractiveActive(): boolean {
    for (const [lane, active] of activeByLane.entries()) {
      if (active > 0 && (lane === 'foreground' || lane === 'preview' || lane === 'activation')) return true
    }
    return false
  }


  function adaptiveBackoffRemainingMs(now = Date.now()): number {
    if (!adaptiveBackoffUntil) return 0
    return Math.max(0, adaptiveBackoffUntil - now)
  }

  function scheduleAdaptiveBackoffResume(delayMs: number): void {
    if (adaptiveBackoffTimer) return
    const timer = setTimeout(() => {
      adaptiveBackoffTimer = null
      scheduleDrain()
    }, Math.max(1, delayMs))
    timer.unref?.()
    adaptiveBackoffTimer = timer
  }

  function shouldAdaptiveThrottle(task: ScheduledTask<unknown>): boolean {
    if (task.profile.interactive) return false
    if (!task.profile.adaptiveThrottle && !task.profile.backgroundThrottle) return false
    const remaining = adaptiveBackoffRemainingMs()
    if (remaining <= 0) return false
    scheduleAdaptiveBackoffResume(remaining)
    return true
  }

  function observeTaskDuration(task: ScheduledTask<unknown>): void {
    if (!task.startedAt) return
    const elapsedMs = Date.now() - task.startedAt
    const slowMs = Math.max(0, task.profile.slowMs || 0)
    if (!slowMs || elapsedMs < slowMs) return
    if (!task.profile.nasSensitive && !task.profile.adaptiveThrottle) return
    const cooldownMs = Math.min(
      Math.max(task.profile.cooldownMs || queuePolicy.interactiveQuietMs || 0, queuePolicy.interactiveQuietMs || 0),
      queuePolicy.adaptiveBackoffMaxMs || 0,
    )
    if (!cooldownMs) return
    const nextUntil = Date.now() + cooldownMs
    if (nextUntil <= adaptiveBackoffUntil) return
    adaptiveBackoffUntil = nextUntil
    adaptiveBackoffReason = `${task.command}:${elapsedMs}ms`
    options.appendStartupLog(`rust core scheduler adaptive backoff started: command=${task.command}, elapsedMs=${elapsedMs}, slowMs=${slowMs}, cooldownMs=${cooldownMs}`)
  }

  function shouldThrottleTask(task: ScheduledTask<unknown>, interactiveQueued: boolean, interactiveActive: boolean): boolean {
    if (task.profile.interactive) return false
    if (queuePolicy.blockBackgroundWhenInteractiveQueued && interactiveQueued && task.profile.backgroundThrottle) return true
    if (queuePolicy.blockMaintenanceWhenInteractiveActive && interactiveActive && task.profile.lane === 'maintenance') return true
    if (shouldAdaptiveThrottle(task)) return true
    const quietRemaining = interactiveQuietRemainingMs()
    if (quietRemaining > 0 && task.profile.backgroundThrottle) {
      scheduleQuietResume(quietRemaining)
      return true
    }
    return false
  }

  function noteInteractiveActivity(profile: RustCoreSchedulerProfile): void {
    if (profile.interactive) lastInteractiveAt = Date.now()
  }

  function interactiveQuietRemainingMs(now = Date.now()): number {
    const quietMs = Math.max(0, queuePolicy.interactiveQuietMs || 0)
    if (!quietMs || !lastInteractiveAt) return 0
    return Math.max(0, lastInteractiveAt + quietMs - now)
  }

  function scheduleQuietResume(delayMs: number): void {
    if (quietResumeTimer) return
    const timer = setTimeout(() => {
      quietResumeTimer = null
      scheduleDrain()
    }, Math.max(1, delayMs))
    timer.unref?.()
    quietResumeTimer = timer
  }

  function laneTopPriority(lane: RustCoreSchedulerLane): number {
    const queue = queues.get(lane)
    if (!queue?.length) return -1
    return queue.reduce((best, task) => Math.max(best, task.profile.priority), -1)
  }

  function nextGeneration(scope: string): number {
    const next = (generationByScope.get(scope) || 0) + 1
    generationByScope.set(scope, next)
    return next
  }

  function isTaskStale(task: ScheduledTask<unknown>): boolean {
    return Boolean(task.generationScope && task.profile.discardStaleResults && generationByScope.get(task.generationScope) !== task.generation)
  }

  function cancelQueuedForScope(scope: string, generation: number): number {
    let cancelled = 0
    for (const [lane, queue] of queues.entries()) {
      const kept: ScheduledTask<unknown>[] = []
      for (const task of queue) {
        if (task.generationScope === scope && task.generation < generation && task.profile.cancelQueuedOnNewer) {
          task.controller.abort()
          task.reject(new RustCoreSchedulerTaskCancelled(`rust scheduler queued task replaced: command=${task.command}, scope=${scope}, generation=${task.generation}->${generation}`))
          cancelled += 1
          continue
        }
        kept.push(task)
      }
      queues.set(lane, kept)
    }
    if (cancelled) options.appendStartupLog(`rust core scheduler queued tasks cancelled: scope=${scope}, generation=${generation}, cancelled=${cancelled}`)
    return cancelled
  }

  function abortActiveForScope(scope: string, generation: number): number {
    let aborted = 0
    for (const task of activeTasks) {
      if (task.generationScope === scope && task.generation < generation && task.profile.abortRunningOnNewer && !task.controller.signal.aborted) {
        task.controller.abort()
        aborted += 1
      }
    }
    if (aborted) options.appendStartupLog(`rust core scheduler active tasks aborted: scope=${scope}, generation=${generation}, aborted=${aborted}`)
    return aborted
  }

  function pruneExpiredResultCache(now = Date.now()): void {
    for (const [key, cached] of resultCacheByKey.entries()) {
      if (cached.expiresAt <= now) resultCacheByKey.delete(key)
    }
  }

  async function run<T>(args: string[], execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    logReadyOnce()
    if (!enabled) return execute(new AbortController().signal)
    const command = commandFromArgs(args)
    const profile = profileFor(command)
    noteInteractiveActivity(profile)
    pruneExpiredResultCache()
    const cacheMs = Math.max(0, profile.cacheMs || 0)
    const requestGlobalCacheGeneration = globalCacheGeneration
    const requestCommandCacheGeneration = commandCacheGeneration(command)
    const key = profile.coalesceMs > 0 || cacheMs > 0 ? stableTaskKey(command, args) : ''
    if (key) {
      const cached = resultCacheByKey.get(key)
      if (cached && cached.expiresAt > Date.now()) return cached.value as T
      if (cached) resultCacheByKey.delete(key)
      const existing = inFlightByKey.get(key)
      if (existing && cacheGenerationIsCurrent(command, existing.globalCacheGeneration, existing.commandCacheGeneration)) {
        return existing.promise as Promise<T>
      }
      if (existing) inFlightByKey.delete(key)
    }
    const generationScope = profile.generationScope
    const generation = generationScope && (profile.cancelQueuedOnNewer || profile.abortRunningOnNewer || profile.discardStaleResults)
      ? nextGeneration(generationScope)
      : 0
    if (generationScope && generation > 0) {
      if (profile.cancelQueuedOnNewer) cancelQueuedForScope(generationScope, generation)
      if (profile.abortRunningOnNewer) abortActiveForScope(generationScope, generation)
    }
    const promise = new Promise<T>((resolve, reject) => {
      const lane = profile.lane
      const queue = queues.get(lane) || []
      queues.set(lane, queue as ScheduledTask<unknown>[])
      queue.push({
        id: nextId += 1,
        command,
        profile,
        enqueuedAt: Date.now(),
        key,
        run: execute,
        controller: new AbortController(),
        generationScope,
        generation,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      enforceQueueBudget(lane, command, profile)
      scheduleQueuedPrune()
      scheduleDrain()
    })
    if (key) {
      const inFlightEntry: SchedulerInFlightEntry = {
        command,
        promise,
        globalCacheGeneration: requestGlobalCacheGeneration,
        commandCacheGeneration: requestCommandCacheGeneration,
      }
      inFlightByKey.set(key, inFlightEntry)
      promise.then((value) => {
        if (cacheMs > 0 && cacheGenerationIsCurrent(command, requestGlobalCacheGeneration, requestCommandCacheGeneration)) {
          resultCacheByKey.set(key, { command, expiresAt: Date.now() + cacheMs, value })
        }
      }, () => undefined)
      const cleanupDelay = Math.max(0, profile.coalesceMs)
      promise.finally(() => {
        setTimeout(() => {
          if (inFlightByKey.get(key)?.promise === promise) inFlightByKey.delete(key)
        }, cleanupDelay).unref?.()
      }).catch(() => undefined)
    }
    return promise
  }

  function invalidate(commands?: string[]): number {
    const commandSet = Array.isArray(commands) && commands.length ? new Set(commands) : null
    if (commandSet) {
      for (const command of commandSet) {
        cacheGenerationByCommand.set(command, commandCacheGeneration(command) + 1)
      }
    } else {
      globalCacheGeneration += 1
    }

    let removed = 0
    let detachedInFlight = 0
    for (const [key, cached] of resultCacheByKey.entries()) {
      if (!commandSet || commandSet.has(cached.command)) {
        resultCacheByKey.delete(key)
        removed += 1
      }
    }
    for (const [key, inFlight] of inFlightByKey.entries()) {
      if (!commandSet || commandSet.has(inFlight.command)) {
        inFlightByKey.delete(key)
        detachedInFlight += 1
      }
    }
    if (removed || detachedInFlight) {
      options.appendStartupLog(`rust core scheduler result cache invalidated: removed=${removed}, detachedInFlight=${detachedInFlight}, scope=${commandSet ? Array.from(commandSet).join(',') : 'all'}`)
    }
    return removed + detachedInFlight
  }

  function cancelScopes(scopes: string[]): number {
    let affected = 0
    for (const scope of scopes.map(normalizeGenerationScope).filter((value): value is string => Boolean(value))) {
      const generation = nextGeneration(scope)
      affected += cancelQueuedForScope(scope, generation)
      affected += abortActiveForScope(scope, generation)
    }
    return affected
  }

  function markInteractiveActivity(reason = 'external'): void {
    lastInteractiveAt = Date.now()
    scheduleDrain()
    options.appendStartupLog(`rust core scheduler interactive activity noted: reason=${String(reason).slice(0, 80)}, quietMs=${queuePolicy.interactiveQuietMs}`)
  }

  return {
    run,
    applyProfiles,
    invalidate,
    cancelScopes,
    markInteractiveActivity,
    status: () => ({ enabled, profiles: profiles.size, source: profileSource, cacheEntries: resultCacheByKey.size, active: totalActiveCount(), queued: queuedTaskCount(), activeTasks: activeTasks.size, generations: generationByScope.size, queuePolicy, lastInteractiveAt, interactiveQuietRemainingMs: interactiveQuietRemainingMs(), adaptiveBackoffRemainingMs: adaptiveBackoffRemainingMs(), adaptiveBackoffReason, lanes: Array.from(new Set(Array.from(profiles.values()).map((profile) => profile.lane))) }),
  }
}
