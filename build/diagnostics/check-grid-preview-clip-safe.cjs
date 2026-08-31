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

const trimRuntimePath = 'src/renderer/src/runtime/preview/gridNativePreviewImageTrimRuntime.ts'
const classRuntimePath = 'src/renderer/src/runtime/preview/gridNativePreviewImageRuntime.ts'
const fontCardPath = 'src/renderer/src/components/FontCard.tsx'
const cssPath = 'src/renderer/src/styles/font-list-card-detail/font-list-card-detail-03.css'

const trimRuntime = read(trimRuntimePath)
const classRuntime = read(classRuntimePath)
const fontCard = read(fontCardPath)
const css = read(cssPath)

assertCheck(
  'grid native preview transparent margin trim runtime exists',
  trimRuntime.includes('useGridNativePreviewImageTrim') && trimRuntime.includes('getImageData'),
  trimRuntimePath,
)
assertCheck(
  'trim runtime only processes png data urls',
  trimRuntime.includes("source.startsWith('data:image/png')"),
  trimRuntimePath,
)
assertCheck(
  'trim runtime keeps an lru cache for repeated card renders',
  trimRuntime.includes('TRIM_CACHE_LIMIT') && trimRuntime.includes('trimInflight'),
  trimRuntimePath,
)
assertCheck(
  'font card uses trimmed grid preview src only in grid native path',
  fontCard.includes('useGridNativePreviewImageTrim') && fontCard.includes('useGridNativePreviewImage ? displayPreviewImage : undefined'),
  fontCardPath,
)
assertCheck(
  'grid img uses clip safe class resolver with trimmed source',
  fontCard.includes('gridNativePreviewImageClassName(gridNativePreviewImageSrc)') && fontCard.includes('src={gridNativePreviewImageSrc}'),
  fontCardPath,
)
assertCheck(
  'grid native preview class includes clip safe class',
  classRuntime.includes('GRID_NATIVE_PREVIEW_IMAGE_CLIP_SAFE_CLASS') && classRuntime.includes('grid-native-preview-image-clip-safe'),
  classRuntimePath,
)
assertCheck(
  'clip safe css scales down only when ink would hit card edge',
  css.includes('.grid-native-preview-image.grid-native-preview-image-clip-safe') && css.includes('object-fit: scale-down'),
  cssPath,
)

const failed = checks.filter((check) => !check.ok)
for (const check of checks) {
  console.log(`${check.ok ? '✓' : '✗'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`)
}
if (failed.length) {
  console.error(`grid preview clip safe policy failed: ${failed.length}/${checks.length}`)
  process.exit(1)
}
console.log(`grid preview clip safe policy passed: ${checks.length} checks`)
