import {
createStartupLogFileName,
createStartupLogger
} from '../logging/startupLog'
import { createStartupLogPolicy } from '../logging/startupLogPolicy'

export function createMainLoggingBootstrap(options: { logsDir: () => string }) {
  const launchLogFileName = createStartupLogFileName()
  const startupLogger = createStartupLogger({
    logsDir: options.logsDir,
    fileName: launchLogFileName
  })
  const logPolicy = createStartupLogPolicy()

  function logPath(): string {
    return startupLogger.logPath()
  }

  function flushStartupLogAsync(): Promise<void> {
    return startupLogger.flushAsync()
  }

  function flushStartupLogSync(): void {
    startupLogger.flushSync()
  }

  function appendStartupLog(message: string): void {
    if (!logPolicy.shouldAppend(message)) return
    startupLogger.append(message)
  }

  return {
    launchLogFileName,
    logPath,
    flushStartupLogAsync,
    flushStartupLogSync,
    appendStartupLog
  }
}
