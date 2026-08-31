import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { hostname } from 'node:os'
import type { PreviewCachePublishRow } from './previewCachePublishRuntime'
import type { PreviewCacheHydrationRow } from './previewCacheHydrationRuntime'
import { getPreviewRendererVersion, PREVIEW_CACHE_KEY_SCHEMA_VERSION, previewCacheDpiBucket, previewCacheForegroundMode } from './previewCacheKeyRuntime'

export type PreviewCacheMetaValidationStatus = 'ok' | 'missing' | 'invalid' | 'mismatch'

export type PreviewCacheMetaValidationResult = {
  status: PreviewCacheMetaValidationStatus
  message?: string
}

export type PreviewCacheMetaPayload = {
  version: 1
  previewKey: string
  checksumAlgorithm: 'sha1'
  checksum: string
  size: number
  renderVersion: string
  keySchemaVersion?: string
  dpiBucket?: string
  foregroundMode?: string
  fontSignature: string
  textHash: string
  fontSize: number
  width: number
  height: number
  outputFormat: 'png'
  createdAt: string
  sourceMachineId: string
  fontId?: string
  sourcePath?: string
}

export type PreviewCacheMetaRuntimeOptions = {
  appendStartupLog: (message: string) => void
}

function machineId(): string {
  return `${hostname() || 'unknown'}:${process.pid}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function metaPathForOutput(outputPath: string): string {
  return `${outputPath}.meta.json`
}

async function sha1File(filePath: string): Promise<{ checksum: string; size: number }> {
  const buffer = await fsp.readFile(filePath)
  return {
    checksum: createHash('sha1').update(buffer).digest('hex'),
    size: buffer.byteLength,
  }
}

function rowLike(row: PreviewCachePublishRow | PreviewCacheHydrationRow): {
  previewKey: string
  fontSignature: string
  textHash: string
  fontSize: number
  width: number
  height: number
  fontId?: string
  sourcePath?: string
} {
  return {
    previewKey: row.previewKey,
    fontSignature: row.fontSignature,
    textHash: row.textHash,
    fontSize: row.fontSize,
    width: row.width,
    height: row.height,
    fontId: row.fontId,
    sourcePath: row.sourcePath,
  }
}

function validateMetaPayload(meta: Partial<PreviewCacheMetaPayload>, row: PreviewCachePublishRow | PreviewCacheHydrationRow, checksum: string, size: number): PreviewCacheMetaValidationResult {
  const expected = rowLike(row)
  if (meta.version !== 1) return { status: 'mismatch', message: 'version-mismatch' }
  if (meta.previewKey !== expected.previewKey) return { status: 'mismatch', message: 'preview-key-mismatch' }
  if (meta.checksumAlgorithm !== 'sha1') return { status: 'mismatch', message: 'checksum-algorithm-mismatch' }
  if (meta.checksum !== checksum) return { status: 'mismatch', message: 'checksum-mismatch' }
  if (Number(meta.size || 0) !== size) return { status: 'mismatch', message: 'size-mismatch' }
  if (meta.renderVersion !== getPreviewRendererVersion()) return { status: 'mismatch', message: 'render-version-mismatch' }
  if (meta.keySchemaVersion && meta.keySchemaVersion !== PREVIEW_CACHE_KEY_SCHEMA_VERSION) return { status: 'mismatch', message: 'key-schema-version-mismatch' }
  if (meta.dpiBucket && meta.dpiBucket !== previewCacheDpiBucket()) return { status: 'mismatch', message: 'dpi-bucket-mismatch' }
  if (meta.foregroundMode && meta.foregroundMode !== previewCacheForegroundMode()) return { status: 'mismatch', message: 'foreground-mode-mismatch' }
  if (meta.fontSignature !== expected.fontSignature) return { status: 'mismatch', message: 'font-signature-mismatch' }
  if (meta.textHash !== expected.textHash) return { status: 'mismatch', message: 'text-hash-mismatch' }
  if (Number(meta.fontSize || 0) !== expected.fontSize) return { status: 'mismatch', message: 'font-size-mismatch' }
  if (Number(meta.width || 0) !== expected.width) return { status: 'mismatch', message: 'width-mismatch' }
  if (Number(meta.height || 0) !== expected.height) return { status: 'mismatch', message: 'height-mismatch' }
  if (meta.outputFormat !== 'png') return { status: 'mismatch', message: 'output-format-mismatch' }
  return { status: 'ok' }
}

function strictSharedMetaEnabled(): boolean {
  return process.env.HFM_PREVIEW_SHARED_META_STRICT === '1'
}

export function createPreviewCacheMetaRuntime(options: PreviewCacheMetaRuntimeOptions) {
  async function writePreviewCacheMeta(outputPath: string, row: PreviewCachePublishRow | PreviewCacheHydrationRow): Promise<void> {
    const metaPath = metaPathForOutput(outputPath)
    const tmpPath = `${metaPath}.tmp.${process.pid}.${Date.now()}`
    try {
      const file = await sha1File(outputPath)
      const payload: PreviewCacheMetaPayload = {
        version: 1,
        previewKey: row.previewKey,
        checksumAlgorithm: 'sha1',
        checksum: file.checksum,
        size: file.size,
        renderVersion: getPreviewRendererVersion(),
        keySchemaVersion: PREVIEW_CACHE_KEY_SCHEMA_VERSION,
        dpiBucket: previewCacheDpiBucket(),
        foregroundMode: previewCacheForegroundMode(),
        fontSignature: row.fontSignature,
        textHash: row.textHash,
        fontSize: row.fontSize,
        width: row.width,
        height: row.height,
        outputFormat: 'png',
        createdAt: new Date().toISOString(),
        sourceMachineId: machineId(),
        fontId: row.fontId,
        sourcePath: row.sourcePath,
      }
      await fsp.writeFile(tmpPath, `${JSON.stringify(payload)}\n`, 'utf-8')
      await fsp.rename(tmpPath, metaPath)
    } catch (error) {
      await fsp.unlink(tmpPath).catch(() => undefined)
      options.appendStartupLog(`preview cache meta write failed: ${metaPath}, ${errorMessage(error)}`)
      throw error
    }
  }

  async function readPreviewCacheMeta(outputPath: string): Promise<PreviewCacheMetaPayload | null> {
    const metaPath = metaPathForOutput(outputPath)
    try {
      return JSON.parse(await fsp.readFile(metaPath, 'utf-8')) as PreviewCacheMetaPayload
    } catch {
      return null
    }
  }

  async function validatePreviewCacheMeta(outputPath: string, row: PreviewCachePublishRow | PreviewCacheHydrationRow): Promise<PreviewCacheMetaValidationResult> {
    const metaPath = metaPathForOutput(outputPath)
    let raw: string
    try {
      raw = await fsp.readFile(metaPath, 'utf-8')
    } catch {
      return { status: 'missing', message: strictSharedMetaEnabled() ? 'meta-missing-strict' : 'meta-missing-legacy-compatible' }
    }

    try {
      const parsed = JSON.parse(raw) as Partial<PreviewCacheMetaPayload>
      const file = await sha1File(outputPath)
      return validateMetaPayload(parsed, row, file.checksum, file.size)
    } catch (error) {
      return { status: 'invalid', message: errorMessage(error) }
    }
  }

  function isStrictSharedMetaEnabled(): boolean {
    return strictSharedMetaEnabled()
  }

  return {
    metaPathForOutput,
    writePreviewCacheMeta,
    readPreviewCacheMeta,
    validatePreviewCacheMeta,
    isStrictSharedMetaEnabled,
  }
}
