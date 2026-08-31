export interface RuntimePerformanceMemorySummary {
  rssMb: number
  heapUsedMb: number
  heapTotalMb: number
  externalMb: number
}

export interface RuntimePerformanceSamplerOptions {
  appendLog: (message: string) => void
  ioSnapshot: () => unknown
  rendererActive: () => boolean
  rendererIdleInMs: () => number
  rendererActivityReason: () => string
  scanActive: () => boolean
  scanJob: () => string
  installRefreshActive: () => boolean
  backgroundTasksActive: () => number
  intervalMs?: number
}

export interface RuntimePerformanceSampler {
  start: () => void
  stop: () => void
  appendSnapshot: (reason: string) => void
}

export function processPerformanceMemorySummary(): RuntimePerformanceMemorySummary {
  const memory = process.memoryUsage()
  const toMb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10
  return {
    rssMb: toMb(memory.rss),
    heapUsedMb: toMb(memory.heapUsed),
    heapTotalMb: toMb(memory.heapTotal),
    externalMb: toMb(memory.external)
  }
}

export function createRuntimePerformanceSampler(options: RuntimePerformanceSamplerOptions): RuntimePerformanceSampler {
  let timer: NodeJS.Timeout | null = null
  const intervalMs = Math.max(5000, options.intervalMs || 15000)
  const sampleRendererActive = process.env.HFM_PERF_SAMPLE_RENDERER_ACTIVE === '1'

  function appendSnapshot(reason: string): void {
    const io = options.ioSnapshot()
    options.appendLog(
      `runtime health: reason=${reason}, memory=${JSON.stringify(processPerformanceMemorySummary())}, io=${JSON.stringify(io)}, rendererActive=${options.rendererActive()}, rendererIdleInMs=${options.rendererIdleInMs()}, rendererReason=${options.rendererActivityReason()}, scanActive=${options.scanActive()}, scanJob=${options.scanJob()}, installRefreshActive=${options.installRefreshActive()}, backgroundTasks=${options.backgroundTasksActive()}`
    )
  }

  function shouldSample(): boolean {
    const io = options.ioSnapshot() as { active?: number; pending?: number }
    return Boolean(
      Number(io?.active || 0) > 0 ||
        Number(io?.pending || 0) > 0 ||
        (sampleRendererActive && options.rendererActive()) ||
        options.scanActive() ||
        options.installRefreshActive() ||
        options.backgroundTasksActive() > 0
    )
  }

  function start(): void {
    if (timer) return
    appendSnapshot('startup')
    timer = setInterval(() => {
      if (shouldSample()) appendSnapshot('interval')
    }, intervalMs)
    timer.unref?.()
  }

  function stop(): void {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  return { start, stop, appendSnapshot }
}
