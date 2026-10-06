import type { NativePreviewLayout } from '../../../shared/preview-layout/nativePreviewLayout'
export type PreviewNativeRenderEngine = 'rust-directwrite' | 'directwrite' | 'powershell-gdi'

export interface PreviewNativeRenderRequest {
  layout?: NativePreviewLayout
  fontPath: string
  preferSystemFont?: boolean
  systemFontFamilyCandidates?: string[]
  text: string
  fontSize: number
  width: number
  height: number
  outputPath: string
}

export interface PreviewNativeRenderResult {
  ok: boolean
  engine: PreviewNativeRenderEngine
  nativeBackend?: string
  provenance?: Record<string, string | number>
  outputPath?: string
  message?: string
}

export interface PreviewNativeRendererOptions {
  appendStartupLog: (message: string) => void
  execFileAsync: (file: string, args?: readonly string[], options?: any) => Promise<{ stdout: string; stderr: string }>
  runRustPreviewRenderImage?: (request: PreviewNativeRenderRequest) => Promise<PreviewNativeRenderResult | null>
}
