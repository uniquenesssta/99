import { isRustCoreDaemonSubmittedError } from './rustCoreDaemonRuntime'

export function rethrowRustCoreDaemonSubmittedJob(error: unknown, appendStartupLog?: (message: string) => void, context?: string): void {
  if (!isRustCoreDaemonSubmittedError(error)) return
  const prefix = context ? `${context}: ` : ''
  appendStartupLog?.(`${prefix}${error.message}; fallback blocked because the job was already submitted to Rust daemon`)
  throw error
}

export function rethrowRustCoreDaemonSubmittedWrite(error: unknown, appendStartupLog?: (message: string) => void, context?: string): void {
  rethrowRustCoreDaemonSubmittedJob(error, appendStartupLog, context)
}
