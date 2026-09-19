import { useRef, useState } from 'react'
import type { FontCleanupAction, FontCleanupReport } from '@shared/fontCleanup'

const stageNames: Record<string, string> = { active: '仍处于激活状态', 'copy-partial': '复制中断的副本', 'copy-pending': '复制未确认', 'registry-pending': '注册未确认', 'resource-pending': '激活未确认', 'resource-removal-pending': '等待取消字体资源', 'registry-removal-pending': '等待清理注册表', 'file-pending': '已停用，等待删除副本', legacy: '旧记录需要核验', resource: '字体资源待清理', registry: '注册表待清理', file: '副本待清理', journal: '恢复记录待结算' }
export function FontCleanupPanel(): JSX.Element {
  const [report, setReport] = useState<FontCleanupReport>({ records: [], errors: [] })
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({})
  const working = useRef(false)
  async function run(action?: FontCleanupAction) {
    if (working.current) return
    working.current = true; setBusy(true); setMessage('')
    try {
      const next = action ? await window.hfm.runFontCleanupAction(action) : await window.hfm.readFontCleanupRemnants()
      setReport(next); setConfirmed({})
      if (action?.action === 'restart') setMessage('已登记。重启并登录 Windows 后将启动软件，核验本地记录并继续清理。')
      else if (action?.action === 'dismiss-missing') setMessage('文件与注册表项已确认不存在，失效记录已清除。')
      else if (action?.action === 'adopt') setMessage('已按刚才确认的文件身份登记，可以点击“重试清理”。')
    } catch (error) { setMessage(String(error)) }
    finally { working.current = false; setBusy(false) }
  }
  return <details className="font-cleanup-panel" data-no-marquee style={{ padding: '6px 12px', maxHeight: '45vh', overflow: 'auto', flexShrink: 0 }} onToggle={event => { if (event.currentTarget.open) void run() }}>
    <summary>字体残留处理{report.records.length ? `（${report.records.length} 项）` : ''}</summary>
    <p>这里只处理本机临时副本。共享网络断开不影响这些记录的查看和清理。</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button disabled={busy} onClick={() => void run()}>刷新记录</button>
      <button disabled={busy || !report.records.length} onClick={() => void run({ action: 'retry' })}>重试清理</button>
      <button disabled={busy || !report.records.length} onClick={() => void run({ action: 'restart' })}>重启后继续清理</button>
      <button disabled={busy} onClick={() => void run({ action: 'open-fonts' })}>打开副本目录</button>
      <button disabled={busy} onClick={() => void run({ action: 'open-records' })}>打开记录目录</button>
    </div>
    {message && <p role="status">{message}</p>}
    {report.errors.map(error => <p role="alert" key={error}>{error}</p>)}
    {!busy && !report.records.length && !report.errors.length && <p>没有待处理的残留记录。</p>}
    {report.records.map(record => <div key={record.key} style={{ borderTop: '1px solid var(--border-color, #ccc)', padding: '10px 0' }}>
      <strong>{record.fileName}</strong> · {record.stage.split(',').map(stage => stageNames[stage] || stage).join('、')}
      <div style={{ overflowWrap: 'anywhere' }}>{record.path}</div>
      {record.error && <p>{record.error}</p>}
      {record.canDismissMissing && <div>
        <label><input type="checkbox" checked={!!confirmed[record.key]} disabled={busy} onChange={event => setConfirmed(previous => ({ ...previous, [record.key]: event.target.checked }))} />我已重启 Windows，此路径的字体已清理</label>
        <button disabled={busy || !confirmed[record.key]} onClick={() => void run({ action:'dismiss-missing',key:record.key,windowsRestarted:true })}>核验并清除失效记录</button>
      </div>}
      {record.canAdopt && record.observedToken && <div>
        <label><input type="checkbox" checked={!!confirmed[record.key]} disabled={busy} onChange={event => setConfirmed(previous => ({ ...previous, [record.key]: event.target.checked }))} />我已核对路径，确认这是本软件的临时副本</label>
        <button disabled={busy || !confirmed[record.key]} onClick={() => void run({ action: 'adopt', key: record.key, observedToken: record.observedToken! })}>确认文件身份</button>
      </div>}
    </div>)}
    {!!report.records.length && <p>文件被占用时可关闭使用该字体的程序后重试。若提示权限拒绝，可关闭软件后以管理员身份启动，再进行清理。文件身份已变化的记录不会自动删除。</p>}
  </details>
}
