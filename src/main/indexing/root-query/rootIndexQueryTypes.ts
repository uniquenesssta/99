export type RootIndexPageRow = {
  relative_path: string
  cache_key: string
  file_size: number
  modified_at: number
  created_at?: number | null
  status: string
  font_json?: string | null
  message?: string | null
  cached_at: string
  installed?: number | null
  installed_by?: string | null
  matches_json?: string | null
  category_index?: string | null
  search_text?: string | null
}

export type MergedIndexPageRow = RootIndexPageRow & { root_path: string }

export type RootIndexQueryParts = {
  clauses: string[]
  params: unknown[]
  hasInstallJoin: boolean
  usedLike: boolean
  unsupportedReason?: string
}

export type RootIndexQuerySqlResult = {
  sql: string
  countSql: string
  params: unknown[]
  countParams: unknown[]
  unsupportedReason?: string
  usedLike: boolean
}
