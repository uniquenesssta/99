import { promises as fsp } from 'node:fs'
import type { FontItem } from '../../../shared/types'
import { fileExistsTimeoutMs,withIoDeadlineResult } from '../../path/ioDeadlineRuntime'
import type { AuthorizeFontRead } from '../../path/fontPathAuthorizationRuntime'

export function createPreviewFontDataRuntime(args: {
  ensureWindows: () => void
  authorizeFontRead: AuthorizeFontRead
  withGlobalIo: <T>(label: string, task: () => Promise<T>, options: { priority: 'foreground' | 'background' | 'normal'; storagePath?: string }) => Promise<T>
}) {
  const { ensureWindows, authorizeFontRead, withGlobalIo } = args

  return async function readPreviewFontData(item: FontItem): Promise<ArrayBuffer> {
    ensureWindows()

    return await withGlobalIo('preview:font-data', async () => {
      const authorizationResult = await withIoDeadlineResult(
        `preview-font-data-stat:${item.path}`,
        () => authorizeFontRead(item.path),
        fileExistsTimeoutMs()
      )
      if (!authorizationResult.ok) {
        throw new Error('字体文件不存在、路径不可达或授权检查超时。')
      }
      const authorization = authorizationResult.value
      if (!authorization.ok) {
        if (authorization.reason === 'file-too-large') {
          throw new Error('字体文件过大，跳过直接 FontFace 数据加载。')
        }
        throw new Error('字体文件不存在、路径无效或未经授权。')
      }

      const fontPath = authorization.value.ioPath
      const readResult = await withIoDeadlineResult(`preview-font-data-read:${fontPath}`, () => fsp.readFile(fontPath), fileExistsTimeoutMs())
      if (!readResult.ok) throw new Error('字体文件读取超时，已跳过本轮 FontFace 预览。')
      const bytes = readResult.value
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    }, { priority: 'foreground', storagePath: item.path })
  }
}
