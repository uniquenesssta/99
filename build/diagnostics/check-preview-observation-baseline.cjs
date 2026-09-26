#!/usr/bin/env node
// S10-01 observation gate: verifies reproduction, NOT that defects are fixed.
// S10-02/03 replace the corresponding observations with healthy-behavior regressions.
const path = require('node:path');
process.chdir(path.resolve(__dirname, '../..'));
if (!process.argv.includes('--observe') && !process.argv.includes('--strict'))
    throw Error('Use --observe or --strict');
async function resetBaseline() {
    const fs = require('fs'), ts = require(process.cwd() + '/node_modules/typescript'), assert = require('assert/strict');
    function load(p, req) { let m = { exports: {} }; new Function('require', 'module', 'exports', ts.transpileModule(fs.readFileSync(p, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(req, m, m.exports); return m.exports; }
    let slots = [], pos = 0, pending = [];
    const react = { useRef: v => { let i = pos++; return slots[i] ??= ({ current: v }); }, useEffect: (f, d) => { let i = pos++, old = slots[i]; if (!old || d.some((x, j) => !Object.is(x, old[j])))
            pending.push(f); slots[i] = d; }, useLayoutEffect: (f) => f(), useMemo: f => f() };
    const fonts = Array.from({ length: 24 }, (_, i) => ({ id: String(i) }));
    let requested = [], resets = 0;
    const derived = load('src/renderer/src/runtime/app/useAppFontDerivedRuntime.ts', n => n === 'react' ? react : n.endsWith('useBrowseDerivedRuntime') ? { useBrowseDerivedRuntime: () => ({ visibleFonts: fonts, fontMetrics: {}, localTagList: [], sharedTagList: [] }) } : n.endsWith('fontViewRuntime') ? { buildVirtualLayout: () => ({ items: fonts }), buildTagSuggestions: () => [] } : { PREVIEW_PREFETCH_LIMIT: 18, traceRendererSyncComputation: (a, b, f) => f() });
    const reset = load('src/renderer/src/runtime/app/effects/usePreviewTextResetRuntime.ts', () => react);
    function render(text, size) { pos = 0; pending = []; reset.usePreviewTextResetRuntime({ previewText: text, listPreviewFontSize: size, resetPreviewRuntimeState: () => { resets++; requested = []; } }); derived.useAppFontDerivedRuntime({ library: { previewText: text, fonts: {} }, cardPoolViewLayout: { rowHeight: size, minCardWidth: 100 }, virtualViewport: {}, selectedFontIds: [], previewFamilies: {}, nativePreviewImages: {}, failedPreviewFontIds: {}, latestVisibleFontsRef: {}, latestViewLayoutRef: {}, contextFontTargets: () => [], requestPreviewFont: f => requested.push(f.id) }); pending.forEach(f => f()); return requested.length; }
    assert.equal(render('abc', 44), 18);
    assert.equal(render('abc', 48), 0);
    assert.equal(resets, 1);
    assert.equal(render('def', 48), 18);
    assert(!requested.includes('18'));
    console.log('PASS actual reset+derived hooks: size change resets but queues 0; text change queues only 18 of 24 stable items (controlled hook runner, not GUI)');
    const deadline = load('src/main/path/ioDeadlineRuntime.ts', () => ({ sharedFileSystem: {} }));
    return (async () => { let finish, done = false; const result = await deadline.withIoDeadlineResult('audit', () => new Promise(r => finish = () => { done = true; r('late'); }), 100); assert(result.timedOut); assert(!done); finish(); await Promise.resolve(); assert(done); console.log('PASS actual deadline helper: timeout returns while operation remains alive and completes later'); })();
}
async function failureBaseline() {
    const fs = require('fs'), ts = require(process.cwd() + '/node_modules/typescript'), assert = require('assert/strict');
    function load(p, req) { let m = { exports: {} }; new Function('require', 'module', 'exports', ts.transpileModule(fs.readFileSync(p, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(req, m, m.exports); return m.exports; }
    const state = load('src/renderer/src/fontPreviewStateRuntime.ts', require);
    let scheduled = [], loads = 0;
    global.window = { setTimeout: f => (scheduled.push(f), scheduled.length), clearTimeout: () => { } };
    const qmod = load('src/renderer/src/runtime/preview/queue/fontVisiblePreviewQueueRuntime.ts', n => n.endsWith('previewTraceRuntime') ? { previewTrace: () => undefined, previewEvent: () => { } } : n.endsWith('appRuntime') ? { requestIdleWindow: f => (scheduled.push(f), scheduled.length), rendererMemoryPressure: () => 'normal', INDEXING_PREVIEW_LOADS: 1, SCROLLING_PREVIEW_LOADS: 1, MAX_CONCURRENT_PREVIEW_LOADS: 4 } : n.endsWith('fontPreviewIndexCooldownRuntime') ? { previewQueueCooldownRemaining: () => 0 } : n.endsWith('fontPreviewBatchPolicyRuntime') ? { VISIBLE_PREVIEW_CACHE_BATCH_LIMIT: 100 } : n.endsWith('fontPreviewNetworkPathRuntime') ? { networkAwarePreviewLimit: (_, x) => x } : { resolveFontPreviewRoute: () => ({ shouldSkipWebFontFileLoad: false }) });
    const opt = { previewFamilies: {}, nativePreviewImages: {}, failedPreviewFontIds: {}, loadingFonts: { current: new Set() }, queuedPreviewFontIds: { current: new Set() }, previewQueue: { current: [] }, activePreviewLoads: { current: 0 }, fontListScrollingRef: { current: false }, previewText: 'abc', listPreviewFontSize: 44, isBadFontRecord: () => false, rendererUserActive: () => true };
    const q = qmod.createFontVisiblePreviewQueueRuntime(opt, { canRequestPreviewFont: font => state.canQueuePreviewFont({ ...opt, font, loadingFontIds: opt.loadingFonts.current, queuedPreviewFontIds: opt.queuedPreviewFontIds.current }) }, { ensurePreviewFont: async () => { loads++; }, loadCachedNativeCardPreviews: async () => new Set(), resetPreviewLoads: () => { } });
    q.requestPreviewFont({ id: 'a' }, 'normal');
    q.requestPreviewFont({ id: 'a' }, 'high');
    assert.equal(opt.previewQueue.current[0].priority, 'normal');
    scheduled.shift()();
    assert.equal(loads, 0);
    assert.equal(opt.previewQueue.current.length, 1);
    console.log('PASS real queue+admission: normal->high upgrade rejected; active user leaves item pending');
    const mem = load('src/main/preview/runtime/previewImageMemoryRuntime.ts', () => ({ DEFAULT_PREVIEW_TEXT: 'abc' }));
    let statChecks = 0, timeout = true, status = null;
    const storage = { previewCacheStorageForFont: async () => ({ identity: 'id', dir: '/cache', storage: 'local' }), readPreviewCacheIndexStatus: async () => status };
    const main = load('src/main/preview/previewRuntime.ts', n => n.endsWith('previewTraceRuntime') ? { tracePreviewPhase: async (_s, f) => f() } : n.endsWith('operationTraceContext') ? { logOperation: () => { }, currentOperationTrace: () => undefined } : n === 'node:path' ? require(n) : n.endsWith('sharedFileSystemRuntime') ? { sharedFileSystem: {} } : n.endsWith('previewInputPolicy') ? { validatePreviewInput: x => x } : n.endsWith('previewImageMemoryRuntime') ? mem : n.endsWith('previewCacheStorageRuntime') ? { createPreviewCacheStorageRuntime: () => storage } : n.endsWith('ioDeadlineRuntime') ? { fileExistsTimeoutMs: () => 500, withIoDeadlineResult: async () => { statChecks++; return timeout ? { ok: false, timedOut: true } : { ok: true, value: { size: 1, mtimeMs: 1 } }; } } : n.endsWith('previewCacheKeyRuntime') ? { previewCacheKey: () => 'key', previewFontSignature: () => 'sig', previewCacheTextHash: () => 'text' } : n.endsWith('previewInstalledFontRouteRuntime') ? { resolveInstalledFontPreviewRoute: () => null, previewCacheStatForInstalledRoute: () => null, previewCacheIdentityForInstalledRoute: x => x } : new Proxy({}, { get: () => () => ({}) }));
    const options = { ensureWindows: () => { }, appendStartupLog: () => { }, resolveExistingFontFilePath: async () => '/font.ttf', withGlobalIo: (_, f) => f(), missingFontPreviewDataUri: () => 'data:image/svg+xml,missing', previewTaskKey: () => 'task', skipBackgroundTask: async () => { } };
    return (async () => { const r = main.createPreviewRuntime(options), font = { id: 'a', path: '/font.ttf', fileSize: 1, modifiedAt: 1 }; const first = await r.renderFontPreviewImage(font, 'abc'); assert(first.startsWith('data:image/svg+xml')); timeout = false; const again = await r.renderFontPreviewImage(font, 'abc'); assert.equal(again, first); assert.equal(statChecks, 1); console.log('PASS real preview runtime+memory: stat timeout becomes missing SVG and second request reuses it without stat'); status = 'failed'; const fresh = main.createPreviewRuntime(options); assert.equal(await fresh.ensureFontPreviewImageFile(font, 'abc'), null); console.log('PASS real preview runtime: failed index becomes null (same return used for missing font)'); })();
}
(async () => {
    await resetBaseline();
    await failureBaseline();
    console.log("OBSERVED: 5 known defects: size-requeue, text-tail-requeue, priority-promotion, timeout-placeholder-reuse, failed-index-missing. Not GUI evidence.");
    if (process.argv.includes("--strict"))
        throw Error("Known preview defects remain open (expected S10-01 strict failure)");
})().catch(error => { console.error(error); process.exitCode = 1; });
