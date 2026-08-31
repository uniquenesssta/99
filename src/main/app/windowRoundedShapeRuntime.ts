import type { BrowserWindow, Rectangle } from 'electron'

export interface WindowRoundedShapeRuntimeOptions {
  platform?: NodeJS.Platform
  radius?: number
  appendLog?: (message: string) => void
}

export interface WindowRoundedShapeRuntime {
  refresh: (reason: string, force?: boolean) => void
  dispose: () => void
}

function mergeRow(rects: Rectangle[], next: Rectangle): void {
  const previous = rects[rects.length - 1]
  if (
    previous
    && previous.x === next.x
    && previous.width === next.width
    && previous.y + previous.height === next.y
  ) {
    previous.height += next.height
    return
  }
  rects.push(next)
}

export function buildRoundedWindowShape(width: number, height: number, radius: number): Rectangle[] {
  const safeWidth = Math.max(1, Math.floor(width))
  const safeHeight = Math.max(1, Math.floor(height))
  const safeRadius = Math.max(0, Math.min(Math.floor(radius), Math.floor(safeWidth / 2), Math.floor(safeHeight / 2)))
  if (safeRadius <= 0) return [{ x: 0, y: 0, width: safeWidth, height: safeHeight }]

  const rects: Rectangle[] = []
  for (let y = 0; y < safeRadius; y += 1) {
    const distanceFromCenter = safeRadius - y - 0.5
    const inset = Math.max(
      0,
      Math.ceil(safeRadius - Math.sqrt(Math.max(0, safeRadius * safeRadius - distanceFromCenter * distanceFromCenter))),
    )
    mergeRow(rects, {
      x: inset,
      y,
      width: Math.max(1, safeWidth - inset * 2),
      height: 1,
    })
  }

  const middleHeight = safeHeight - safeRadius * 2
  if (middleHeight > 0) {
    mergeRow(rects, { x: 0, y: safeRadius, width: safeWidth, height: middleHeight })
  }

  for (let y = safeRadius - 1; y >= 0; y -= 1) {
    const source = rects.find((rect) => y >= rect.y && y < rect.y + rect.height)
    const inset = source?.x || 0
    mergeRow(rects, {
      x: inset,
      y: safeHeight - y - 1,
      width: Math.max(1, safeWidth - inset * 2),
      height: 1,
    })
  }

  return rects
}

export function createWindowRoundedShapeRuntime(
  window: BrowserWindow,
  options: WindowRoundedShapeRuntimeOptions = {},
): WindowRoundedShapeRuntime {
  const platform = options.platform || process.platform
  const radius = Math.max(0, Math.floor(options.radius ?? 18))
  const appendLog = options.appendLog || (() => undefined)
  let disposed = false
  let timer: NodeJS.Timeout | null = null
  let followUpTimer: NodeJS.Timeout | null = null
  let lastSignature = ''
  let loggedInitialApply = false

  function clearTimers(): void {
    if (timer) clearTimeout(timer)
    if (followUpTimer) clearTimeout(followUpTimer)
    timer = null
    followUpTimer = null
  }

  function invalidateContents(): void {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.invalidate()
  }

  function apply(reason: string, force = false): void {
    if (disposed || platform !== 'win32' || window.isDestroyed()) return
    if (typeof window.setShape !== 'function') return

    try {
      if (window.isMaximized() || window.isFullScreen()) {
        const signature = 'rectangular'
        if (force || lastSignature !== signature) window.setShape([])
        lastSignature = signature
        invalidateContents()
        return
      }

      const bounds = window.getBounds()
      const signature = `${bounds.width}x${bounds.height}@${radius}`
      if (force || signature !== lastSignature) {
        window.setShape(buildRoundedWindowShape(bounds.width, bounds.height, radius))
        lastSignature = signature
      }
      invalidateContents()
      if (!loggedInitialApply) {
        loggedInitialApply = true
        appendLog(`window native rounded shape applied: radius=${radius}, size=${bounds.width}x${bounds.height}, reason=${reason}`)
      }
    } catch (error) {
      appendLog(`window native rounded shape failed: reason=${reason}, message=${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function schedule(reason: string, force = false, delayMs = 0, withFollowUp = false): void {
    if (disposed || platform !== 'win32') return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      apply(reason, force)
    }, Math.max(0, delayMs))

    if (withFollowUp) {
      if (followUpTimer) clearTimeout(followUpTimer)
      followUpTimer = setTimeout(() => {
        followUpTimer = null
        apply(`${reason}-settled`, true)
      }, 90)
    }
  }

  const onResize = (): void => schedule('resize', false, 16)
  const onFocus = (): void => schedule('focus', true, 0, true)
  const onBlur = (): void => schedule('blur', true, 0, true)
  const onShow = (): void => schedule('show', true, 0, true)
  const onRestore = (): void => schedule('restore', true, 0, true)
  const onMaximize = (): void => schedule('maximize', true)
  const onUnmaximize = (): void => schedule('unmaximize', true, 0, true)
  const onEnterFullScreen = (): void => schedule('enter-full-screen', true)
  const onLeaveFullScreen = (): void => schedule('leave-full-screen', true, 0, true)
  const onReadyToShow = (): void => schedule('ready-to-show', true, 0, true)

  if (platform === 'win32' && typeof window.setShape === 'function') {
    window.on('resize', onResize)
    window.on('focus', onFocus)
    window.on('blur', onBlur)
    window.on('show', onShow)
    window.on('restore', onRestore)
    window.on('maximize', onMaximize)
    window.on('unmaximize', onUnmaximize)
    window.on('enter-full-screen', onEnterFullScreen)
    window.on('leave-full-screen', onLeaveFullScreen)
    window.on('ready-to-show', onReadyToShow)
    schedule('create', true)
  }

  return {
    refresh: (reason: string, force = false) => schedule(reason, force),
    dispose: () => {
      if (disposed) return
      disposed = true
      clearTimers()
      window.removeListener('resize', onResize)
      window.removeListener('focus', onFocus)
      window.removeListener('blur', onBlur)
      window.removeListener('show', onShow)
      window.removeListener('restore', onRestore)
      window.removeListener('maximize', onMaximize)
      window.removeListener('unmaximize', onUnmaximize)
      window.removeListener('enter-full-screen', onEnterFullScreen)
      window.removeListener('leave-full-screen', onLeaveFullScreen)
      window.removeListener('ready-to-show', onReadyToShow)
    },
  }
}
