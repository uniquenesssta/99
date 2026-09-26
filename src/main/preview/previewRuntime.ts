import { isCompletePreviewPng } from './runtime/previewImageValidationRuntime'
import { previewFailure, previewFailureKind, previewFailureMessage, hasLegacyMissingPreviewFlag } from '../../shared/previewFailure'
import { resolvePreviewSource } from './runtime/previewSourceRuntime'
import { tracePreviewPhase } from './runtime/previewTraceRuntime'
import { logOperation, currentOperationTrace } from '../logging/operationTraceContext'
import { sharedFileSystem as fsp } from '../path/sharedFileSystemRuntime'
import { validatePreviewInput } from './runtime/previewInputPolicy'
import { join,resolve } from 'node:path'
import type { FontItem } from '../../shared/types'
import { findBestWatchedRootForFile } from '../path/fontPathPolicy'
import { fileExistsWithDeadline,withIoDeadlineResult,fileExistsTimeoutMs,previewCacheQueryTimeoutMs } from '../path/ioDeadlineRuntime'
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
  const previewImageMemoryRuntime = createPreviewImageMemoryRuntime()
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
    legacyRootPreviewCacheDir,
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
    if (!result.ok && required) throw previewFailure(result.timedOut ? 'timeout' : previewFailureKind(result.error))
    return result.ok && isCompletePreviewPng(result.value) ? result.value : undefined
  }

  async function ensureFontPreviewImageFile(
    item: FontItem,
    text: string,
    fontSize = 44,
    width = 720,
    height = 260,
    preferCachedFontStat = false,
    ignorePreviewIndex = false
  ): Promise<PreviewImageFileResult | null> {
    ensureWindows()

    const resolvedFontPath = resolve(item.path)
    const { text: normalizedText } = validatePreviewInput({ text, fontSize, width, height }, appendStartupLog)
    const installedRoute = resolveInstalledFontPreviewRoute(item)
    const previewCache = await tracePreviewPhase('storage-prepare', () => previewCacheStorageForFont(resolvedFontPath))
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
      stat = verifiedSource.stat
    }

    const cacheIdentity = previewCacheIdentityForInstalledRoute(previewCache.identity, installedRoute)
    const key = previewCacheKey(sha1, cacheIdentity, stat.size, stat.mtimeMs, fontSize, width, height, normalizedText)
    const recentFailure = failedUntil.get(key)
    if (recentFailure && recentFailure.until > Date.now()) throw recentFailure.error
    failedUntil.delete(key)
    const previewDir = previewCache.dir
    const fontSignature = previewFontSignature(cacheIdentity, stat.size, stat.mtimeMs)
    const textHash = previewCacheTextHash(sha1, normalizedText)

    const inputPath = join(previewDir, `${key}.json`)
    const outputPath = join(previewDir, `${key}.png`)
    const taskKey = previewTaskKey(key)

    if (!ignorePreviewIndex) {
      const indexedStatus = await tracePreviewPhase('index-read', () => readPreviewCacheIndexStatus(previewCache, key, outputPath))
      if (indexedStatus === 'ok' && (imageBytes = await readValidCachedImage(outputPath))) {
        await completeBackgroundTask(taskKey, '预览缓存已存在').catch(() => undefined)
        return { outputPath, cached: true, storage: previewCache.storage, bytes: imageBytes }
      }
      // Historical failed/missing rows are evidence of an old attempt, not current source absence.
      // Retry through current source validation; successful generation replaces this row.

    }

    if (!(await fileExistsWithDeadline(outputPath)) && previewCache.shared?.rootPath) {
      const legacyOutputPath = join(legacyRootPreviewCacheDir(previewCache.shared.rootPath), `${key}.png`)
      if (await fileExistsWithDeadline(legacyOutputPath)) {
        const legacyMkdir = await withIoDeadlineResult(`preview-legacy-mkdir:${previewDir}`, () => fsp.mkdir(previewDir, { recursive: true }), previewCacheQueryTimeoutMs())
        if (legacyMkdir.ok) await withIoDeadlineResult(`preview-legacy-copy:${legacyOutputPath}`, () => fsp.copyFile(legacyOutputPath, outputPath), previewCacheQueryTimeoutMs())
      }
    }

    if (!ignorePreviewIndex && (imageBytes = await readValidCachedImage(outputPath))) {
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

    if (!ignorePreviewIndex && previewCache.shared) {
      const hydrated = await hydratePreviewCache(previewCache, {
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
      })
      if (hydrated && (imageBytes = await readValidCachedImage(outputPath))) {
        await completeBackgroundTask(taskKey, '预览缓存已从共享缓存拉取到本地').catch(() => undefined)
        return { outputPath, cached: true, storage: previewCache.storage, bytes: imageBytes }
      }
    }

    rememberPreviewCacheRenderQueued(1)
    await upsertBackgroundTask(taskKey, 'preview_cache', 10, { fontId: item.id, path: item.path, previewKey: key, outputPath, text: normalizedText, fontSize, width, height }).catch(() => undefined)
    await startBackgroundTask(taskKey).catch(() => null)
    await heartbeatBackgroundTask(taskKey, 0.1, '正在准备字体预览输入').catch(() => undefined)

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
    }): Promise<void> {
      const renderResult = await tracePreviewPhase('native-render', () => nativePreviewRenderer.renderNativePreview(request, inputPath))
      if (!renderResult.ok) {
        throw new Error(renderResult.message || `${renderResult.engine} preview renderer did not create output.`)
      }
      imageBytes = await readValidCachedImage(renderResult.outputPath || outputPath, true)
      if (!imageBytes) throw previewFailure('failed')
      renderMessage = request.preferSystemFont
        ? `${renderResult.engine}:system-installed:${installedRoute?.reason || 'matched'}`
        : renderResult.engine
    }

    try {
      let rendered = false
      // Temporary activation does not guarantee family-name lookup is available.
      // Use the existing font file directly while keeping the same cache identity.
      const activeFontPath = installedRoute?.reason === 'active'
        ? await tracePreviewPhase('font-resolve', () => resolveExistingFontFilePath(item.path))
        : null
      if (activeFontPath) {
        await fsp.access(activeFontPath)
        await heartbeatBackgroundTask(taskKey, 0.35, '正在使用字体文件生成已激活字体预览').catch(() => undefined)
        await renderRequest({ fontPath: activeFontPath, text: normalizedText, fontSize, width, height, outputPath })
        rendered = true
        appendStartupLog(`active font preview file route: fontId=${item.id}, engine=${renderMessage}`)
      }
      if (!rendered && installedRoute) {
        try {
          await heartbeatBackgroundTask(taskKey, 0.35, '正在使用系统已安装字体快速生成预览').catch(() => undefined)
          await renderRequest({
            fontPath: '',
            preferSystemFont: true,
            systemFontFamilyCandidates: installedRoute.systemFontFamilyCandidates,
            text: normalizedText,
            fontSize,
            width,
            height,
            outputPath
          })
          rendered = true
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          appendStartupLog(`installed font preview fast path failed: fontId=${item.id}, reason=${installedRoute.reason}, message=${message}; trying rust file-path fallback`)
        }
      }

      if (!rendered) {
        const source = verifiedSource || await tracePreviewPhase('font-resolve', () => resolvePreviewSource(item.path, resolveExistingFontFilePath))
        const fontPath = source.path

        await fsp.access(fontPath)
        await heartbeatBackgroundTask(taskKey, 0.4, `正在生成字体预览图片（${nativePreviewRenderer.activeEngineLabel()}）`).catch(() => undefined)
        await renderRequest({
          fontPath,
          text: normalizedText,
          fontSize,
          width,
          height,
          outputPath
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const kind = previewFailureKind(error)
      if (kind === 'failed' || kind === 'missing') await writePreviewCacheIndex(previewCache, key, {
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
      await failBackgroundTask(taskKey, message, error instanceof Error ? error.stack : undefined).catch(() => undefined)
      appendStartupLog(`native preview failed: ${item.path} ${message}`)
      const failure = previewFailure(previewFailureKind(error))
      if (kind !== 'cancelled') failedUntil.set(key, { until: Date.now() + 30000, error: failure })
      while (failedUntil.size > 512) failedUntil.delete(failedUntil.keys().next().value!)
      throw failure
    }

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

    await completeBackgroundTask(taskKey, '预览缓存已生成').catch(() => undefined)
    return { outputPath, cached: false, storage: previewCache.storage, bytes: imageBytes }
  }





  async function renderFontPreviewImage(
    item: FontItem,
    text: string,
    fontSize = 44,
    width = 720,
    height = 260
  ): Promise<string> {
    text = validatePreviewInput({ text, fontSize, width, height }, appendStartupLog).text
    const requestKey = previewImageMemoryRuntime.requestKey(item, text, fontSize, width, height)
    const cachedDataUri = previewImageMemoryRuntime.get(requestKey)
    if (cachedDataUri && !hasLegacyMissingPreviewFlag(item)) { logOperation({ stage: 'image-memory-hit' }); return cachedDataUri }

    const existing = previewImageMemoryRuntime.inflight.get(requestKey)
    if (existing) { logOperation({ stage: 'render-coalesced', jobId: renderTraceOwners.get(requestKey) }); return existing }

    const owner = currentOperationTrace()?.operationId
    if (owner) {
      renderTraceOwners.set(requestKey, owner)
      while (renderTraceOwners.size > 512) renderTraceOwners.delete(renderTraceOwners.keys().next().value!)
    }
    const queuedAt = performance.now()
    logOperation({ stage: 'render-queued' })
    const task = withGlobalIo('preview:render', async () => {
      logOperation({ stage: 'render-start', elapsedMs: performance.now() - queuedAt })
      let previewFile = await ensureFontPreviewImageFile(item, text, fontSize, width, height, false)
      if (!previewFile) throw previewFailure('missing')

      try {
        const bytes = previewFile.bytes || await tracePreviewPhase('image-read', () => fsp.readFile(previewFile!.outputPath))
        if (!isCompletePreviewPng(bytes)) throw previewFailure('failed')
        return previewImageMemoryRuntime.remember(requestKey, `data:image/png;base64,${bytes.toString('base64')}`)
      } catch (error) {
        if (previewFile.cached) {
          const storage = await previewCacheStorageForFont(resolve(item.path))
          const normalizedText = text || DEFAULT_PREVIEW_TEXT
          const installedRoute = resolveInstalledFontPreviewRoute(item)
          const keyIdentity = previewCacheIdentityForInstalledRoute(storage.identity, installedRoute)
          const keyStat = previewCacheStatForInstalledRoute(item, installedRoute, { size: item.fileSize || 0, mtimeMs: item.modifiedAt || 0 }) || { size: 0, mtimeMs: 0 }
          const key = previewCacheKey(sha1, keyIdentity, keyStat.size, keyStat.mtimeMs, fontSize, width, height, normalizedText)
          await deletePreviewCacheIndex(storage, key).catch(() => undefined)
          previewFile = await ensureFontPreviewImageFile(item, text, fontSize, width, height, false, true)
          if (previewFile) {
            const bytes = previewFile.bytes || await tracePreviewPhase('image-read', () => fsp.readFile(previewFile!.outputPath))
            if (!isCompletePreviewPng(bytes)) throw previewFailure('failed')
        return previewImageMemoryRuntime.remember(requestKey, `data:image/png;base64,${bytes.toString('base64')}`)
          }
        }
        throw error
      }
    }, { priority: 'foreground', storagePath: item.path })
      .finally(() => {
        renderTraceOwners.delete(requestKey)
        previewImageMemoryRuntime.inflight.delete(requestKey)
      })

    previewImageMemoryRuntime.inflight.set(requestKey, task)
    return task
  }

  async function ensureFontPreviewCache(
    item: FontItem,
    text: string,
    fontSize = 34,
    width = 520,
    height = 150
  ): Promise<{ ok: boolean; cached: boolean; storage?: 'root' | 'fallback' | 'local'; message?: string }> {
    try {
      const previewFile = await withGlobalIo('preview:cache', () => ensureFontPreviewImageFile(item, text, fontSize, width, height, !hasLegacyMissingPreviewFlag(item)), { priority: 'background', storagePath: item.path })
      if (!previewFile) return { ok: false, cached: false, message: previewFailureMessage('missing') }
      return { ok: true, cached: previewFile.cached, storage: previewFile.storage }
    } catch (error) {
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
