import type { FontItem } from '../../shared/types'
import { normalizePathForCacheCompare as key } from '../path/cachePath'
import { fontPhysicalKey } from '../fonts/fontContentIdentityRuntime'
import type { InstallSourceIdentity } from './fontInstallEvidenceRuntime'
import type { FontMutationPlan } from './fontMutationProcessRuntime'

export type FontUninstallStep = {
  plan: FontMutationPlan
  target: InstallSourceIdentity
  state: 'pending' | 'attempted' | 'done'
}
export type FontUninstallReceipt = {
  version: 1
  revision: number
  sourcePath: string
  sourceId: string
  source: InstallSourceIdentity
  steps: FontUninstallStep[]
  completedSteps: number
  stage: string
  message: string
  cancelled?: boolean
}
export type FontUninstallReceiptStore = ReturnType<typeof openFontUninstallReceipts>

function validate(receipt: FontUninstallReceipt, path: string): void {
  const identity = (value: InstallSourceIdentity) => value && typeof value.path === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isFinite(value.size) && Number.isFinite(value.modified) && !!fontPhysicalKey(value)
  if (!receipt || receipt.version !== 1 || key(receipt.sourcePath) !== key(path) || !receipt.sourceId
    || !Number.isSafeInteger(receipt.revision) || receipt.revision < 0 || !identity(receipt.source)
    || !Number.isSafeInteger(receipt.completedSteps) || receipt.completedSteps < 0
    || typeof receipt.stage !== 'string' || typeof receipt.message !== 'string'
    || !Array.isArray(receipt.steps) || !receipt.steps.length || receipt.steps.length > 2048) throw new Error('卸载恢复记录无效，未执行；请保留记录并核对。')
  for (const step of receipt.steps) {
    const plan = step?.plan
    if (!identity(step?.target) || !['pending', 'attempted', 'done'].includes(step.state)
      || !plan || key(plan.path) !== key(step.target.path) || plan.sha256 !== step.target.sha256
      || typeof plan.delete_file !== 'boolean' || !Array.isArray(plan.records) || plan.records.length !== (plan.delete_file ? 0 : 1)
      || plan.records.some(record => !['HKCU', 'HKLM'].includes(record.scope) || typeof record.name !== 'string' || !record.name || typeof record.value !== 'string')
      || plan.identity !== undefined) throw new Error('卸载恢复目标格式无效，未执行；请保留记录并核对。')
  }
}

// This table belongs to the existing local library connection, not app_state
// (settings saves replace app_state). Every write is synchronous and CAS checked.
export function openFontUninstallReceipts(db: any) {
  db.exec('CREATE TABLE IF NOT EXISTS font_uninstall_receipts (source_path TEXT PRIMARY KEY, revision INTEGER NOT NULL, receipt_json TEXT NOT NULL)')
  const read = db.prepare('SELECT revision, receipt_json FROM font_uninstall_receipts WHERE source_path = ?')
  function load(path: string): FontUninstallReceipt | undefined {
    const row = read.get(key(path))
    if (!row) return undefined
    const receipt = JSON.parse(row.receipt_json) as FontUninstallReceipt
    validate(receipt, path)
    if (receipt.revision !== row.revision) throw new Error('卸载恢复记录版本不一致，未执行。')
    return receipt
  }
  function save(receipt: FontUninstallReceipt): FontUninstallReceipt {
    validate(receipt, receipt.sourcePath)
    const next = { ...receipt, revision: receipt.revision + 1 }
    const text = JSON.stringify(next)
    const result = receipt.revision === 0
      ? db.prepare('INSERT OR IGNORE INTO font_uninstall_receipts (source_path, revision, receipt_json) VALUES (?, ?, ?)').run(key(receipt.sourcePath), next.revision, text)
      : db.prepare('UPDATE font_uninstall_receipts SET revision = ?, receipt_json = ? WHERE source_path = ? AND revision = ?').run(next.revision, text, key(receipt.sourcePath), receipt.revision)
    if (Number(result.changes) !== 1) throw new Error('卸载恢复记录已被其他操作更新，当前操作停止。')
    return next
  }
  function remove(receipt: FontUninstallReceipt): void {
    const result = db.prepare('DELETE FROM font_uninstall_receipts WHERE source_path = ? AND revision = ?').run(key(receipt.sourcePath), receipt.revision)
    if (Number(result.changes) !== 1) throw new Error('卸载恢复记录清理未确认，请重试核验。')
  }
  function hydrate(items: FontItem[]): FontItem[] {
    return items.map(item => {
      const receipt = load(item.path)
      // Always replace possible renderer/index hints, including when absent.
      return { ...item, pendingUninstall: receipt ? { message: receipt.message, cancelled: receipt.cancelled } : undefined }
    })
  }
  return { load, save, remove, hydrate }
}
