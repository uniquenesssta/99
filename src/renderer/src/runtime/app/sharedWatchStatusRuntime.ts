import { isSharedWatchStatus, type SharedWatchRootStatus, type SharedWatchStatus } from '../../../../shared/sharedWatchStatus'

type StatusConsumer = (status: SharedWatchStatus | null) => void
type Timer = ReturnType<typeof setTimeout>

/** Memory-only IPC: one unsettled request, even across effect cleanup/restart. */
export function createSharedWatchStatusPoller(options: {
  read: () => Promise<unknown>
  setTimer?: (callback: () => void, delayMs: number) => Timer
  clearTimer?: (timer: Timer) => void
}) {
  const setTimer = options.setTimer || setTimeout
  const clearTimer = options.clearTimer || clearTimeout
  let consumer: StatusConsumer | undefined
  let generation = 0
  let active = false
  let timer: Timer | undefined
  let deadline: Timer | undefined
  let lastKey: string | undefined

  function publish(value: SharedWatchStatus | null): void {
    const key = JSON.stringify(value)
    if (key === lastKey) return
    lastKey = key
    consumer?.(value)
  }

  async function poll(): Promise<void> {
    timer = undefined
    if (!consumer || active) return
    active = true
    const ticket = generation
    let expired = false
    deadline = setTimer(() => {
      expired = true
      if (ticket === generation && consumer) publish(null)
    }, 6000)
    try {
      const value = await options.read()
      if (ticket === generation && consumer && !expired) publish(isSharedWatchStatus(value) ? value : null)
    } catch {
      if (ticket === generation && consumer) publish(null)
    } finally {
      active = false
      if (deadline !== undefined) clearTimer(deadline)
      deadline = undefined
      // Expiry only changes the display. It never abandons an in-flight request.
      if (consumer) timer = setTimer(() => { void poll() }, 2000)
    }
  }

  return {
    start(next: StatusConsumer): () => void {
      const ticket = ++generation
      consumer = next
      lastKey = undefined
      publish(null)
      if (timer !== undefined) clearTimer(timer)
      timer = undefined
      void poll()
      return () => {
        if (ticket !== generation) return
        generation += 1
        consumer = undefined
        if (timer !== undefined) clearTimer(timer)
        if (deadline !== undefined) clearTimer(deadline)
        timer = undefined
        deadline = undefined
      }
    }
  }
}

const phaseLabels: Record<SharedWatchRootStatus['phase'], string> = {
  idle: '等待检查', checking: '正在检查', applying: '正在处理',
  offline: '离线', error: '检查异常', stopped: '已暂停'
}

export function sharedWatchStatusPresentation(
  status: SharedWatchStatus | null,
  formatTime: (timestamp: number) => string = timestamp => new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
): { text: string; detail: string } | null {
  if (!status) return { text: 'NAS 监听状态待确认 · 上次检查时间：未知 · 正在处理：数量待确认', detail: '尚未取得当前监听状态；这不表示检查完成或目录在线。' }
  const roots = status.roots
  if (!roots.length) return null
  const known = roots.reduce((sum, root) => sum + (root.pendingCount ?? 0), 0)
  const unknown = roots.some(root => root.pendingCount === null) || !Number.isSafeInteger(known)
  const count = unknown ? (known > 0 && Number.isSafeInteger(known) ? `已确认 ${known} 项，其余待确认` : '数量待确认') : `${known} 项`
  const completed = roots.map(root => root.lastCheckedAt).filter((value): value is number => value !== null)
  const lastCheck = completed.length !== roots.length
    ? completed.length ? '部分位置尚未完成' : '尚未完成'
    : formatTime(completed.reduce((oldest, value) => Math.min(oldest, value), Number.POSITIVE_INFINITY)) + (roots.length > 1 ? '（最早）' : '')
  const phases = (['offline', 'error', 'stopped', 'checking', 'applying'] as const)
    .flatMap(phase => {
      const count = roots.filter(root => root.phase === phase).length
      return count ? [`${phaseLabels[phase]}${roots.length > 1 ? ` ${count} 处` : ''}`] : []
    })
  const detail = roots.slice(0, 8).map(root =>
    `${root.rootPath.slice(0, 160)}：${phaseLabels[root.phase]}；上次检查时间：${root.lastCheckedAt === null ? '尚未完成' : formatTime(root.lastCheckedAt)}；正在处理：${root.pendingCount === null ? '数量待确认' : `${root.pendingCount} 项`}`
  )
  if (roots.length > 8) detail.push(`另有 ${roots.length - 8} 处共享位置；汇总包含全部位置。`)
  detail.push('上次检查时间仅在目录检查和索引应用全部确认后更新；多位置汇总显示最早一次。处理数量仅包含本轮已确认的变更项，不是字体库总数。')
  return {
    text: `NAS 监听：${phases.join('、') || phaseLabels.idle} · 正在处理：${count} · 上次检查时间：${lastCheck}`,
    detail: detail.join('\n')
  }
}
