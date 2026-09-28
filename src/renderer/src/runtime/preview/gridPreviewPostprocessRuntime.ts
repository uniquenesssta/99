export type TrimmedPreviewImage = { image: string; clipped: boolean }
export type GridPreviewCrop = TrimmedPreviewImage & { width: number; height: number }

// grid-v1 is at most 4096 × 128. Account for the source canvas, RGBA readback
// and output canvas, as well as UTF-16 source/result strings. These are budgets,
// not measurements of the browser's complete image/GC memory usage.
export const GRID_POSTPROCESS_LIMITS = {
  active: 2, pending: 64, pendingBytes: 16 * 1024 * 1024,
  workingBytes: 16 * 1024 * 1024, cacheBytes: 32 * 1024 * 1024,
  cacheEntries: 240, pixels: 4096 * 128
} as const

type Job = {
  source: string; encodedBytes: number; workingBytes: number; epoch: number
  listeners: Set<(value: TrimmedPreviewImage) => void>; active: boolean
}

function pngPixels(source: string): number {
  const prefix = 'data:image/png;base64,'
  if (!source.startsWith(prefix)) return 0
  try {
    const header = atob(source.slice(prefix.length, prefix.length + 44))
    if (!header.startsWith('\x89PNG\r\n\x1a\n') || header.slice(12, 16) !== 'IHDR') return 0
    const uint = (offset: number) => [0, 1, 2, 3].reduce((n, i) => n * 256 + header.charCodeAt(offset + i), 0)
    const width = uint(16), height = uint(20)
    return width > 0 && width <= 4096 && height > 0 && width * height <= GRID_POSTPROCESS_LIMITS.pixels ? width * height : 0
  } catch { return 0 }
}

export function createGridPreviewPostprocessRuntime(
  crop: (source: string, wanted: () => boolean) => Promise<GridPreviewCrop | undefined>
) {
  const cache = new Map<string, { value: TrimmedPreviewImage; bytes: number }>()
  const jobs = new Map<string, Job>()
  const pending: Job[] = []
  const lifecycleListeners = new Set<() => void>()
  let cacheBytes = 0, pendingBytes = 0, workingBytes = 0, active = 0, epoch = 0
  let paused = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const fallback = (source: string): TrimmedPreviewImage => ({ image: source, clipped: true })
  const wanted = (job: Job) => !paused && job.epoch === epoch && job.listeners.size > 0

  function removePending(job: Job): void {
    const index = pending.indexOf(job)
    if (index < 0) return
    pending.splice(index, 1)
    pendingBytes -= job.encodedBytes
    if (jobs.get(job.source) === job) jobs.delete(job.source)
  }

  function remember(source: string, value: GridPreviewCrop): void {
    const bytes = (source.length + value.image.length) * 2 + value.width * value.height * 4
    if (bytes > GRID_POSTPROCESS_LIMITS.cacheBytes) return
    const previous = cache.get(source)
    if (previous) { cacheBytes -= previous.bytes; cache.delete(source) }
    cache.set(source, { value: { image: value.image, clipped: value.clipped }, bytes })
    cacheBytes += bytes
    while (cache.size > GRID_POSTPROCESS_LIMITS.cacheEntries || cacheBytes > GRID_POSTPROCESS_LIMITS.cacheBytes) {
      const oldest = cache.keys().next().value!
      cacheBytes -= cache.get(oldest)!.bytes
      cache.delete(oldest)
    }
  }

  function schedule(): void {
    if (paused || timer !== undefined || !pending.length || active >= GRID_POSTPROCESS_LIMITS.active) return
    // Yield between admissions instead of starting every decoded image in the
    // same promise chain. A queued request can be released before any decode.
    timer = setTimeout(() => { timer = undefined; pump() }, 0)
  }

  function pump(): void {
    while (!paused && pending.length && active < GRID_POSTPROCESS_LIMITS.active) {
      const job = pending[0]
      if (workingBytes + job.workingBytes > GRID_POSTPROCESS_LIMITS.workingBytes) break
      pending.shift(); pendingBytes -= job.encodedBytes
      job.active = true; active++; workingBytes += job.workingBytes
      void (async () => {
        let value: GridPreviewCrop | undefined
        try { value = await crop(job.source, () => wanted(job)) } catch { /* show uncropped source; do not cache a failure */ }
        if (wanted(job)) {
          if (value) remember(job.source, value)
          for (const listener of job.listeners) listener(value || fallback(job.source))
        }
      })().finally(() => {
        // Cancellation never frees an active slot before the real decode and
        // synchronous canvas work have returned, including across close/resume.
        job.listeners.clear()
        active--; workingBytes -= job.workingBytes
        if (jobs.get(job.source) === job) jobs.delete(job.source)
        schedule()
      })
    }
  }

  function request(source: string, listener: (value: TrimmedPreviewImage) => void): () => void {
    if (paused) return () => {}
    const hit = cache.get(source)
    if (hit) { cache.delete(source); cache.set(source, hit); listener(hit.value); return () => {} }
    let job = jobs.get(source)
    if (!job) {
      const pixels = pngPixels(source), encodedBytes = source.length * 2
      const cost = encodedBytes + pixels * 12
      if (!pixels || cost > GRID_POSTPROCESS_LIMITS.workingBytes || pending.length >= GRID_POSTPROCESS_LIMITS.pending || pendingBytes + encodedBytes > GRID_POSTPROCESS_LIMITS.pendingBytes) {
        // Bounded admission must not leave a visible card blank forever. Keep
        // its original PNG with an explicit boundary hint, without caching it.
        listener(fallback(source)); return () => {}
      }
      job = { source, encodedBytes, workingBytes: cost, epoch, listeners: new Set(), active: false }
      jobs.set(source, job); pending.push(job); pendingBytes += encodedBytes
    }
    job.listeners.add(listener)
    schedule()
    let released = false
    return () => {
      if (released) return
      released = true
      job!.listeners.delete(listener)
      if (!job!.listeners.size && !job!.active) removePending(job!)
      if (!pending.length && timer !== undefined) { clearTimeout(timer); timer = undefined }
    }
  }

  return {
    request,
    setPaused(next: boolean, clearCache = true) {
      if (next && clearCache) { cache.clear(); cacheBytes = 0 }
      if (paused === next) return
      paused = next; epoch++
      if (next) {
        if (timer !== undefined) { clearTimeout(timer); timer = undefined }
        for (const job of jobs.values()) job.listeners.clear()
        jobs.clear(); pending.length = 0; pendingBytes = 0
      }
      for (const listener of lifecycleListeners) listener()
      if (!next) schedule()
    },
    subscribe(listener: () => void) { lifecycleListeners.add(listener); return () => { lifecycleListeners.delete(listener) } },
    getSnapshot: () => epoch,
    getStats: () => ({ active, workingBytes, pending: pending.length, pendingBytes, cacheEntries: cache.size, cacheBytes, paused })
  }
}
