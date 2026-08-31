import type { FontItem, InstallCompareResult } from '../../shared/types'

const SAVE_RETRY_DELAYS_MS = [120, 360, 900]
const BACKGROUND_RETRY_DELAY_MS = 1800

export interface ActivationInstallStatusSaveQueueDeps {
  saveInstallStatusIndex: (
    results: Record<string, InstallCompareResult>,
    itemsById: Map<string, FontItem>,
    options: { completeTasks: boolean },
  ) => Promise<void>
  appWatchedFolders: () => Promise<string[]>
  rootForFontPath: (fontPath: string, watchedFolders: string[]) => Promise<string | null>
  syncMergedIndexAfterInstallStatusRefresh: (roots: string[]) => Promise<void>
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
  let pendingResults: Record<string, InstallCompareResult> = {}
  let pendingItemsById = new Map<string, FontItem>()

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

    pendingResults = {}
    pendingItemsById = new Map<string, FontItem>()
    const startedAt = Date.now()
    const affectedItems = Array.from(itemsById.values())

    const task = (async (): Promise<void> => {
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
          `activation install status async save failed: reason=${reason}, rows=${rowCount}, pending=${pendingCount()}, ${lastError instanceof Error ? lastError.message : String(lastError)}`,
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
          await deps.syncMergedIndexAfterInstallStatusRefresh(Array.from(affectedRoots))
        }
        deps.clearFontQueryCaches()
        deps.appendStartupLog(
          `activation install status async save flushed: reason=${reason}, rows=${rowCount}, saveElapsed=${saveElapsed}ms, syncRoots=${affectedRoots.size}, elapsed=${Date.now() - startedAt}ms`,
        )
      } catch (error) {
        deps.clearFontQueryCaches()
        deps.appendStartupLog(
          `activation install status post-save sync failed: reason=${reason}, rows=${rowCount}, ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })().finally(() => {
      if (saveInFlight === task) saveInFlight = null
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
    hasPending: () => pendingCount() > 0,
    hasInFlight: () => !!saveInFlight,
  }
}
