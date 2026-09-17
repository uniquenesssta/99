import { isDeepStrictEqual } from 'node:util'
import type { FontItem, InstallCompareResult } from '../../shared/types'

const SAVE_RETRY_DELAYS_MS = [120, 360, 900]
const BACKGROUND_RETRY_DELAY_MS = 1800

export interface ActivationInstallStatusSaveQueueDeps {
  readInstallStatusIndex: (
    items: FontItem[],
    options: { enqueueMissTasks: boolean },
  ) => Promise<{ results: Record<string, InstallCompareResult>; misses: FontItem[] }>
  saveInstallStatusIndex: (
    results: Record<string, InstallCompareResult>,
    itemsById: Map<string, FontItem>,
    options: { completeTasks: boolean },
  ) => Promise<void>
  appWatchedFolders: () => Promise<string[]>
  rootForFontPath: (fontPath: string, watchedFolders: string[]) => Promise<string | null>
  syncMergedIndexAfterInstallStatusRefresh: (roots: string[], items?: FontItem[]) => Promise<void>
  clearFontQueryCaches: () => void
  appendStartupLog: (message: string) => void
  batchDelayMs?: number
}

export interface ActivationInstallStatusSaveQueueRuntime {
  schedule: (
    results: Record<string, InstallCompareResult>,
    itemsById: Map<string, FontItem>,
    reason: string,
  ) => void
  flush: (reason: string) => Promise<void>
  applyPendingState: (items: FontItem[]) => FontItem[]
  hasPending: () => boolean
  hasInFlight: () => boolean
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

export function createActivationInstallStatusSaveQueue(
  deps: ActivationInstallStatusSaveQueueDeps,
): ActivationInstallStatusSaveQueueRuntime {
  const batchDelayMs = deps.batchDelayMs ?? 500
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let saveInFlight: Promise<void> | null = null
  let inFlightResults: Record<string, InstallCompareResult> = {}
  let pendingResults: Record<string, InstallCompareResult> = {}
  let pendingItemsById = new Map<string, FontItem>()

  function applyPendingState(items: FontItem[]): FontItem[] {
    return items.map(item => {
      const result = pendingResults[item.id] || inFlightResults[item.id]
      if (!result) return item
      return { ...item, active: result.by === 'managed' || result.by === 'both',
        installStatusKnown: true, systemInstalled: result.installed && result.by !== 'managed',
        systemInstallMatches: result.matches || [] }
    })
  }

  function pendingCount(): number {
    return Object.keys(pendingResults).length
  }

  function scheduleTimer(delayMs: number, reason: string): void {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      void flush(reason).catch(() => undefined)
    }, delayMs)
    saveTimer.unref?.()
  }

  function mergeFailedBatch(
    results: Record<string, InstallCompareResult>,
    itemsById: Map<string, FontItem>,
  ): void {
    for (const [id, result] of Object.entries(results)) {
      if (!(id in pendingResults)) pendingResults[id] = result
      if (!pendingItemsById.has(id)) {
        const item = itemsById.get(id)
        if (item) pendingItemsById.set(id, item)
      }
    }
  }

  function schedule(
    results: Record<string, InstallCompareResult>,
    itemsById: Map<string, FontItem>,
    reason: string,
  ): void {
    const ids = Object.keys(results)
    if (!ids.length) return

    for (const id of ids) {
      pendingResults[id] = results[id]
      const item = itemsById.get(id)
      if (item) pendingItemsById.set(id, item)
    }

    deps.appendStartupLog(
      `activation install status async save queued: reason=${reason}, rows=${ids.length}, pending=${pendingCount()}`,
    )
    deps.clearFontQueryCaches()
    scheduleTimer(batchDelayMs, 'timer')
  }

  async function flush(reason: string): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }

    if (saveInFlight) {
      await saveInFlight.catch(() => undefined)
      if (!pendingCount()) return
    }

    const results = pendingResults
    const itemsById = pendingItemsById
    const rowCount = Object.keys(results).length
    if (!rowCount) return

    inFlightResults = { ...results }
    pendingResults = {}
    pendingItemsById = new Map<string, FontItem>()
    const startedAt = Date.now()

    const task = (async (): Promise<void> => {
      const unchangedIds: string[] = []
      try {
        const persisted = await deps.readInstallStatusIndex(Array.from(itemsById.values()), { enqueueMissTasks: false })
        const missingIds = new Set(persisted.misses.map((item) => item.id))
        for (const [id, result] of Object.entries(results)) {
          const previous = persisted.results[id]
          if (previous && !missingIds.has(id) && previous.installed === result.installed && previous.by === result.by
            && isDeepStrictEqual(previous.matches || [], result.matches || [])) unchangedIds.push(id)
        }
      } catch (error) {
        deps.appendStartupLog(`activation install status comparison unavailable: ${error instanceof Error ? error.message : String(error)}; saving requested rows`)
      }
      if (unchangedIds.length === rowCount) {
        deps.appendStartupLog(`activation install status async save skipped: reason=${reason}, unchanged=${unchangedIds.length}, syncRoots=0`)
        return
      }
      for (const id of unchangedIds) {
        delete results[id]
        itemsById.delete(id)
      }
      const affectedItems = Array.from(itemsById.values())
      const writeCount = Object.keys(results).length
      let saved = false
      let lastError: unknown = null

      for (let attempt = 0; attempt <= SAVE_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          await deps.saveInstallStatusIndex(results, itemsById, { completeTasks: false })
          saved = true
          break
        } catch (error) {
          lastError = error
          if (attempt < SAVE_RETRY_DELAYS_MS.length) {
            await waitForRetry(SAVE_RETRY_DELAYS_MS[attempt])
          }
        }
      }

      if (!saved) {
        mergeFailedBatch(results, itemsById)
        deps.appendStartupLog(
          `activation install status async save failed: reason=${reason}, rows=${writeCount}, pending=${pendingCount()}, ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        )
        scheduleTimer(BACKGROUND_RETRY_DELAY_MS, 'background-retry')
        throw lastError instanceof Error ? lastError : new Error(String(lastError))
      }

      const saveElapsed = Date.now() - startedAt
      try {
        const watchedFolders = await deps.appWatchedFolders().catch(() => [])
        const affectedRoots = new Set<string>()
        for (const item of affectedItems) {
          const root = await deps.rootForFontPath(item.path, watchedFolders).catch(() => null)
          if (root) affectedRoots.add(root)
        }
        if (affectedRoots.size) {
          await deps.syncMergedIndexAfterInstallStatusRefresh(Array.from(affectedRoots), affectedItems)
        }
        deps.clearFontQueryCaches()
        deps.appendStartupLog(
          `activation install status async save flushed: reason=${reason}, rows=${writeCount}, unchanged=${unchangedIds.length}, saveElapsed=${saveElapsed}ms, syncRoots=${affectedRoots.size}, elapsed=${Date.now() - startedAt}ms`,
        )
      } catch (error) {
        deps.clearFontQueryCaches()
        deps.appendStartupLog(
          `activation install status post-save sync failed: reason=${reason}, rows=${rowCount}, ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })().finally(() => {
      if (saveInFlight === task) {
        saveInFlight = null
        inFlightResults = {}
        deps.clearFontQueryCaches()
      }
    })

    saveInFlight = task
    await task

    if (pendingCount()) {
      await flush(`${reason}-followup`)
    }
  }

  return {
    schedule,
    flush,
    applyPendingState,
    hasPending: () => pendingCount() > 0,
    hasInFlight: () => !!saveInFlight,
  }
}
