import { SharedIoProcessError } from '../../path/sharedIoProcessRuntime'
import { sharedIoResourceKeys } from '../../rust-core/rustSharedIoCommandRuntime'
import type { RootIndexAccessKind, RootIndexStorage } from './rootIndexTypes'

export async function resolveRootIndexAccessKind(
  filePath: string,
  storage: RootIndexStorage,
): Promise<RootIndexAccessKind> {
  const access: RootIndexAccessKind = (await sharedIoResourceKeys([filePath])).length ? 'shared' : 'local'
  if (storage === 'fallback' && access === 'shared') {
    throw new SharedIoProcessError(
      '本机 fallback 根索引不能位于共享路径。',
      'not-started',
      'invalid-root-index-access',
    )
  }
  return access
}
