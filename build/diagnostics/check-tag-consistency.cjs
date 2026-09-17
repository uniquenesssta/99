#!/usr/bin/env node
/*
 * Lightweight regression checks for the tag/shared-tag migration chain.
 * It intentionally avoids app startup and native SQLite dependencies so it can run
 * before Electron/Rust build steps.
 */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
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

const authority = require('./check-operation-chain.cjs').loader()('src/renderer/src/fontTagStateAuthorityRuntime.ts');
const markOptimistic = authority.markFontTagsOptimistic;
const mergeWithAuthority = authority.mergeFontWithTagAuthority;
const applySignal = authority.applyFontTagMutationSignalToLibrary;

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

function testStateSignalPreservesIntentAndUpdatesKnownTags() {
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
  assert(authority.isFontTagStateDirty(font, 'local'), 'broadcast must not acknowledge a specific edit');
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
  assertIncludes('src/main/library/runtime/localFontTagNodePersistenceRuntime.ts', 'mergeKnownLocalTags(previousKnownTags, nextBoundTags');
  assertIncludes('src/main/library/runtime/localFontTagNodePersistenceRuntime.ts', 'previousKnownTags.filter((tag) => tag !== tagName)');
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
  assertIncludes('src/main/library/runtime/localFontTagMutationEffectsRuntime.ts', 'local known tag retained empty:');
  assertIncludes('src/main/library/runtime/localFontTagMutationEffectsRuntime.ts', 'local known tag deleted:');
  assertNotIncludes('src/main/library/runtime/localFontTagMutationEffectsRuntime.ts', 'local known tag zero-bind removed:');
  assertIncludes('src/renderer/src/fontTagStateAuthorityRuntime.ts', 'if (hasKnownTags)');
  assertIncludes('src/renderer/src/runtime/app/useBrowseDerivedRuntime.ts', "isLibraryTagAuthorityKnown(library, 'local')");
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
  assertIncludes('src/main/rust-core/clients/rustMetadataClientRuntime.ts', 'mutationProtocol');
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
  testStateSignalPreservesIntentAndUpdatesKnownTags,
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
