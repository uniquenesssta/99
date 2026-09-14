import type { FontIndexProgressPayload } from '@shared/types'

export function isIndexProgressActive(payload: FontIndexProgressPayload): boolean {
  return payload.stage !== 'done' && payload.stage !== 'cancelled' && payload.stage !== 'error'
}

export function folderChangeStatusText(payload: { fileName?: string; folder?: string }): string {
  return `检测到字体文件夹变化：${payload.fileName || payload.folder}，等待增量索引事件……`
}

export function fontIndexChangeStatusText(stats: { upserted: number; removed: number; errors?: number }): string {
  const errorText = stats.errors ? `，错误 ${stats.errors} 个` : ''
  return `增量索引已更新：新增/更新 ${stats.upserted} 个，移除 ${stats.removed} 个${errorText}。`
}
