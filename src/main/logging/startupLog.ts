import fs,{ promises as fsp } from 'node:fs'
import { join } from 'node:path'

export interface StartupLogger {
  readonly fileName: string
  logPath(): string
  append(message: string): void
  flushAsync(): Promise<void>
  flushSync(): void
}

export function createStartupLogFileName(date = new Date(), pid = process.pid): string {
  return `startup-${date.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 23)}-${pid}.log`
}

export function createStartupLogger(options: { logsDir: () => string; fileName?: string; flushDelayMs?: number; maxBufferBytes?: number }): StartupLogger {
  const fileName = options.fileName || createStartupLogFileName()
  const flushDelayMs = Math.max(10, options.flushDelayMs ?? 80)
  const maxBufferBytes = Math.max(4 * 1024, options.maxBufferBytes ?? 64 * 1024)

  let buffer = ''
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let writeTail: Promise<void> = Promise.resolve()

  const logPath = (): string => join(options.logsDir(), fileName)

  const clearFlushTimer = (): void => {
    if (!flushTimer) return
    clearTimeout(flushTimer)
    flushTimer = null
  }

  const scheduleFlush = (delayMs = flushDelayMs): void => {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flushAsync()
    }, delayMs)
    flushTimer.unref?.()
  }

  const enqueueChunk = (chunk: string): Promise<void> => {
    const write = writeTail.then(async () => {
      try {
        await fsp.mkdir(options.logsDir(), { recursive: true })
        await fsp.appendFile(logPath(), chunk, 'utf-8')
      } catch {
        // Startup logging must never block application startup or shutdown.
      }
    })
    writeTail = write.catch(() => undefined)
    return write
  }

  const flushAsync = async (): Promise<void> => {
    clearFlushTimer()
    while (buffer) {
      const chunk = buffer
      buffer = ''
      await enqueueChunk(chunk)
    }
    await writeTail
    if (buffer) await flushAsync()
  }

  const flushSync = (): void => {
    clearFlushTimer()
    if (!buffer) return
    const chunk = buffer
    buffer = ''
    try {
      fs.mkdirSync(options.logsDir(), { recursive: true })
      fs.appendFileSync(logPath(), chunk, 'utf-8')
    } catch {
      // ignore
    }
  }

  const append = (message: string): void => {
    buffer += `[${new Date().toISOString()}] ${message}\n`
    if (buffer.length > maxBufferBytes) {
      void flushAsync()
      return
    }
    scheduleFlush()
  }

  return { fileName, logPath, append, flushAsync, flushSync }
}
