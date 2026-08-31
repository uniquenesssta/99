#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')
function read(file) { return fs.readFileSync(path.join(root, file), 'utf8') }
function assert(condition, message) {
  if (!condition) {
    console.error(`[folder-count-path-consistency] ${message}`)
    process.exit(1)
  }
}

const rustPath = read('native-src/hfm-core-worker/src/merged_index/path_utils.rs')
assert(rustPath.includes('upper.starts_with("\\\\\\\\?\\\\UNC\\\\")'), 'Rust path normalization must strip the Windows UNC device prefix')
assert(rustPath.includes('upper.starts_with("\\\\\\\\?\\\\")'), 'Rust path normalization must strip the Windows device prefix')
assert(rustPath.includes('let is_unc = normalized.starts_with("\\\\\\\\")'), 'Rust path normalization must preserve UNC roots while collapsing duplicate separators')

const rustFolders = read('native-src/hfm-core-worker/src/folders/mod.rs')
assert(rustFolders.includes('normalize_native_path_text(&root.to_string_lossy())'), 'physical folder roots must not expose \\?\\ paths to the renderer')
assert(rustFolders.includes('normalize_native_path_text(&full.to_string_lossy())'), 'physical folder nodes must not expose \\?\\ paths to the renderer')

const rendererNormalize = read('src/renderer/src/library-normalize/libraryNormalizeBase.ts')
assert(rendererNormalize.includes("normalized.replace(/^\\\\\\\\\\?\\\\UNC\\\\/i, '\\\\\\\\')"), 'renderer normalization must repair stored UNC device paths')
assert(rendererNormalize.includes("normalized.replace(/^\\\\\\\\\\?\\\\/i, '')"), 'renderer normalization must repair stored drive device paths')

const treeRuntime = read('src/renderer/src/library-normalize/libraryFolderTreeRuntime.ts')
assert(treeRuntime.includes('normalizePhysicalFolderTree(tree)'), 'all physical folder trees must be normalized before entering LibraryState')
assert(treeRuntime.includes('parentId: normalizePhysicalPathText(node.parentId)'), 'folder parent IDs must use the same canonical path form as root IDs')

const persistence = read('src/main/library/runtime/libraryPersistenceRuntime.ts')
assert(persistence.includes('normalizeNativePathText(node.id)'), 'existing folder node IDs must be repaired while loading Library SQLite')
assert(persistence.includes('normalizeNativePathText(node.parentId)'), 'existing folder parent IDs must be repaired while loading Library SQLite')

const reconcile = read('src/main/library/fontMetricsFolderCountReconcileRuntime.ts')
assert(reconcile.includes('normalizedRoots.some((root) => !counts.has(root))'), 'metrics must detect missing watched-root count keys')
assert(reconcile.includes('normalizedRoots.length === 1 && rootTotal !== total'), 'single-root metrics must detect a root total that diverges from total fonts')
assert(reconcile.includes('overlapping watched roots'), 'multi-root metrics must not treat legitimate overlapping-root totals as corruption')
assert(reconcile.includes('folderCounts: { ...(fallback.folderCounts || {}) }'), 'invalid Rust folder counts must be self-healed from the authoritative fallback snapshot')

console.log('[folder-count-path-consistency] ok')
