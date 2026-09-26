#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
function loader(mocks = {}) {
    const cache = new Map();
    function load(file) {
        file = path.resolve(root, file);
        if (cache.has(file))
            return cache.get(file).exports;
        const module = { exports: {} };
        cache.set(file, module);
        const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
        new Function('require', 'module', 'exports', code)(id => {
            if (Object.hasOwn(mocks, id))
                return mocks[id];
            if (id.startsWith('node:'))
                return require(id);
            if (!id.startsWith('.') && !id.startsWith('@shared/'))
                throw Error(`Unmocked ${id}`);
            const target = id.startsWith('@shared/') ? path.join(root, 'src/shared', id.slice(8)) : path.resolve(path.dirname(file), id);
            return load(target + '.ts');
        }, module, module.exports);
        return module.exports;
    }
    return load;
}
async function run() {
    const events = [];
    global.window = { hfm: { previewTraceEnabled: false, reportPerformanceEvent: payload => { events.push(JSON.parse(payload.details.event)); return Promise.resolve(); } } };
    const load = loader();
    const renderer = load('src/renderer/src/runtime/preview/previewTraceRuntime.ts');
    assert.equal(renderer.previewTrace('font', 'private text', 44), undefined);
    renderer.previewEvent(undefined, 'visible');
    assert.equal(events.length, 0);
    window.hfm.previewTraceEnabled = true;
    const a = renderer.previewTrace('font', 'private text', 44);
    assert.equal(renderer.previewTrace('font', 'private text', 44), a);
    const attempt1 = renderer.previewLoadTrace('font', 'private text', 44), attempt2 = renderer.previewLoadTrace('font', 'private text', 44);
    assert.equal(attempt1.operationId, attempt2.operationId);
    assert.notEqual(attempt1.attemptId, attempt2.attemptId);
    renderer.previewEvent(a, 'queued');
    renderer.previewEvent(a, 'load-start');
    assert(events.find(e => e.stage === 'load-start').elapsedMs >= 0);
    assert(events.find(e => e.stage === 'load-start').monotonicMs >= events.find(e => e.stage === 'queued').monotonicMs);
    renderer.rememberPreviewImageTrace('data:image/png;base64,PRIVATE', a);
    renderer.resetPreviewTrace();
    const b = renderer.previewTrace('font', 'private text', 44);
    assert.notEqual(a.operationId, b.operationId);
    assert.notEqual(a.rendererGeneration, b.rendererGeneration);
    assert.equal(renderer.previewImageTrace('data:image/png;base64,PRIVATE'), a, 'late old image lost its generation');
    const members = Array.from({ length: 24 }, (_, i) => renderer.previewTrace('f' + i, 'private text', 44));
    const batch = renderer.previewBatchTrace(members);
    assert.equal(batch.members.length, 16);
    assert.equal(batch.omitted, 8);
    assert.equal(events.filter(e => e.stage === 'cache-batch-member').length, 24);
    assert(!JSON.stringify(events).includes('private text'));
    assert(!JSON.stringify(events).includes('PRIVATE'));
    await new Promise(setImmediate);
    for (let i = 0; i < 520; i++)
        renderer.previewTrace('evict' + i, 'x', 44);
    assert.notEqual(renderer.previewTrace('font', 'private text', 44), b, 'diagnostic cache not bounded');
    for (let i = 0; i < 520; i++)
        renderer.rememberPreviewImageTrace('image' + i, a);
    assert.equal(renderer.previewImageTrace('data:image/png;base64,PRIVATE'), undefined);
    window.hfm.previewTraceEnabled = false;
    const before = events.length;
    renderer.previewEvent(a, 'visible');
    assert.equal(events.length, before);
    const context = load('src/main/logging/operationTraceContext.ts');
    const phase = load('src/main/preview/runtime/previewTraceRuntime.ts');
    const logs = [];
    process.env.HFM_LOG_DETAIL = 'debug';
    const fail = new Error('private failure text');
    await Promise.all([
        context.withOperationTrace(a, x => logs.push(x), () => phase.tracePreviewPhase('test-a', async () => { await Promise.resolve(); assert.equal(context.currentOperationTrace().operationId, a.operationId); return 7; })),
        assert.rejects(context.withOperationTrace(b, x => logs.push(x), () => phase.tracePreviewPhase('test-b', async () => { await Promise.resolve(); throw fail; })), e => e === fail)
    ]);
    assert.equal(context.currentOperationTrace(), undefined);
    assert(logs.some(x => x.includes('test-b-end') && x.includes('rejected')));
    assert(!logs.join('').includes('private failure text'));
    process.env.HFM_LOG_DETAIL = '';
    delete process.env.HFM_VERBOSE_LOGS;
    const old = logs.length;
    assert.equal(await context.withOperationTrace(a, x => logs.push(x), () => phase.tracePreviewPhase('off', async () => 19)), 19);
    assert.equal(logs.length, old);
    // Both shipped preloads carry optional diagnostic metadata; old five-argument calls remain identical.
    for (const fallback of [false, true]) {
        let api;
        const calls = [];
        const electron = { contextBridge: { exposeInMainWorld: (_n, v) => { api = v; } }, ipcRenderer: { invoke: async (...args) => { calls.push(args); return ''; }, on: () => { }, removeListener: () => { } } };
        if (fallback) {
            const source = loader().call(null, 'src/main/preload/runtimePreloadSource.ts').runtimePreloadSource;
            new Function('require', 'process', 'Buffer', source)(id => { assert.equal(id, 'electron'); return electron; }, process, Buffer);
        }
        else
            loader({ electron }).call(null, 'src/preload/index.ts');
        for (const method of ['renderPreviewImage', 'getCachedPreviewImage', 'getCachedPreviewImages']) {
            calls.length = 0;
            await api[method]({}, 'sample', 44, 760, 144);
            assert.equal(calls[0].length, 6);
            calls.length = 0;
            await api[method]({}, 'sample', 44, 760, 144, a);
            assert.equal(calls[0].length, 7);
            assert.deepEqual(calls[0][6], { __hfmOperationTrace: a });
        }
        assert.equal(api.previewTraceEnabled, false);
    }
    let handler, trusted = true, handled = 0;
    const ipcLoad = loader({ electron: { ipcMain: { handle: (_channel, fn) => { handler = fn; } } }, '../security/ipcSenderValidation': { assertTrustedIpcSender: () => { if (!trusted)
                throw Error('untrusted'); } } });
    const ipcContext = ipcLoad('src/main/logging/operationTraceContext.ts');
    const ipc = ipcLoad('src/main/ipc/ipcTraceRuntime.ts');
    for (const channel of ['fonts:renderPreviewImage', 'fonts:getCachedPreviewImage', 'fonts:getCachedPreviewImages']) {
        const seen = [];
        ipc.registerTracedIpcHandler({ appendLog: () => { } }, channel, async (_e, ...args) => { handled++; seen.push({ args, trace: ipcContext.currentOperationTrace() }); return 'ok'; });
        const business = [{}, 'sample', 44, 760, 144];
        assert.equal(await handler({ sender: { id: 1 } }, ...business, { __hfmOperationTrace: a }), 'ok');
        assert.deepEqual(seen[0].args, business);
        assert.equal(seen[0].trace.operationId, a.operationId);
        await handler({ sender: { id: 1 } }, ...business);
        assert.equal(seen[1].trace, undefined);
        const count = handled;
        trusted = false;
        await assert.rejects(handler({ sender: { id: 1 } }, ...business, { __hfmOperationTrace: a }), /untrusted/);
        assert.equal(handled, count);
        trusted = true;
    }
    // Invoke the actual card image handlers, including a late event after the current generation changes.
    window.hfm.previewTraceEnabled = true;
    renderer.rememberPreviewImageTrace('data:image/png;base64,CARD', a, 'font');
    renderer.rememberPreviewImageTrace('data:image/png;base64,CARD', b, 'other-font');
    const cardLoad = loader({
        react: { memo: f => f, useEffect: () => { }, useMemo: f => f(), useRef: () => ({ current: null }) },
        'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
        '../runtime/preview/previewTraceRuntime': renderer,
        '../appRuntime': { fontDisplayName: () => '', fontFileDisplayName: () => '', formatSize: () => '', installLabel: () => '', isInstalled: () => false, scriptLabels: {} },
        '../runtime/preview/fontPreviewCssFamilyRuntime': { buildListPreviewCssFamily: () => '' },
        '../runtime/preview/useResizeFrozenPreviewRuntime': { useResizeFrozenPreviewRuntime: (_id, v) => v },
        '../runtime/preview/gridNativePreviewImageTrimRuntime': { useGridNativePreviewImageTrim: () => undefined },
        '../runtime/preview/gridPreviewVisualFitRuntime': { useGridPreviewVisualFitText: () => ({ fittedText: 'sample', visualFitRef: { current: null }, visualFitActive: false }) },
        '../runtime/app/windowResizePhaseRuntime': { isWindowResizeActive: () => false, subscribeWindowResizeSettled: () => () => { } }
    });
    const card = cardLoad('src/renderer/src/components/FontCard.tsx').FontCard({ font: { id: 'font' }, compact: true, previewImage: 'data:image/png;base64,CARD', previewText: 'sample', listPreviewFontSize: 44 });
    function findImage(node) { if (!node || typeof node !== 'object')
        return; if (node.type === 'img')
        return node; for (const child of [node.props?.children].flat(Infinity)) {
        const found = findImage(child);
        if (found)
            return found;
    } }
    const img = findImage(card);
    assert(img);
    renderer.resetPreviewTrace();
    renderer.rememberPreviewImageTrace('data:image/png;base64,CARD', b, 'font');
    img.props.onLoad();
    img.props.onError();
    assert.equal(events.at(-1).stage, 'image-error');
    assert.equal(events.at(-1).trace.operationId, a.operationId);
    assert.equal(events.at(-2).stage, 'image-load');
    assert.equal(events.at(-2).trace.operationId, a.operationId);
    process.env.HFM_LOG_DETAIL = 'debug';
    process.env.HFM_PREVIEW_SCHEDULER_COALESCE_DELAY_MS = '0';
    process.env.HFM_PREVIEW_SCHEDULER_REQUEST_TIMEOUT_MS = '500';
    const schedulerLoad = loader({ './sharedFileSystemRuntime': { sharedFileSystem: {} } });
    const sc = schedulerLoad('src/main/logging/operationTraceContext.ts');
    const schedulerModule = schedulerLoad('src/main/preview/runtime/previewRequestSchedulerRuntime.ts');
    const schedulerLogs = [];
    let release, started, calls = 0;
    let began = new Promise(resolve => { started = resolve; });
    const scheduler = schedulerModule.createPreviewRequestSchedulerRuntime({
        appendStartupLog: x => schedulerLogs.push(x),
        readCachedPreviewImages: () => { calls++; started(); return new Promise(resolve => { release = resolve; }); }
    });
    const font = { id: 'font', path: 'C:/font.ttf', fileSize: 1, modifiedAt: 1 };
    const one = sc.withOperationTrace(a, undefined, () => scheduler.readCachedPreviewImages([font], 'sample'));
    const two = sc.withOperationTrace(b, undefined, () => scheduler.readCachedPreviewImages([font], 'sample'));
    await began;
    release({ font: 'image' });
    assert.deepEqual(await one, { font: 'image' });
    assert.deepEqual(await two, { font: 'image' });
    assert.equal(calls, 1);
    const parseEvents = () => schedulerLogs.filter(x => x.startsWith('operation-chain: ')).map(x => JSON.parse(x.slice(17)));
    let links = parseEvents().filter(x => x.stage === 'cache-physical-member');
    assert.equal(links.length, 2);
    assert.equal(links[0].jobId, links[1].jobId);
    assert.notEqual(links[0].trace.operationId, links[1].trace.operationId);
    began = new Promise(resolve => { started = resolve; });
    const late = sc.withOperationTrace(a, undefined, () => scheduler.readCachedPreviewImages([font], 'later'));
    await began;
    assert.deepEqual(await late, {});
    assert(parseEvents().some(x => x.stage === 'cache-caller-deadline'));
    release({ font: 'late-image' });
    await new Promise(setImmediate);
    assert(parseEvents().some(x => x.stage === 'cache-physical-settled' && x.outcome === 'caller-ended'));
    // A FontFace can finish physically after its logical deadline. Observing it must not add it to document.fonts.
    global.window.setTimeout = setTimeout;
    global.window.clearTimeout = clearTimeout;
    let releaseFont, added = 0;
    const settlements = [];
    global.FontFace = class {
        load() { return new Promise(resolve => { releaseFont = () => resolve(this); }); }
    };
    global.document = { fonts: { add() { added++; } } };
    const quickSource = fs.readFileSync(path.join(root, 'src/renderer/src/runtime/preview/queue/fontPreviewQuickFallbackRuntime.ts'), 'utf8').replace(/import\.meta\.env/g, '({})');
    const quickModule = { exports: {} };
    new Function('module', 'exports', ts.transpileModule(quickSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(quickModule, quickModule.exports);
    await assert.rejects(quickModule.exports.loadFontFaceFromUrlWithinBudget('family', 'url', 1, x => settlements.push(x)));
    assert.equal(added, 0);
    releaseFont();
    await new Promise(setImmediate);
    assert.deepEqual(settlements, ['loaded']);
    assert.equal(added, 0);
    const protocolLogs = [], paths = [];
    let reads = 0, allowed = true;
    const protocolLoad = loader({ '../path/sharedFileSystemRuntime': { sharedFileSystem: { readFile: async () => { reads++; return Buffer.from('font'); } } } });
    const protocol = protocolLoad('src/main/app/fontProtocolRuntime.ts').createFontProtocolRuntime({ appendLog: x => protocolLogs.push(x), authorizeFontRead: async (p) => { paths.push(p); return allowed ? { ok: true, value: { ioPath: p } } : { ok: false, reason: 'outside-authorized-roots' }; } });
    const originalPath = 'C:\\字体\\font ? # %.ttf';
    const url = 'hfm-font://local/b64/' + Buffer.from(originalPath).toString('base64url');
    const tracedUrl = url + '?hfmTrace=' + encodeURIComponent(JSON.stringify(a));
    assert.equal((await protocol.handleRequest({ url: tracedUrl })).status, 200);
    assert.equal(paths.at(-1), originalPath);
    const physicalEvents = protocolLogs.filter(x => x.startsWith('operation-chain: ')).map(x => JSON.parse(x.slice(17)));
    assert(physicalEvents.some(x => x.stage === 'font-authorize-end' && x.trace.operationId === a.operationId));
    assert(physicalEvents.some(x => x.stage === 'font-file-read-end' && x.trace.operationId === a.operationId));
    allowed = false;
    const readCount = reads;
    assert.equal((await protocol.handleRequest({ url: tracedUrl })).status, 403);
    assert.equal((await protocol.handleRequest({ url: url + '?hfmTrace=invalid' })).status, 403);
    assert.equal(reads, readCount, 'trace metadata bypassed authorization');
    allowed = true;
    assert.equal((await protocol.handleRequest({ url })).status, 200);
    assert(!protocolLogs.join('').includes(originalPath));
    console.log('preview trace checks passed: gating, bounded state, old-generation image, 24-member links, privacy, async isolation, error identity, both preload compatibility');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
