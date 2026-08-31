#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8') }
function assert(condition, message) {
  if (!condition) {
    console.error(`[diagnostics:window-corner-clipping] ${message}`)
    process.exit(1)
  }
}

const windowRuntime = read('src/main/app/windowRuntime.ts')
assert(windowRuntime.includes('transparent: true'), 'main window must remain transparent for CSS-rounded corners')
assert(
  windowRuntime.includes("hasShadow: process.platform !== 'win32'"),
  'Windows transparent frameless windows must disable the rectangular DWM native shadow'
)

assert(
  windowRuntime.includes("roundedCorners: true"),
  'Windows frameless windows must explicitly request native rounded corners'
)
assert(
  windowRuntime.includes("createWindowRoundedShapeRuntime"),
  'main window must install the native rounded shape lifecycle runtime'
)
const roundedShapeRuntime = read('src/main/app/windowRoundedShapeRuntime.ts')
assert(
  roundedShapeRuntime.includes('window.setShape(buildRoundedWindowShape'),
  'Windows window shape must be enforced at the native region level'
)
assert(
  roundedShapeRuntime.includes("window.on('blur', onBlur)") && roundedShapeRuntime.includes("window.on('focus', onFocus)"),
  'native rounded shape must be reapplied across inactive/active compositor transitions'
)
assert(
  roundedShapeRuntime.includes('window.webContents.invalidate()'),
  'focus transitions must request a full webContents repaint'
)
assert(
  roundedShapeRuntime.includes("apply(`${reason}-settled`, true)"),
  'focus transitions must include a settled follow-up refresh after DWM state changes'
)
assert(
  roundedShapeRuntime.includes("window.setShape([])"),
  'maximized and full-screen windows must revert to a rectangular native region'
)

const studioCss = read('src/renderer/src/styles/studio-interface/studio-interface-01.css')
assert(studioCss.includes('clip-path: inset(0 round 18px)'), 'application surface must keep the explicit rounded clip')
assert(studioCss.includes('.app::before {'), 'application rounded border overlay must exist')
assert(studioCss.includes('position: absolute;'), 'rounded border overlay must stay inside the app clipping layer')
assert(studioCss.includes('box-sizing: border-box;'), 'rounded border overlay must not grow beyond the window surface')
assert(studioCss.includes('border-radius: 18px 18px 0 0;'), 'topbar paint must match the application top corners')
assert(studioCss.includes('background-clip: padding-box;'), 'topbar background must not paint outside its rounded border')
assert(
  studioCss.includes('--studio-topbar-bg:'),
  'topbar must use a dedicated opaque surface instead of the transparent window backdrop'
)
const topbarStart = studioCss.indexOf('.topbar {')
const topbarEnd = studioCss.indexOf('\n}', topbarStart)
const topbarBlock = studioCss.slice(topbarStart, topbarEnd + 2)
assert(topbarStart >= 0 && topbarEnd > topbarStart, 'topbar style block must exist')
assert(
  topbarBlock.includes('background: var(--studio-topbar-bg);'),
  'topbar outer edge must be painted by the dedicated opaque surface'
)
assert(
  topbarBlock.includes('backdrop-filter: none;') && topbarBlock.includes('-webkit-backdrop-filter: none;'),
  'topbar must not create a rectangular backdrop compositor layer at the rounded window edge'
)
assert(
  !/backdrop-filter:\s*blur\(/.test(topbarBlock),
  'topbar rounded window edge must not use backdrop blur'
)

console.log('[diagnostics:window-corner-clipping] ok')
