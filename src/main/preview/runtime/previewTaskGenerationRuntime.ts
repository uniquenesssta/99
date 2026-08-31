export type PreviewTaskGenerationRuntime = {
  currentGeneration: () => number
  beginGeneration: (reason?: string) => number
  isCurrentGeneration: (generation: number) => boolean
}

const DEFAULT_LOG_THROTTLE_MS = 10000

export function createPreviewTaskGenerationRuntime(options: {
  appendStartupLog?: (message: string) => void
  label?: string
  now?: () => number
} = {}): PreviewTaskGenerationRuntime {
  const now = options.now || (() => Date.now())
  const label = options.label || 'preview-task'
  let generation = 0
  let lastLoggedAt = 0

  function currentGeneration(): number {
    return generation
  }

  function beginGeneration(reason = 'context-change'): number {
    generation += 1
    const current = now()
    if (options.appendStartupLog && current - lastLoggedAt >= DEFAULT_LOG_THROTTLE_MS) {
      lastLoggedAt = current
      options.appendStartupLog(`${label} generation advanced: generation=${generation}, reason=${reason}`)
    }
    return generation
  }

  function isCurrentGeneration(value: number): boolean {
    return value === generation
  }

  return {
    currentGeneration,
    beginGeneration,
    isCurrentGeneration,
  }
}
