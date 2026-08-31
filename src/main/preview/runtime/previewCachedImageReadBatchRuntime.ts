import { promises as fsp } from 'node:fs'
import { fileExistsTimeoutMs,withIoDeadlineResult } from '../../path/ioDeadlineRuntime'

export type PreviewCachedImageReadItem = {
  id: string
  outputPath?: string
}

export type PreviewCachedImageReadOptions = {
  readTimeoutMs?: number
  onReadTimeout?: (item: PreviewCachedImageReadItem, error: unknown) => void
}

export async function readCachedPreviewImageDataUris(
  items: PreviewCachedImageReadItem[],
  concurrency = 6,
  options: PreviewCachedImageReadOptions = {},
): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const queue = (items || []).filter((item) => item?.id && item.outputPath)
  if (!queue.length) return result

  const readTimeoutMs = Math.max(100, Number(options.readTimeoutMs || fileExistsTimeoutMs()) || fileExistsTimeoutMs())
  let index = 0
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), queue.length))
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (index < queue.length) {
      const item = queue[index]
      index += 1
      if (!item?.outputPath) continue
      try {
        const readResult = await withIoDeadlineResult(`preview-cache-image-read:${item.outputPath}`, () => fsp.readFile(item.outputPath || ''), readTimeoutMs)
        if (!readResult.ok) {
          if (readResult.timedOut) options.onReadTimeout?.(item, readResult.error)
          continue
        }
        result[item.id] = `data:image/png;base64,${readResult.value.toString('base64')}`
      } catch {
        // 缓存索引和 PNG 文件可能被其他进程同时清理；保持未命中，后续会重新生成。
      }
    }
  }))

  return result
}
