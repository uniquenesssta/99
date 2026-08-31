import { promises as fsp } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import type { PreviewCacheMetaPayload, PreviewCacheMetaValidationResult } from './previewCacheMetaRuntime'
import type { PreviewCachePublishRow } from './previewCachePublishRuntime'
import type { PreviewCacheStorage } from './previewRuntimeTypes'

export type PreviewCacheManifestEvent = 'published' | 'existing' | 'index-written' | 'meta-mismatch'

export type PreviewCacheManifestEntry = {
  version: 1
  event: PreviewCacheManifestEvent
  previewKey: string
  relativePath: string
  metaPath: string
  rootPath?: string
  fontSignature: string
  textHash: string
  fontSize: number
  width: number
  height: number
  outputFormat: 'png'
  sourceMachineId: string
  sourcePath?: string
  fontId?: string
  checksum?: string
  size?: number
  renderVersion?: string
  metaStatus?: PreviewCacheMetaValidationResult['status']
  metaMessage?: string
  createdAt: string
}

export type PreviewCacheManifestRuntimeOptions = {
  appendStartupLog: (message: string) => void
  withIoDeadlineResult: <T>(label: string, operation: () => Promise<T>, timeoutMs: number) => Promise<{ ok: true; value: T; timedOut?: boolean } | { ok: false; error: unknown; timedOut?: boolean }>
  readSharedPreviewCacheMeta?: (outputPath: string) => Promise<PreviewCacheMetaPayload | null>
}

const DEFAULT_MANIFEST_WRITE_TIMEOUT_MS = 1200

function parseEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

function manifestWriteTimeoutMs(): number {
  return parseEnvInt('HFM_PREVIEW_MANIFEST_WRITE_TIMEOUT_MS', DEFAULT_MANIFEST_WRITE_TIMEOUT_MS, 100, 10000)
}

function machineId(): string {
  return `${hostname() || 'unknown'}:${process.pid}`
}

function safeMachineFileName(): string {
  return (hostname() || 'unknown-machine').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80) || 'unknown-machine'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sharedCacheDir(storage: PreviewCacheStorage): string {
  return dirname(storage.dir)
}

function manifestPath(storage: PreviewCacheStorage): string {
  return join(sharedCacheDir(storage), 'manifests', `${safeMachineFileName()}.jsonl`)
}

function toSharedRelativePath(storage: PreviewCacheStorage, filePath: string): string {
  const rel = relative(sharedCacheDir(storage), filePath).replaceAll('\\', '/')
  return rel && !rel.startsWith('..') ? rel : `images/${basename(filePath)}`
}

export function createPreviewCacheManifestRuntime(options: PreviewCacheManifestRuntimeOptions) {
  const stats = {
    queued: 0,
    written: 0,
    dropped: 0,
    errors: 0,
  }

  async function appendPreviewCacheManifestEntry(
    storage: PreviewCacheStorage,
    row: PreviewCachePublishRow,
    outputPath: string,
    event: PreviewCacheManifestEvent,
    metaValidation?: PreviewCacheMetaValidationResult | null
  ): Promise<void> {
    if (storage.storage !== 'root') return
    stats.queued += 1
    const targetPath = manifestPath(storage)
    const meta = await options.readSharedPreviewCacheMeta?.(outputPath).catch(() => null) || null
    const entry: PreviewCacheManifestEntry = {
      version: 1,
      event,
      previewKey: row.previewKey,
      relativePath: toSharedRelativePath(storage, outputPath),
      metaPath: `${toSharedRelativePath(storage, outputPath)}.meta.json`,
      rootPath: storage.rootPath,
      fontSignature: row.fontSignature,
      textHash: row.textHash,
      fontSize: row.fontSize,
      width: row.width,
      height: row.height,
      outputFormat: 'png',
      sourceMachineId: machineId(),
      sourcePath: row.sourcePath,
      fontId: row.fontId,
      checksum: meta?.checksum,
      size: meta?.size,
      renderVersion: meta?.renderVersion,
      metaStatus: metaValidation?.status || (meta ? 'ok' : undefined),
      metaMessage: metaValidation?.message,
      createdAt: new Date().toISOString(),
    }

    const writeResult = await options.withIoDeadlineResult(`preview-cache-manifest-append:${targetPath}`, async () => {
      await fsp.mkdir(dirname(targetPath), { recursive: true })
      await fsp.appendFile(targetPath, `${JSON.stringify(entry)}\n`, 'utf-8')
    }, manifestWriteTimeoutMs())

    if (!writeResult.ok) {
      if (writeResult.timedOut) stats.dropped += 1
      else stats.errors += 1
      options.appendStartupLog(`preview cache manifest append skipped: ${targetPath}, ${errorMessage(writeResult.error)}`)
      return
    }
    stats.written += 1
  }

  function snapshotStats(): { queued: number; written: number; dropped: number; errors: number } {
    return { ...stats }
  }

  return {
    manifestPath,
    appendPreviewCacheManifestEntry,
    snapshotStats,
  }
}
