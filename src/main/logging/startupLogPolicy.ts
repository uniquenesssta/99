export interface StartupLogPolicy {
  shouldAppend(message: string): boolean
}

function normalizedLogDetail(): string {
  return String(process.env.HFM_LOG_DETAIL || '').trim().toLowerCase()
}

export function detailedStartupLogsEnabled(): boolean {
  const detail = normalizedLogDetail()
  return process.env.HFM_VERBOSE_LOGS === '1' || detail === 'debug' || detail === 'verbose' || detail === 'full'
}

function extractIpcChannel(text: string): string {
  const match = text.match(/channel=([^, ]+)/)
  return match ? String(match[1] || '') : ''
}

function previewIpcLogThreshold(channel: string): number | null {
  if (channel === 'fonts:getCachedPreviewImage') return 1600
  if (channel === 'fonts:getCachedPreviewImages') return 4000
  if (channel === 'fonts:renderPreviewImage') return 1400
  return null
}

function extractDurationMs(text: string, patterns: RegExp[]): number {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) return Number(match[1] || 0)
  }
  return 0
}

function isErrorOrFailureLog(lower: string): boolean {
  return (
    lower.includes('error') ||
    lower.includes('failed') ||
    lower.includes('corrupt') ||
    lower.includes('quarantine') ||
    lower.includes('uncaught') ||
    lower.includes('unhandled') ||
    lower.includes('panic') ||
    lower.includes('fatal')
  )
}

function isFontRecordLog(text: string): boolean {
  return /\bfontId=|\bfileName=|\bpostscriptName=|\bfamily=|\bfullName=|font protocol file not found|font protocol read failed/.test(text)
}

function isRoutineFontRecordLog(text: string): boolean {
  if (isFontRecordLog(text)) return true
  return (
    text.startsWith('activation step:') ||
    text.startsWith('activation batch copy result:') ||
    text.startsWith('activation install status cache hit:') ||
    text.startsWith('activation install status cache miss:') ||
    text.startsWith('temporary activation quick check:') ||
    text.startsWith('temporary activation verify:') ||
    text.startsWith('installed activation quick refresh:') ||
    text.startsWith('installed activation verify:') ||
    text.startsWith('rust activation copy used:')
  )
}

function isRoutineStateChurnLog(text: string): boolean {
  return (
    text.startsWith('rust core scheduler interactive activity noted:') ||
    text.startsWith('shared metadata mutation signal ignored:') ||
    text.startsWith('local tags mutation signal ignored:') ||
    text.startsWith('shared metadata mutation signal applied:') ||
    text.startsWith('local tags mutation signal applied:') ||
    text.startsWith('shared metadata mutation wrote by rust:') ||
    text.startsWith('shared metadata tag removed by rust:') ||
    text.startsWith('rust local tags set finished:') ||
    text.startsWith('rust local tags delete finished:') ||
    text.startsWith('rust shared metadata apply finished:') ||
    text.startsWith('rust shared metadata remove tag finished:') ||
    text.startsWith('tag metadata revision barrier:') ||
    text.startsWith('tag metadata barrier cleared fast metrics cache:')
  )
}

function shouldKeepDurationLog(text: string, thresholdMs: number): boolean {
  const elapsedMs = extractDurationMs(text, [
    /elapsed=(\d+)ms/,
    /durationMs=(\d+)/,
    /duration=(\d+)ms/,
    /workerElapsed=(\d+)ms/,
  ])
  return elapsedMs >= thresholdMs
}

function shouldKeepRoutinePerformanceLog(text: string): boolean {
  if (text.startsWith('tag metadata barrier delayed indexed')) return true
  if (text.startsWith('tag-aware indexed page result rejected:')) return true
  if (text.startsWith('memory fallback page query:')) return true
  if (text.startsWith('rust merged index page query:')) return shouldKeepDurationLog(text, 120)
  if (text.startsWith('rust merged index page query finished:')) return shouldKeepDurationLog(text, 120)
  if (text.startsWith('rust merged index metrics query finished:')) return shouldKeepDurationLog(text, 180)
  if (text.startsWith('rust metrics query:')) return shouldKeepDurationLog(text, 180)
  if (text.startsWith('db worker merged index page query:')) return shouldKeepDurationLog(text, 180)
  if (text.startsWith('db worker metrics query:')) return shouldKeepDurationLog(text, 180)
  if (text.startsWith('local merged index page query:')) return shouldKeepDurationLog(text, 180)
  if (text.startsWith('rust shared metadata overlay read finished:')) return shouldKeepDurationLog(text, 250)
  if (text.startsWith('rust shared metadata signature finished:')) return shouldKeepDurationLog(text, 500)
  if (text.startsWith('rust install status read finished:')) return shouldKeepDurationLog(text, 250)
  if (text.startsWith('machine install status rust read:')) return shouldKeepDurationLog(text, 250)
  if (text.startsWith('rust preview cache read-status finished:')) return shouldKeepDurationLog(text, 300)
  if (text.startsWith('preview request scheduler pressure:')) return true
  if (text.startsWith('preview cache tier summary:')) return true
  if (text.startsWith('renderer perf summary:')) return true
  if (text.startsWith('renderer long task:')) return true
  return false
}

export function createStartupLogPolicy(): StartupLogPolicy {
  const detailed = detailedStartupLogsEnabled()
  const lowValuePrefixes = [
    'sqlite quick_check ok:',
    'sqlite quick_check skipped fast-open shared cache:',
    'sqlite opened with better-sqlite3:',
    'checking renderer html:',
    'runtime preload written:',
    'gpu info basic:'
  ]
  const lowValueContains = [
    'console[0]',
    'console[1]'
  ]

  function shouldAppend(message: string): boolean {
    if (detailed) return true
    const text = String(message || '')
    const lower = text.toLowerCase()
    const isFailure = isErrorOrFailureLog(lower)

    if (isFailure) return true

    if (lowValuePrefixes.some((prefix) => text.startsWith(prefix))) return false
    if (lowValueContains.some((part) => text.includes(part))) return false

    if (isRoutineFontRecordLog(text)) return false
    if (isRoutineStateChurnLog(text)) return shouldKeepRoutinePerformanceLog(text)

    if (text.startsWith('perf ipc start:')) return false
    if (text.startsWith('perf ipc end:')) {
      if (text.includes('severity=error') || text.includes('status=failed')) return true
      if (text.includes('severity=info')) return false
      const durationMs = extractDurationMs(text, [/durationMs=(\d+)/])
      const previewThreshold = previewIpcLogThreshold(extractIpcChannel(text))
      if (previewThreshold !== null) return durationMs >= previewThreshold
      return durationMs >= 300 || text.includes('severity=warn')
    }

    if (text.startsWith('renderer perf event:')) {
      if (text.includes('severity=error')) return true
      const durationMs = extractDurationMs(text, [/durationMs=(\d+)/])
      return durationMs >= 300 || text.includes('severity=warn')
    }

    if (text.startsWith('perf db-worker request:')) return false
    if (text.startsWith('perf db-worker response:') && text.includes('status=ok')) {
      const durationMs = extractDurationMs(text, [/durationMs=(\d+)/])
      return durationMs >= 180
    }
    if (text.startsWith('perf db-worker exited:') && text.includes('expected=true')) return false

    if (shouldKeepRoutinePerformanceLog(text)) return true

    if (text.startsWith('gpu feature status:')) return false

    return true
  }

  return { shouldAppend }
}
