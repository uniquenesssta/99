#!/usr/bin/env node
/*
 * Lightweight regression checks for the tag/shared-tag migration chain.
 * It intentionally avoids app startup and native SQLite dependencies so it can run
 * before Electron/Rust build steps.
 */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const TAG_DIRTY_PROTECTION_MS = 20_000;
const TAG_LOCALE = 'zh-Hans-CN';

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(relativePath, needle) {
  const content = read(relativePath);
  assert(content.includes(needle), `${relativePath} missing ${needle}`);
}

function assertNotIncludes(relativePath, needle) {
  const content = read(relativePath);
  assert(!content.includes(needle), `${relativePath} must not contain ${needle}`);
}

function cleanTags(tags) {
  return Array.from(new Set((tags || []).map((tag) => String(tag || '').trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, TAG_LOCALE));
}

function numericValue(value) {
  const numberValue = typeof value === 'number' ? value : Number(value || 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function tagField(scope) {
  return scope === 'local' ? 'localTagNames' : 'tagNames';
}

function revisionField(scope) {
  return scope === 'local' ? '__localTagRevision' : '__sharedTagRevision';
}

function dirtyUntilField(scope) {
  return scope === 'local' ? '__localTagDirtyUntil' : '__sharedTagDirtyUntil';
}

function authorityField(scope) {
  return scope === 'local' ? '__localTagAuthorityKnown' : '__sharedTagAuthorityKnown';
}

function filterFontByLibraryAuthority(library, font) {
  let next = font;
  for (const scope of ['shared', 'local']) {
    if (library[authorityField(scope)] !== true) continue;
    const field = tagField(scope);
    const known = new Set(cleanTags(scope === 'local' ? library.localTags : library.tags));
    const current = cleanTags(next[field]);
    const filtered = current.filter((tag) => known.has(tag));
    if (filtered.length !== current.length) next = { ...next, [field]: filtered };
  }
  return next;
}

function ensureKnownTags(library) {
  const sharedKnown = library.__sharedTagAuthorityKnown === true;
  const localKnown = library.__localTagAuthorityKnown === true;
  const sharedTags = new Set(cleanTags(library.tags));
  const localTags = new Set(cleanTags(library.localTags));
  const fonts = {};
  for (const [fontId, original] of Object.entries(library.fonts || {})) {
    const font = filterFontByLibraryAuthority(library, original);
    fonts[fontId] = font;
    if (!sharedKnown) for (const tag of cleanTags(font.tagNames)) sharedTags.add(tag);
    if (!localKnown) for (const tag of cleanTags(font.localTagNames)) localTags.add(tag);
  }
  return { ...library, fonts, tags: cleanTags([...sharedTags]), localTags: cleanTags([...localTags]) };
}

function markOptimistic(font, scope, tagNames, nowMs) {
  const revisionKey = revisionField(scope);
  return {
    ...font,
    [tagField(scope)]: cleanTags(tagNames),
    [revisionKey]: Math.max(numericValue(font[revisionKey]) + 1, nowMs),
    [dirtyUntilField(scope)]: nowMs + TAG_DIRTY_PROTECTION_MS,
  };
}

function mergeScope(existing, incoming, scope, nowMs) {
  const tagsKey = tagField(scope);
  const revisionKey = revisionField(scope);
  const dirtyKey = dirtyUntilField(scope);
  const existingTags = cleanTags(existing ? existing[tagsKey] : undefined);
  const incomingHasTags = Array.isArray(incoming[tagsKey]);
  const incomingTags = cleanTags(incomingHasTags ? incoming[tagsKey] : undefined);
  const existingRevision = numericValue(existing ? existing[revisionKey] : 0);
  const incomingRevision = numericValue(incoming[revisionKey]);
  const dirty = numericValue(existing ? existing[dirtyKey] : 0) > nowMs;

  if (dirty || (incomingRevision > 0 && existingRevision > incomingRevision)) {
    return {
      [tagsKey]: existingTags,
      [revisionKey]: existingRevision,
      [dirtyKey]: existing ? existing[dirtyKey] : undefined,
    };
  }

  if (!incomingHasTags && existing) {
    return {
      [tagsKey]: existingTags,
      [revisionKey]: existingRevision,
      [dirtyKey]: existing ? existing[dirtyKey] : undefined,
    };
  }

  return {
    [tagsKey]: incomingTags,
    [revisionKey]: incomingRevision || existingRevision || undefined,
    [dirtyKey]: undefined,
  };
}

function mergeWithAuthority(existing, incoming, nowMs) {
  return {
    ...incoming,
    ...mergeScope(existing, incoming, 'shared', nowMs),
    ...mergeScope(existing, incoming, 'local', nowMs),
  };
}

function applySignal(library, signal, nowMs) {
  const scope = signal.scope === 'shared' ? 'shared' : 'local';
  const revisionKey = revisionField(scope);
  const dirtyKey = dirtyUntilField(scope);
  const changedIds = new Set((signal.changedIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  const signalRevision = numericValue(scope === 'local' ? signal.localRevision : signal.sharedRevision);
  const updatedAtRevision = Number.isFinite(Date.parse(signal.updatedAt || '')) ? Date.parse(signal.updatedAt || '') : 0;
  const nextRevisionBase = Math.max(signalRevision, updatedAtRevision, nowMs);
  const fonts = {};
  for (const [fontId, font] of Object.entries(library.fonts || {})) {
    if (changedIds.size && !changedIds.has(fontId)) {
      fonts[fontId] = font;
      continue;
    }
    fonts[fontId] = {
      ...font,
      [revisionKey]: Math.max(numericValue(font[revisionKey]), nextRevisionBase),
      [dirtyKey]: nowMs,
    };
  }
  const hasKnownTags = Array.isArray(signal.knownTags);
  const knownTags = cleanTags(signal.knownTags);
  if (hasKnownTags) {
    const knownSet = new Set(knownTags);
    const field = tagField(scope);
    for (const [fontId, font] of Object.entries(fonts)) {
      fonts[fontId] = { ...font, [field]: cleanTags(font[field]).filter((tag) => knownSet.has(tag)) };
    }
  }
  return ensureKnownTags({
    ...library,
    fonts,
    ...(hasKnownTags
      ? scope === 'local'
        ? { localTags: knownTags, __localTagAuthorityKnown: true }
        : { tags: knownTags, __sharedTagAuthorityKnown: true }
      : {}),
  });
}

function testDirtyLocalDoesNotOverwriteShared() {
  const now = 1_000_000;
  const original = {
    id: 'font-a',
    tagNames: ['共享旧'],
    localTagNames: ['本地旧'],
    __sharedTagRevision: 10,
    __localTagRevision: 10,
  };
  const localDeleted = markOptimistic(original, 'local', [], now);
  const staleIncoming = {
    id: 'font-a',
    tagNames: ['共享新'],
    localTagNames: ['本地旧'],
    __sharedTagRevision: 11,
    __localTagRevision: 9,
  };
  const merged = mergeWithAuthority(localDeleted, staleIncoming, now + 1);
  assert(merged.localTagNames.length === 0, 'dirty local delete was overwritten by stale page data');
  assert(merged.tagNames.join(',') === '共享新', 'shared tag update should not be blocked by local dirty state');
}

function testOldRevisionCannotOverrideCleanNewerState() {
  const now = 2_000_000;
  const existing = {
    id: 'font-b',
    tagNames: ['共享确认'],
    localTagNames: ['本地确认'],
    __sharedTagRevision: 50,
    __localTagRevision: 50,
  };
  const staleIncoming = {
    id: 'font-b',
    tagNames: ['共享旧'],
    localTagNames: ['本地旧'],
    __sharedTagRevision: 49,
    __localTagRevision: 49,
  };
  const merged = mergeWithAuthority(existing, staleIncoming, now);
  assert(merged.localTagNames.join(',') === '本地确认', 'lower local revision overwrote newer local tags');
  assert(merged.tagNames.join(',') === '共享确认', 'lower shared revision overwrote newer shared tags');
}

function testStateSignalCleansDirtyAndUpdatesKnownTags() {
  const now = 3_000_000;
  const dirtyFont = markOptimistic({ id: 'font-c', localTagNames: ['设计'] }, 'local', ['标题'], now);
  const library = { fonts: { 'font-c': dirtyFont }, localTags: ['设计'], tags: [] };
  const next = applySignal(library, {
    scope: 'local',
    changedIds: ['font-c'],
    localRevision: now + 10,
    updatedAt: new Date(now + 10).toISOString(),
    knownTags: ['标题', '正文'],
  }, now + 20);
  const font = next.fonts['font-c'];
  assert(numericValue(font.__localTagDirtyUntil) <= now + 20, 'local state signal did not clean dirty protection');
  assert(next.localTags.join(',') === '标题,正文', 'known local tags from signal were not applied');
}

function testStateSignalCanClearKnownTags() {
  const now = 3_100_000;
  const library = { fonts: {}, localTags: ['最后一个'], tags: ['共享最后一个'] };
  const nextLocal = applySignal(library, {
    scope: 'local',
    changedIds: [],
    localRevision: now + 10,
    updatedAt: new Date(now + 10).toISOString(),
    knownTags: [],
  }, now + 20);
  const nextShared = applySignal(library, {
    scope: 'shared',
    changedIds: [],
    sharedRevision: now + 10,
    updatedAt: new Date(now + 10).toISOString(),
    knownTags: [],
  }, now + 20);
  assert(Array.isArray(nextLocal.localTags) && nextLocal.localTags.length === 0, 'empty known local tags signal did not clear last tag');
  assert(Array.isArray(nextShared.tags) && nextShared.tags.length === 0, 'empty known shared tags signal did not clear last tag');
}


function testLastUnbindRetainsEmptyLocalTag() {
  const now = 3_200_000;
  const library = {
    fonts: { 'font-z': { id: 'font-z', localTagNames: [] } },
    localTags: ['最后一个'],
    tags: [],
  };
  const next = applySignal(library, {
    scope: 'local',
    changedIds: ['font-z'],
    localRevision: now + 10,
    updatedAt: new Date(now + 10).toISOString(),
    knownTags: ['最后一个'],
  }, now + 20);
  assert(next.localTags.join(',') === '最后一个', 'last unbind removed the local tag catalog entry');
  assert(next.fonts['font-z'].localTagNames.length === 0, 'last unbind did not clear the font binding');
}

function testExplicitDeleteRemovesEmptyLocalTag() {
  const now = 3_300_000;
  const library = {
    fonts: { 'font-z': { id: 'font-z', localTagNames: [] } },
    localTags: ['最后一个'],
    tags: [],
  };
  const next = applySignal(library, {
    scope: 'local',
    changedIds: [],
    localRevision: now + 10,
    updatedAt: new Date(now + 10).toISOString(),
    knownTags: [],
  }, now + 20);
  assert(next.localTags.length === 0, 'explicit tag delete did not remove the empty catalog entry');
}

function testLocalTagCatalogPersistenceWiring() {
  assertIncludes('native-src/hfm-core-worker/src/local_tags/catalog.rs', 'read_catalog_tags');
  assertIncludes('native-src/hfm-core-worker/src/local_tags/catalog.rs', 'merge_tag_sets');
  assertIncludes('native-src/hfm-core-worker/src/local_tags/catalog.rs', 'retained_empty_tags');
  assertIncludes('native-src/hfm-core-worker/src/local_tags/state_machine.rs', 'previous_known_tags.as_slice()');
  assertIncludes('native-src/hfm-core-worker/src/local_tags/state_machine.rs', 'remove_known_tag(&previous_known_tags, &tag_name)');
  assertIncludes('src/main/library/runtime/localFontTagsRuntime.ts', 'mergeKnownLocalTags(previousKnownTags, nextBoundTags');
  assertIncludes('src/main/library/runtime/localFontTagsRuntime.ts', 'previousKnownTags.filter((tag) => tag !== tagName)');
}

function testTagSignalInvalidatesQueriesBeforePersistenceWait() {
  const hook = read('src/renderer/src/runtime/app/effects/useFontTagStateSignalEventRuntime.ts');
  const refreshAt = hook.indexOf('current.refreshDatabaseDerivedState()');
  const saveAt = hook.indexOf('await current.saveLibraryImmediately(nextLibrary)');
  assert(refreshAt >= 0 && saveAt >= 0 && refreshAt < saveAt, 'tag state signal must invalidate database requests before waiting for shell persistence');
  assertIncludes('src/renderer/src/databaseDerivedStateRuntime.ts', 'options.databasePageRequestSeqRef.current += 1');
  assertIncludes('src/renderer/src/databaseDerivedStateRuntime.ts', 'options.fontMetricsRequestSeqRef.current += 1');
}

function testLocalKnownTagLifecycleLoggingWiring() {
  assertIncludes('native-src/hfm-core-worker/src/local_tags/state_machine.rs', 'known_tag_diff');
  assertIncludes('native-src/hfm-core-worker/src/local_tags/types.rs', 'retained_empty_tags');
  assertIncludes('src/main/library/runtime/localFontTagsRuntime.ts', 'local known tag retained empty:');
  assertIncludes('src/main/library/runtime/localFontTagsRuntime.ts', 'local known tag deleted:');
  assertNotIncludes('src/main/library/runtime/localFontTagsRuntime.ts', 'local known tag zero-bind removed:');
  assertIncludes('src/renderer/src/fontTagStateAuthorityRuntime.ts', 'if (hasKnownTags)');
  assertIncludes('src/renderer/src/runtime/app/useAppFontDerivedRuntime.ts', "isLibraryTagAuthorityKnown(library, 'local')");
  assertIncludes('src/renderer/src/fontTagStateAuthorityRuntime.ts', '__localTagAuthorityKnown: true');
  assertIncludes('src/renderer/src/fontViewRuntime.ts', 'filterFontByLibraryTagAuthority');
}

function testThinIpcTopology() {
  assert(fs.existsSync(path.join(repoRoot, 'src/main/ipc/handlers/fontTagIpcHandlers.ts')), 'fontTagIpcHandlers.ts missing');
  assertIncludes('src/main/ipc/ipcHandlers.ts', 'registerFontTagIpcHandlers');
  const fontSystem = read('src/main/ipc/handlers/fontSystemIpcHandlers.ts');
  for (const channel of [
    'fonts:setLocalTags',
    'fonts:setLocalTagsBatch',
    'fonts:deleteLocalTag',
    'fonts:setSharedTags',
    'fonts:setSharedTagsBatch',
    'fonts:deleteSharedTag',
  ]) {
    assertIncludes('src/main/ipc/handlers/fontTagIpcHandlers.ts', channel);
    assert(!fontSystem.includes(channel), `${channel} should be registered by fontTagIpcHandlers, not fontSystemIpcHandlers`);
  }
}

function testSharedKnownTagZeroBindDeleteWiring() {
  assertIncludes('src/main/library/sharedKnownTagsRuntime.ts', 'deleteKnownSharedTagIfUnbound');
  assertIncludes('src/main/library/sharedKnownTagsRuntime.ts', 'zero-bind-delete');
  assertIncludes('src/main/library/sharedFontMetadataMutations.ts', 'shared-known-tag-zero-bind-delete');
  assertIncludes('src/main/library/tagMutationProtocolResultRuntime.ts', 'const hasKnownTags = Array.isArray(options.knownTags)');
  assertIncludes('src/renderer/src/fontTagStateAuthorityRuntime.ts', 'const hasKnownTags = Array.isArray(signal.knownTags)');
}

function testProtocolWiring() {
  assertIncludes('src/main/library/tagMutationProtocolResultRuntime.ts', 'createTagMutationProtocolResult');
  assertIncludes('src/main/library/tagMutationWriteProtocolRuntime.ts', 'result.mutationProtocol?.changedIds');
  assertIncludes('src/main/library/tagMutationStateSignalRuntime.ts', 'font-tags:stateSignal');
  assertIncludes('src/main/rust-core/rustCoreWorkerRuntime.ts', 'mutationProtocol');
  assertIncludes('src/main/rust-core/rustCoreWorkerRuntime.ts', 'runRustLocalTagsRead');
  assertIncludes('src/main/rust-core/rustCoreWorkerRuntime.ts', 'runRustSharedMetadataOverlayRead');
  assertIncludes('native-src/hfm-core-worker/src/mutation_protocol.rs', 'MutationProtocolResult');
  assertIncludes('native-src/hfm-core-worker/src/merged_index/tag_revision.rs', 'merged_index_tag_revision_metadata');
}


function testMigrationDiagnosticsVisible() {
  assertIncludes('src/main/diagnostics/migrationDiagnosticsRuntime.ts', 'createMigrationDiagnosticsRuntime');
  assertIncludes('src/main/diagnostics/migrationDiagnosticsRuntime.ts', 'nodeDbQueryFallback');
  assertIncludes('src/main/library/fontQueryFacadeRuntime.ts', 'migrationDiagnostics?.record');
  assertIncludes('src/main/ipc/handlers/maintenanceIpcHandlers.ts', 'diagnostics:getMigrationStatus');
  assertIncludes('src/preload/index.ts', 'getMigrationDiagnostics');
  assertIncludes('src/renderer/src/rendererDeveloperStatusRuntime.ts', 'setMigrationDiagnostics');
  assertIncludes('src/renderer/src/components/app/FontListPanel.tsx', 'Rust 迁移 / fallback 诊断');
}

function testQueryProtocolFallbackPolicy() {
  assertIncludes('src/main/library/mergedIndexQueryProtocolRuntime.ts', 'shouldAcceptIndexedPageProtocol');
  assertIncludes('src/main/library/nodeIndexedFallbackCompatibilityRuntime.ts', 'nodeIndexedFallbackPolicySnapshot');
  assertIncludes('src/main/library/mergedIndexQueryProtocolRuntime.ts', 'tagRevisionMatchesSnapshot');
  assertIncludes('src/main/library/fontQueryFacadeRuntime.ts', 'shouldAcceptIndexedPageResult');
  assertIncludes('src/main/library/fontQueryFacadeRuntime.ts', 'missing-or-mismatched-tag-revision');
  assertIncludes('src/main/library/fontQueryFacadeRuntime.ts', 'tagRevisionCacheToken');
  assertIncludes('src/main/library/fontQueryFacadeRuntime.ts', 'recordNodeIndexedFallbackDisabled');
  assertIncludes('src/main/library/fontMetricsRequestCoalescerRuntime.ts', 'cachedByKey');
  assertIncludes('src/main/indexing/merged-page/mergedIndexPageQueryRuntime.ts', 'nodeIndexedFallbackDeniedMessage');
}

const tests = [
  testDirtyLocalDoesNotOverwriteShared,
  testOldRevisionCannotOverrideCleanNewerState,
  testStateSignalCleansDirtyAndUpdatesKnownTags,
  testStateSignalCanClearKnownTags,
  testLastUnbindRetainsEmptyLocalTag,
  testExplicitDeleteRemovesEmptyLocalTag,
  testLocalTagCatalogPersistenceWiring,
  testTagSignalInvalidatesQueriesBeforePersistenceWait,
  testLocalKnownTagLifecycleLoggingWiring,
  testThinIpcTopology,
  testSharedKnownTagZeroBindDeleteWiring,
  testProtocolWiring,
  testQueryProtocolFallbackPolicy,
  testMigrationDiagnosticsVisible,
];

for (const test of tests) {
  test();
  console.log(`ok ${test.name}`);
}
console.log(`tag consistency checks passed (${tests.length})`);
