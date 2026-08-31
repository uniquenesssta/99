import React,{ Profiler } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

window.addEventListener('error', (event) => {
  const fallback = document.getElementById('boot-fallback')
  if (fallback) {
    fallback.innerHTML = `<div style="max-width:860px;padding:28px;background:#17191f;border:1px solid #2a2f3c;border-radius:18px;">
      <h1>前端脚本错误</h1>
      <pre style="white-space:pre-wrap;word-break:break-word;">${String(event.message)}</pre>
    </div>`
  }
})

window.addEventListener('unhandledrejection', (event) => {
  const fallback = document.getElementById('boot-fallback')
  if (fallback) {
    fallback.innerHTML = `<div style="max-width:860px;padding:28px;background:#17191f;border:1px solid #2a2f3c;border-radius:18px;">
      <h1>前端异步错误</h1>
      <pre style="white-space:pre-wrap;word-break:break-word;">${String(event.reason)}</pre>
    </div>`
  }
})

document.getElementById('boot-fallback')?.remove()


function reportReactRender(
  id: string,
  phase: 'mount' | 'update' | 'nested-update',
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number
): void {
  const durationMs = Math.round(actualDuration * 10) / 10
  if (phase !== 'mount' && durationMs < 8) return
  window.hfm?.reportPerformanceEvent?.({
    source: 'renderer',
    kind: 'react-render-commit',
    label: id,
    severity: durationMs >= 32 ? 'warn' : durationMs >= 8 ? 'slow' : 'info',
    durationMs,
    timestamp: Date.now(),
    details: {
      phase,
      baseDurationMs: Math.round(baseDuration * 10) / 10,
      startTimeMs: Math.round(startTime),
      commitTimeMs: Math.round(commitTime)
    }
  }).catch(() => undefined)
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Profiler id="App" onRender={reportReactRender}>
      <App />
    </Profiler>
  </React.StrictMode>
)
