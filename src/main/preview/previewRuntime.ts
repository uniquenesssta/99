import { applicationWorkEpoch, isApplicationClosing } from '../app/shutdownCoordinatorRuntime'
import { createPreviewRenderTaskRuntime, assertPreviewRequestCurrent, type PreviewRenderTask } from './runtime/previewRenderTaskRuntime'
import type { NativePreviewLayout } from '../../shared/preview-layout/nativePreviewLayout'
import { currentPreviewRenderLifetime, isTerminalPreviewRenderFailure, withoutPreviewRenderLifetime } from './runtime/previewRenderLifetimeRuntime'
import { sharedIoAvailabilityRoot } from '../rust-core/rustSharedIoCommandRuntime'
import { claimPreviewImage } from './runtime/previewImageCommitRuntime'
import { isCompletePreviewPng } from './runtime/previewImageValidationRuntime'
import { previewFailure, previewFailureKind, previewFailureMessage, hasLegacyMissingPreviewFlag, type PreviewFailureKind } from '../../shared/previewFailure'
import { resolvePreviewSource } from './runtime/previewSourceRuntime'
import { tracePreviewPhase, createPreviewReuseObserver } from './runtime/previewTraceRuntime'
import { logOperation, currentOperationTrace } from '../logging/operationTraceContext'
import { sharedFileSystem as fsp, withSharedPreviewReads, currentSharedIoSignal } from '../path/sharedFileSystemRuntime'
import { validatePreviewInput } from './runtime/previewInputPolicy'
import { join,resolve } from 'node:path'
import type { FontItem } from '../../shared/types'
import { findBestWatchedRootForFile } from '../path/fontPathPolicy'
import { withIoDeadlineResult,withPhysicalIoCompletion,fileExistsTimeoutMs,awaitPhysicalIoClose } from '../path/ioDeadlineRuntime'
import { createCachedPreviewReadRuntime } from './runtime/cachedPreviewReadRuntime'
import { createPreviewFontDataRuntime } from './runtime/previewFontDataRuntime'
import { createPreviewImageMemoryRuntime } from './runtime/previewImageMemoryRuntime'
import { createPreviewNativeRenderer } from './native-renderer/previewNativeRendererRuntime'
import { DEFAULT_PREVIEW_TEXT,previewCacheKey,previewCacheTextHash,previewFontSignature } from './runtime/previewCacheKeyRuntime'
import { createPreviewCacheStorageRuntime } from './runtime/previewCacheStorageRuntime'
import { createPreviewCachePublishRuntime } from './runtime/previewCachePublishRuntime'
import { createPreviewCacheMetaRuntime } from './runtime/previewCacheMetaRuntime'
import { createPreviewCacheManifestRuntime } from './runtime/previewCacheManifestRuntime'
import { previewCacheIdentityForInstalledRoute,previewCacheStatForInstalledRoute,resolveInstalledFontPreviewRoute } from './runtime/previewInstalledFontRouteRuntime'
import type { PreviewImageFileResult,PreviewRuntimeOptions } from './runtime/previewRuntimeTypes'

export type { PreviewCacheStorage,PreviewImageFileResult,PreviewRuntimeOptions } from './runtime/previewRuntimeTypes'

export function createPreviewRuntime(options: PreviewRuntimeOptions) {
  const reuseObserver = createPreviewReuseObserver(options.appendStartupLog)
  const previewImageMemoryRuntime = createPreviewImageMemoryRuntime()
  const renderTasks = createPreviewRenderTaskRuntime()
  const nativeRenderInFlight = new Map<string, PreviewRenderTask<{ bytes: Buffer; message: string; transient: boolean }>>()
  const failedUntil = new Map<string, { until: number; error: Error }>()
  const renderTraceOwners = new Map<string, string>()

  const {
    appendStartupLog,
    sha1,
    ensureWindows,
    resolveExistingFontFilePath,
    authorizeFontRead,
    previewTaskKey,
    completeBackgroundTask,
    upsertBackgroundTask,
    startBackgroundTask,
    heartbeatBackgroundTask,
    failBackgroundTask,
    execFileAsync,
    withGlobalIo
  } = options

  const {
    previewCacheStorageForFont,
    readPreviewCacheIndexStatus,
    writePreviewCacheIndex,
    deletePreviewCacheIndex,
    getPreviewCacheStatus,
    readCachedPreviewImages,
    hydratePreviewCache,
    rememberPreviewCacheRenderQueued,
    previewCacheStorageToShared,
    ensureSharedPreviewCacheAvailable,
    invalidateLibraryShellCache
  } = createPreviewCacheStorageRuntime(options)

  const previewCacheMetaRuntime = createPreviewCacheMetaRuntime({ appendStartupLog })
  const previewCacheManifestRuntime = createPreviewCacheManifestRuntime({
    appendStartupLog,
    withIoDeadlineResult,
    readSharedPreviewCacheMeta: previewCacheMetaRuntime.readPreviewCacheMeta,
  })

  const previewCachePublishRuntime = createPreviewCachePublishRuntime({
    appendStartupLog,
    withIoDeadlineResult,
    writePreviewCacheIndex,
    previewCacheStorageToShared,
    ensureSharedAvailable: ensureSharedPreviewCacheAvailable,
    writeSharedPreviewCacheMeta: previewCacheMetaRuntime.writePreviewCacheMeta,
    validateSharedPreviewCacheMeta: previewCacheMetaRuntime.validatePreviewCacheMeta,
    appendSharedPreviewCacheManifest: previewCacheManifestRuntime.appendPreviewCacheManifestEntry,
  })

  const nativePreviewRenderer = createPreviewNativeRenderer({
    appendStartupLog,
    execFileAsync,
    runRustPreviewRenderImage: options.runRustPreviewRenderImage
  })

  const readPreviewFontData = createPreviewFontDataRuntime({
    ensureWindows,
    authorizeFontRead,
    withGlobalIo
  })

  const {
    readCachedFontPreviewImage,
    readCachedFontPreviewImages
  } = createCachedPreviewReadRuntime({
    appendStartupLog,
    ensureWindows,
    sha1,
    previewCacheStorageForFont,
    readPreviewCacheIndexStatus,
    readCachedPreviewImages
  })

  async function readValidCachedImage(path: string, required = false): Promise<Buffer | undefined> {
    const result = await withIoDeadlineResult('preview-cache-validate', () => tracePreviewPhase('image-read', () => fsp.readFile(path)), fileExistsTimeoutMs())
    if (!result.ok && required) {
      await awaitPhysicalIoClose(result.error)
      if (isTerminalPreviewRenderFailure(result.error)) throw result.error
      throw previewFailure(result.timedOut ? 'timeout' : previewFailureKind(result.error))
    }
    return result.ok && isCompletePreviewPng(result.value) ? result.value : undefined
  }

  async function ensureFontPreviewImageFile(
    item: FontItem,
    text: string,
    fontSize = 44,
    width = 720,
    height = 260,
    preferCachedFontStat = false,
    ignorePreviewIndex = false,
    foreground = true,
    layout?: NativePreviewLayout
  ): Promise<PreviewImageFileResult | null> {
    ensureWindows()
    const requestEpoch = applicationWorkEpoch(), requestSignal = currentSharedIoSignal()
    const assertCurrent = () => assertPreviewRequestCurrent(requestEpoch, requestSignal)
    assertCurrent()

    const resolvedFontPath = resolve(item.path)
    const { text: normalizedText } = validatePreviewInput({ text, fontSize, width, height, layout }, appendStartupLog)
    const installedRoute = resolveInstalledFontPreviewRoute(item)
    const previewCache = await tracePreviewPhase('storage-prepare', () => previewCacheStorageForFont(resolvedFontPath))
    assertCurrent()
    let verifiedSource: Awaited<ReturnType<typeof resolvePreviewSource>> | undefined
    let imageBytes: Buffer | undefined
    let stat = (installedRoute || preferCachedFontStat) ? previewCacheStatForInstalledRoute(
      item,
      installedRoute,
      (preferCachedFontStat || !!installedRoute) && item.fileSize > 0 && item.modifiedAt > 0
        ? { size: item.fileSize, mtimeMs: item.modifiedAt }
        : null
    ) : null

    if (!stat) {
      verifiedSource = await tracePreviewPhase('font-resolve', () => resolvePreviewSource(item.path, resolveExistingFontFilePath))
      assertCurrent()
      stat = verifiedSource.stat
    }

    const cacheIdentity = previewCacheIdentityForInstalledRoute(previewCache.identity, installedRoute)
    const key = previewCacheKey(sha1, cacheIdentity, stat.size, stat.mtimeMs, fontSize, width, height, normalizedText, undefined, layout)
    const previewDir = previewCache.dir
    const fontSignature = previewFontSignature(cacheIdentity, stat.size, stat.mtimeMs)
    const textHash = previewCacheTextHash(sha1, normalizedText)

    const outputPath = join(previewDir, `${key}.png`)
    const taskKey = previewTaskKey(key)

    if (!ignorePreviewIndex) {
      const indexedStatus = await tracePreviewPhase('index-read', () => readPreviewCacheIndexStatus(previewCache, key, outputPath))
      assertCurrent()
      if (indexedStatus === 'ok' && (imageBytes = await readValidCachedImage(outputPath))) {
        assertCurrent()
        if (!foreground) await completeBackgroundTask(taskKey, '预览缓存已存在').catch(() => undefined)
        return { outputPath, cached: true, storage: previewCache.storage, bytes: imageBytes }
      }
      // Historical failed/missing rows are evidence of an old attempt, not current source absence.
      // Retry through current source validation; successful generation replaces this row.

    }

    if (!ignorePreviewIndex && (imageBytes = await readValidCachedImage(outputPath))) {
      assertCurrent()
      await writePreviewCacheIndex(previewCache, key, {
        outputPath,
        fontSignature,
        textHash,
        fontSize,
        width,
        height,
        status: 'ok',
        fontId: item.id,
        sourcePath: item.path
      })
      return { outputPath, cached: true, storage: previewCache.storage, bytes: imageBytes }
    }

    if (!foreground && !ignorePreviewIndex && previewCache.shared) {
      const hydrationRow = {
        id: item.id,
        previewKey: key,
        outputPath,
        fontSignature,
        textHash,
        fontSize,
        width,
        height,
        fontId: item.id,
        sourcePath: item.path,
      }
      const hydrated = await hydratePreviewCache(previewCache, hydrationRow)
      assertCurrent()
      if (hydrated && (imageBytes = await readValidCachedImage(outputPath))) {
        await completeBackgroundTask(taskKey, '预览缓存已从共享缓存拉取到本地').catch(() => undefined)
        return { outputPath, cached: true, storage: previewCache.storage, bytes: imageBytes }
      }
    }

    // A foreground owner may have completed while background hydration settled.
    // Reuse its committed image instead of starting a second native render.
    if (!foreground && (imageBytes = await readValidCachedImage(outputPath))) {
      assertCurrent()
      return { outputPath, cached: true, storage: previewCache.storage, bytes: imageBytes }
    }

    // A failed display attempt cannot suppress an explicit cache job, and valid
    // cache hits above remain usable even during this lane's failure cooldown.
    const laneKey = `${foreground ? 'visible' : 'cache'}:${key}`
    const recentFailure = failedUntil.get(laneKey)
    if (recentFailure && recentFailure.until > Date.now()) throw recentFailure.error
    failedUntil.delete(laneKey)

    if (!foreground) {
      rememberPreviewCacheRenderQueued(1)
      await upsertBackgroundTask(taskKey, 'preview_cache', 10, { fontId: item.id, path: item.path, previewKey: key, outputPath, text: normalizedText, fontSize, width, height, layout }).catch(() => undefined)
      await startBackgroundTask(taskKey).catch(() => null)
      await heartbeatBackgroundTask(taskKey, 0.1, '正在准备字体预览输入').catch(() => undefined)
    }

    let transient = false
    let renderMessage: string = nativePreviewRenderer.activeEngineLabel()

    async function renderRequest(request: {
      fontPath: string
      text: string
      fontSize: number
      width: number
      height: number
      outputPath: string
      preferSystemFont?: boolean
      systemFontFamilyCandidates?: string[]
    }): Promise<{ bytes: Buffer; message: string; transient: boolean }> {
      const lifetime = currentPreviewRenderLifetime()!
      lifetime.assertCurrent()
      const lease = claimPreviewImage(outputPath, foreground ? 'display' : 'render', () => {
        try { lifetime.assertCurrent(); return true } catch { return false }
      })
      const inputPath = `${lease.temporaryPath}.json`
      try {
        const renderResult = await tracePreviewPhase('native-render', () => nativePreviewRenderer.renderNativePreview({ ...request, layout, ...(foreground ? { foregroundBytes: true } : {}), outputPath: lease.temporaryPath }, inputPath))
        lifetime.assertCurrent()
        if (!renderResult.ok) throw new Error(renderResult.message || `${renderResult.engine} preview renderer did not create output.`)
        const message = request.preferSystemFont
          ? `${renderResult.engine}:system-installed:${installedRoute?.reason || 'matched'}`
          : renderResult.engine
        if (renderResult.transient) {
          if (!foreground || !Buffer.isBuffer(renderResult.bytes) || !isCompletePreviewPng(renderResult.bytes)) throw previewFailure('failed')
          if (!lease.current()) throw previewFailure('cancelled')
          return { bytes: renderResult.bytes, message, transient: true }
        }
        const bytes = await withPhysicalIoCompletion(() => readValidCachedImage(renderResult.outputPath || lease.temporaryPath, true))
        lifetime.assertCurrent()
        if (!bytes) throw previewFailure('failed')
        if (!(await lease.commit())) { lifetime.assertCurrent(); throw previewFailure('cancelled') }
        lifetime.assertCurrent()
        return { bytes, message, transient: false }
      } catch (error) {
        // The native child may reject before close. Do not release its lease yet.
        await awaitPhysicalIoClose(error)
        throw error
      } finally {
        await withoutPreviewRenderLifetime(async () => {
          await lease.release()
          await fsp.unlink(inputPath).catch(() => undefined)
        })
      }
    }

    try {
      const renderKey = `${foreground ? 'visible' : 'cache'}:${outputPath}`
      assertCurrent()
      const previous = nativeRenderInFlight.get(renderKey)
      let task = renderTasks.reusable(previous) ? previous : undefined
      reuseObserver.native(renderKey, key, installedRoute ? 'system' : 'file', task?.pending)
      if (!task) {
        // The entire route sequence owns one deadline and queue ledger. Joiners
        // cannot restart the failed fast route or mint a fresh fallback budget.
        task = renderTasks.create(async lifetime => {
          let phase: 'system' | 'native' = 'native'
          try {
            let activeFontPath: string | undefined
            if (installedRoute?.reason === 'active') {
              try {
                activeFontPath = (await tracePreviewPhase('font-resolve', () => resolvePreviewSource(item.path, resolveExistingFontFilePath))).path
              } catch (error) {
                await awaitPhysicalIoClose(error)
                const code = (error as { code?: string; reason?: string })?.code || (error as { reason?: string })?.reason
                // Only authoritative absence permits the installed-family route.
                // Permission, queue, cancellation and uncertain I/O stay terminal.
                if (code !== 'ENOENT' && code !== 'ENOTDIR' && previewFailureKind(error) !== 'missing') throw error
              }
            }
            lifetime.assertCurrent()
            if (activeFontPath) {
              if (!foreground) await heartbeatBackgroundTask(taskKey, 0.35, '正在使用字体文件生成已激活字体预览').catch(() => undefined)
              const result = await renderRequest({ fontPath: activeFontPath, text: normalizedText, fontSize, width, height, outputPath })
              appendStartupLog(`active font preview file route: fontId=${item.id}, engine=${result.message}`)
              return result
            }
            if (installedRoute) {
              phase = 'system'
              try {
                if (!foreground) await heartbeatBackgroundTask(taskKey, 0.35, '正在使用系统已安装字体快速生成预览').catch(() => undefined)
                return await renderRequest({
                  fontPath: '', preferSystemFont: true,
                  systemFontFamilyCandidates: installedRoute.systemFontFamilyCandidates,
                  text: normalizedText, fontSize, width, height, outputPath
                })
              } catch (error) {
                await lifetime.allowFallback(error)
                lifetime.traceDecision('system', 'fallback', error, sharedIoAvailabilityRoot(item.path) || '', appendStartupLog)
              }
            }
            phase = 'native'
            lifetime.assertCurrent()
            const source = verifiedSource || await tracePreviewPhase('font-resolve', () => resolvePreviewSource(item.path, resolveExistingFontFilePath))
            lifetime.assertCurrent()
            if (!foreground) await heartbeatBackgroundTask(taskKey, 0.4, `正在生成字体预览图片（${nativePreviewRenderer.activeEngineLabel()}）`).catch(() => undefined)
            return await renderRequest({ fontPath: source.path, text: normalizedText, fontSize, width, height, outputPath })
          } catch (error) {
            const failure = lifetime.failure(error)
            lifetime.traceDecision(phase, 'stop', failure, sharedIoAvailabilityRoot(item.path) || '', appendStartupLog)
            throw failure
          }
        }, previous)
        nativeRenderInFlight.set(renderKey, task)
        reuseObserver.track(task.pending)
        const ownedTask = task
        void task.physicalCompletion.finally(() => { if (nativeRenderInFlight.get(renderKey) === ownedTask) nativeRenderInFlight.delete(renderKey) }).catch(() => undefined)
      }
      const result = await renderTasks.join(task)
      assertCurrent()
      imageBytes = result.bytes
      transient = result.transient
      renderMessage = result.message
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const kind = previewFailureKind(error)
      const current = requestEpoch === applicationWorkEpoch() && !isApplicationClosing() && !requestSignal?.aborted
      if (current && !foreground && (kind === 'failed' || kind === 'missing')) await writePreviewCacheIndex(previewCache, key, {
        outputPath,
        fontSignature,
        textHash,
        fontSize,
        width,
        height,
        status: kind === 'missing' ? 'missing' : 'failed',
        message,
        fontId: item.id,
        sourcePath: item.path
      }).catch(() => undefined)
      if (!foreground) await failBackgroundTask(taskKey, message, error instanceof Error ? error.stack : undefined).catch(() => undefined)
      appendStartupLog(`native preview failed: ${item.path} ${message}`)
      const failure = Object.assign(previewFailure(kind), {
        cause: error,
        ...((error && typeof error === 'object') ? {
          reason: (error as { reason?: string }).reason,
          sharedIo: (error as { sharedIo?: boolean }).sharedIo,
          closed: (error as { closed?: Promise<void> }).closed,
        } : {}),
      })
      if (current && kind !== 'cancelled') failedUntil.set(laneKey, { until: Date.now() + 30000, error: failure })
      while (failedUntil.size > 512) failedUntil.delete(failedUntil.keys().next().value!)
      throw failure
    }

    assertCurrent()
    if (transient) return { outputPath, cached: false, storage: previewCache.storage, bytes: imageBytes, transient: true }

    await writePreviewCacheIndex(previewCache, key, {
      outputPath,
      fontSignature,
      textHash,
      fontSize,
      width,
      height,
      status: 'ok',
      message: renderMessage,
      fontId: item.id,
      sourcePath: item.path
    })

    assertCurrent()
    previewCachePublishRuntime.enqueuePreviewCachePublish(previewCache, {
      previewKey: key,
      localOutputPath: outputPath,
      fontSignature,
      textHash,
      fontSize,
      width,
      height,
      fontId: item.id,
      sourcePath: item.path,
      message: renderMessage,
    })

    if (!foreground) await completeBackgroundTask(taskKey, '预览缓存已生成').catch(() => undefined)
    return { outputPath, cached: false, storage: previewCache.storage, bytes: imageBytes }
  }





  async function renderFontPreviewImage(
    item: FontItem,
    text: string,
    fontSize = 44,
    width = 720,
    height = 260,
    layout?: NativePreviewLayout
  ): Promise<string> {
    assertPreviewRequestCurrent(applicationWorkEpoch())
    text = validatePreviewInput({ text, fontSize, width, height, layout }, appendStartupLog).text
    const requestKey = previewImageMemoryRuntime.requestKey(item, text, fontSize, width, height, layout)
    const cachedDataUri = previewImageMemoryRuntime.get(requestKey)
    const previous = previewImageMemoryRuntime.inflight.get(requestKey)
    const existing = renderTasks.reusable(previous) ? previous : undefined
    const legacyMissing = hasLegacyMissingPreviewFlag(item)
    const observation = reuseObserver.admit({ requestKey, item, text, fontSize, width, height, layout, memory: !!cachedDataUri, legacyMissing, existing: existing?.pending })
    if (cachedDataUri && !legacyMissing) { logOperation({ stage: 'image-memory-hit' }); return cachedDataUri }

    if (existing) {
      logOperation({ stage: 'render-coalesced', jobId: renderTraceOwners.get(requestKey) })
      return renderTasks.join(existing)
    }

    const owner = currentOperationTrace()?.operationId
    if (owner) {
      renderTraceOwners.set(requestKey, owner)
      while (renderTraceOwners.size > 512) renderTraceOwners.delete(renderTraceOwners.keys().next().value!)
    }
    const queuedAt = performance.now()
    logOperation({ stage: 'render-queued' })
    let outcome: 'fulfilled' | 'rejected' = 'rejected', failure: PreviewFailureKind | undefined
    const task = reuseObserver.run(observation, () => renderTasks.create(lifetime => withGlobalIo('preview:render', () => withSharedPreviewReads(() => withPhysicalIoCompletion(async () => {
      lifetime.assertCurrent()
      logOperation({ stage: 'render-start', elapsedMs: performance.now() - queuedAt })
      let previewFile = await ensureFontPreviewImageFile(item, text, fontSize, width, height, false, false, true, layout)
      if (!previewFile) throw previewFailure('missing')

      try {
        const bytes = previewFile.bytes || await tracePreviewPhase('image-read', () => fsp.readFile(previewFile!.outputPath))
        if (!isCompletePreviewPng(bytes)) throw previewFailure('failed')
        lifetime.assertCurrent()
        const image = previewImageMemoryRuntime.remember(requestKey, `data:image/png;base64,${bytes.toString('base64')}`)
        reuseObserver.remember(!!previewFile.transient)
        return image
      } catch (error) {
        await awaitPhysicalIoClose(error)
        if (previewFile.cached && !isTerminalPreviewRenderFailure(error)) {
          const storage = await previewCacheStorageForFont(resolve(item.path))
          const normalizedText = text || DEFAULT_PREVIEW_TEXT
          const installedRoute = resolveInstalledFontPreviewRoute(item)
          const keyIdentity = previewCacheIdentityForInstalledRoute(storage.identity, installedRoute)
          const keyStat = previewCacheStatForInstalledRoute(item, installedRoute, { size: item.fileSize || 0, mtimeMs: item.modifiedAt || 0 }) || { size: 0, mtimeMs: 0 }
          const key = previewCacheKey(sha1, keyIdentity, keyStat.size, keyStat.mtimeMs, fontSize, width, height, normalizedText, undefined, layout)
          await deletePreviewCacheIndex(storage, key).catch(() => undefined)
          previewFile = await ensureFontPreviewImageFile(item, text, fontSize, width, height, false, true, true, layout)
          if (previewFile) {
            const bytes = previewFile.bytes || await tracePreviewPhase('image-read', () => fsp.readFile(previewFile!.outputPath))
            if (!isCompletePreviewPng(bytes)) throw previewFailure('failed')
            lifetime.assertCurrent()
            const image = previewImageMemoryRuntime.remember(requestKey, `data:image/png;base64,${bytes.toString('base64')}`)
            reuseObserver.remember(!!previewFile.transient)
            return image
          }
        }
        throw error
      }
    })), { priority: 'foreground', storagePath: item.path, signal: lifetime.signal }), previous))
    void task.pending.then(() => { outcome = 'fulfilled' }, error => {
      try { failure = previewFailureKind(error) } catch { /* Diagnostic classification never replaces the original error. */ }
    })
    void task.physicalCompletion.then(() => {
        if (previewImageMemoryRuntime.inflight.get(requestKey) === task) {
          renderTraceOwners.delete(requestKey)
          previewImageMemoryRuntime.inflight.delete(requestKey)
        }
      reuseObserver.settled(observation, outcome, failure)
    })

    previewImageMemoryRuntime.inflight.set(requestKey, task)
    reuseObserver.track(task.pending, observation)
    return renderTasks.join(task)
  }

  async function ensureFontPreviewCache(
    item: FontItem,
    text: string,
    fontSize = 34,
    width = 520,
    height = 150
  ): Promise<{ ok: boolean; cached: boolean; storage?: 'root' | 'fallback' | 'local'; message?: string }> {
    try {
      assertPreviewRequestCurrent(applicationWorkEpoch())
      // Queued cache work belongs to the epoch that requested it as well. A
      // cancelled exit cannot revive that old callback under the resumed epoch.
      const task = renderTasks.create(lifetime => withGlobalIo('preview:cache', () => withPhysicalIoCompletion(async () => {
        lifetime.assertCurrent()
        return ensureFontPreviewImageFile(item, text, fontSize, width, height, !hasLegacyMissingPreviewFlag(item), false, false)
      }), { priority: 'background', storagePath: item.path, signal: lifetime.signal }))
      const previewFile = await renderTasks.join(task)
      if (!previewFile) return { ok: false, cached: false, message: previewFailureMessage('missing') }
      return { ok: true, cached: previewFile.cached, storage: previewFile.storage }
    } catch (error) {
      // This API returns a plain receipt, so it cannot transfer the marked
      // physical-close responsibility to its caller the way display errors do.
      await awaitPhysicalIoClose(error)
      return { ok: false, cached: false, message: previewFailureMessage(previewFailureKind(error)) }
    }
  }





  return {
    findBestWatchedRootForFile,
    previewCacheStorageForFont,
    getPreviewCacheStatus,
    ensureFontPreviewImageFile,
    readPreviewFontData,
    renderFontPreviewImage,
    readCachedFontPreviewImage,
    readCachedFontPreviewImages,
    ensureFontPreviewCache,
    invalidateLibraryShellCache
  }
}
