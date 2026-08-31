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
  const [fontFamilyGroupResult, setFontFamilyGroupResult] = useState<FontFamilyGroupResult | null>(null)
  const [fontFamilyGroupLoading, setFontFamilyGroupLoading] = useState(false)
  const [fontFamilyGroupError, setFontFamilyGroupError] = useState('')
  const [expandedFontFamilyIds, setExpandedFontFamilyIds] = useState<Record<string, true>>({})
  const familyQueryScopeKey = useMemo(() => fontFamilyQueryScopeKey(databaseQueryRequest), [databaseQueryKey])

  useEffect(() => {
    if (cardPoolViewMode !== 'family' || !shouldUseDatabaseQuery) {
      setFontFamilyGroupLoading(false)
      return
    }

    let disposed = false
    setFontFamilyGroupLoading(true)
    setFontFamilyGroupError('')

    loadFontFamilyGroups(hfm, databaseQueryRequest, () => disposed)
      .then((result) => {
        if (disposed) return
        setFontFamilyGroupResult(result)
        setFontFamilyGroupError('')
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
        setFontFamilyGroupError(error instanceof Error ? error.message : String(error))
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
    fontFamilyGroupLoading,
    fontFamilyGroupError,
    expandedFontFamilyIds,
    toggleFontFamilyExpanded
  }
}
