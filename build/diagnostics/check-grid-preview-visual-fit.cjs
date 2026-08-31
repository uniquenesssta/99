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

const runtimePath = 'src/renderer/src/runtime/preview/gridPreviewVisualFitRuntime.ts'
const fontCardPath = 'src/renderer/src/components/FontCard.tsx'
const cssPath = 'src/renderer/src/styles/font-list-card-detail/font-list-card-detail-03.css'
const fixturePath = 'build/diagnostics/fixtures/grid-preview-visual-fit.fixture.json'

const runtime = read(runtimePath)
const fontCard = read(fontCardPath)
const css = read(cssPath)
const fixture = JSON.parse(read(fixturePath))

assertCheck(
  'grid visual fit runtime exists with candidate builder',
  runtime.includes('buildGridPreviewVisualFitCandidates') && runtime.includes('useGridPreviewVisualFitText'),
  runtimePath,
)
assertCheck(
  'visual fit only targets mixed CJK latin tails',
  runtime.includes('MIXED_SCRIPT_LATIN_TAIL_PATTERN') && runtime.includes('lineCanUseLatinTailFit'),
  runtimePath,
)
assertCheck(
  'runtime checks real rendered overflow before shortening',
  runtime.includes('scrollWidth') && runtime.includes('clientWidth') && runtime.includes('measureText') && runtime.includes('requestAnimationFrame'),
  runtimePath,
)
assertCheck(
  'font card renders fitted grid visual preview lines',
  fontCard.includes('useGridPreviewVisualFitText') && fontCard.includes('gridVisualPreviewLines.map'),
  fontCardPath,
)
assertCheck(
  'native png preview path is not shortened by text visual fit',
  fontCard.includes('!useGridNativePreviewImage') && fontCard.includes('useGridNativePreviewImage ? displayPreviewImage : undefined'),
  fontCardPath,
)
assertCheck(
  'visual fit active css class is wired',
  fontCard.includes('grid-preview-visual-fit-active') && css.includes('.preview-layout-grid.grid-preview-visual-fit-active'),
  `${fontCardPath}, ${cssPath}`,
)
assertCheck(
  'fixture documents expected fallback sequence',
  Array.isArray(fixture.candidates) && fixture.candidates.join('|') === '安盛aaaa|安盛aaa|安盛aa|安盛a|安盛',
  fixturePath,
)

const failed = checks.filter((check) => !check.ok)
for (const check of checks) {
  console.log(`${check.ok ? '✓' : '✗'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`)
}
if (failed.length) {
  console.error(`grid preview visual fit policy failed: ${failed.length}/${checks.length}`)
  process.exit(1)
}
console.log(`grid preview visual fit policy passed: ${checks.length} checks`)
