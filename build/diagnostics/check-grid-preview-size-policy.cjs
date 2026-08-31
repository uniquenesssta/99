#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const root = process.cwd()
const checks = []
function assertCheck(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail })
}
function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

const runtimePath = 'src/renderer/src/runtime/preview/gridNativePreviewImageRuntime.ts'
const fontCardPath = 'src/renderer/src/components/FontCard.tsx'
const cssPath = 'src/renderer/src/styles/font-list-card-detail/font-list-card-detail-03.css'

const runtime = read(runtimePath)
const fontCard = read(fontCardPath)
const css = read(cssPath)

assertCheck(
  'grid native preview runtime exists',
  runtime.includes('gridNativePreviewImageClassName') && runtime.includes('GRID_NATIVE_PREVIEW_IMAGE_CLASS'),
  runtimePath,
)
assertCheck(
  'svg placeholders are not treated as native png previews',
  runtime.includes("!source.startsWith('data:image/svg+xml')"),
  runtimePath,
)
assertCheck(
  'grid card image uses grid native class resolver',
  fontCard.includes("import { gridNativePreviewImageClassName }") && fontCard.includes('className={gridNativePreviewImageClassName(gridNativePreviewImageSrc)}'),
  fontCardPath,
)
assertCheck(
  'list row native preview image class remains compact',
  fontCard.includes('className="font-sample-image compact"'),
  fontCardPath,
)
assertCheck(
  'grid native image does not shrink full png canvas',
  css.includes('.font-card .font-sample-image.grid-native-preview-image') && css.includes('object-fit: none'),
  cssPath,
)
assertCheck(
  'grid native image stays centered after clipping transparent canvas',
  css.includes('object-position: center center'),
  cssPath,
)

const failed = checks.filter((check) => !check.ok)
for (const check of checks) {
  console.log(`${check.ok ? '✓' : '✗'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`)
}
if (failed.length) {
  console.error(`grid preview size policy failed: ${failed.length}/${checks.length}`)
  process.exit(1)
}
console.log(`grid preview size policy passed: ${checks.length} checks`)
