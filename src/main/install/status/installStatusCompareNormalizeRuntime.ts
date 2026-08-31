import type { InstallCompareResult } from '../../../shared/types'

export function createInstallStatusCompareNormalizeRuntime() {
  function normalizeInstallCompareResult(result: Partial<InstallCompareResult> | null | undefined): InstallCompareResult | null {
    if (!result || typeof result !== 'object') return null
    const by = result.by === 'managed' || result.by === 'system' || result.by === 'both' || result.by === 'user' || result.by === 'none' ? result.by : 'none'
    return {
      installed: !!result.installed,
      by,
      matches: Array.isArray(result.matches) ? result.matches : []
    }
  }

  return { normalizeInstallCompareResult }
}
