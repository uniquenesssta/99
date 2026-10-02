import type { FontQueryRequest } from '../../shared/types'

export function fontQueryNeedsFreshTagMetadata(request: FontQueryRequest): boolean {
  const sidebarPage = request.sidebarPage || 'library'
  const activeKind = request.activeFilter?.kind || 'all'
  return (
    Boolean(String(request.keyword || '').trim()) ||
    sidebarPage === 'tags' ||
    sidebarPage === 'sharedTags' ||
    activeKind === 'tag' ||
    activeKind === 'sharedTag'
  )
}
