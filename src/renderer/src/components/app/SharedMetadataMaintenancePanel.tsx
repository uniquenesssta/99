import { useState } from 'react'
import { stringifyDeveloperValue } from '../../appRuntime'

type SharedMetadataMaintenancePanelProps = {
  diagnostics: unknown
  refreshDeveloperStatusDetails: () => Promise<void>
  onDiagnosticsUpdated: (value: unknown) => void
}

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

function diagnosticsValue(report: RecordValue | null, key: string): string {
  if (!report) return '0'
  const value = report[key]
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return '0'
}

function hasProblems(summary: RecordValue | null): boolean {
  if (!summary) return false
  return [
    'invalidTagJsonRows',
    'missingTagOps',
    'conflicts',
    'revisionTies',
    'latestRemovalConflicts',
    'multiMachineConflicts',
    'orphanTagOps',
  ].some((key) => asNumber(summary[key]) > 0)
}

function rootDisplayName(rootPath: unknown): string {
  const text = asString(rootPath, '未知共享根目录')
  return text.length > 92 ? `…${text.slice(-92)}` : text
}

export function SharedMetadataMaintenancePanel({
  diagnostics,
  refreshDeveloperStatusDetails,
  onDiagnosticsUpdated,
}: SharedMetadataMaintenancePanelProps): JSX.Element {
  const [busyAction, setBusyAction] = useState('')
  const [lastResult, setLastResult] = useState<unknown>(null)
  const [lastError, setLastError] = useState('')
  const report = asRecord(diagnostics)
  const summary = asRecord(report?.summary)
  const reports = asArray(report?.reports)
  const severity = asString(report?.severity, 'unknown')
  const busy = !!busyAction

  async function runPanelAction(label: string, action: () => Promise<unknown>, updateDiagnostics: boolean): Promise<void> {
    setBusyAction(label)
    setLastError('')
    try {
      const result = await action()
      setLastResult(result)
      if (updateDiagnostics) {
        onDiagnosticsUpdated(result)
      } else {
        await refreshDeveloperStatusDetails()
      }
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyAction('')
    }
  }

  function refreshDiagnostics(): Promise<void> {
    return runPanelAction('刷新诊断', () => window.hfm.getSharedMetadataDiagnostics({ includeRepairDryRun: true }), true)
  }

  function synchronizeDiagnostics(): Promise<void> {
    return runPanelAction('同步并诊断', () => window.hfm.getSharedMetadataDiagnostics({ synchronize: true, includeRepairDryRun: true }), true)
  }

  function dryRunRepair(): Promise<void> {
    return runPanelAction('预检修复', () => window.hfm.repairSharedMetadata({
      apply: false,
      repairInvalidTagJson: true,
      purgeInvalidTagOps: true,
      archiveOrphanTagOps: true,
      purgeArchivedOrphanTagOps: false,
    }), false)
  }

  function applySafeRepair(): Promise<void> {
    return runPanelAction('应用安全修复', () => window.hfm.repairSharedMetadata({
      apply: true,
      synchronizeAfterRepair: true,
      repairInvalidTagJson: true,
      purgeInvalidTagOps: true,
      archiveOrphanTagOps: true,
      purgeArchivedOrphanTagOps: false,
      orphanArchiveReason: 'frontend-maintenance-panel',
    }), false)
  }

  function purgeArchivedOrphans(): Promise<void> {
    const confirmed = window.confirm('会归档并清理已确认孤儿的共享标签操作记录。确认继续？')
    if (!confirmed) return Promise.resolve()
    return runPanelAction('归档并清理孤儿操作', () => window.hfm.repairSharedMetadata({
      apply: true,
      synchronizeAfterRepair: true,
      repairInvalidTagJson: false,
      purgeInvalidTagOps: false,
      archiveOrphanTagOps: true,
      purgeArchivedOrphanTagOps: true,
      orphanArchiveReason: 'frontend-maintenance-panel-purge',
    }), false)
  }

  return (
    <div className="shared-metadata-maintenance-panel">
      <div className="shared-metadata-maintenance-header">
        <div>
          <h3>共享元数据维护面板</h3>
          <p>用于检查、同步、预检和修复共享标签 / 共享元数据。修复会走现有后端维护 IPC，不直接在前端改数据库。</p>
        </div>
        <span className={`shared-metadata-severity severity-${severity}`}>{severity}</span>
      </div>

      <div className="shared-metadata-summary-grid">
        <div><strong>{diagnosticsValue(report, 'roots')}</strong><span>监听根目录</span></div>
        <div><strong>{diagnosticsValue(report, 'existingRoots')}</strong><span>已有元数据库</span></div>
        <div><strong>{diagnosticsValue(report, 'synchronizedRoots')}</strong><span>本次同步根</span></div>
        <div><strong>{hasProblems(summary) ? '需要处理' : '正常'}</strong><span>维护状态</span></div>
      </div>

      <div className="shared-metadata-summary-grid compact">
        <div><strong>{diagnosticsValue(summary, 'invalidTagJsonRows')}</strong><span>非法标签 JSON</span></div>
        <div><strong>{diagnosticsValue(summary, 'missingTagOps')}</strong><span>缺失操作日志</span></div>
        <div><strong>{diagnosticsValue(summary, 'conflicts')}</strong><span>标签冲突</span></div>
        <div><strong>{diagnosticsValue(summary, 'orphanTagOps')}</strong><span>孤儿操作</span></div>
      </div>

      <div className="shared-metadata-maintenance-actions">
        <button type="button" disabled={busy} onClick={() => void refreshDiagnostics()}>刷新诊断</button>
        <button type="button" disabled={busy} onClick={() => void synchronizeDiagnostics()}>同步并诊断</button>
        <button type="button" disabled={busy} onClick={() => void dryRunRepair()}>预检修复</button>
        <button type="button" disabled={busy} onClick={() => void applySafeRepair()}>应用安全修复</button>
        <button type="button" disabled={busy} onClick={() => void purgeArchivedOrphans()}>归档并清理孤儿操作</button>
      </div>

      {busyAction && <p className="shared-metadata-action-status">正在执行：{busyAction}</p>}
      {lastError && <p className="shared-metadata-action-error">{lastError}</p>}

      {!!reports.length && (
        <div className="shared-metadata-root-list">
          {reports.slice(0, 8).map((item, index) => {
            const root = asRecord(item)
            const rootSeverity = asString(root?.severity, root?.error ? 'critical' : 'unknown')
            return (
              <div key={`${asString(root?.rootPath, 'root')}-${index}`} className="shared-metadata-root-row">
                <div>
                  <strong>{rootDisplayName(root?.rootPath)}</strong>
                  <span>{asString(root?.dbPath, '无数据库路径')}</span>
                </div>
                <span className={`shared-metadata-severity severity-${rootSeverity}`}>{rootSeverity}</span>
              </div>
            )
          })}
        </div>
      )}

      {lastResult !== null && (
        <details className="shared-metadata-action-result">
          <summary>查看最近维护结果</summary>
          <pre>{stringifyDeveloperValue(lastResult)}</pre>
        </details>
      )}
    </div>
  )
}
