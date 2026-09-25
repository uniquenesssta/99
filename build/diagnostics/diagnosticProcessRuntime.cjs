const { spawn, execFile } = require('node:child_process')

// Diagnostics own a process group/tree so a failed npm child cannot hold verify open.
function runDiagnosticProcess(command, args, options = {}) {
  const { timeoutMs = 300000, onTimeout = () => {}, ...spawnOptions } = options
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid diagnostic deadline')
  return new Promise(resolve => {
    let child, deadline, reapDeadline, settled = false, timedOut = false, error, terminationError
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(reapDeadline)
      resolve({ code, signal, timedOut, error, terminationError })
    }
    try {
      child = spawn(command, args, { ...spawnOptions, detached: process.platform !== 'win32', windowsHide: true })
    } catch (caught) { error = caught; finish(null, null); return }
    child.once('error', caught => { error = caught })
    child.once('close', finish)
    deadline = setTimeout(() => {
      timedOut = true
      onTimeout()
      reapDeadline = setTimeout(() => {
        terminationError ||= new Error('Diagnostic process did not close after tree termination')
        child.unref()
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(null, null)
      }, 6000)
      if (!child.pid) return
      if (process.platform === 'win32') {
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true }, caught => {
          if (caught && !settled) terminationError = caught
        })
      } else {
        try { process.kill(-child.pid, 'SIGKILL') }
        catch (caught) { if (caught.code !== 'ESRCH') terminationError = caught }
      }
    }, timeoutMs)
  })
}

module.exports = { runDiagnosticProcess }
