import type { PreviewNativeRenderRequest,PreviewNativeRenderResult } from '../previewNativeRenderTypes'
import { buildNativePreviewPowerShellScript } from '../../runtime/nativePreviewScriptRuntime'

export async function renderWithPowerShellPreview(
  request: PreviewNativeRenderRequest,
  inputPath: string,
  execFileAsync: (file: string, args?: readonly string[], options?: any) => Promise<{ stdout: string; stderr: string }>
): Promise<PreviewNativeRenderResult> {
  const script = buildNativePreviewPowerShellScript(inputPath)
  const encoded = Buffer.from(script, 'utf16le').toString('base64')

  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded
  ], {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 4
  })

  return { ok: true, engine: 'powershell-gdi', outputPath: request.outputPath }
}
