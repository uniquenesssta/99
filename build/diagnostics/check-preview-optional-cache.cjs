const assert = require('node:assert/strict'), path = require('node:path');
const repo = path.resolve(__dirname, '../..');
const { loader } = require(repo + '/build/diagnostics/check-operation-chain.cjs');
const png = require(repo + '/build/diagnostics/fixtures/preview-png.cjs');
const gate = () => { let resolve; return { promise: new Promise(r => resolve = r), resolve: value => resolve(value) }; };
const font = { id: 'a', path: '/font.ttf', fileSize: 100, modifiedAt: 1 };
async function within(pending, label) {
  let timer;
  try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), 700); })]); }
  finally { clearTimeout(timer); }
}
function fixture() {
  const state = { files: new Map(), index: new Map(), rows: [], tasks: [], requests: [], publications: [], renames: [], reads: [], prefetches: 0, hydrates: 0, queued: 0 };
  const missing = () => Object.assign(Error('missing'), { code: 'ENOENT' });
  const fakefs = {
    stat: async () => ({ size: 100, mtimeMs: 1 }), access: async () => {}, mkdir: async () => {},
    readFile: async p => { state.reads.push(p); if (!state.files.has(p)) throw missing(); return state.files.get(p); },
    rename: async (a, b) => {
      state.renames.push([a, b]);
      if (state.beforeRename) await state.beforeRename(a, b);
      if (!state.files.has(a)) throw missing();
      state.files.set(b, state.files.get(a)); state.files.delete(a);
    },
    unlink: async p => { state.files.delete(p); },
  };
  const storage = {
    previewCacheStorageForFont: async () => ({ identity: 'font', dir: '/cache', storage: 'local', shared: { rootPath: '\\\\nas\\fonts' } }),
    readPreviewCacheIndexStatus: async (_storage, _key, output) => state.index.get(output)?.status || null,
    writePreviewCacheIndex: async (_storage, key, row) => { state.rows.push({ key, ...row }); state.index.set(row.outputPath, row); },
    deletePreviewCacheIndex: async () => {}, rememberPreviewCacheRenderQueued: () => { state.queued++; },
    schedulePreviewCachePrefetch: () => { state.prefetches++; },
    hydratePreviewCache: async () => { state.hydrates++; return state.hydrate ? state.hydrate() : false; },
  };
  const deadline = {
    withPhysicalIoCompletion: fn => fn(), fileExistsTimeoutMs: () => 500, previewCacheQueryTimeoutMs: () => 2000,
    fileExistsWithDeadline: async () => false,
    withIoDeadlineResult: async (_label, fn) => { try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error }; } },
  };
  state.render = async request => {
    if (request.foregroundBytes) return { ok: true, outputPath: request.outputPath, engine: 'test', bytes: png, transient: true };
    state.files.set(request.outputPath, png);
    return { ok: true, outputPath: request.outputPath, engine: 'test' };
  };
  const load = loader({
    '../native-renderer/directwrite/directWritePreviewHelperPathRuntime': { hasDirectWritePreviewHelper: () => false },
    '../path/sharedFileSystemRuntime': { sharedFileSystem: fakefs, withSharedPreviewReads: fn => fn() },
    '../../path/sharedFileSystemRuntime': { sharedFileSystem: fakefs, withSharedPreviewReads: fn => fn() },
    '../path/ioDeadlineRuntime': deadline, '../../path/ioDeadlineRuntime': deadline,
    './runtime/previewCacheStorageRuntime': { createPreviewCacheStorageRuntime: () => storage },
    './runtime/previewCachePublishRuntime': { createPreviewCachePublishRuntime: () => ({ enqueuePreviewCachePublish: (_storage, row) => state.publications.push(row) }) },
    './native-renderer/previewNativeRendererRuntime': { createPreviewNativeRenderer: () => ({ activeEngineLabel: () => 'test', renderNativePreview: async request => { state.requests.push(request); return state.render(request); } }) },
  });
  const options = {
    ensureWindows() {}, appendStartupLog() {}, sha1: () => 'key', resolveExistingFontFilePath: async () => '/font.ttf',
    withGlobalIo: (_label, fn) => fn(), previewTaskKey: key => key, legacyRootPreviewCacheDir: () => '/legacy',
  };
  for (const method of ['completeBackgroundTask', 'upsertBackgroundTask', 'startBackgroundTask', 'heartbeatBackgroundTask', 'failBackgroundTask', 'skipBackgroundTask']) {
    options[method] = async (...args) => { state.tasks.push({ method, args }); };
  }
  return { state, load, runtime: load('src/main/preview/previewRuntime.ts').createPreviewRuntime(options) };
}
const render = runtime => runtime.ensureFontPreviewImageFile(font, 'text', 44, 720, 260, false, false, true);
const cache = runtime => runtime.ensureFontPreviewImageFile(font, 'text', 44, 720, 260, false, false, false);

async function main() {
  {
    const { state, runtime } = fixture();
    state.hydrate = () => new Promise(() => {});
    const result = await within(runtime.renderFontPreviewImage(font, 'text'), 'foreground waited for optional cache');
    assert(result.startsWith('data:image/png'));
    assert.equal(state.requests.length, 1); assert.equal(state.requests[0].foregroundBytes, true);
    assert.equal(state.prefetches, 0); assert.equal(state.hydrates, 0);
    assert.deepEqual(state.rows, []); assert.deepEqual(state.publications, []); assert.deepEqual(state.tasks, []);
    assert.deepEqual(state.renames, []); assert.equal(state.queued, 0); assert.equal(state.files.size, 0);
    assert(!state.reads.includes(state.requests[0].outputPath), 'transient output path was read as a file');
    console.log('PASS foreground bytes bypass optional prefetch, persistent rows, tasks and publication');
  }
  {
    const { state, runtime } = fixture();
    const pair = await Promise.all([render(runtime), render(runtime)]);
    assert(pair.every(result => result.transient && result.bytes.equals(png)));
    assert.equal(state.requests.length, 1, 'same-lane consumers launched competing renderers');
    console.log('PASS same-lane visible consumers share one transient native render');
  }
  {
    const { state, runtime } = fixture();
    const result = await cache(runtime);
    assert.equal(result.cached, false); assert(!result.transient); assert(state.files.get(result.outputPath).equals(png));
    assert.equal(state.requests[0].foregroundBytes, undefined); assert.equal(state.rows.at(-1).status, 'ok');
    assert.equal(state.publications.length, 1); assert.equal(state.queued, 1);
    for (const method of ['upsertBackgroundTask', 'startBackgroundTask', 'heartbeatBackgroundTask', 'completeBackgroundTask']) assert(state.tasks.some(task => task.method === method));
    console.log('PASS explicit background cache still commits files, rows and task state');
  }
  {
    const { state, runtime } = fixture(); const ready = gate(), held = gate(); const defaultRender = state.render;
    state.render = async request => { if (request.foregroundBytes) { ready.resolve(); await held.promise; } return defaultRender(request); };
    const visible = render(runtime); await ready.promise;
    const persisted = await within(cache(runtime), 'background coalesced behind held foreground bytes');
    const rows = state.rows.length, tasks = state.tasks.length;
    held.resolve(); const result = await within(visible, 'background invalidated held display lease');
    assert(result.transient && result.bytes.equals(png)); assert(state.files.get(persisted.outputPath).equals(png));
    assert.equal(state.rows.length, rows); assert.equal(state.tasks.length, tasks); assert.equal(state.publications.length, 1);
    assert.equal(state.requests.length, 2);
    console.log('PASS held foreground and same-key background retain independent leases and results');
  }
  {
    const { state, runtime } = fixture(); const ready = gate(), held = gate(); const defaultRender = state.render;
    state.render = async request => { if (request.foregroundBytes) { ready.resolve(); await held.promise; throw Error('held foreground failed'); } return defaultRender(request); };
    const visible = render(runtime).then(() => ({ unexpected: true }), error => ({ error })); await ready.promise;
    const persisted = await within(cache(runtime), 'background waited for held foreground failure');
    const rows = state.rows.length, tasks = state.tasks.length;
    held.resolve(); assert((await visible).error);
    assert.equal(state.rows.length, rows); assert.equal(state.rows.at(-1).status, 'ok'); assert.equal(state.tasks.length, tasks);
    assert.equal(state.publications.length, 1); assert(state.files.get(persisted.outputPath).equals(png));
    const hit = await render(runtime); assert(hit.cached, 'visible cooldown hid a valid background cache hit');
    state.files.clear(); state.index.clear();
    const regenerated = await within(cache(runtime), 'foreground failure cooldown suppressed explicit cache regeneration');
    assert(!regenerated.cached); assert.equal(state.requests.length, 3); assert.equal(state.rows.at(-1).status, 'ok');
    console.log('PASS foreground failure preserves background success and cannot suppress later cache work');
  }
  {
    const { state, runtime } = fixture(); const ready = gate(), held = gate();
    state.beforeRename = async () => { ready.resolve(); await held.promise; };
    const background = cache(runtime); await ready.promise;
    const visible = await within(render(runtime), 'transient display release waited for another owner commit');
    assert(visible.transient); held.resolve(); assert((await background).bytes.equals(png));
    console.log('PASS transient display release never joins an unrelated pending file commit');
  }
  {
    const { state, runtime } = fixture();
    state.render = async request => { state.files.set(request.outputPath, png); return { ok: true, outputPath: request.outputPath, engine: 'test' }; };
    const result = await render(runtime);
    assert(!result.transient); assert(state.files.get(result.outputPath).equals(png));
    assert.equal(state.renames.length, 2, 'legacy display file did not lazily acquire its publication lease');
    assert.equal(state.rows.at(-1).status, 'ok'); assert.equal(state.publications.length, 1); assert.deepEqual(state.tasks, []);
    console.log('PASS legacy foreground file results lazily acquire a real publication lease');
  }
  {
    const { state, runtime } = fixture(); const ready = gate(), held = gate();
    state.hydrate = async () => { ready.resolve(); await held.promise; return false; };
    state.render = async request => { state.files.set(request.outputPath, png); return { ok: true, outputPath: request.outputPath, engine: 'test' }; };
    const background = cache(runtime); await ready.promise;
    await render(runtime); held.resolve();
    assert((await background).cached); assert.equal(state.requests.length, 1, 'late hydration miss rerendered a committed legacy display image');
    console.log('PASS late background hydration reuses an already committed legacy foreground file');
  }
  {
    const { state, runtime } = fixture();
    state.render = async request => ({ ok: true, outputPath: request.outputPath, engine: 'test', bytes: png.subarray(0, png.length - 1), transient: true });
    await assert.rejects(render(runtime));
    assert.deepEqual(state.rows, []); assert.deepEqual(state.publications, []); assert.deepEqual(state.tasks, []); assert.deepEqual(state.renames, []);
    console.log('PASS incomplete transient PNG never reaches cache persistence');
  }
  {
    const { state, load } = fixture(); const { claimPreviewImage } = load('src/main/preview/runtime/previewImageCommitRuntime.ts');
    const hydration = claimPreviewImage('/cache/shared.png', 'hydrate');
    const display = claimPreviewImage('/cache/shared.png', 'display');
    assert(hydration.current(), 'display lease aborted or superseded hydration');
    await display.release(); assert(hydration.current());
    state.files.set(hydration.temporaryPath, png); assert(await hydration.commit()); await hydration.release();
    console.log('PASS a display lease leaves active hydration ownership unchanged');
  }
}

async function nativeByteResult() {
  let accesses = 0;
  const load = loader({
    '../../path/sharedFileSystemRuntime': { sharedFileSystem: { writeFile: async () => {}, access: async () => { accesses++; throw Error('unexpected file access'); } } },
    '../../rust-core/rustSharedIoCommandRuntime': { sharedIoResourceKeys: async () => [] },
    './directwrite/directWritePreviewHelperPathRuntime': { findDirectWritePreviewHelperPath: () => null },
    './directwrite/directWritePreviewRequestRuntime': { renderWithDirectWritePreviewHelper: async () => { throw Error('unexpected helper'); } },
    './powershell/powerShellPreviewRendererRuntime': { renderWithPowerShellPreview: async () => { throw Error('unexpected fallback'); } },
    '../../rust-core/nodeBridgeFallbackCompatibilityRuntime': { nodeBridgeFallbackCompatibilityAllowed: () => false, logNodeBridgeFallbackDisabled() {}, nodeBridgeFallbackDeniedMessage: () => 'disabled' },
  });
  const renderer = load('src/main/preview/native-renderer/previewNativeRendererRuntime.ts').createPreviewNativeRenderer({
    appendStartupLog() {}, execFileAsync: async () => { throw Error('unexpected helper'); },
    runRustPreviewRenderImage: async request => ({ ok: true, engine: 'rust-directwrite', outputPath: request.outputPath, bytes: png, transient: true }),
  });
  const request = { fontPath: '/font.ttf', text: 'text', fontSize: 44, width: 720, height: 260, outputPath: '/nonexistent.png' };
  assert((await renderer.renderNativePreview({ ...request, foregroundBytes: true }, '/input.json')).transient);
  assert.equal(accesses, 0, 'transient native bytes checked a nonexistent output file');
  assert.equal((await renderer.renderNativePreview(request, '/input.json')).ok, false, 'cache request accepted unsolicited transient bytes');
  assert.equal(accesses, 0);
  console.log('PASS native renderer accepts transient bytes only for foreground without path access');
}

async function recovery() {
  const load = loader({}); let calls = 0; const remembered = [];
  const shared = { storage: 'root', rootPath: '//nas/fonts', dir: '//nas/fonts/.hfm-cache', indexDbPath: '//nas/fonts/preview.sqlite' };
  const run = load('src/main/preview/runtime/previewCacheHydrationRuntime.ts').createPreviewCacheHydrationRuntime({
    appendStartupLog() {}, previewCacheStorageToShared: () => shared, ensureSharedAvailable: async () => true,
    readPreviewCacheIndexStatus: async () => { calls++; throw Error('transient timeout'); },
    sharedPresence: { getSharedPresence: () => 'missing', rememberSharedPresence: (_storage, _key, status) => remembered.push(status) },
    sharedPresenceIndex: { getSharedPresenceIndex: async () => 'missing', rememberSharedPresenceIndex: async (_storage, _key, status) => remembered.push(status) },
  });
  const row = { id: 'a', previewKey: 'key', outputPath: '/local/a.png', fontSignature: 'font', textHash: 'text', fontSize: 32, width: 100, height: 50 };
  assert.equal(await run.hydratePreviewCache({ storage: 'local' }, row), false);
  assert.equal(await run.hydratePreviewCache({ storage: 'local' }, row), false);
  assert.deepEqual(remembered, []); assert.equal(calls, 2);
  console.log('PASS transient failure stays unknown; old persistent missing is rechecked');
}
main().then(nativeByteResult).then(recovery).catch(error => { console.error(error); process.exitCode = 1; });
