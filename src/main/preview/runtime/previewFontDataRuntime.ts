import { promises as fsp } from 'node:fs'
import type { FontItem } from '../../../shared/types'
import { fileExistsTimeoutMs,withIoDeadlineResult } from '../../path/ioDeadlineRuntime'

const MAX_PREVIEW_FONT_DATA_BYTES = 80 * 1024 * 1024

export function createPreviewFontDataRuntime(args: {
  ensureWindows: () => void
  resolveExistingFontFilePath: (path: string) => Promise<string | null | undefined>
  withGlobalIo: <T>(label: string, task: () => Promise<T>, options: { priority: 'foreground' | 'background' | 'normal'; storagePath?: string }) => Promise<T>
}) {
  const { ensureWindows, resolveExistingFontFilePath, withGlobalIo } = args

  return async function readPreviewFontData(item: FontItem): Promise<ArrayBuffer> {
    ensureWindows()

    const fontPath = await resolveExistingFontFilePath(item.path)
    if (!fontPath) {
      throw new Error('字体文件不存在或路径已失效。')
    }

    return await withGlobalIo('preview:font-data', async () => {
      const statResult = await withIoDeadlineResult(`preview-font-data-stat:${fontPath}`, () => fsp.stat(fontPath), fileExistsTimeoutMs())
      if (!statResult.ok) throw new Error('字体文件不存在、路径不可达或读取超时。')
      if (statResult.value.size > MAX_PREVIEW_FONT_DATA_BYTES) {
        throw new Error(`字体文件过大，跳过直接 FontFace 数据加载：${Math.round(statResult.value.size / 1024 / 1024)}MB`)
      }

      const readResult = await withIoDeadlineResult(`preview-font-data-read:${fontPath}`, () => fsp.readFile(fontPath), fileExistsTimeoutMs())
      if (!readResult.ok) throw new Error('字体文件读取超时，已跳过本轮 FontFace 预览。')
      const bytes = readResult.value
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    }, { priority: 'foreground', storagePath: item.path })
  }
}
