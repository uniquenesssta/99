#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')
const { spawnSync, execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '../..')
let checks = 0
const baseline = process.argv.find((arg) => arg.startsWith('--baseline='))?.slice(11)
if (baseline) assert.match(baseline, /^[a-f0-9]{7,40}$/)
const onlyEngine = process.argv.find((arg) => arg.startsWith('--engine='))?.slice(9)

function loader(mocks = {}) {
  const cache = new Map()
  function load(rel) {
    if (Object.hasOwn(mocks, rel)) return mocks[rel]
    if (cache.has(rel)) return cache.get(rel)
    const filename = path.join(root, rel)
    const source = baseline ? execFileSync('git', ['show', `${baseline}:${rel}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(filename, 'utf8')
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText
    const module = { exports: {} }
    cache.set(rel, module.exports)
    new Function('require', 'module', 'exports', code)((name) => {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      return name.startsWith('.') ? load(path.posix.normalize(path.posix.join(path.posix.dirname(rel), name)) + '.ts') : require(name)
    }, module, module.exports)
    return module.exports
  }
  return load
}

const fixture = JSON.parse(fs.readFileSync(path.join(root, 'build/diagnostics/fixtures/preview-input-boundary.fixture.json'), 'utf8'))
const cases = fixture.cases.map(({ patch, repeat, ok }) => ({ patch: repeat ? { ...patch, text: patch.text.repeat(repeat) } : patch, ok }))
cases.push(...['width', 'height', 'fontSize'].flatMap((field) => [NaN, Infinity, -Infinity, undefined].map((value) => ({ patch: { [field]: value }, ok: false }))))
cases.push(...['\ud800', '\udc00', '\ud800x', '\ud800\ud800', '\udc00\ud800'].map((text) => ({ patch: { text }, ok: false })))
cases.push({ patch: { text: undefined }, ok: false })
const valid = cases.filter(({ ok }) => ok).map(({ patch }) => patch)
const invalid = cases.filter(({ ok }) => !ok).map(({ patch }) => patch)

async function dispatchTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-preview-input-'))
  try {
    for (const engine of ['rust-directwrite', 'directwrite', 'powershell-gdi']) {
      if (onlyEngine && engine !== onlyEngine) continue
      const calls = [], logs = []
      const load = loader({
        'src/main/preview/native-renderer/directwrite/directWritePreviewHelperPathRuntime.ts': { findDirectWritePreviewHelperPath: () => engine === 'directwrite' ? 'helper.exe' : null },
        'src/main/preview/native-renderer/directwrite/directWritePreviewRequestRuntime.ts': { renderWithDirectWritePreviewHelper: invoke },
        'src/main/preview/native-renderer/powershell/powerShellPreviewRendererRuntime.ts': { renderWithPowerShellPreview: invoke },
        'src/main/rust-core/nodeBridgeFallbackCompatibilityRuntime.ts': {
          nodeBridgeFallbackCompatibilityAllowed: () => true, logNodeBridgeFallbackUsed() {}, logNodeBridgeFallbackDisabled() {},
        },
      })
      async function invoke(request, inputPath) {
        calls.push(request)
        if (inputPath) assert.deepEqual(JSON.parse(fs.readFileSync(inputPath, 'utf8')), request, 'backend JSON differs from validated request')
        fs.writeFileSync(request.outputPath, 'test-image')
        return { ok: true, engine, outputPath: request.outputPath }
      }
      const runtime = load('src/main/preview/native-renderer/previewNativeRendererRuntime.ts').createPreviewNativeRenderer({
        appendStartupLog: (message) => logs.push(message), execFileAsync: async () => { throw new Error('unexpected spawn') },
        runRustPreviewRenderImage: engine === 'rust-directwrite' ? invoke : undefined,
      })
      const base = { fontPath: 'font.ttf', text: '字体 Aa', fontSize: 44, width: 720, height: 260, outputPath: path.join(dir, 'out.png') }
      for (const patch of invalid) {
        calls.length = 0
        let result
        try { result = await runtime.renderNativePreview({ ...base, ...patch }, path.join(dir, 'in.json')) } catch (error) { result = { ok: false, message: error.message } }
        assert.equal(calls.length, 0, `${engine} dispatched invalid ${Object.keys(patch).join(',')} input`)
        assert.equal(result.ok, false)
        assert.match(result.message, /PREVIEW_INPUT_INVALID/)
        checks++
      }
      for (const patch of valid) {
        calls.length = 0
        const request = { ...base, ...patch }
        const result = await runtime.renderNativePreview(request, path.join(dir, 'in.json'))
        assert.equal(result.ok, true)
        assert.deepEqual(calls, [{ ...request, text: request.text || '字体预览 AaBb 123' }])
        checks++
      }
      assert.ok(logs.filter((line) => line.includes('PREVIEW_INPUT_INVALID')).length <= 1, 'invalid request log storm')
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

function nativeTests() {
  const load = loader()
  const policy = load('src/main/preview/runtime/previewInputPolicy.ts')
  const limits = policy.PREVIEW_INPUT_LIMITS
  // Native constants are mirrors, not independently configurable policies.
  for (const rel of ['native-src/preview-renderer/preview-input-policy.h', 'native-src/hfm-core-worker/src/preview_render/types.rs']) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8')
    for (const [key, value] of Object.entries(limits)) {
      const name = key.replace(/[A-Z]/g, (letter) => '_' + letter).toUpperCase()
      assert.match(source, new RegExp(`\\b${name}[^=\\n]*= ${value}(?:\\.0)?;`), `${rel}: ${key} drift`)
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-preview-native-'))
  const requests = cases.map(({ patch }) => ({ ...fixture.base, ...patch }))
  const expected = cases.map(({ ok }, index) => ok ? '1 ' + Buffer.from(requests[index].text || '字体预览 AaBb 123').toString('hex') : '0')
  const input = requests.map((request) => JSON.stringify(request)).join('\n') + '\n'
  // Exercise legal alternate JSON encodings that the old C++ scanner misread.
  const alternate = [
    '{"width":7.2e2,"height":260.0,"fontSize":4.4e1,"text":"\\u6c49\\ud83d\\ude00"}',
    '{"width":null,"height":260,"fontSize":44,"text":"width"}',
    '{"width":1e999,"height":260,"fontSize":44,"text":"a"}',
    '{"width":"720","height":260,"fontSize":44,"text":"a"}',
    '{"width":720,"height":260,"fontSize":44,"text":"\\uD83D\\uDE00"}',
    '{"width":720,"height":260,"fontSize":44,"text":"\\uFFFD"}',
    '{"width":720,"height":260,"fontSize":44,"text":"\\uD800\\\\udc00"}',
    '{"width":720,"height":260,"fontSize":44,"text":"\\uD800","ignored":"\\uDC00"}',
  ]
  const allInput = input + alternate.join('\n') + '\n'
  const allExpected = [...expected, '1 ' + Buffer.from('汉😀').toString('hex'), '0', '0', '0', '1 ' + Buffer.from('😀').toString('hex'), '1 efbfbd', '0', '0']
  function run(command, args, options = {}) {
    return spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...options })
  }
  function verifyLines(result, label) {
    assert.equal(result.status, 0, `${label}: ${result.stderr}`)
    const actual = result.stdout.trimEnd().split(/\r?\n/)
    assert.equal(actual.length, allExpected.length, `${label}: result count`)
    for (let i = 0; i < allExpected.length; i++) {
      assert.equal(actual[i], allExpected[i], `${label}: fixture ${i + 1} (${i < cases.length ? Object.keys(cases[i].patch).join(',') : 'alternate JSON'})`)
    }
    console.log(`${label}: ${allExpected.length} cases passed`)
  }
  const skipped = []
  try {
    const binary = path.join(dir, process.platform === 'win32' ? 'boundary.exe' : 'boundary')
    let compile
    if (!run('g++', ['--version']).error) {
      compile = run('g++', ['-std=c++17', '-O2', 'build/diagnostics/native/preview-input-boundary.cpp', '-o', binary])
    } else if (process.platform === 'win32' && !run('cl', []).error) {
      compile = run('cl', ['/nologo', '/EHsc', '/std:c++17', '/utf-8', 'build/diagnostics/native/preview-input-boundary.cpp', `/Fe:${binary}`, `/Fo:${path.join(dir, 'boundary.obj')}`])
    }
    if (compile) {
      assert.equal(compile.status, 0, compile.stderr + compile.stdout)
      verifyLines(run(binary, [], { input: allInput }), 'C++ actual input policy (no GDI+)')
    } else skipped.push('C++ compiler')

    const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
    if (!run(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion']).error) {
      const validation = load('src/main/preview/runtime/nativePreviewScriptRuntime.ts').buildPreviewInputPowerShellValidation()
      const script = `$ErrorActionPreference = 'Stop'\nwhile ($null -ne ($line = [Console]::ReadLine())) {\ntry {\n$inputJsonText = $line\n${validation}\n'1 ' + ([BitConverter]::ToString([Text.Encoding]::UTF8.GetBytes($text))).Replace('-', '').ToLowerInvariant()\n} catch { '0' }\n}`
      // Console input is ASCII JSON, avoiding Windows console codepage differences.
      const asciiInput = allInput.replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
      verifyLines(run(shell, ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { input: asciiInput }), 'PowerShell actual generated validation (no GDI+)')
    } else skipped.push('PowerShell runtime')

    if (!run('cargo', ['--version']).error) {
      const result = run('cargo', ['test', '--offline', '--manifest-path', 'native-src/hfm-core-worker/Cargo.toml', 'shared_preview_input_boundaries'])
      assert.equal(result.status, 0, result.stderr + result.stdout)
      console.log('Rust actual input policy: shared fixtures passed')
    } else skipped.push('Rust/Cargo')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  if (skipped.length) {
    console.log(`EXTERNAL VERIFICATION REQUIRED: ${skipped.join(', ')}`)
    assert.ok(!process.argv.includes('--require-native'), 'required native validation unavailable')
  }
}

async function cacheTests() {
  const load = loader({
    'src/main/preview/native-renderer/directwrite/directWritePreviewHelperPathRuntime.ts': { hasDirectWritePreviewHelper: () => false },
  })
  const { createPreviewRequestSchedulerRuntime } = load('src/main/preview/runtime/previewRequestSchedulerRuntime.ts')
  const calls = []
  const runtime = createPreviewRequestSchedulerRuntime({
    readCachedPreviewImages: async (items, text, fontSize) => { calls.push({ text, fontSize }); return { font: String(fontSize) } },
  })
  const item = { id: 'font', path: 'font.ttf', fileSize: 1, modifiedAt: 1 }
  await assert.rejects(runtime.readCachedPreviewImages([item], 'a', 44, Infinity, 260), /PREVIEW_INPUT_INVALID/)
  const values = await Promise.all([34.1, 34.2].map((fontSize) => runtime.readCachedPreviewImages([item], 'a', fontSize, 520, 150)))
  assert.deepEqual(values, [{ font: '34.1' }, { font: '34.2' }], 'fractional font sizes must not share a scheduler group')
  assert.equal(calls.length, 2)
  checks += 2
  const { createCachedPreviewReadRuntime } = load('src/main/preview/runtime/cachedPreviewReadRuntime.ts')
  const cached = createCachedPreviewReadRuntime({
    ensureWindows() { throw new Error('invalid request reached disk') }, sha1: (value) => value,
  })
  await assert.rejects(cached.readCachedFontPreviewImage(item, 'a', 44, Infinity, 260), /PREVIEW_INPUT_INVALID/)
  await assert.rejects(cached.readCachedFontPreviewImages([item], 'a', 44, 720, 0), /PREVIEW_INPUT_INVALID/)
  checks += 2
  const keys = load('src/main/preview/runtime/previewCacheKeyRuntime.ts')
  const sha1 = (value) => require('node:crypto').createHash('sha1').update(value).digest('hex')
  for (const [current, old] of [[keys.POWERSHELL_PREVIEW_RENDERER_VERSION, 'native-preview-powershell-center-v6'], [keys.DIRECTWRITE_PREVIEW_RENDERER_VERSION, 'native-preview-private-gdi-inkbox-v7']]) {
    for (const keyFor of [keys.legacyPreviewCacheKey, keys.strictPreviewCacheKey]) {
      const args = [sha1, 'font.ttf', 1, 1, 44, 720, 260, 'a']
      assert.notEqual(keyFor(...args, current), keyFor(...args, old), 'old renderer cache must not hide text semantics fix')
      assert.equal(keyFor(...args, current), keyFor(...args, current), 'cache identity must remain deterministic')
      checks++
    }
  }
}

async function ipcLogTests() {
  const handlers = new Map(), logs = []
  const load = loader({
    electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
    'src/main/security/ipcSenderValidation.ts': { assertTrustedIpcSender() {} },
    'src/main/logging/startupLogPolicy.ts': { detailedStartupLogsEnabled: () => false },
  })
  const { validatePreviewInput } = load('src/main/preview/runtime/previewInputPolicy.ts')
  const { registerTracedIpcHandler } = load('src/main/ipc/ipcTraceRuntime.ts')
  const appendLog = (line) => logs.push(line)
  registerTracedIpcHandler({ appendLog }, 'fonts:renderPreviewImage', () => validatePreviewInput({ ...fixture.base, width: Infinity }, appendLog))
  const invoke = handlers.get('fonts:renderPreviewImage')
  for (let i = 0; i < 100; i++) await assert.rejects(invoke({ sender: { id: 1 } }), /PREVIEW_INPUT_INVALID/)
  assert.equal(logs.length, 1, 'IPC must not amplify bounded validation logs')
  assert.ok(!logs[0].includes('font.ttf'))
  registerTracedIpcHandler({ appendLog }, 'fonts:renderPreviewImage', () => { throw new Error('unrelated failure') })
  await assert.rejects(handlers.get('fonts:renderPreviewImage')({ sender: { id: 1 } }), /unrelated failure/)
  assert.equal(logs.length, 2, 'unrelated IPC failures must still be logged')
  checks += 2
}

async function main() { await dispatchTests(); if (!baseline) { await cacheTests(); await ipcLogTests(); nativeTests(); } console.log(`preview input boundary passed (${checks} JS behavior cases)`); }
main().catch((error) => { console.error(error); process.exitCode = 1 })
