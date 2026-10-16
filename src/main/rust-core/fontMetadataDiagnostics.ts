export interface RustMetadataDiagnostic {
  stage: 'collection' | 'table-directory' | 'name' | 'cmap' | 'style'
  kind: 'io-error' | 'invalid-structure' | 'unsupported-format' | 'resource-limit' | 'missing-table' | 'empty-metadata'
  sourceIndex?: number
  detail: string
  ioKind?: string
}

const stages = new Set(['collection', 'table-directory', 'name', 'cmap', 'style'])
const kinds = new Set(['io-error', 'invalid-structure', 'unsupported-format', 'resource-limit', 'missing-table', 'empty-metadata'])
export const MAX_METADATA_DIAGNOSTICS = 16

export function normalizeRustMetadataDiagnostics(input: unknown): RustMetadataDiagnostic[] | undefined {
  if (!Array.isArray(input)) return undefined
  const result: RustMetadataDiagnostic[] = []
  for (const value of input.slice(0, MAX_METADATA_DIAGNOSTICS)) {
    if (!value || typeof value !== 'object' || !stages.has(value.stage) || !kinds.has(value.kind)) continue
    result.push({ stage: value.stage, kind: value.kind,
      detail: typeof value.detail === 'string' ? value.detail.slice(0, 96) : '',
      ...(Number.isSafeInteger(value.sourceIndex) && value.sourceIndex >= 0 ? { sourceIndex: value.sourceIndex } : {}),
      ...(typeof value.ioKind === 'string' ? { ioKind: value.ioKind.slice(0, 64) } : {}),
    })
  }
  return result.length ? result : undefined
}

