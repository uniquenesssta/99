import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface SharedFolderNotificationOptions {
  getWorkerPath?: () => Promise<string | undefined>
  log: (message: string) => void
  spawnProcess?: typeof spawn
}

/** Notification children have their own bounded owner; they never occupy finite I/O lanes. */
export function createSharedFolderNotificationRuntime(options: SharedFolderNotificationOptions) {
  const live = new Set<Promise<void>>()
  const maxChildren = 8
  const spawnProcess = options.spawnProcess || spawn
  let starting = 0
  const log = (message: string) => { try { options.log(message) } catch { /* Never affect child cleanup. */ } }

  function watch(folder: string, changed: (deliveryObserved?: boolean, paths?: readonly string[]) => void) {
    let stopped = false
    let child: ChildProcessWithoutNullStreams | undefined
    let closed: Promise<void> | undefined
    let startingTask: Promise<void> | undefined
    let retryAt = 0
    let failures = 0
    let unsupported = false
    let stopChild: (() => void) | undefined
    let invalidateChild: (() => void) | undefined
    const notify = (deliveryObserved = false, paths: readonly string[] = []) => { try { changed(deliveryObserved, paths) } catch { log('shared watcher reconciliation hint rejected; periodic reconciliation retained') } }

    async function ensureStarted(): Promise<void> {
      if (stopped || unsupported || child || Date.now() < retryAt) return
      if (startingTask) return startingTask
      const task = start()
      startingTask = task
      try { await task } finally { if (startingTask === task) startingTask = undefined }
    }

    async function start(): Promise<void> {
      if (live.size + starting >= maxChildren) { retryAt = Date.now() + 30000; return }
      starting += 1
      try {
        const workerPath = await options.getWorkerPath?.()
        if (stopped) return
        if (!workerPath) { unsupported = true; log('shared watcher notifications unavailable; periodic reconciliation retained'); return }
        const process = spawnProcess(workerPath, ['--watch-shared-root', folder], {
          stdio: 'pipe', windowsHide: true, shell: false,
          env: { ...globalThis.process.env, HFM_PARENT_PID: String(globalThis.process.pid) },
        }) as ChildProcessWithoutNullStreams
        child = process
        let settleClosed!: () => void
        closed = new Promise<void>(resolve => { settleClosed = resolve })
        const whenClosed = closed
        live.add(whenClosed)
        let settleReady!: () => void
        const ready = new Promise<void>(resolve => { settleReady = resolve })
        let timer: ReturnType<typeof setTimeout> | undefined
        let killTimer: ReturnType<typeof setTimeout> | undefined
        let buffer = ''
        let failed = false
        let registered = false
        let observed = false
        let windowStart = Date.now()
        let bytesInWindow = 0
        const arm = (delay: number) => {
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => fail(registered ? 'heartbeat-timeout' : 'registration-timeout'), delay)
          timer.unref?.()
        }
        const kill = () => {
          if (timer) clearTimeout(timer)
          timer = undefined
          settleReady()
          try { process.kill('SIGTERM') } catch { /* Physical close is still required. */ }
          if (!killTimer) {
            killTimer = setTimeout(() => { try { process.kill('SIGKILL') } catch { /* Wait for close, never release a live slot. */ } }, 1000)
            killTimer.unref?.()
          }
        }
        const fail = (reason: string) => {
          if (failed || stopped) return
          failed = true
          failures = Math.min(failures + 1, 4)
          retryAt = Date.now() + Math.min(300000, 30000 * 2 ** (failures - 1))
          log(`shared watcher notification fallback: reason=${reason}; retryMs=${Math.max(0, retryAt - Date.now())}; periodic reconciliation retained`)
          notify()
          kill()
        }
        stopChild = kill
        invalidateChild = () => fail('root-reconciliation-failed')
        process.on('error', () => fail('process-error'))
        process.stdin.on('error', () => fail('stdin-error'))
        process.stdout.on('error', () => fail('stdout-error'))
        process.stderr.on('error', () => fail('stderr-error'))
        process.on('close', () => {
          if (timer) clearTimeout(timer)
          if (killTimer) clearTimeout(killTimer)
          if (!stopped && !failed) fail('process-closed')
          if (killTimer) clearTimeout(killTimer)
          if (child === process) { child = undefined; stopChild = undefined; invalidateChild = undefined }
          live.delete(whenClosed)
          settleReady()
          settleClosed()
        })
        const account = (bytes: number): boolean => {
          if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); bytesInWindow = 0 }
          bytesInWindow += bytes
          if (bytesInWindow > 65536) { fail('traffic-budget'); return false }
          return true
        }
        process.stderr.on('data', (chunk: Buffer) => { account(chunk.length) })
        process.stdout.setEncoding('utf8')
        process.stdout.on('data', (chunk: string) => {
          if (stopped || failed || !account(Buffer.byteLength(chunk))) return
          buffer += chunk
          for (;;) {
            const end = buffer.indexOf('\n')
            if (end < 0) { if (Buffer.byteLength(buffer) > 16384) fail('receipt-budget'); break }
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
            if (Buffer.byteLength(line) > 16384) { fail('receipt-budget'); return }
            let receipt: { type?: string; protocol?: number; paths?: unknown }
            try { receipt = JSON.parse(line) } catch { fail('invalid-receipt'); return }
            if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || Object.keys(receipt).some(key => !['protocol', 'type', ...(receipt.type === 'change' ? ['paths'] : [])].includes(key)) || receipt.protocol !== 1 || !['registered', 'heartbeat', 'change', 'overflow', 'error'].includes(receipt.type || '')) { fail('invalid-receipt'); return }
            const paths: string[] = []
            if (receipt.type === 'change') {
              if (!Array.isArray(receipt.paths) || receipt.paths.length > 64) { fail('invalid-path-hints'); return }
              for (const value of receipt.paths) {
                if (typeof value !== 'string' || Buffer.byteLength(value) > 1024) { fail('invalid-path-hints'); return }
                const name = value.replaceAll('\\', '/')
                if (!name || /[:\0]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) { fail('invalid-path-hints'); return }
                paths.push(name)
              }
            }
            if (receipt.type === 'error') { fail('native-error'); return }
            if (!registered && receipt.type !== 'registered') { fail('receipt-before-registration'); return }
            if (receipt.type === 'registered') {
              if (registered) { fail('duplicate-registration'); return }
              registered = true
              log('shared watcher notification handle registered; delivery not yet observed; periodic reconciliation retained')
              settleReady()
            } else if (receipt.type === 'change') {
              if (!observed) { observed = true; failures = 0; log('shared watcher notification delivery observed; periodic reconciliation retained') }
              notify(true, paths)
            } else if (receipt.type === 'overflow') { notify(true); log('shared watcher notification overflow; complete reconciliation requested') }
            arm(15000)
          }
        })
        arm(5000)
        process.stdin.end()
        if (stopped) kill()
        await ready
      } catch {
        failures = Math.min(failures + 1, 4)
        retryAt = Date.now() + Math.min(300000, 30000 * 2 ** (failures - 1))
        log('shared watcher notification startup failed; periodic reconciliation retained')
      } finally { starting -= 1 }
    }

    return {
      ensureStarted,
      invalidate() { invalidateChild?.() },
      close() { stopped = true; stopChild?.() },
      async whenClosed() { await startingTask; await closed },
    }
  }

  return { watch, async whenClosed() { await Promise.all([...live]) } }
}
