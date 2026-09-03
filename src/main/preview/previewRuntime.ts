import { promises as fsp } from 'node:fs'
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

  const {
    appendStartupLog,
    sha1,
    ensureWindows,
    resolveExistingFontFilePath,
    authorizeFontRead,
    previewTaskKey,
    completeBackgroundTask,
    skipBackgroundTask,
    upsertBackgroundTask,
    startBackgroundTask,
    heartbeatBackgroundTask,
    failBackgroundTask,
    legacyRootPreviewCacheDir,
    execFileAsync,
    withGlobalIo,
    missingFontPreviewDataUri
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
    ensureWindows,
    sha1,
    previewCacheStorageForFont,
    readPreviewCacheIndexStatus,
    readCachedPreviewImages
  })

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
    const normalizedText = text || DEFAULT_PREVIEW_TEXT
    const installedRoute = resolveInstalledFontPreviewRoute(item)
    const previewCache = await previewCacheStorageForFont(resolvedFontPath)
    let stat = previewCacheStatForInstalledRoute(
      item,
      installedRoute,
      (preferCachedFontStat || !!installedRoute) && item.fileSize > 0 && item.modifiedAt > 0
        ? { size: item.fileSize, mtimeMs: item.modifiedAt }
        : null
    )

    if (!stat) {
      const existingFontPath = await resolveExistingFontFilePath(item.path)
      if (!existingFontPath) {
        if (installedRoute) {
          stat = { size: 0, mtimeMs: 0 }
        } else {
          appendStartupLog(`native preview skipped missing font path: ${item.path}`)
          return null
        }
      } else {
        {
          const statResult = await withIoDeadlineResult(`preview-font-stat:${existingFontPath}`, () => fsp.stat(existingFontPath), fileExistsTimeoutMs())
          if (!statResult.ok) {
            appendStartupLog(`native preview skipped slow/missing font path: ${existingFontPath}`)
            return null
          }
          stat = statResult.value
        }
      }
    }

    const cacheIdentity = previewCacheIdentityForInstalledRoute(previewCache.identity, installedRoute)
    const key = previewCacheKey(sha1, cacheIdentity, stat.size, stat.mtimeMs, fontSize, width, height, normalizedText)
    const previewDir = previewCache.dir
    const fontSignature = previewFontSignature(cacheIdentity, stat.size, stat.mtimeMs)
    const textHash = previewCacheTextHash(sha1, normalizedText)

    const inputPath = join(previewDir, `${key}.json`)
    const outputPath = join(previewDir, `${key}.png`)
    const taskKey = previewTaskKey(key)

    if (!ignorePreviewIndex) {
      const indexedStatus = await readPreviewCacheIndexStatus(previewCache, key, outputPath)
      if (indexedStatus === 'ok') {
        await completeBackgroundTask(taskKey, '预览缓存已存在').catch(() => undefined)
        return { outputPath, cached: true, storage: previewCache.storage }
      }
      if ((indexedStatus === 'missing' || indexedStatus === 'failed') && !installedRoute) {
        await skipBackgroundTask(taskKey, indexedStatus === 'missing' ? '字体文件路径已记录为失效，跳过预览缓存。' : '字体预览生成曾失败，跳过重复重试。').catch(() => undefined)
        return null
      }
    }

    if (!(await fileExistsWithDeadline(outputPath)) && previewCache.shared?.rootPath) {
      const legacyOutputPath = join(legacyRootPreviewCacheDir(previewCache.shared.rootPath), `${key}.png`)
      if (await fileExistsWithDeadline(legacyOutputPath)) {
        const legacyMkdir = await withIoDeadlineResult(`preview-legacy-mkdir:${previewDir}`, () => fsp.mkdir(previewDir, { recursive: true }), previewCacheQueryTimeoutMs())
        if (legacyMkdir.ok) await withIoDeadlineResult(`preview-legacy-copy:${legacyOutputPath}`, () => fsp.copyFile(legacyOutputPath, outputPath), previewCacheQueryTimeoutMs())
      }
    }

    if (await fileExistsWithDeadline(outputPath)) {
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
      return { outputPath, cached: true, storage: previewCache.storage }
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
      if (hydrated && await fileExistsWithDeadline(outputPath)) {
        await completeBackgroundTask(taskKey, '预览缓存已从共享缓存拉取到本地').catch(() => undefined)
        return { outputPath, cached: true, storage: previewCache.storage }
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
      // JSON 明确按 UTF-8 写入；PowerShell / DirectWrite helper 读取时也指定 UTF-8。
      await fsp.writeFile(inputPath, JSON.stringify(request, null, 2), 'utf-8')
      const renderResult = await nativePreviewRenderer.renderNativePreview(request, inputPath)
      if (!renderResult.ok || !(await fileExistsWithDeadline(renderResult.outputPath || outputPath))) {
        throw new Error(renderResult.message || `${renderResult.engine} preview renderer did not create output.`)
      }
      renderMessage = request.preferSystemFont
        ? `${renderResult.engine}:system-installed:${installedRoute?.reason || 'matched'}`
        : renderResult.engine
    }

    try {
      let rendered = false
      if (installedRoute) {
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
        const fontPath = await resolveExistingFontFilePath(item.path)
        if (!fontPath) {
          await writePreviewCacheIndex(previewCache, key, {
            outputPath,
            fontSignature,
            textHash,
            fontSize,
            width,
            height,
            status: installedRoute ? 'failed' : 'missing',
            message: installedRoute ? '系统已安装字体快速预览失败，且字体文件不存在或路径已失效。' : '字体文件不存在或路径已失效。',
            fontId: item.id,
            sourcePath: item.path
          })
          await upsertBackgroundTask(taskKey, 'preview_cache', 10, { fontId: item.id, path: item.path, previewKey: key, outputPath, text: normalizedText, fontSize, width, height }, 'skipped', '字体文件不存在或路径已失效。').catch(() => undefined)
          appendStartupLog(`native preview skipped missing font path: ${item.path}`)
          return null
        }

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
      await writePreviewCacheIndex(previewCache, key, {
        outputPath,
        fontSignature,
        textHash,
        fontSize,
        width,
        height,
        status: 'failed',
        message,
        fontId: item.id,
        sourcePath: item.path
      }).catch(() => undefined)
      await failBackgroundTask(taskKey, message, error instanceof Error ? error.stack : undefined).catch(() => undefined)
      appendStartupLog(`native preview failed: ${item.path} ${message}`)
      throw new Error('Native preview failed.')
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
    return { outputPath, cached: false, storage: previewCache.storage }
  }





  async function renderFontPreviewImage(
    item: FontItem,
    text: string,
    fontSize = 44,
    width = 720,
    height = 260
  ): Promise<string> {
    const requestKey = previewImageMemoryRuntime.requestKey(item, text, fontSize, width, height)
    const cachedDataUri = previewImageMemoryRuntime.get(requestKey)
    if (cachedDataUri) return cachedDataUri

    const existing = previewImageMemoryRuntime.inflight.get(requestKey)
    if (existing) return existing

    const task = withGlobalIo('preview:render', async () => {
      let previewFile = await ensureFontPreviewImageFile(item, text, fontSize, width, height, false)
      if (!previewFile) return previewImageMemoryRuntime.remember(requestKey, missingFontPreviewDataUri(item.path, width, height))

      try {
        const bytes = await fsp.readFile(previewFile.outputPath)
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
            const bytes = await fsp.readFile(previewFile.outputPath)
            return previewImageMemoryRuntime.remember(requestKey, `data:image/png;base64,${bytes.toString('base64')}`)
          }
        }
        throw error
      }
    }, { priority: 'foreground', storagePath: item.path })
      .finally(() => {
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
      const previewFile = await withGlobalIo('preview:cache', () => ensureFontPreviewImageFile(item, text, fontSize, width, height, true), { priority: 'background', storagePath: item.path })
      if (!previewFile) return { ok: false, cached: false, message: '字体文件不存在或路径已失效。' }
      return { ok: true, cached: previewFile.cached, storage: previewFile.storage }
    } catch (error) {
      return { ok: false, cached: false, message: error instanceof Error ? error.message : String(error) }
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
