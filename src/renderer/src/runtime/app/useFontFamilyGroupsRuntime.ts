import { useEffect, useMemo, useState } from 'react'
import type { FontQueryRequest } from '@shared/types'
import type { FontFamilyGroupResult } from '../family/fontFamilyGroupingRuntime'
import { fontFamilyQueryScopeKey, loadFontFamilyGroups } from '../family/fontFamilyGroupingRuntime'
import { reportRendererTrace } from '../../appRuntime'

export function useFontFamilyGroupsRuntime(args: {
  hfm: Window['hfm']
  cardPoolViewMode: string
  databaseQueryRequest: FontQueryRequest
  databaseQueryKey: string
  shouldUseDatabaseQuery: boolean
  databaseRefreshToken: number
  sidebarPage: string
}): {
  fontFamilyGroupResult: FontFamilyGroupResult | null
  fontFamilyGroupLoading: boolean
  fontFamilyGroupError: string
  expandedFontFamilyIds: Record<string, true>
  toggleFontFamilyExpanded: (groupId: string) => void
} {
  const { hfm, cardPoolViewMode, databaseQueryRequest, databaseQueryKey, shouldUseDatabaseQuery, databaseRefreshToken, sidebarPage } = args
  const [resolved, setResolved] = useState<{ scope: string; result: FontFamilyGroupResult } | null>(null)
  const [fontFamilyGroupLoading, setFontFamilyGroupLoading] = useState(false)
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null)
  const [expandedFontFamilyIds, setExpandedFontFamilyIds] = useState<Record<string, true>>({})
  const familyQueryScopeKey = useMemo(() => fontFamilyQueryScopeKey(databaseQueryRequest), [databaseQueryKey])
  const resultScope = `${familyQueryScopeKey}:${databaseRefreshToken}`
  const fontFamilyGroupResult = resolved?.scope === resultScope ? resolved.result : null
  const fontFamilyGroupError = failure?.scope === resultScope ? failure.message : ''

  useEffect(() => {
    if (cardPoolViewMode !== 'family' || !shouldUseDatabaseQuery) {
      setFontFamilyGroupLoading(false)
      return
    }

    let disposed = false
    setFontFamilyGroupLoading(true)
    setFailure(null)

    loadFontFamilyGroups(hfm, databaseQueryRequest, () => disposed)
      .then((result) => {
        if (disposed) return
        setResolved({ scope: resultScope, result })
        setFailure(null)
        reportRendererTrace({
          kind: 'font-family-groups-loaded',
          label: 'familyGroupView',
          page: sidebarPage,
          severity: result.elapsedMs >= 500 ? 'slow' : 'info',
          durationMs: result.elapsedMs,
          details: { groups: result.totalGroups, fonts: result.totalFonts, truncated: result.truncated }
        }, 'font-family-groups-loaded')
      })
      .catch((error) => {
        if (disposed) return
        const message = error instanceof Error ? error.message : String(error)
        setFailure({ scope: resultScope, message })
        reportRendererTrace({ kind: 'db-query-error', label: 'family-query', page: sidebarPage, severity: 'error', details: { keyword: databaseQueryRequest.keyword, message } })
      })
      .finally(() => {
        if (!disposed) setFontFamilyGroupLoading(false)
      })

    return () => {
      disposed = true
    }
  }, [cardPoolViewMode, familyQueryScopeKey, shouldUseDatabaseQuery, databaseRefreshToken, sidebarPage])

  const toggleFontFamilyExpanded = (groupId: string): void => {
    setExpandedFontFamilyIds((prev) => {
      if (prev[groupId]) {
        const next = { ...prev }
        delete next[groupId]
        return next
      }
      return { ...prev, [groupId]: true }
    })
  }

  return {
    fontFamilyGroupResult,
    fontFamilyGroupLoading: fontFamilyGroupLoading || (cardPoolViewMode === 'family' && shouldUseDatabaseQuery && !fontFamilyGroupResult && !fontFamilyGroupError),
    fontFamilyGroupError,
    expandedFontFamilyIds,
    toggleFontFamilyExpanded
  }
}
