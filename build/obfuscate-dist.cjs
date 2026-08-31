const fs = require('node:fs')
const path = require('node:path')

const MARKER = '/* hfm-secure-obfuscated-v1 */'
const TARGET_DIRS = [
  path.join(process.cwd(), 'out', 'main'),
  path.join(process.cwd(), 'out', 'preload'),
  path.join(process.cwd(), 'out', 'renderer', 'assets')
]

function loadEsbuild() {
  try {
    return require('esbuild')
  } catch {
    return null
  }
}

function listJsFiles(root) {
  if (!fs.existsSync(root)) return []
  const entries = fs.readdirSync(root, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...listJsFiles(fullPath))
    else if (/\.(mjs|cjs|js)$/i.test(entry.name)) files.push(fullPath)
  }
  return files
}

function formatForFile(filePath) {
  if (filePath.endsWith('.mjs')) return 'esm'
  if (filePath.endsWith('.cjs')) return 'cjs'
  return undefined
}

async function transformFile(esbuild, filePath) {
  const source = fs.readFileSync(filePath, 'utf-8')
  if (source.startsWith(MARKER)) return false
  const result = await esbuild.transform(source, {
    loader: 'js',
    target: 'chrome120',
    format: formatForFile(filePath),
    minify: true,
    legalComments: 'none',
    keepNames: false,
    treeShaking: true,
    sourcemap: false,
    charset: 'utf8'
  })
  fs.writeFileSync(filePath, `${MARKER}\n${result.code}`, 'utf-8')
  return true
}

async function main() {
  const esbuild = loadEsbuild()
  if (!esbuild) {
    console.warn('[hfm] esbuild not found; secure obfuscation/minify pass skipped.')
    return
  }

  const files = TARGET_DIRS.flatMap(listJsFiles)
  let changed = 0
  for (const filePath of files) {
    if (await transformFile(esbuild, filePath)) changed += 1
  }
  console.log(`[hfm] secure obfuscation/minify pass completed: ${changed}/${files.length} files`)
}

main().catch((error) => {
  console.error('[hfm] secure obfuscation/minify pass failed:', error)
  process.exitCode = 1
})
