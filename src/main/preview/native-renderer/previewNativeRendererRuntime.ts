import fs from 'node:fs'
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
    logHelperAvailabilityOnce()

    if (options.runRustPreviewRenderImage) {
      try {
        const result = await options.runRustPreviewRenderImage(request)
        if (result?.ok && result.outputPath && fs.existsSync(result.outputPath)) return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        options.appendStartupLog(`preview rust renderer failed before fallback: ${message}`)
      }
    }

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
        const result = await renderWithDirectWritePreviewHelper(request, inputPath, options.execFileAsync)
        if (result.ok && result.outputPath && fs.existsSync(result.outputPath)) return result
        options.appendStartupLog(`preview directwrite renderer returned empty result: ${result.message || 'unknown'}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        options.appendStartupLog(`preview directwrite renderer failed; fallback to powershell-gdi: ${message}`)
      }
    }

    return await renderWithPowerShellPreview(request, inputPath, options.execFileAsync)
  }

  return {
    activeEngineLabel,
    renderNativePreview
  }
}
