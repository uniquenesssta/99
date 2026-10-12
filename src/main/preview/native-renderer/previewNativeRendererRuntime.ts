import { awaitPhysicalIoClose } from '../../path/ioDeadlineRuntime'
import { recordOperationWork } from '../../logging/operationTraceContext'
import type { ChildProcess } from 'node:child_process'
import { allowPreviewRenderFallback, currentPreviewRenderLifetime, PreviewRenderDomainError } from '../runtime/previewRenderLifetimeRuntime'
import { sharedFileSystem as fsp } from '../../path/sharedFileSystemRuntime'
import { sharedIoResourceKeys } from '../../rust-core/rustSharedIoCommandRuntime'
import { SharedIoProcessError, rethrowSharedIoProcessError } from '../../path/sharedIoProcessRuntime'
import { validatePreviewInput } from '../runtime/previewInputPolicy'
import type { PreviewNativeRenderRequest,PreviewNativeRenderResult,PreviewNativeRendererOptions } from './previewNativeRenderTypes'
import { findDirectWritePreviewHelperPath } from './directwrite/directWritePreviewHelperPathRuntime'
import { renderWithDirectWritePreviewHelper } from './directwrite/directWritePreviewRequestRuntime'
import { renderWithPowerShellPreview } from './powershell/powerShellPreviewRendererRuntime'
import {
  logNodeBridgeFallbackDisabled,
  logNodeBridgeFallbackUsed,
  nodeBridgeFallbackCompatibilityAllowed,
  nodeBridgeFallbackDeniedMessage,
  type NodeBridgeFallbackSource,
} from '../../rust-core/nodeBridgeFallbackCompatibilityRuntime'

let helperAvailabilityLogged = false

export function createPreviewNativeRenderer(options: PreviewNativeRendererOptions) {
  async function execPreviewFile(file: string, args?: readonly string[], execOptions?: any): Promise<{ stdout: string; stderr: string }> {
    const lifetime = currentPreviewRenderLifetime()
    lifetime?.assertCurrent()
    const execution = options.execFileAsync(file, args, {
      ...execOptions,
      ...(lifetime ? { signal: lifetime.signal, timeout: lifetime.remainingMs() } : {}),
    }) as Promise<{ stdout: string; stderr: string }> & { child?: ChildProcess }
    const closed = execution.child ? new Promise<void>(resolve => execution.child!.once('close', () => resolve())) : undefined
    try { return await execution }
    catch (error) { await awaitPhysicalIoClose(error); throw error }
    finally { await closed }
  }
  async function outputAvailable(outputPath: string): Promise<boolean> {
    try {
      await fsp.access(outputPath)
      currentPreviewRenderLifetime()?.assertCurrent()
      return true
    } catch (error) {
      await allowPreviewRenderFallback(error)
      return false
    }
  }
  function activeEngineLabel(): 'rust-directwrite' | 'directwrite' | 'powershell-gdi' {
    if (options.runRustPreviewRenderImage) return 'rust-directwrite'
    return findDirectWritePreviewHelperPath() ? 'directwrite' : 'powershell-gdi'
  }

  function logHelperAvailabilityOnce(): void {
    if (helperAvailabilityLogged) return
    helperAvailabilityLogged = true
    const helperPath = findDirectWritePreviewHelperPath()
    if (helperPath) {
      options.appendStartupLog(`preview native renderer: directwrite helper available at ${helperPath}`)
    } else {
      options.appendStartupLog(nodeBridgeFallbackCompatibilityAllowed()
        ? 'preview native renderer: directwrite helper not found; using powershell-gdi fallback'
        : 'preview native renderer: directwrite helper not found; powershell-gdi fallback is policy-gated by HFM_NODE_BRIDGE_FALLBACK=1')
    }
  }

  async function renderNativePreview(request: PreviewNativeRenderRequest, inputPath: string): Promise<PreviewNativeRenderResult> {
    // Validate before helper discovery, Rust invocation, or fallback selection.
    request = { ...request, ...validatePreviewInput(request, options.appendStartupLog) }
    currentPreviewRenderLifetime()?.assertCurrent()
    // All file-based backends consume the exact same validated payload as Rust.
    await fsp.writeFile(inputPath, JSON.stringify(request, null, 2), 'utf-8')
    logHelperAvailabilityOnce()

    if (options.runRustPreviewRenderImage) {
      try {
        recordOperationWork({ renders: 1 })
        const result = await options.runRustPreviewRenderImage(request)
        if (request.foregroundBytes && result?.ok && result.transient && Buffer.isBuffer(result.bytes)) return result
        if (result?.ok && !result.transient && result.outputPath && await outputAvailable(result.outputPath)) return result
      } catch (error) {
        // The native system selection is definitively exhausted. Let the
        // dispatcher choose its source-file route, without another system backend.
        if (error instanceof PreviewRenderDomainError) throw error
        rethrowSharedIoProcessError(error)
        await allowPreviewRenderFallback(error)
        const message = error instanceof Error ? error.message : String(error)
        options.appendStartupLog(`preview rust renderer failed before fallback: ${message}`)
      }
    }

    if ((await sharedIoResourceKeys([request.fontPath || '', request.outputPath || ''])).length) throw new SharedIoProcessError('共享预览需要隔离的原生执行器。','not-started','shared-fallback-denied')
    const systemOnlyRequest = !!request.preferSystemFont && !request.fontPath
    const fallbackSource: NodeBridgeFallbackSource = systemOnlyRequest ? 'preview-render-powershell' : 'preview-render-directwrite'
    if (!nodeBridgeFallbackCompatibilityAllowed()) {
      logNodeBridgeFallbackDisabled({
        appendStartupLog: options.appendStartupLog,
        source: fallbackSource,
        reason: options.runRustPreviewRenderImage ? 'rust-preview-render-missed' : 'rust-preview-render-unavailable',
      })
      return { ok: false, engine: systemOnlyRequest ? 'powershell-gdi' : 'directwrite', message: nodeBridgeFallbackDeniedMessage(fallbackSource) }
    }
    logNodeBridgeFallbackUsed({
      appendStartupLog: options.appendStartupLog,
      source: fallbackSource,
      reason: options.runRustPreviewRenderImage ? 'rust-preview-render-missed' : 'rust-preview-render-unavailable',
    })

    const helperPath = systemOnlyRequest ? null : findDirectWritePreviewHelperPath()
    if (helperPath) {
      try {
        const result = await renderWithDirectWritePreviewHelper(request, inputPath, execPreviewFile)
        if (result.ok && result.outputPath && await outputAvailable(result.outputPath)) return result
        options.appendStartupLog(`preview directwrite renderer returned empty result: ${result.message || 'unknown'}`)
      } catch (error) {
        rethrowSharedIoProcessError(error)
        await allowPreviewRenderFallback(error)
        const message = error instanceof Error ? error.message : String(error)
        options.appendStartupLog(`preview directwrite renderer failed; fallback to powershell-gdi: ${message}`)
      }
    }

    currentPreviewRenderLifetime()?.assertCurrent()
    return await renderWithPowerShellPreview(request, inputPath, execPreviewFile)
  }

  return {
    activeEngineLabel,
    renderNativePreview
  }
}
