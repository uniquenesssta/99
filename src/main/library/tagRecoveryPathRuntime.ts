import { canonicalizeAbsolutePath, isPathInsideAbsoluteBoundary } from '../path/pathBoundaryPolicy'
import { mappedDriveTableAsync } from '../path/pathCanonicalizer'

// One verified mapping snapshot per query/recovery. Missing files cannot be
// realpathed, so only established drive aliases participate in ownership.
export async function createTagRecoveryPaths(roots: string[]) {
  const drives = await mappedDriveTableAsync()
  const compare = (path: string): string => {
    const canonical = canonicalizeAbsolutePath(path)
    if (!canonical) return ''
    const drive = canonical.path.match(/^([a-z]:)(\\.*)$/i)
    const remote = drive && drives?.get(drive[1].toUpperCase())
    return canonicalizeAbsolutePath(remote ? remote + drive![2] : canonical.path)!.comparePath
  }
  const inside = (path: string, root: string) => isPathInsideAbsoluteBoundary(compare(path), compare(root))
  const unique = [...new Map(roots.filter(root => compare(root)).map(root => [compare(root), root])).values()]
  const owner = (path: string) => unique.filter(root => inside(path, root)).sort((a, b) => compare(b).length - compare(a).length)[0]
  return { roots: unique, compare, inside, owner, contains: (path: string) => !!owner(path) }
}

export type TagRecoveryPaths = Awaited<ReturnType<typeof createTagRecoveryPaths>>
