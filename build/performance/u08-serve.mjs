// Isolated, synthetic React probe. No Electron IPC or user library is accessed.
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
execFileSync(process.execPath, ['node_modules/typescript/lib/tsc.js', '--project', 'build/performance/u08-tsconfig.json'], { cwd: root, stdio: 'inherit' })
const baseline = '08c07c7ecd6b58c6fb24481cef5f8ccaaa173a5a'
const hookPath = 'src/renderer/src/runtime/app/useBrowseDerivedRuntime.ts'
const before = execFileSync('git', ['show', `${baseline}:${hookPath}`], { cwd: root, encoding: 'utf8' })
const bundle = await build({
  absWorkingDir: root, entryPoints: ['build/performance/u08-browser.tsx'], bundle: true,
  write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': JSON.stringify({ DEV: true, PROD: false }) },
  plugins: [{ name: 'u08-baseline', setup(builder) {
    builder.onResolve({ filter: /^u08-before$/ }, () => ({ path: hookPath, namespace: 'u08-baseline' }))
    builder.onLoad({ filter: /.*/, namespace: 'u08-baseline' }, () => ({ contents: before, loader: 'ts', resolveDir: dirname(resolve(root, hookPath)) }))
  } }]
})
if (process.argv.includes('--check')) {
  console.log('U-08 baseline/current React browser bundle typechecked and compiled; browser execution is separate')
  process.exit(0)
}
const html = readFileSync(resolve(root, 'build/performance/u08-index.html'))
const server = createServer((req, res) => {
  if (req.url === '/probe.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(bundle.outputFiles[0].contents) }
  else if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html) }
  else { res.statusCode = 404; res.end() }
})
server.listen(39218, '127.0.0.1', () => console.log(`U-08 React 18 development probe: http://127.0.0.1:39218/ (baseline ${baseline}; stop with Ctrl+C)`))
