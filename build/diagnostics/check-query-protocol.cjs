#!/usr/bin/env node
/*
 * Regression checks for Rust-first query protocol and explicit Node fallback policy.
 * The checks are dependency-free and simulate the protocol rules used by the TS runtime.
 */
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertIncludes(relativePath, needle) {
  const content = read(relativePath)
  assert(content.includes(needle), `${relativePath} missing ${needle}`)
}

function revisionNumber(value, key) {
  const record = value && typeof value === 'object' ? value : null
  if (!record) return 0
  const numberValue = Number(record[key] || 0)
  return Number.isFinite(numberValue) ? numberValue : 0
}

function tagRevisionCacheToken(snapshot) {
  const localRevision = revisionNumber(snapshot, 'localRevision')
  const sharedRevision = revisionNumber(snapshot, 'sharedRevision')
  if (!localRevision && !sharedRevision) return ''
  return `tagrev:l${localRevision}:s${sharedRevision}`
}

function tagRevisionMatchesSnapshot(snapshot, metadata) {
  const requested = metadata && typeof metadata === 'object' ? metadata.requested : null
  return !!requested &&
    revisionNumber(snapshot, 'localRevision') === revisionNumber(requested, 'localRevision') &&
    revisionNumber(snapshot, 'sharedRevision') === revisionNumber(requested, 'sharedRevision')
}

function fontQueryNeedsFreshTagMetadata(request) {
  const sidebarPage = request.sidebarPage || 'library'
  const activeKind = request.activeFilter && request.activeFilter.kind || 'all'
  return sidebarPage === 'tags' || sidebarPage === 'sharedTags' || activeKind === 'tag' || activeKind === 'sharedTag'
}

function shouldAcceptIndexedPageProtocol({ request, result, snapshot, stale, allowLegacyFallback }) {
  if (!result) return { accept: false, reason: 'empty-result' }
  if (stale) return { accept: false, reason: 'tag-revision-stale' }
  if (!fontQueryNeedsFreshTagMetadata(request)) return { accept: true }
  if (tagRevisionMatchesSnapshot(snapshot, result.tagRevision)) return { accept: true }
  if (allowLegacyFallback && Number(result.total || 0) > 0) return { accept: true, reason: 'legacy-non-zero-compatible' }
  return { accept: false, reason: 'missing-or-mismatched-tag-revision' }
}

function shouldAcceptMetricsProtocol({ result, snapshot, allowLegacyFallback }) {
  if (!result) return { accept: false, reason: 'empty-result' }
  if (!tagRevisionCacheToken(snapshot)) return { accept: true }
  if (tagRevisionMatchesSnapshot(snapshot, result.tagRevision)) return { accept: true }
  if (allowLegacyFallback) return { accept: true, reason: 'legacy-metrics-compatible' }
  return { accept: false, reason: 'metrics-missing-or-mismatched-tag-revision' }
}

function testTagPageRejectsMissingRevisionUnlessExplicitCompat() {
  const request = { sidebarPage: 'sharedTags', activeFilter: { kind: 'sharedTag', name: '标题' } }
  const snapshot = { localRevision: 10, sharedRevision: 20 }
  const legacyResult = { total: 3, items: [], tagRevision: undefined }
  const strict = shouldAcceptIndexedPageProtocol({ request, result: legacyResult, snapshot, allowLegacyFallback: false })
  const compat = shouldAcceptIndexedPageProtocol({ request, result: legacyResult, snapshot, allowLegacyFallback: true })
  assert(!strict.accept && strict.reason === 'missing-or-mismatched-tag-revision', 'strict tag page accepted legacy result without tagRevision')
  assert(compat.accept && compat.reason === 'legacy-non-zero-compatible', 'explicit compatibility mode should allow non-zero legacy tag page')
}

function testFreshTagRevisionAccepted() {
  const request = { sidebarPage: 'tags', activeFilter: { kind: 'tag', name: '正文' } }
  const snapshot = { localRevision: 5, sharedRevision: 7 }
  const result = { total: 1, tagRevision: { requested: { localRevision: 5, sharedRevision: 7 } } }
  const decision = shouldAcceptIndexedPageProtocol({ request, result, snapshot, allowLegacyFallback: false })
  assert(decision.accept, 'fresh tagRevision result was rejected')
}

function testStaleResultAlwaysRejected() {
  const request = { sidebarPage: 'library' }
  const snapshot = { localRevision: 5, sharedRevision: 7 }
  const result = { total: 100, tagRevision: { requested: { localRevision: 5, sharedRevision: 7 } } }
  const decision = shouldAcceptIndexedPageProtocol({ request, result, snapshot, stale: true, allowLegacyFallback: true })
  assert(!decision.accept && decision.reason === 'tag-revision-stale', 'stale query result should not be accepted even in compatibility mode')
}

function testMetricsRequiresRevisionWhenTokenExists() {
  const snapshot = { localRevision: 10, sharedRevision: 0 }
  const strict = shouldAcceptMetricsProtocol({ result: { total: 10 }, snapshot, allowLegacyFallback: false })
  const compat = shouldAcceptMetricsProtocol({ result: { total: 10 }, snapshot, allowLegacyFallback: true })
  assert(!strict.accept && strict.reason === 'metrics-missing-or-mismatched-tag-revision', 'strict metrics accepted missing tagRevision')
  assert(compat.accept && compat.reason === 'legacy-metrics-compatible', 'explicit compatibility mode should allow legacy metrics')
}

function testMetricsCacheKeysAreRevisionScoped() {
  assert(tagRevisionCacheToken({ localRevision: 1, sharedRevision: 2 }) === 'tagrev:l1:s2', 'revision token format changed')
  assert(tagRevisionCacheToken({ localRevision: 2, sharedRevision: 2 }) !== tagRevisionCacheToken({ localRevision: 1, sharedRevision: 2 }), 'metrics revision cache key did not vary by localRevision')
  assertIncludes('src/main/library/fontQueryFacadeRuntime.ts', "key: metricsRevisionToken ? `metrics:${metricsRevisionToken}` : 'metrics:default'")
}


function testSmallInstallStatusMissingDoesNotLeaveSidebarSyncing() {
  assertIncludes('src/main/library/fontMetricsInstallStatusReconcileRuntime.ts', 'metrics install status small missing finalized')
  assertIncludes('src/main/library/fontMetricsInstallStatusReconcileRuntime.ts', 'installStatusMissingCount: 0')
  assertIncludes('src/main/library/fontMetricsInstallStatusReconcileRuntime.ts', 'installStatusReady: true')
  assertIncludes('src/main/library/fontMetricsInstallStatusReconcileRuntime.ts', 'notInstalledCount: Math.max(0, total - installedCount)')
}

function testTagBarrierUsesRustIndexedGraceInsteadOfMemoryBypass() {
  assertIncludes('src/main/library/tagMetadataRevisionBarrierRuntime.ts', 'TAG_METADATA_INDEXED_QUERY_GRACE_MS')
  assertIncludes('src/main/library/tagMetadataRevisionBarrierRuntime.ts', 'indexedQueryDelayMsForRequest')
  assertIncludes('src/main/library/tagMetadataRevisionBarrierRuntime.ts', 'return false')
  assertIncludes('src/main/library/fontQueryFacadeRuntime.ts', 'tag metadata barrier delayed indexed')
  assertIncludes('src/main/library/fontQueryFacadeRuntime.ts', 'rust-worker-retry')
  const predicate = read('src/main/indexing/merged-page/mergedIndexQueryPredicateRuntime.ts')
  assert(!predicate.includes('sidebarPage === "tags"'), 'tag page still forces validated merged index fallback')
  assert(!predicate.includes('sidebarPage === "sharedTags"'), 'shared tag page still forces validated merged index fallback')
  assert(!predicate.includes('activeKind === "tag"'), 'tag filter still forces validated merged index fallback')
  assert(!predicate.includes('activeKind === "sharedTag"'), 'shared tag filter still forces validated merged index fallback')
}

function testRuntimeWiring() {
  assertIncludes('src/main/library/nodeIndexedFallbackCompatibilityRuntime.ts', 'nodeIndexedFallbackPolicySnapshot')
  assertIncludes('src/main/library/nodeIndexedFallbackCompatibilityRuntime.ts', 'HFM_NODE_DB_QUERY_FALLBACK=1')
  assertIncludes('src/main/library/mergedIndexQueryProtocolRuntime.ts', 'nodeIndexedFallbackCompatibilityAllowed')
  assertIncludes('src/main/library/fontQueryFacadeRuntime.ts', 'recordNodeIndexedFallbackDisabled')
  assertIncludes('src/main/library/fontQueryFacadeRuntime.ts', 'recordNodeIndexedFallbackUsed')
  assertIncludes('src/main/diagnostics/migrationDiagnosticsRuntime.ts', 'nodeIndexedFallbackPolicySnapshot')
  assertIncludes('src/main/indexing/merged-page/mergedIndexPageQueryRuntime.ts', 'nodeIndexedFallbackDeniedMessage')
}

const tests = [
  testTagPageRejectsMissingRevisionUnlessExplicitCompat,
  testFreshTagRevisionAccepted,
  testStaleResultAlwaysRejected,
  testMetricsRequiresRevisionWhenTokenExists,
  testMetricsCacheKeysAreRevisionScoped,
  testSmallInstallStatusMissingDoesNotLeaveSidebarSyncing,
  testTagBarrierUsesRustIndexedGraceInsteadOfMemoryBypass,
  testRuntimeWiring,
]

for (const test of tests) {
  test()
  console.log(`ok ${test.name}`)
}
console.log(`query protocol checks passed (${tests.length})`)
