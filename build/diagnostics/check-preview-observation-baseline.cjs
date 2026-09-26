#!/usr/bin/env node
// Remaining S10-03 observation gate; verifies reproduction, NOT repair.
// S10-02 healthy behavior lives in check-preview-visible-requeue.cjs.
const path = require('node:path');
process.chdir(path.resolve(__dirname, '../..'));
if (!process.argv.includes('--observe') && !process.argv.includes('--strict'))
    throw Error('Use --observe or --strict');
async function deadlineBaseline() {
    const fs = require('fs'), ts = require(process.cwd() + '/node_modules/typescript'), assert = require('assert/strict');
    function load(p, req) { let m = { exports: {} }; new Function('require', 'module', 'exports', ts.transpileModule(fs.readFileSync(p, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(req, m, m.exports); return m.exports; }
    const deadline = load('src/main/path/ioDeadlineRuntime.ts', () => ({ sharedFileSystem: {} }));
    return (async () => { let finish, done = false; const result = await deadline.withIoDeadlineResult('audit', () => new Promise(r => finish = () => { done = true; r('late'); }), 100); assert(result.timedOut); assert(!done); finish(); await Promise.resolve(); assert(done); console.log('PASS actual deadline helper: timeout returns while operation remains alive and completes later'); })();
}
async function failureBaseline() {
    const fs = require('fs'), ts = require(process.cwd() + '/node_modules/typescript'), assert = require('assert/strict');
    function load(p, req) { let m = { exports: {} }; new Function('require', 'module', 'exports', ts.transpileModule(fs.readFileSync(p, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(req, m, m.exports); return m.exports; }
    const mem = load('src/main/preview/runtime/previewImageMemoryRuntime.ts', () => ({ DEFAULT_PREVIEW_TEXT: 'abc' }));
    let statChecks = 0, timeout = true, status = null;
    const storage = { previewCacheStorageForFont: async () => ({ identity: 'id', dir: '/cache', storage: 'local' }), readPreviewCacheIndexStatus: async () => status };
    const main = load('src/main/preview/previewRuntime.ts', n => n.endsWith('previewTraceRuntime') ? { tracePreviewPhase: async (_s, f) => f() } : n.endsWith('operationTraceContext') ? { logOperation: () => { }, currentOperationTrace: () => undefined } : n === 'node:path' ? require(n) : n.endsWith('sharedFileSystemRuntime') ? { sharedFileSystem: {} } : n.endsWith('previewInputPolicy') ? { validatePreviewInput: x => x } : n.endsWith('previewImageMemoryRuntime') ? mem : n.endsWith('previewCacheStorageRuntime') ? { createPreviewCacheStorageRuntime: () => storage } : n.endsWith('ioDeadlineRuntime') ? { fileExistsTimeoutMs: () => 500, withIoDeadlineResult: async () => { statChecks++; return timeout ? { ok: false, timedOut: true } : { ok: true, value: { size: 1, mtimeMs: 1 } }; } } : n.endsWith('previewCacheKeyRuntime') ? { previewCacheKey: () => 'key', previewFontSignature: () => 'sig', previewCacheTextHash: () => 'text' } : n.endsWith('previewInstalledFontRouteRuntime') ? { resolveInstalledFontPreviewRoute: () => null, previewCacheStatForInstalledRoute: () => null, previewCacheIdentityForInstalledRoute: x => x } : new Proxy({}, { get: () => () => ({}) }));
    const options = { ensureWindows: () => { }, appendStartupLog: () => { }, resolveExistingFontFilePath: async () => '/font.ttf', withGlobalIo: (_, f) => f(), missingFontPreviewDataUri: () => 'data:image/svg+xml,missing', previewTaskKey: () => 'task', skipBackgroundTask: async () => { } };
    return (async () => { const r = main.createPreviewRuntime(options), font = { id: 'a', path: '/font.ttf', fileSize: 1, modifiedAt: 1 }; const first = await r.renderFontPreviewImage(font, 'abc'); assert(first.startsWith('data:image/svg+xml')); timeout = false; const again = await r.renderFontPreviewImage(font, 'abc'); assert.equal(again, first); assert.equal(statChecks, 1); console.log('PASS real preview runtime+memory: stat timeout becomes missing SVG and second request reuses it without stat'); status = 'failed'; const fresh = main.createPreviewRuntime(options); assert.equal(await fresh.ensureFontPreviewImageFile(font, 'abc'), null); console.log('PASS real preview runtime: failed index becomes null (same return used for missing font)'); })();
}
(async () => {
    await deadlineBaseline();
    await failureBaseline();
    console.log("OBSERVED: 2 remaining defects: timeout-placeholder-reuse, failed-index-missing. Not GUI evidence.");
    if (process.argv.includes("--strict"))
        throw Error("Known preview defects remain open (S10-03 pending)");
})().catch(error => { console.error(error); process.exitCode = 1; });
