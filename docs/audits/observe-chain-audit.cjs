// Read-only audit observations, not a regression gate: after fixes, reproduced must become false.
// Run from any cwd with: node docs/audits/observe-chain-audit.cjs
const { load } = require('../../build/diagnostics/check-decomposition-baseline.cjs')
const authority = load('src/renderer/src/fontTagStateAuthorityRuntime.ts')
const font = { id: 'a', path: 'C:/audit/a.ttf', fileName: 'a.ttf', localTagNames: ['old'], tagNames: ['shared'], favorite: true, deleteProtected: true }
const edited = authority.markFontTagsOptimistic(font, 'local', ['new'], 2000)
const library = { fonts: { a: edited }, localTags: ['old', 'new'], tags: ['shared'] }
const late = authority.applyFontTagMutationSignalToLibrary(library, {
  scope: 'local', changedIds: ['a'], updatedAt: new Date(1000).toISOString(), localRevision: 1, knownTags: ['old']
}, 3000)
const other = authority.applyFontTagMutationSignalToLibrary(library, {
  scope: 'local', changedIds: ['b'], updatedAt: new Date(1000).toISOString(), localRevision: 1, knownTags: ['old']
}, 3000)
const expired = authority.mergeFontTagState(edited, font, 'local', 22001)
function signals() {
  const broadcasts = []
  const barrier = load('src/main/library/tagMetadataRevisionBarrierRuntime.ts', {
    './tagQueryFreshnessRuntime': load('src/main/library/tagQueryFreshnessRuntime.ts')
  }).createTagMetadataRevisionBarrierRuntime({ appendStartupLog() {} })
  const runtime = load('src/main/library/tagMutationStateSignalRuntime.ts', {
    electron: { BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_, payload) => broadcasts.push(payload) } }] } }
  }).createTagMutationStateSignalRuntime({ tagMetadataRevisionBarrier: barrier, clearFontQueryCaches() {}, appendStartupLog() {} })
  return { runtime, broadcasts }
}
const roots = signals(), tail = signals()
const shared = { mutationKind: 'deleteTag', updatedAt: '2026-09-16T00:00:00.000Z', changedIds: [], sharedMetadataChanged: true }
roots.runtime.handleSharedMetadataMutationStateSignal({ ...shared, rootPath: 'C:/audit/rootA' })
roots.runtime.handleSharedMetadataMutationStateSignal({ ...shared, rootPath: 'C:/audit/rootB' })
const prefix = Array.from({ length: 80 }, (_, i) => `f${i}`)
const local = { mutationKind: 'setBatch', updatedAt: shared.updatedAt, dbPath: 'C:/audit/library.db', knownTags: ['old'] }
tail.runtime.handleLocalTagsMutationStateSignal({ ...local, changedIds: [...prefix, 'a'] })
tail.runtime.handleLocalTagsMutationStateSignal({ ...local, changedIds: [...prefix, 'b'] })
console.log(JSON.stringify({
  scope: 'real authority/signal/barrier modules; controlled time/input; Electron broadcast sink replaced; no disk or native operations',
  observations: [
    { id: 'F-01a', scenario: 'older acknowledgement after newer optimistic edit', expectedTags: ['new'], actualTags: late.fonts.a.localTagNames, stillDirty: authority.isFontTagStateDirty(late.fonts.a, 'local', 3000), reproduced: !late.fonts.a.localTagNames.includes('new') },
    { id: 'F-01b', scenario: 'other font acknowledgement filters pending tag globally', expectedTags: ['new'], actualTags: other.fonts.a.localTagNames, reproduced: !other.fonts.a.localTagNames.includes('new') },
    { id: 'F-02', scenario: 'unconfirmed tag edit after 20s protection expires', expectedTagsWhilePending: ['new'], actualTags: expired.localTagNames, reproduced: !expired.localTagNames.includes('new') },
    { id: 'F-03a', scenario: 'distinct shared roots same timestamp and empty changed IDs', expectedBroadcasts: 2, actualBroadcasts: roots.broadcasts.length, reproduced: roots.broadcasts.length !== 2 },
    { id: 'F-03b', scenario: 'distinct local batch tail after identical first 80 IDs', expectedBroadcasts: 2, actualBroadcasts: tail.broadcasts.length, reproduced: tail.broadcasts.length !== 2 }
  ]
}, null, 2))
