import { withSharedIoPriority } from '../../path/sharedFileSystemRuntime'
import { fileRuntimeFontId } from '../../fonts/fontFileIdentity'
import { assertApplicationOpen, applicationWorkEpoch } from '../../app/shutdownCoordinatorRuntime'
import { getStartupPathRootState } from '../../path/startupPathAvailabilityRuntime'
import type {
FontItem,
InstallCompareOptions,
InstallCompareResult,
InstallStatusProgressPayload,
InstallStatusRefreshResult
} from '../../../shared/types'
import type { InstallStatusRefreshRuntimeDeps } from './installStatusRefreshTypes'
import { createFontInstallEvidenceSession } from '../fontInstallEvidenceRuntime'

export function createInstallStatusRefreshRunner(
  deps: InstallStatusRefreshRuntimeDeps,
  options: {
    installStatusRefreshBatchSize: number
    lightweightMissingThreshold: number
    readSystemInstalledFontsLightweight: () => Promise<import('../../../shared/types').SystemInstalledFont[]>
  }
) {
  async function refreshInstallStatusIndex(
    installOptions: InstallCompareOptions = {},
    runtime: { jobId?: string; emitProgress?: boolean } = {}
  ): Promise<InstallStatusRefreshResult> {
    const startedAt = Date.now()
    const epoch = applicationWorkEpoch()
    const expectedRevision = deps.installStatusWriteRevision?.()
    const jobId = runtime.jobId || `install-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const emitProgress = runtime.emitProgress !== false
    const forceFullRefresh = installOptions.force === true && installOptions.incremental !== true
    const progress = (
      payload: Omit<InstallStatusProgressPayload, 'jobId' | 'at'>
    ): void => {
      if (!emitProgress) return
      deps.emitInstallStatusProgress({ jobId, ...payload })
    }

    progress({
      stage: 'start',
      message: forceFullRefresh
        ? '正在准备全量刷新已安装状态。'
        : '正在准备增量刷新已安装状态。',
      processed: 0,
      updatedCount: 0
    })

    const folders = await deps.appWatchedFolders().catch(() => [])
    const items = await deps.loadSharedFontsForFolders(folders)
    if (!items.length) {
      const empty: InstallStatusRefreshResult = {
        mode: 'skipped',
        total: 0,
        installedCount: 0,
        installedTotalCount: 0,
        notInstalledCount: 0,
        systemMatchedCount: 0,
        systemDefaultCount: 0,
        managedCount: 0,
        updatedCount: 0,
        missingCount: 0,
        elapsedMs: Date.now() - startedAt
      }
      progress({
        stage: 'done',
        message: '已安装状态刷新完成：字体库为空。',
        total: 0,
        processed: 0,
        installedCount: 0,
        installedTotalCount: 0,
        updatedCount: 0,
        missingCount: 0,
        elapsedMs: empty.elapsedMs
      })
      return empty
    }

    let targetItems = items
    let existingResults: Record<string, InstallCompareResult> = {}
    let existingInstalledCount = 0
    let missingCount = items.length

    if (!forceFullRefresh) {
      progress({
        stage: 'reading',
        message: `正在读取本机已安装状态快照，字体库 ${items.length} 个。`,
        total: items.length,
        processed: 0,
        updatedCount: 0
      })
      const snapshotStartedAt = Date.now()
      const snapshot = await deps.readInstallStatusIndex(items, { enqueueMissTasks: false })
      existingResults = snapshot.results || {}
      const missingIds = new Set(snapshot.misses.map((item) => item.id))
      targetItems = items.filter((item) => missingIds.has(item.id))
      existingInstalledCount = Object.values(existingResults).filter((result) => result.known !== false && result.installed && result.by !== 'managed').length
      missingCount = targetItems.length

      if (!targetItems.length) {
        const installedTotalCount = await deps.readInstalledTotalSummaryForRoots(folders).catch(() => null)
        const elapsedMs = Date.now() - startedAt
        const summary: InstallStatusRefreshResult = {
          mode: 'skipped',
          total: items.length,
          installedCount: existingInstalledCount,
          installedTotalCount: installedTotalCount ?? existingInstalledCount,
          notInstalledCount: Math.max(0, items.length - existingInstalledCount),
          systemMatchedCount: existingInstalledCount,
          systemDefaultCount: 0,
          managedCount: 0,
          updatedCount: 0,
          missingCount: 0,
          elapsedMs
        }
        progress({
          stage: 'done',
          message: `已安装状态快照已是最新：已安装 ${summary.installedCount} 个，未安装 ${summary.notInstalledCount} 个，无需全量刷新。`,
          total: summary.total,
          processed: summary.total,
          installedCount: summary.installedCount,
          installedTotalCount: summary.installedTotalCount,
          updatedCount: 0,
          missingCount: 0,
          elapsedMs
        })
        deps.appendStartupLog(
          `install status incremental refresh skipped: total=${items.length}, known=${Object.keys(existingResults).length}, snapshotMs=${Date.now() - snapshotStartedAt}, durationMs=${elapsedMs}`
        )
        return summary
      }

      deps.appendStartupLog(
        `install status incremental refresh started: total=${items.length}, missing=${targetItems.length}, known=${Object.keys(existingResults).length}, snapshotMs=${Date.now() - snapshotStartedAt}`
      )
    }

    progress({
      stage: 'reading',
      message: forceFullRefresh
        ? `正在读取 Windows 已安装字体记录，字体库 ${items.length} 个。`
        : `正在读取 Windows 已安装字体记录，仅更新缺失/过期状态 ${targetItems.length}/${items.length} 个。`,
      total: items.length,
      processed: 0,
      updatedCount: 0,
      missingCount
    })

    await deps.waitForRendererIdle(forceFullRefresh ? 900 : 1600)
    await deps.delayToEventLoop()

    const useLightweightMissingRefresh =
      !forceFullRefresh &&
      targetItems.length > 0 &&
      targetItems.length <= options.lightweightMissingThreshold
    if (useLightweightMissingRefresh) {
      deps.appendStartupLog(
        `install status incremental lightweight refresh enabled: missing=${targetItems.length}, threshold=${options.lightweightMissingThreshold}`
      )
    }
    const installed = useLightweightMissingRefresh
      ? await deps.withGlobalIo(
          'system:installed-fonts-lightweight',
          () => options.readSystemInstalledFontsLightweight(),
          { priority: 'background' }
        )
      : await deps.getSystemInstalledFontsCached(forceFullRefresh)
    const rustCompareAll = await deps.runRustInstallStatusCompare?.({ appName: deps.appName || '字体管理器', items: targetItems, installed }).catch(() => null)
    const rustCompareResults = rustCompareAll?.results || null
    const rustCompareComplete = Boolean(rustCompareResults && Object.keys(rustCompareResults).length === targetItems.length)
    const installedLookup = rustCompareComplete ? null : deps.buildInstalledFontLookupIndex(installed)
    if (rustCompareResults) {
      deps.appendStartupLog(`install status compare rust fast path used: items=${targetItems.length}, results=${Object.keys(rustCompareResults).length}, complete=${rustCompareComplete}, workerElapsed=${rustCompareAll?.elapsedMs || 0}ms`)
    }
    await deps.delayToEventLoop()

    let refreshedInstalledCount = 0
    let managedCount = 0
    let updatedCount = 0
    const refreshedResults: Record<string, InstallCompareResult> = {}
    let batchResults: Record<string, InstallCompareResult> = {}
    let batchItemsById = new Map<string, FontItem>()
    const temporary = await deps.readTemporaryActiveFonts?.()
    const evidence = createFontInstallEvidenceSession({ readHistorical: deps.readHistoricalFont, installed, temporaryRecords: temporary?.records })

    const flushBatch = async (processed: number): Promise<void> => {
      const batchSize = Object.keys(batchResults).length
      if (!batchSize) return
      progress({
        stage: 'writing',
        message: forceFullRefresh
          ? `正在分批写入已安装状态：${processed}/${items.length}。`
          : `正在分批写入增量已安装状态：${processed}/${targetItems.length}。`,
        total: items.length,
        processed: forceFullRefresh ? processed : Object.keys(existingResults).length + processed,
        installedCount: existingInstalledCount + refreshedInstalledCount,
        installedTotalCount: installed.length,
        updatedCount,
        missingCount: Math.max(0, missingCount - processed)
      })
      assertApplicationOpen(epoch)
      let persistedIds: string[] | undefined
      await deps.saveInstallStatusIndex(batchResults, batchItemsById, {
        completeTasks: false, expectedRevision, onPersisted: ids => { persistedIds = ids }
      })
      updatedCount += persistedIds?.length ?? (expectedRevision === undefined ? batchSize : 0)
      assertApplicationOpen(epoch)
      if (!deps.installStatusProjectionOwnedByWriter) await deps.syncMergedIndexAfterInstallStatusRefresh([], Array.from(batchItemsById.values()))
      const persisted = await deps.readInstallStatusIndex(Array.from(batchItemsById.values()), { enqueueMissTasks: false })
      for (const item of batchItemsById.values()) refreshedResults[item.id] = persisted.results[item.id] || { installed: false, by: 'none', matches: [], known: false }
      batchResults = {}
      batchItemsById = new Map<string, FontItem>()
      await deps.delayToEventLoop()
    }

    let lastProgressAt = 0
    // Two background confirmations bound full reads without changing the shared
    // scheduler's physical slots, alias barriers or foreground priority.
    for (let index = 0; index < targetItems.length; index += 2) {
      assertApplicationOpen(epoch)
      if (Date.now() - lastProgressAt >= 250) {
        lastProgressAt = Date.now()
        progress({ stage: 'comparing', message: `正在确认字体内容与安装证据：${index}/${targetItems.length}。`,
          total: items.length, processed: Object.keys(existingResults).length + index,
          updatedCount, missingCount: Math.max(0, targetItems.length - index), elapsedMs: Date.now() - startedAt })
      }
      const settled = await withSharedIoPriority('background', () => Promise.all(targetItems.slice(index, index + 2).map(async item => {
        let result: InstallCompareResult
        const root = await deps.rootForFontPath(item.path, folders).catch(() => null)
        try {
          fileRuntimeFontId(item.path, item.fileSize, item.modifiedAt)
          if (root && getStartupPathRootState(root).state === 'offline') throw new Error('source root is offline')
          const candidates = rustCompareResults?.[item.id] || deps.compareFontInstalledWithLookupIndex(item, installedLookup)
          result = await evidence.confirm(item, candidates)
          if (root && getStartupPathRootState(root).state === 'offline') throw new Error('source root became offline')
        } catch (error) { result = { installed: false, by: 'none', matches: [], known: false, reason: `identity-unavailable: ${error instanceof Error ? error.message : String(error)}` } }
        return { item, result, root }
      })))
      assertApplicationOpen(epoch)
      for (const { item, result } of settled) {
        refreshedResults[item.id] = result
        batchItemsById.set(item.id, item); batchResults[item.id] = result
        if (result.known !== false && result.installed && result.by !== 'managed') refreshedInstalledCount++
        if (result.by === 'managed' || result.by === 'both') managedCount++
      }
      const processed = index + settled.length
      if (Object.keys(batchResults).length >= options.installStatusRefreshBatchSize) {
        await deps.waitForRendererIdle(900)
        await flushBatch(processed)
      } else if (processed % 100 === 0) await deps.delayToEventLoop()
    }

    await deps.waitForRendererIdle(900)
    await flushBatch(targetItems.length)
    await deps.saveInstalledTotalSummaryForRoots(folders, installed.length)
    assertApplicationOpen(epoch)
    const finalSnapshot = await deps.readInstallStatusIndex(items, { enqueueMissTasks: false })
    const finalResults: Record<string, InstallCompareResult> = { ...finalSnapshot.results }
    for (const item of finalSnapshot.misses) finalResults[item.id] = { installed: false, by: 'none', matches: [], known: false }
    const matchedInstalledCount = Object.values(finalResults).filter((result) => result.known !== false && result.installed && result.by !== 'managed').length
    const elapsedMs = Date.now() - startedAt
    const summary: InstallStatusRefreshResult = {
      mode: forceFullRefresh ? 'full' : 'incremental',
      total: items.length,
      installedCount: matchedInstalledCount,
      installedTotalCount: installed.length,
      notInstalledCount: Object.values(finalResults).filter(result => result.known !== false && (!result.installed || result.by === 'managed')).length,
      systemMatchedCount: matchedInstalledCount,
      systemDefaultCount: 0,
      managedCount,
      updatedCount,
      missingCount: Object.values(finalResults).filter(result => result.known === false).length,
      elapsedMs
    }

    progress({
      stage: 'done',
      message: forceFullRefresh
        ? `已安装状态全量刷新完成：字体库内已安装 ${summary.installedCount} 个，未安装 ${summary.notInstalledCount} 个，用时 ${Math.round(elapsedMs / 1000)} 秒。`
        : `已安装状态增量刷新完成：更新 ${summary.updatedCount} 个，字体库内已安装 ${summary.installedCount} 个，未安装 ${summary.notInstalledCount} 个，用时 ${Math.round(elapsedMs / 1000)} 秒。`,
      total: summary.total,
      processed: summary.total,
      installedCount: summary.installedCount,
      installedTotalCount: summary.installedTotalCount,
      updatedCount: summary.updatedCount,
      missingCount: summary.missingCount,
      elapsedMs
    })

    deps.appendStartupLog(
      `install status refresh finished: mode=${summary.mode}, total=${summary.total}, installed=${summary.installedCount}, windowsTotal=${summary.installedTotalCount || 0}, updated=${summary.updatedCount}, missing=${summary.missingCount || 0}, batch=${options.installStatusRefreshBatchSize}, durationMs=${elapsedMs}`
    )
    return summary
  }

  return { refreshInstallStatusIndex }
}
