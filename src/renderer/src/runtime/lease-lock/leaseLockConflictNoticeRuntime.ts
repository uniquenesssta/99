export interface LeaseLockConflictNotice {
  sourceText: string
  machineId: string
  operation: string
  operationLabel: string
  remainingSeconds: number
  expiresAtText: string
  resourcePath: string
}

const LOCK_CONFLICT_MARKER = '锁定设备：'
const LOCK_CONFLICT_PATTERN = /锁定设备：([^；]+)；操作：([^；]+)；剩余约\s*(\d+)\s*秒；到期：([^；]+)；资源：([\s\S]+)$/

const OPERATION_LABELS: Record<string, string> = {
  'move-font': '移动字体',
  'move-font-batch': '批量移动字体',
  'delete-font': '删除字体到回收站',
  'rename-folder': '重命名物理文件夹',
}

function rawOperationName(value: string): string {
  const clean = value.trim()
  const match = clean.match(/\(([^()]+)\)$/)
  return (match?.[1] || clean).trim()
}

export function friendlyLeaseLockOperationName(operation: string): string {
  const raw = rawOperationName(operation)
  return OPERATION_LABELS[raw] || operation || '未知操作'
}

export function parseLeaseLockConflictNotice(text: string): LeaseLockConflictNotice | null {
  if (!text || !text.includes(LOCK_CONFLICT_MARKER)) return null
  const match = text.match(LOCK_CONFLICT_PATTERN)
  if (!match) return null

  const machineId = match[1].trim()
  const operation = match[2].trim()
  const remainingSeconds = Number(match[3])
  const expiresAtText = match[4].trim()
  const resourcePath = match[5].trim()

  return {
    sourceText: text,
    machineId,
    operation,
    operationLabel: friendlyLeaseLockOperationName(operation),
    remainingSeconds: Number.isFinite(remainingSeconds) ? remainingSeconds : 0,
    expiresAtText,
    resourcePath,
  }
}
