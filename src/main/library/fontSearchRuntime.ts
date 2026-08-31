import { inferMergedIndexCategory, type MergedIndexCategory } from '../indexing/merged-page/mergedIndexCategoryRuntime'

export type FontSearchCategory = MergedIndexCategory

export function createFontSearchRuntime() {
  return {
    inferFontSearchCategory: inferMergedIndexCategory,
  }
}
