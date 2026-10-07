import { useState } from 'react'
import { stringifyDeveloperValue } from '../../appRuntime'

type RecordValue = Record<string, unknown>

function asRecord(value: unknown): RecordValue | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function rootDisplayName(rootPath: unknown): string {
  const text = asString(rootPath, '未知共享根目录')
  return text.length > 92 ? `…${text.slice(-92)}` : text
}

export function SharedIndexSnapshotMaintenancePanel(): JSX.Element {
  const [busyAction, setBusyAction] = useState('')
  const [result, setResult] = useState<unknown>(null)
  const [error, setError] = useState('')
  const report = asRecord(result)
  const roots = asArray(report?.reports)
  const busy = !!busyAction

  async function runAction(label: string, action: () => Promise<unknown>): Promise<void> {
    setBusyAction(label)
    setError('')
    try {
      setResult(await action())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyAction('')
    }
  }

  function refresh(): Promise<void> {
    return runAction('检查 shared index snapshot', () => window.hfm.getSharedIndexSnapshotDiagnostics())
  }

  function dryRunRepair(): Promise<void> {
    return runAction('预检 shared index snapshot 维护', () => window.hfm.repairSharedIndexSnapshots({ apply: false }))
  }

  function applyRepair(): Promise<void> {
    const confirmed = window.confirm('会清理旧的非活动 shared index snapshot、过期 tmp 文件和孤儿 SQLite sidecar。确认继续？')
    if (!confirmed) return Promise.resolve()
    return runAction('应用 shared index snapshot 维护', () => window.hfm.repairSharedIndexSnapshots({ apply: true }))
  }

  return (
    <div className="shared-index-maintenance-panel">
      <div className="shared-index-maintenance-header">
        <div>
          <h3>Shared index snapshot 维护</h3>
          <p>用于手动检查和清理 NAS 共享索引快照。只清理非活动旧快照、过期 tmp 和孤儿 sidecar，不会删除当前 active snapshot。</p>
        </div>
        <span className={`shared-metadata-severity severity-${report?.ok === true ? 'ok' : report ? 'warning' : 'unknown'}`}>{report?.ok === true ? 'ok' : report ? 'check' : 'idle'}</span>
      </div>

      <div className="shared-metadata-summary-grid compact">
        <div><strong>{asNumber(report?.checkedRoots)}</strong><span>检查根目录</span></div>
        <div><strong>{asNumber(report?.problemRoots)}</strong><span>问题根目录</span></div>
        <div><strong>{asNumber(report?.cleanedRoots)}</strong><span>已清理根</span></div>
        <div><strong>{asNumber(report?.deletedFiles)}</strong><span>删除文件</span></div>
      </div>

      <div className="shared-metadata-maintenance-actions">
        <button type="button" disabled={busy} onClick={() => void refresh()}>检查快照</button>
        <button type="button" disabled={busy} onClick={() => void dryRunRepair()}>预检维护</button>
        <button type="button" disabled={busy} onClick={() => void applyRepair()}>应用安全维护</button>
      </div>

      {busyAction && <p className="shared-metadata-action-status">正在执行：{busyAction}</p>}
      {error && <p className="shared-metadata-action-error">{error}</p>}

      {!!roots.length && (
        <div className="shared-metadata-root-list">
          {roots.slice(0, 8).map((item, index) => {
            const root = asRecord(item)
            const rootOk = root?.ok === true
            return (
              <div key={`${asString(root?.rootPath, 'root')}-${index}`} className="shared-metadata-root-row">
                <div>
                  <strong>{rootDisplayName(root?.rootPath)}</strong>
                  <span>snapshot {asNumber(root?.snapshotCount)}，stale {asNumber(root?.staleSnapshotCount)}，tmp {asNumber(root?.tmpFileCount)}，orphan {asNumber(root?.orphanSidecarCount)}，deleted {asArray(root?.deletedFiles).length}</span>
                </div>
                <span className={`shared-metadata-severity severity-${rootOk ? 'ok' : 'warning'}`}>{rootOk ? 'ok' : 'check'}</span>
              </div>
            )
          })}
        </div>
      )}

      {result !== null && (
        <details className="shared-metadata-action-result">
          <summary>查看 shared index snapshot 结果</summary>
          <pre>{stringifyDeveloperValue(result)}</pre>
        </details>
      )}
    </div>
  )
}
