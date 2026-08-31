import { hasDirectWritePreviewHelper } from '../native-renderer/directwrite/directWritePreviewHelperPathRuntime'

export const DEFAULT_PREVIEW_TEXT = '字体预览 AaBb 123'
export const POWERSHELL_PREVIEW_RENDERER_VERSION = 'native-preview-powershell-center-v6'
export const DIRECTWRITE_PREVIEW_RENDERER_VERSION = 'native-preview-private-gdi-inkbox-v7'
export const PREVIEW_CACHE_KEY_SCHEMA_VERSION = 'preview-cache-key-v2'
export const PREVIEW_CACHE_OUTPUT_FORMAT = 'png'

export type PreviewCacheKeyDescriptor = {
  schemaVersion: typeof PREVIEW_CACHE_KEY_SCHEMA_VERSION
  rendererVersion: string
  fontSignature: string
  textHash: string
  fontSize: number
  width: number
  height: number
  outputFormat: typeof PREVIEW_CACHE_OUTPUT_FORMAT
  dpiBucket: string
  foregroundMode: string
}

export function getPreviewRendererVersion(): string {
  return hasDirectWritePreviewHelper()
    ? DIRECTWRITE_PREVIEW_RENDERER_VERSION
    : POWERSHELL_PREVIEW_RENDERER_VERSION
}

function normalizedPreviewCacheEnvToken(value: string | undefined, fallback: string): string {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
  return normalized || fallback
}

export function previewCacheDpiBucket(): string {
  return normalizedPreviewCacheEnvToken(process.env.HFM_PREVIEW_DPI_BUCKET, 'dpi-default')
}

export function previewCacheForegroundMode(): string {
  return normalizedPreviewCacheEnvToken(process.env.HFM_PREVIEW_FOREGROUND_MODE, 'foreground-default')
}

export function isStrictPreviewCacheKeyEnabled(): boolean {
  return process.env.HFM_PREVIEW_CACHE_KEY_STRICT === '1'
}

export function previewCacheTextHash(sha1: (value: string) => string, text: string): string {
  return sha1(text || DEFAULT_PREVIEW_TEXT)
}

export function previewFontSignature(identity: string, size: number, mtimeMs: number): string {
  return `${identity}|${Math.round(size || 0)}|${Math.round(mtimeMs || 0)}`
}

export function previewCacheKeyDescriptor(
  sha1: (value: string) => string,
  identity: string,
  size: number,
  mtimeMs: number,
  fontSize: number,
  width: number,
  height: number,
  text: string,
  rendererVersion = getPreviewRendererVersion()
): PreviewCacheKeyDescriptor {
  return {
    schemaVersion: PREVIEW_CACHE_KEY_SCHEMA_VERSION,
    rendererVersion,
    fontSignature: previewFontSignature(identity, size, mtimeMs),
    textHash: previewCacheTextHash(sha1, text),
    fontSize,
    width,
    height,
    outputFormat: PREVIEW_CACHE_OUTPUT_FORMAT,
    dpiBucket: previewCacheDpiBucket(),
    foregroundMode: previewCacheForegroundMode(),
  }
}

export function legacyPreviewCacheKey(sha1: (value: string) => string, identity: string, size: number, mtimeMs: number, fontSize: number, width: number, height: number, text: string, rendererVersion = getPreviewRendererVersion()): string {
  return sha1(`${rendererVersion}|${previewFontSignature(identity, size, mtimeMs)}|${fontSize}|${width}|${height}|${text}`)
}

export function strictPreviewCacheKey(sha1: (value: string) => string, identity: string, size: number, mtimeMs: number, fontSize: number, width: number, height: number, text: string, rendererVersion = getPreviewRendererVersion()): string {
  const descriptor = previewCacheKeyDescriptor(sha1, identity, size, mtimeMs, fontSize, width, height, text, rendererVersion)
  return sha1(JSON.stringify(descriptor))
}

export function previewCacheKey(sha1: (value: string) => string, identity: string, size: number, mtimeMs: number, fontSize: number, width: number, height: number, text: string, rendererVersion = getPreviewRendererVersion()): string {
  return isStrictPreviewCacheKeyEnabled()
    ? strictPreviewCacheKey(sha1, identity, size, mtimeMs, fontSize, width, height, text, rendererVersion)
    : legacyPreviewCacheKey(sha1, identity, size, mtimeMs, fontSize, width, height, text, rendererVersion)
}
