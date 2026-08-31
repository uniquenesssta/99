import type { LeaseLockConflictNotice as LeaseLockConflictNoticeState } from '../../runtime/lease-lock/leaseLockConflictNoticeRuntime'

type LeaseLockConflictNoticeProps = {
  notice: LeaseLockConflictNoticeState | null
  onClose: () => void
}

function copyNoticeText(notice: LeaseLockConflictNoticeState): void {
  const text = [
    'HanFontManager NAS lease lock 冲突',
    `锁定设备：${notice.machineId}`,
    `操作：${notice.operationLabel}`,
    `原始操作：${notice.operation}`,
    `剩余约：${notice.remainingSeconds} 秒`,
    `到期：${notice.expiresAtText}`,
    `资源：${notice.resourcePath}`,
    `原始提示：${notice.sourceText}`,
  ].join('\n')
  void navigator.clipboard?.writeText(text).catch(() => undefined)
}

export function LeaseLockConflictNotice({ notice, onClose }: LeaseLockConflictNoticeProps): JSX.Element | null {
  if (!notice) return null

  return (
    <div className="lease-lock-notice" role="status" aria-live="polite">
      <div className="lease-lock-notice-header">
        <strong>NAS 操作被其他设备临时锁定</strong>
        <button type="button" aria-label="关闭 NAS 锁冲突提示" onClick={onClose}>×</button>
      </div>
      <div className="lease-lock-notice-grid">
        <span>锁定设备</span><strong>{notice.machineId}</strong>
        <span>正在操作</span><strong>{notice.operationLabel}</strong>
        <span>剩余时间</span><strong>约 {notice.remainingSeconds} 秒</strong>
        <span>到期时间</span><strong>{notice.expiresAtText}</strong>
      </div>
      <div className="lease-lock-notice-path" title={notice.resourcePath}>{notice.resourcePath}</div>
      <div className="lease-lock-notice-actions">
        <button type="button" onClick={() => copyNoticeText(notice)}>复制锁信息</button>
        <button type="button" onClick={onClose}>知道了</button>
      </div>
    </div>
  )
}
