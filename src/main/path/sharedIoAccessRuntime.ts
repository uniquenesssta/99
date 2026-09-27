/** Conflict identities are separate from availability roots. Descriptions are
 * supplied by the operation owner; an absent description is a share barrier. */
export type SharedIoAccess = {
  root: string
  path: string
  mode: 'read' | 'write'
  scope: 'file' | 'database' | 'tree'
}
export type SharedIoAccessPath = Omit<SharedIoAccess, 'root'>

function objectPath(access: SharedIoAccess): string {
  // SQLite journals belong to the database even when accessed through the FS adapter.
  return access.path.replace(/-(?:wal|shm|journal)$/, '')
}
export function sharedIoAccessConflict(a: SharedIoAccess, b: SharedIoAccess): boolean {
  if (a.root !== b.root || (a.mode === 'read' && b.mode === 'read')) return false
  const ap = objectPath(a), bp = objectPath(b)
  return ap === bp || (a.scope === 'tree' && bp.startsWith(ap + '\\')) || (b.scope === 'tree' && ap.startsWith(bp + '\\'))
}
