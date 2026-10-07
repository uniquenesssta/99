import type { FontItem,InstallCompareOptions,InstallCompareResult } from '../../../shared/types'
import type { InstallStatusRefreshRuntimeDeps } from './installStatusRefreshTypes'

export function createInstallStatusCompareRuntime(deps: InstallStatusRefreshRuntimeDeps) {
  async function compareFontInstalled(
    item: FontItem
  ): Promise<InstallCompareResult> {
    const installed = await deps.getSystemInstalledFontsCached(true)
    const rustCompare = await deps.runRustInstallStatusCompare?.({ appName: deps.appName || '字体管理器', items: [item], installed })
    const result = rustCompare?.results?.[item.id] || deps.compareFontInstalledWithLookupIndex(
      item,
      deps.buildInstalledFontLookupIndex(installed)
    )
    await deps.saveInstallStatusIndex(
      { [item.id]: result },
      new Map([[item.id, item]])
    )
    return result
  }

  async function compareFontsInstalled(
    items: FontItem[],
    options: InstallCompareOptions = {}
  ): Promise<Record<string, InstallCompareResult>> {
    const uniqueItems = Array.from(
      new Map(
        (items || []).filter(Boolean).map((item) => [item.id, item])
      ).values()
    )
    if (!uniqueItems.length) return {}

    if (options.force) {
      const installed = await deps.getSystemInstalledFontsCached(true)
      const rustCompare = await deps.runRustInstallStatusCompare?.({ appName: deps.appName || '字体管理器', items: uniqueItems, installed })
      const freshResults: Record<string, InstallCompareResult> = {}
      if (rustCompare?.results && Object.keys(rustCompare.results).length === uniqueItems.length) {
        Object.assign(freshResults, rustCompare.results)
      } else {
        const lookup = deps.buildInstalledFontLookupIndex(installed)
        for (let index = 0; index < uniqueItems.length; index += 1) {
          const item = uniqueItems[index]
          freshResults[item.id] = deps.compareFontInstalledWithLookupIndex(item, lookup)
          if (index > 0 && index % 100 === 0) await deps.delayToEventLoop()
        }
      }
      await deps.saveInstallStatusIndex(
        freshResults,
        new Map(uniqueItems.map((item) => [item.id, item]))
      )
      return freshResults
    }

    const { results } = await deps.readInstallStatusIndex(uniqueItems, {
      enqueueMissTasks: false
    })
    return results
  }

  return { compareFontInstalled, compareFontsInstalled }
}
