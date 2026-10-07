import type { RootDirectorySignature } from './watchedFolderIndexTypes'

export function watcherRelativePath(fileName: string): string {
  return String(fileName || '')
    .replace(/^[/\\]+/, '')
    .replaceAll('\\', '/')
    .toLowerCase()
    .replace(/\/+$/g, '')
}

export function watcherPathIsInside(relativePath: string, parentRelativePath: string): boolean {
  const child = relativePath
    .replaceAll('\\', '/')
    .toLowerCase()
    .replace(/\/+$/g, '')
  const parent = parentRelativePath
    .replaceAll('\\', '/')
    .toLowerCase()
    .replace(/\/+$/g, '')
  if (!parent) return true
  return child === parent || child.startsWith(`${parent}/`)
}

export function watcherPathDepth(relativePath: string): number {
  const normalized = watcherRelativePath(relativePath)
  if (!normalized) return 0
  return normalized.split('/').filter(Boolean).length
}

export function directorySignatureMatches(
  a: RootDirectorySignature | undefined,
  b: RootDirectorySignature | null,
): boolean {
  if (!a || !b) return false
  return (
    Math.round(a.modifiedAt) === Math.round(b.modifiedAt) &&
    a.fileCount === b.fileCount &&
    a.dirCount === b.dirCount
  )
}
