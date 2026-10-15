export type OperationStatusNoticeProps = { message: string | null; onDismiss: () => void }

/** One dismissible operation receipt, separate from developer/background status. */
export function OperationStatusNotice({ message, onDismiss }: OperationStatusNoticeProps): JSX.Element | null {
  if (!message) return null
  return (
    <aside className="operation-status-notice" aria-label="操作反馈">
      <div className="operation-status-notice-header">
        <strong>操作反馈</strong>
        <button type="button" aria-label="关闭操作反馈" onClick={onDismiss}>关闭</button>
      </div>
      <p role="status" aria-live="polite">{message}</p>
    </aside>
  )
}
