import { relative,resolve } from 'node:path'
import { normalizePathCompareText } from './pathCanonicalizer'

export function normalizePathForCacheCompare(filePath: string): string {
  return normalizePathCompareText(filePath)
}

export function relativePathForRoot(rootPath: string, filePath: string): string {
  const relativePath = relative(resolve(rootPath), resolve(filePath))
  return relativePath.replaceAll('\\', '/').toLowerCase()
}
