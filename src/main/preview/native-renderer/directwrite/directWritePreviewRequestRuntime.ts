import type { PreviewNativeRenderRequest,PreviewNativeRenderResult } from '../previewNativeRenderTypes'
import { findDirectWritePreviewHelperPath } from './directWritePreviewHelperPathRuntime'

function parseHelperResult(stdout: string, outputPath: string): PreviewNativeRenderResult {
  const text = String(stdout || '').trim()
  if (!text) return { ok: true, engine: 'directwrite', outputPath }

  try {
    const parsed = JSON.parse(text) as { ok?: boolean; output?: string; outputPath?: string; message?: string; error?: string }
    return {
      ok: parsed.ok !== false,
      engine: 'directwrite',
      outputPath: parsed.outputPath || parsed.output || outputPath,
      message: parsed.message || parsed.error
    }
  } catch {
    return { ok: true, engine: 'directwrite', outputPath }
  }
}

export async function renderWithDirectWritePreviewHelper(
  request: PreviewNativeRenderRequest,
  inputPath: string,
  execFileAsync: (file: string, args?: readonly string[], options?: any) => Promise<{ stdout: string; stderr: string }>
): Promise<PreviewNativeRenderResult> {
  const helperPath = findDirectWritePreviewHelperPath()
  if (!helperPath) {
    return { ok: false, engine: 'directwrite', message: 'DirectWrite preview helper not found.' }
  }

  const result = await execFileAsync(helperPath, ['--input', inputPath], {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 2
  })

  // Old helpers may silently ignore unknown JSON. Require explicit receipt
  // before accepting their output under a new layout cache identity.
  if (request.layout) {
    let version: unknown
    try { version = JSON.parse(result.stdout).layoutVersion } catch { /* no capability receipt */ }
    if (version !== request.layout.version) return { ok: false, engine: 'directwrite', message: 'Preview helper lacks list-v1 layout support.' }
  }
  const parsed = parseHelperResult(result.stdout, request.outputPath)
  if (!parsed.ok) return parsed
  return { ...parsed, outputPath: parsed.outputPath || request.outputPath }
}
