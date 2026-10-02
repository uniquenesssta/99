import type { FontQueryRequest } from '../../shared/types'

export function shouldUseMergedIndexWorkerForPage(request: FontQueryRequest, hasPendingActivationState = true): boolean {
  const activeKind = request.activeFilter?.kind || 'all'
  return !(
    activeKind === 'active' && hasPendingActivationState
  )
}
